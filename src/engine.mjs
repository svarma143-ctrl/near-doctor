import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DETECTORS, fileRegex } from "./detectors.mjs";
import { matchSymptoms } from "./symptoms.mjs";
import { interpolate, makeRunner, walk } from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version;
export const DEFAULT_RULES_DIR = path.join(HERE, "..", "rules");

const SEV_ORDER = { error: 0, warn: 1, info: 2 };

export function makeFinding(rule, hit, source = "static") {
  const vars = { ...(hit.vars || {}), file: hit.file ?? "", line: hit.line ?? "" };
  const af = rule.fix?.autofix || null;
  return {
    id: rule.id,
    title: rule.title,
    severity: rule.severity,
    tier: rule.tier,
    status: rule.status,
    source,
    message: interpolate(rule.message || rule.title, vars),
    file: hit.file ?? null,
    line: hit.line ?? null,
    why: rule.summary,
    fix: {
      steps: (rule.fix?.steps || []).map((s) => interpolate(s, vars)),
      autofix: af ? { type: af.type, description: af.description, available: true } : null,
    },
    agent: {
      task: interpolate(rule.fix?.agent || rule.fix?.steps?.[0] || rule.title, vars),
      acceptance: { command: `near-doctor --only ${rule.id} --json`, expect: `no finding with id ${rule.id}` },
    },
    target: hit.target || null,
    vars,
    refs: rule.refs || [],
    evidence: rule.evidence || null,
    _autofix: af,
  };
}

function firstErrorLine(text) {
  const m = /error(?:\[E\d+\])?:[^\n]*/.exec(text);
  return m ? m[0].trim() : "";
}

/** Run all static/env checks (and optionally `cargo near check`) against a project directory. */
export async function runChecks(opts) {
  const t0 = Date.now();
  const root = path.resolve(opts.root || ".");
  const rules = opts.rules;
  const ig = [...(opts.ignoreGlobs || [])];
  const ignoreFile = path.join(root, ".near-doctorignore");
  if (fs.existsSync(ignoreFile)) {
    for (const l of fs.readFileSync(ignoreFile, "utf8").split("\n")) {
      const s = l.trim();
      if (s && !s.startsWith("#")) ig.push(s);
    }
  }
  const files = walk(root, { ignoreGlobs: ig });
  const cache = new Map();
  const read = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    let t = null;
    try {
      t = fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      /* unreadable */
    }
    cache.set(rel, t);
    return t;
  };
  const crates = files
    .filter((f) => /(^|\/)Cargo\.toml$/.test(f))
    .map((f) => {
      const d = path.posix.dirname(f);
      return { dir: d === "." ? "" : d, manifest: f, near: /\bnear-sdk\b/.test(read(f) || "") };
    });
  const nearProject =
    crates.some((c) => c.near) ||
    files.some((f) => /(^|\/)package\.json$/.test(f) && /near-api-js|@near-js|near-cli|near-sdk-js|"near-/.test(read(f) || ""));
  const runner = opts.runner || makeRunner(opts.mock);
  const ctx = {
    root,
    files,
    read,
    crates,
    nearProject,
    runner,
    opts,
    fetchImpl: opts.fetchImpl || fetch,
    skipped: [],
    notes: [],
  };
  if (!nearProject) ctx.notes.push("No NEAR project detected here (no near-sdk crate or near-* npm dependency).");

  const findings = [];
  for (const rule of rules) {
    if (!rule.detect) continue;
    if (rule.status === "historical" && !opts.historical) continue;
    if (opts.only && !opts.only.includes(rule.id)) continue;
    if (opts.ignore && opts.ignore.includes(rule.id)) continue;
    let hits = [];
    try {
      if (rule.detect.kind === "file-regex") hits = fileRegex(ctx, rule.detect);
      else hits = await DETECTORS[rule.detect.name](ctx, rule.detect.params || {}, rule);
    } catch (e) {
      ctx.skipped.push({ id: rule.id, reason: `detector error: ${e.message}` });
      continue;
    }
    for (const h of hits) findings.push(makeFinding(rule, h));
  }

  if (opts.deep) {
    for (const c of crates.filter((x) => x.near)) {
      const args = ["near", "check", ...(opts.clippy ? ["--clippy"] : [])];
      const cwd = path.join(root, c.dir);
      const r = runner("cargo", args, { cwd, timeout: 900000 });
      const text = `${r.stdout}\n${r.stderr}`;
      if (r.code === 127 || /no such (sub)?command/i.test(text)) {
        ctx.skipped.push({ id: "deep", reason: "`cargo near` is not installed; run `near-doctor` to see the install steps" });
        continue;
      }
      if (r.code === 0) {
        ctx.notes.push(`cargo near check passed in ${c.dir || "."}`);
        continue;
      }
      const matches = matchSymptoms(text, rules, { only: opts.only, ignore: opts.ignore });
      for (const m of matches) findings.push(makeFinding(m.rule, { file: c.dir || ".", vars: m.vars }, "deep"));
      if (!matches.length) {
        findings.push({
          id: "UNKNOWN",
          title: "cargo near check failed with no known match",
          severity: "info",
          tier: "hypothesis",
          status: "active",
          source: "deep",
          message: firstErrorLine(text) || "cargo near check exited non-zero",
          file: c.dir || ".",
          line: null,
          why: "This failure is not in the friction log yet.",
          fix: { steps: ["Run `near-doctor submit --from <saved-output>` to turn it into a friction report."], autofix: null },
          agent: { task: "Investigate the first compiler error and fix it.", acceptance: { command: "cargo near check", expect: "exit code 0" } },
          target: null,
          vars: {},
          refs: [],
          evidence: null,
          _autofix: null,
        });
      }
    }
  }

  // De-duplicate (static + deep can report the same thing); prefer the one with a file and line.
  const byKey = new Map();
  for (const f of findings) {
    const key = f.vars.name ? `${f.id}:${f.vars.name}` : `${f.id}:${f.file}:${f.line}`;
    const prev = byKey.get(key);
    if (!prev || (!prev.line && f.line)) byKey.set(key, f);
  }
  const out = [...byKey.values()].sort(
    (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.id.localeCompare(b.id) || (a.file || "").localeCompare(b.file || ""),
  );
  const summary = { error: 0, warn: 0, info: 0 };
  for (const f of out) summary[f.severity]++;
  return {
    tool: "near-doctor",
    version: VERSION,
    root,
    nearProject,
    durationMs: Date.now() - t0,
    summary,
    findings: out,
    skipped: ctx.skipped,
    notes: ctx.notes,
  };
}

/** Strip internal fields before printing JSON. */
export function publicResult(result) {
  return { ...result, findings: result.findings.map(({ _autofix, ...rest }) => rest) };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RULES_DIR, VERSION, publicResult, runChecks } from "./engine.mjs";
import { applyFixes } from "./fix.mjs";
import { redact } from "./redact.mjs";
import { formatCheck, formatExplain, formatRulesList, renderSteps, rulesMarkdown } from "./report.mjs";
import { loadRules, validateRules } from "./rules.mjs";
import { matchSymptoms } from "./symptoms.mjs";
import { makeRunner } from "./util.mjs";
import { inspectWasm } from "./wasm.mjs";

const COMMANDS = new Set(["check", "explain", "fix", "inspect", "submit", "rules", "help", "version"]);
const BOOL = new Set(["json", "deep", "clippy", "net", "historical", "safe", "dry-run", "markdown", "check", "no-color", "help", "version"]);
const VALUE = new Set(["rpc", "only", "ignore", "fail-on", "rules", "from", "out", "command"]);

export const HELP = `near-doctor ${VERSION}: preflight checks and an evidence-backed friction log for NEAR developers

Usage
  near-doctor [path]              scan a project (static + environment checks, no network)
  near-doctor explain --from FILE paste tool output (or --from -) and get the known cause and fix
  near-doctor fix --safe          apply deterministic, allowlisted fixes, then re-check
  near-doctor inspect FILE.wasm   show wasm sections and target features
  near-doctor submit              build a redacted friction report (markdown) to paste into a GitHub issue
  near-doctor rules               list the friction log (--markdown, --json, --check)

Options
  --json            machine-readable output (agent-ready: includes tasks and acceptance commands)
  --deep            also run \`cargo near check\` and explain its output
  --clippy          with --deep, run clippy instead of check
  --net             also probe public RPC latency (the only network access; off by default)
  --rpc URL         RPC to probe (default https://rpc.testnet.near.org)
  --only IDS        comma-separated rule ids to run, e.g. F-001,F-004
  --ignore IDS      comma-separated rule ids to skip
  --historical      include rules about problems that no longer reproduce
  --fail-on LEVEL   error (default) | warn | never : when to exit 1
  --rules DIR       use a different rule pack
  --dry-run         with fix, show what would change
  --no-color        plain output

Exit codes: 0 ok, 1 findings at or above --fail-on, 2 usage or internal error.
Rules are data-only; this tool never sends data anywhere unless you pass --net.
`;

export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      if (BOOL.has(k)) flags[k] = true;
      else if (VALUE.has(k)) {
        const v = inline !== undefined ? inline : argv[++i];
        if (v === undefined) throw new Error(`--${k} needs a value`);
        flags[k] = v;
      } else throw new Error(`unknown option --${k}`);
    } else positionals.push(a);
  }
  return { flags, positionals };
}

const list = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

async function readStdin(io) {
  if (io.stdinText !== undefined) return io.stdinText;
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function readInput(flags, io) {
  if (flags.from === "-") return readStdin(io);
  if (flags.from) return fs.readFileSync(flags.from, "utf8");
  return null;
}

export async function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(s));
  const err = io.err || ((s) => process.stderr.write(s));
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err(`near-doctor: ${e.message}\n\n${HELP}`);
    return 2;
  }
  const { flags, positionals } = parsed;
  let command = "check";
  if (positionals.length && COMMANDS.has(positionals[0])) command = positionals.shift();
  const extra = positionals.slice(command === "submit" || command === "inspect" || command === "explain" || command === "fix" || command === "check" ? 1 : 0);
  if (extra.length && !flags.help && !flags.version) {
    const hint = COMMANDS.has(extra[0]) ? ` (did you mean \`near-doctor ${extra[0]} <path>\`? the command comes first)` : "";
    err(`near-doctor: unexpected argument "${extra[0]}"${hint}\n`);
    return 2;
  }
  if (flags.help) command = "help";
  if (flags.version) command = "version";
  const color = !flags["no-color"] && !process.env.NO_COLOR && (io.isTTY ?? process.stdout.isTTY);

  if (command === "help") {
    out(HELP);
    return 0;
  }
  if (command === "version") {
    out(VERSION + "\n");
    return 0;
  }

  const rulesDir = flags.rules || process.env.NEAR_DOCTOR_RULES || DEFAULT_RULES_DIR;
  let rules;
  try {
    rules = loadRules(rulesDir);
    const problems = validateRules(rules);
    if (problems.length) {
      err(`near-doctor: rule pack ${rulesDir} is invalid:\n  ${problems.join("\n  ")}\n`);
      return 2;
    }
  } catch (e) {
    err(`near-doctor: cannot load rules from ${rulesDir}: ${e.message}\n`);
    return 2;
  }
  const only = list(flags.only);
  const ignore = list(flags.ignore);
  const failOn = flags["fail-on"] || "error";
  if (!["error", "warn", "never"].includes(failOn)) {
    err("near-doctor: --fail-on must be error, warn or never\n");
    return 2;
  }
  const exitFor = (summary) =>
    failOn === "never" ? 0 : summary.error > 0 || (failOn === "warn" && summary.warn > 0) ? 1 : 0;
  const runner = io.runner || makeRunner(io.mock);

  try {
    if (command === "rules") {
      if (flags.check) {
        const fixturesDir = io.fixturesDir || path.join(rulesDir, "..", "fixtures");
        const haveFixtures = fs.existsSync(fixturesDir);
        if (!haveFixtures) out("note: fixtures are not shipped in the npm package; checking rule schema only\n");
        const problems = validateRules(rules, { fixturesDir: haveFixtures ? fixturesDir : undefined });
        if (problems.length) {
          err(problems.join("\n") + "\n");
          return 1;
        }
        out(`${rules.length} rules valid\n`);
        return 0;
      }
      if (flags.json) out(JSON.stringify(rules.map(({ __file, ...r }) => r), null, 2) + "\n");
      else if (flags.markdown) out(rulesMarkdown(rules));
      else out(formatRulesList(rules));
      return 0;
    }

    if (command === "explain") {
      const text = await readInput(flags, io);
      if (text == null) {
        err("near-doctor explain: pass --from FILE (or --from - to read stdin)\n");
        return 2;
      }
      const matches = matchSymptoms(text, rules, { only, ignore });
      if (flags.json) {
        out(
          JSON.stringify(
            matches.map((m) => ({ id: m.rule.id, title: m.rule.title, tier: m.rule.tier, status: m.rule.status, why: m.rule.summary, fix: renderSteps(m.rule, m.vars), vars: m.vars })),
            null,
            2,
          ) + "\n",
        );
      } else if (matches.length) out(formatExplain(matches, { color }));
      else out("No known match. If this blocked you, run `near-doctor submit --from <file>` and open a friction report.\n");
      return matches.length ? 0 : 1;
    }

    if (command === "inspect") {
      const file = positionals[0];
      if (!file) {
        err("near-doctor inspect: pass a .wasm file\n");
        return 2;
      }
      const info = inspectWasm(fs.readFileSync(file));
      if (flags.json) out(JSON.stringify(info, null, 2) + "\n");
      else {
        out(`${file}: ${info.size} bytes, ${info.sections.length} sections\n`);
        if (info.targetFeatures) {
          out(`target features enabled: ${info.targetFeatures.enabled.join(", ") || "(none)"}\n`);
          out(`post-MVP features: ${info.postMvp.join(", ") || "(none)"}\n`);
        } else out("no target_features section (stripped by wasm-opt, e.g. via `cargo near build`)\n");
        out("Note: R-001 (PrepareError(Deserialization)) did not reproduce with post-MVP features on testnet node 2.14.1; see `near-doctor rules --markdown`.\n");
      }
      return 0;
    }

    const root = positionals[0] || ".";
    const base = { root, rules, only, ignore, historical: flags.historical, deep: flags.deep, clippy: flags.clippy, net: flags.net, rpc: flags.rpc, runner, fetchImpl: io.fetchImpl, now: io.now };

    if (command === "check") {
      const result = await runChecks(base);
      out(flags.json ? JSON.stringify(publicResult(result), null, 2) + "\n" : formatCheck(result, { color }));
      return exitFor(result.summary);
    }

    if (command === "fix") {
      if (!flags.safe) {
        err("near-doctor fix applies only safe, deterministic fixes. Re-run with --safe (add --dry-run to preview).\n");
        return 2;
      }
      const before = await runChecks({ ...base, deep: false });
      const results = applyFixes(before.findings, { root: before.root, dryRun: flags["dry-run"], runner });
      const after = flags["dry-run"] ? null : await runChecks({ ...base, deep: false });
      if (flags.json) {
        out(JSON.stringify({ fixes: results, remaining: after ? publicResult(after).findings : null }, null, 2) + "\n");
      } else {
        if (!results.length) out("Nothing to fix automatically.\n");
        for (const r of results) out(`${r.status.toUpperCase().padEnd(8)} ${r.id}  ${r.detail}${r.file ? `  (${r.file})` : ""}\n`);
        if (after) {
          out("\nRe-check:\n" + formatCheck(after, { color }));
        }
      }
      return after ? exitFor(after.summary) : 0;
    }

    if (command === "submit") {
      const errorText = (await readInput(flags, io)) || "";
      const result = await runChecks({ ...base, deep: false });
      const ver = (cmd, args) => {
        const r = runner(cmd, args);
        return r.code === 0 ? (r.stdout || r.stderr).trim().split("\n")[0] : "not found";
      };
      const projectVersions = [];
      const lock = path.join(path.resolve(root), "contract", "Cargo.lock");
      for (const f of [path.join(path.resolve(root), "Cargo.lock"), lock]) {
        if (fs.existsSync(f)) {
          const m = /name = "near-sdk"\nversion = "([^"]+)"/.exec(fs.readFileSync(f, "utf8"));
          if (m) projectVersions.push(`near-sdk ${m[1]} (${path.basename(path.dirname(f))}/Cargo.lock)`);
        }
      }
      const napi = path.join(path.resolve(root), "node_modules", "near-api-js", "package.json");
      if (fs.existsSync(napi)) projectVersions.push(`near-api-js ${JSON.parse(fs.readFileSync(napi, "utf8")).version}`);
      const md = [
        `### Command`,
        "",
        "```",
        redact(flags.command || "(describe the command you ran)"),
        "```",
        "",
        `### Error output`,
        "",
        "```",
        redact(errorText).trim() || "(none provided; re-run with --from FILE)",
        "```",
        "",
        `### Environment`,
        "",
        `- near-doctor: ${VERSION}`,
        `- OS: ${os.platform()} ${os.arch()} ${os.release()}`,
        `- node: ${ver("node", ["--version"])}`,
        `- npm: ${ver("npm", ["--version"])}`,
        `- rustc: ${ver("rustc", ["--version"])}`,
        `- cargo: ${ver("cargo", ["--version"])}`,
        `- cargo-near: ${ver("cargo", ["near", "--version"])}`,
        `- near CLI: ${ver("near", ["--version"])}`,
        ...projectVersions.map((v) => `- ${v}`),
        "",
        `### Doctor findings`,
        "",
        result.findings.length ? result.findings.map((f) => `- ${f.id} ${f.title}${f.file ? ` (${redact(f.file)}${f.line ? ":" + f.line : ""})` : ""}`).join("\n") : "- none",
        "",
        "_Generated locally by `near-doctor submit`. Secrets and home paths were redacted automatically; please re-read before posting._",
        "",
      ].join("\n");
      if (flags.out) {
        fs.writeFileSync(flags.out, md);
        out(`wrote ${flags.out}\n`);
      } else out(md);
      return 0;
    }
  } catch (e) {
    err(`near-doctor: ${e.message}\n`);
    return 2;
  }
  err(`near-doctor: unknown command\n${HELP}`);
  return 2;
}

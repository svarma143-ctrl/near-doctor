import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { globToRegex, lineIndex, parseSemver } from "./util.mjs";
import { scanNear, stripRust } from "./rust.mjs";

const SIZE_LIMIT = 1_000_000;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const rustFiles = (ctx) => ctx.files.filter((f) => f.endsWith(".rs"));

function crateRootFor(ctx, file) {
  let best = null;
  for (const c of ctx.crates) {
    const prefix = c.dir ? c.dir + "/" : "";
    if (file.startsWith(prefix) && (!best || c.dir.length > best.dir.length)) best = c;
  }
  if (best) {
    const lib = (best.dir ? best.dir + "/" : "") + "src/lib.rs";
    if (ctx.files.includes(lib)) return lib;
  }
  return file;
}

/** Generic data-driven file scan used by rules with detect.kind === "file-regex". */
export function fileRegex(ctx, d) {
  const flags = d.flags ?? "";
  const mk = (s) => new RegExp(s, flags);
  const all = (d.all || []).map(mk);
  const any = (d.any || []).map(mk);
  const unless = (d.unless || []).map(mk);
  const globs = d.globs.map(globToRegex);
  const hits = [];
  for (const f of ctx.files) {
    if (!globs.some((g) => g.test(f))) continue;
    const text = ctx.read(f);
    if (text == null || text.length > SIZE_LIMIT) continue;
    if (unless.some((r) => r.test(text))) continue;
    if (!all.every((r) => r.test(text))) continue;
    if (any.length && !any.some((r) => r.test(text))) continue;
    const probe = [...any, ...all].find((r) => r.test(text));
    const m = probe ? probe.exec(text) : null;
    const line = m ? lineIndex(text)(m.index) : 1;
    hits.push({ file: f, line, vars: { match: m ? m[0].slice(0, 80) : "" } });
  }
  return hits;
}

export const DETECTORS = {
  /** A free fn named like a public method of a #[near] impl: wasm-only duplicate symbol (E0428). */
  "rust-near-name-collision": (ctx) => {
    const hits = [];
    for (const f of rustFiles(ctx)) {
      const text = ctx.read(f);
      if (!text || !/#\[\s*near/.test(text)) continue;
      const s = scanNear(text);
      const methods = new Map(s.methods.map((m) => [m.module + "|" + m.name, m]));
      for (const fn of s.freeFns) {
        const m = methods.get(fn.module + "|" + fn.name);
        if (m) {
          hits.push({
            file: f,
            line: fn.line,
            vars: { name: fn.name, methodLine: m.line, newName: "compute_" + fn.name },
          });
        }
      }
    }
    return hits;
  },

  /** Public #[near] methods with more parameters than clippy allows, without a crate-level allow. */
  "rust-near-too-many-args": (ctx, params) => {
    const max = params.max ?? 7;
    const hits = [];
    for (const f of rustFiles(ctx)) {
      const text = ctx.read(f);
      if (!text || !/#\[\s*near/.test(text)) continue;
      const s = scanNear(text);
      const root = crateRootFor(ctx, f);
      const rootText = ctx.read(root) || "";
      const allowed = s.allowsTooManyArgs || /#!\[\s*allow\([^\]]*too_many_arguments/.test(stripRust(rootText));
      if (allowed) continue;
      for (const m of s.methods) {
        if (m.params > max) {
          hits.push({
            file: f,
            line: m.line,
            vars: { name: m.name, count: m.params, max, crateRoot: root },
            target: { file: root },
          });
        }
      }
    }
    return hits;
  },

  /** Integration tests or examples use a crate that Cargo.toml does not declare. */
  "rust-undeclared-crate": (ctx, params) => {
    const name = params.crate;
    const usage = new RegExp(params.usage || `\\b${escapeRe(name)}::`);
    const declared = new RegExp(`^\\s*${escapeRe(name)}\\s*[=.]|\\[(?:dev-|build-)?dependencies\\.${escapeRe(name)}\\]`, "m");
    const hits = [];
    for (const c of ctx.crates) {
      const prefix = c.dir ? c.dir + "/" : "";
      const manifest = ctx.read(c.manifest) || "";
      if (declared.test(manifest)) continue;
      for (const f of rustFiles(ctx)) {
        if (!f.startsWith(prefix)) continue;
        const rel = f.slice(prefix.length);
        if (!/^(tests|benches|examples)\//.test(rel)) continue;
        const text = ctx.read(f);
        if (!text) continue;
        const clean = stripRust(text);
        const m = usage.exec(clean);
        if (m) {
          hits.push({
            file: f,
            line: lineIndex(text)(m.index),
            vars: { crate: name, manifest: c.manifest },
            target: { file: c.manifest },
          });
          break;
        }
      }
    }
    return hits;
  },

  /** Named imports from a JS package that the installed version does not export. */
  "js-import-exports": (ctx, params) => {
    const pkg = params.package;
    const hints = params.hints || {};
    const importRe = new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${escapeRe(pkg)}["']`, "g");
    const reqRe = new RegExp(`\\{([^}]*)\\}\\s*=\\s*(?:await\\s+import\\(|require\\()\\s*["']${escapeRe(pkg)}["']\\s*\\)`, "g");
    const cache = new Map();
    const hits = [];
    for (const f of ctx.files) {
      if (!/\.(m?js|cjs|jsx)$/.test(f)) continue; // TS type-only imports would be false positives
      const text = ctx.read(f);
      if (!text || text.length > SIZE_LIMIT || !text.includes(pkg)) continue;
      const found = [];
      for (const re of [importRe, reqRe]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) {
          for (const raw of m[1].split(",")) {
            const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+|\s*:\s*/)[0].trim();
            if (name) found.push({ name, index: m.index });
          }
        }
      }
      if (!found.length) continue;
      const req = createRequire(path.join(ctx.root, f));
      let info;
      try {
        const resolved = req.resolve(pkg);
        if (!cache.has(resolved)) {
          const exp = req(pkg);
          let dir = path.dirname(resolved);
          let version = "unknown";
          for (let i = 0; i < 6; i++) {
            const pj = path.join(dir, "package.json");
            if (fs.existsSync(pj)) {
              const j = JSON.parse(fs.readFileSync(pj, "utf8"));
              if (j.name === pkg) {
                version = j.version;
                break;
              }
            }
            dir = path.dirname(dir);
          }
          cache.set(resolved, { exp, version });
        }
        info = cache.get(resolved);
      } catch (e) {
        ctx.skipped.push({ id: "F-007", reason: `${pkg} not installed or not loadable from ${f} (${String(e.message).split("\n")[0]})` });
        continue;
      }
      const li = lineIndex(text);
      for (const { name, index } of found) {
        if (name in info.exp) continue;
        hits.push({
          file: f,
          line: li(index),
          vars: { name, package: pkg, version: info.version, hint: hints[name] || "Check the package's migration guide for the replacement." },
        });
      }
    }
    return hits;
  },

  "env-cargo-near": (ctx) => {
    if (!ctx.crates.some((c) => c.near)) return [];
    if (ctx.runner("cargo", ["--version"]).code !== 0) {
      ctx.skipped.push({ id: "E-001", reason: "cargo not found; install Rust first (https://rustup.rs)" });
      return [];
    }
    return ctx.runner("cargo", ["near", "--version"]).code === 0 ? [] : [{ file: null, vars: {} }];
  },

  "env-wasm-target": (ctx) => {
    if (!ctx.crates.some((c) => c.near)) return [];
    if (ctx.runner("rustup", ["--version"]).code !== 0) return [];
    const t = ctx.runner("rustup", ["target", "list", "--installed"]);
    if (t.code !== 0) return [];
    return /wasm32-unknown-unknown/.test(t.stdout) ? [] : [{ file: null, vars: {} }];
  },

  "env-near-cli-flavor": (ctx) => {
    if (!ctx.nearProject) return [];
    const r = ctx.runner("near", ["--version"]);
    if (r.code !== 0) return [];
    const v = parseSemver(r.stdout + r.stderr);
    return v && v[0] >= 1 ? [{ file: null, vars: { version: v.join(".") } }] : [];
  },

  /** Opt-in (--net): median latency of the public RPC. */
  "net-rpc-latency": async (ctx, params) => {
    if (!ctx.opts.net) return [];
    const url = ctx.opts.rpc || "https://rpc.testnet.near.org";
    const threshold = params.thresholdMs ?? 2000;
    const now = ctx.opts.now || Date.now;
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const t0 = now();
      try {
        const r = await ctx.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }),
          signal: AbortSignal.timeout(30000),
        });
        await r.text();
      } catch (e) {
        ctx.skipped.push({ id: "F-011", reason: `RPC probe failed: ${e.message}` });
        return [];
      }
      samples.push(now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[1];
    ctx.notes.push(`RPC ${url}: median ${median} ms over 3 calls`);
    return median > threshold ? [{ file: null, vars: { ms: median, url, recommended: Math.max(25000, median * 5) } }] : [];
  },
};

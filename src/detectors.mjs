import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { globToRegex, lineIndex, parseSemver } from "./util.mjs";
import { scanNear, stripRust } from "./rust.mjs";

const SIZE_LIMIT = 1_000_000;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");


/** node_modules/<pkg> above the importing file (path lookup only; nothing is executed). */
function findPackageDir(root, relFile, pkg) {
  let dir = path.dirname(path.join(root, relFile));
  for (;;) {
    const candidate = path.join(dir, "node_modules", pkg);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function dtsEntry(pkgDir, pj) {
  const fromExports = (e) => {
    if (!e) return null;
    if (typeof e === "string") return null;
    if (e.types) return e.types;
    for (const k of ["import", "require", "default", "."]) {
      const r = fromExports(e[k]);
      if (r) return r;
    }
    return null;
  };
  const cands = [pj.types, pj.typings, fromExports(pj.exports?.["."] ?? pj.exports)];
  if (pj.main) cands.push(pj.main.replace(/\.[cm]?js$/, ".d.ts"));
  cands.push("index.d.ts");
  for (const c of cands) if (c && fs.existsSync(path.join(pkgDir, c))) return path.join(pkgDir, c);
  return null;
}

function stripTsComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Names exported by a .d.ts entry, following relative `export *` and `export {..} from`. */
export function dtsExports(file, seen = new Set()) {
  const names = new Set();
  if (seen.has(file) || !fs.existsSync(file)) return names;
  seen.add(file);
  const text = stripTsComments(fs.readFileSync(file, "utf8"));
  const resolveRel = (spec) => {
    const base = path.resolve(path.dirname(file), spec);
    for (const c of [base, base.replace(/\.[cm]?js$/, ".d.ts"), base + ".d.ts", path.join(base, "index.d.ts")]) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
  };
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of m[1].split(",")) {
      const n = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  for (const m of text.matchAll(/export\s*\*\s*(?:as\s+([\w$]+)\s*)?from\s*["']([^"']+)["']/g)) {
    if (m[1]) names.add(m[1]);
    else if (m[2].startsWith(".")) {
      const r = resolveRel(m[2]);
      if (r) for (const n of dtsExports(r, seen)) names.add(n);
    }
  }
  for (const m of text.matchAll(/export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function\*?|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  if (/export\s+default\b/.test(text)) names.add("default");
  return names;
}

function packageExports(pkgDir, pkg, relFile, ctx) {
  const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const version = pj.version || "unknown";
  const entry = dtsEntry(pkgDir, pj);
  if (entry) {
    const text = fs.readFileSync(entry, "utf8");
    if (/^\s*export\s*=/m.test(text)) return { reason: "type declarations use `export =`; pass --allow-exec to load the package instead", version };
    const names = dtsExports(entry);
    if (names.size) return { names, version, via: "types" };
  }
  if (ctx.opts.allowExec) {
    try {
      const req = createRequire(path.join(ctx.root, relFile));
      return { names: new Set(Object.keys(req(pkg))), version, via: "exec" };
    } catch (e) {
      return { reason: `could not load: ${String(e.message).split("\n")[0]}`, version };
    }
  }
  return { reason: "no type declarations found; pass --allow-exec to load the package (this runs its code)", version };
}

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
        if (m.params > max && !m.allowed) {
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
    // A file belongs to its nearest enclosing crate: a nested crate (for example tests/Cargo.toml) is checked
    // against its own manifest, not the root one.
    const prefixes = ctx.crates.map((c) => (c.dir ? c.dir + "/" : ""));
    const owner = (f) => prefixes.reduce((best, p) => (f.startsWith(p) && p.length > best.length ? p : best), "");
    const all = rustFiles(ctx);
    const fileSet = new Set(all);
    for (const c of ctx.crates) {
      const prefix = c.dir ? c.dir + "/" : "";
      const manifest = ctx.read(c.manifest) || "";
      if (!/^\s*\[package\]/m.test(manifest)) continue; // a virtual workspace root has no test targets
      if (declared.test(manifest)) continue;
      // Cargo auto-discovers tests/*.rs and tests/*/main.rs (same for benches and examples); a file in a
      // deeper directory only compiles when its target root exists next to it (tests/x.rs or tests/x/main.rs).
      const compiled = (rel) => {
        const m = /^(tests|benches|examples)\/(.+)$/.exec(rel);
        if (!m) return false;
        const parts = m[2].split("/");
        if (parts.length === 1) return true;
        if (parts.length === 2 && parts[1] === "main.rs") return true;
        return fileSet.has(prefix + `${m[1]}/${parts[0]}.rs`) || fileSet.has(prefix + `${m[1]}/${parts[0]}/main.rs`);
      };
      for (const f of all) {
        if (!f.startsWith(prefix) || owner(f) !== prefix) continue;
        const rel = f.slice(prefix.length);
        if (!compiled(rel)) continue;
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

  /**
   * Named imports from a package that the installed version does not export. Exports are read from
   * the package's type declarations (no code is executed). With --allow-exec, packages without
   * types are loaded with require() instead.
   */
  "js-import-exports": (ctx, params) => {
    const pkg = params.package;
    const hints = params.hints || {};
    const importRe = new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${escapeRe(pkg)}["']`, "g");
    const reqRe = new RegExp(`\\{([^}]*)\\}\\s*=\\s*(?:await\\s+import\\(|require\\()\\s*["']${escapeRe(pkg)}["']\\s*\\)`, "g");
    const cache = new Map();
    const hits = [];
    for (const f of ctx.files) {
      if (!/\.(m?[jt]sx?|c[jt]s)$/.test(f) || f.endsWith(".d.ts")) continue;
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
      const pkgDir = findPackageDir(ctx.root, f, pkg);
      if (!pkgDir) {
        ctx.skipped.push({ id: "F-007", reason: `${pkg} is not installed (no node_modules/${pkg} above ${f})` });
        continue;
      }
      if (!cache.has(pkgDir)) cache.set(pkgDir, packageExports(pkgDir, pkg, f, ctx));
      const info = cache.get(pkgDir);
      if (!info.names) {
        ctx.skipped.push({ id: "F-007", reason: `${pkg}: ${info.reason}` });
        continue;
      }
      const li = lineIndex(text);
      for (const { name, index } of found) {
        if (info.names.has(name)) continue;
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

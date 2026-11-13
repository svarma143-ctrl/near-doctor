import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  "target",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
]);

/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegex(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(re + "$");
}

/** Relative posix paths of all files under root, skipping heavy dirs and ignoreGlobs. */
export function walk(root, { ignoreGlobs = [], maxFiles = 20000 } = {}) {
  const ig = ignoreGlobs.map(globToRegex);
  const out = [];
  (function rec(dir, rel) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (out.length >= maxFiles) return;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(e.name)) continue;
        if (ig.some((x) => x.test(r) || x.test(r + "/"))) continue;
        rec(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        if (ig.some((x) => x.test(r))) continue;
        out.push(r);
      }
    }
  })(root, "");
  return out;
}

export function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

export function parseSemver(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function interpolate(template, vars) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (_, k) =>
    vars && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : "",
  );
}

/**
 * Command runner. `mock` maps "cmd arg arg" -> {code, stdout, stderr}. With mock.__strict,
 * unknown commands fail with 127 instead of touching the real machine (used by fixtures).
 */
export function makeRunner(mock) {
  return (cmd, args = [], opts = {}) => {
    const key = [cmd, ...args].join(" ");
    if (mock) {
      if (key in mock) {
        const m = mock[key];
        return { code: m.code ?? 0, stdout: m.stdout ?? "", stderr: m.stderr ?? "" };
      }
      if (mock.__strict) return { code: 127, stdout: "", stderr: `mock: ${key} not available` };
    }
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      cwd: opts.cwd,
      timeout: opts.timeout ?? 120000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) {
      return { code: r.error.code === "ENOENT" ? 127 : 1, stdout: "", stderr: String(r.error.message) };
    }
    return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
  };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

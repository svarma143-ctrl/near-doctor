import fs from "node:fs";
import path from "node:path";

/** Insert a crate-level inner attribute after leading comments/inner attributes. Idempotent. */
export function insertCrateAttr(src, attr, comment) {
  if (src.includes(attr)) return src;
  const lines = src.split("\n");
  let idx = 0;
  let last = -1;
  while (idx < lines.length) {
    const l = lines[idx].trim();
    if (l === "" || l.startsWith("//") || l.startsWith("#![")) {
      if (l !== "") last = idx;
      idx++;
      continue;
    }
    break;
  }
  const at = last + 1;
  const block = [];
  if (last >= 0) block.push("");
  block.push(`// ${comment}`, attr);
  if (at >= lines.length || lines[at].trim() !== "") block.push("");
  lines.splice(at, 0, ...block);
  return lines.join("\n");
}

/** Add `crate = "version"` under [dev-dependencies]. Idempotent. */
export function insertDevDep(src, crate, version) {
  if (new RegExp(`^\\s*${crate}\\s*[=.]`, "m").test(src)) return src;
  const lines = src.split("\n");
  const i = lines.findIndex((l) => l.trim() === "[dev-dependencies]");
  const entry = `${crate} = "${version}"`;
  if (i >= 0) {
    lines.splice(i + 1, 0, entry);
    return lines.join("\n");
  }
  return src.replace(/\n*$/, "\n") + `\n[dev-dependencies]\n${entry}\n`;
}

/**
 * Apply deterministic, allowlisted autofixes for the given findings.
 * Returns [{id, type, status: "applied"|"planned"|"failed"|"skipped", detail}].
 */
export function applyFixes(findings, { root, dryRun = false, runner }) {
  const results = [];
  const done = new Set();
  for (const f of findings) {
    const af = f._autofix;
    if (!af) continue;
    const targetFile = f.target?.file || f.file || "";
    const key = `${af.type}:${targetFile}:${af.crate || af.target || af.attr || ""}`;
    if (done.has(key)) continue;
    done.add(key);
    const rec = { id: f.id, type: af.type, file: targetFile || null };
    try {
      if (af.type === "rust-crate-attr" || af.type === "cargo-dev-dep") {
        const abs = path.join(root, targetFile);
        const before = fs.readFileSync(abs, "utf8");
        const after =
          af.type === "rust-crate-attr"
            ? insertCrateAttr(before, af.attr, af.comment || `near-doctor ${f.id}: ${af.description}`)
            : insertDevDep(before, af.crate, af.version);
        if (after === before) {
          results.push({ ...rec, status: "skipped", detail: "already applied" });
        } else if (dryRun) {
          results.push({ ...rec, status: "planned", detail: af.description });
        } else {
          fs.writeFileSync(abs, after);
          results.push({ ...rec, status: "applied", detail: af.description });
        }
      } else if (af.type === "rustup-target-add") {
        if (dryRun) {
          results.push({ ...rec, status: "planned", detail: `rustup target add ${af.target}` });
        } else {
          const r = runner("rustup", ["target", "add", af.target]);
          results.push({
            ...rec,
            status: r.code === 0 ? "applied" : "failed",
            detail: r.code === 0 ? `rustup target add ${af.target}` : (r.stderr || r.stdout).trim().split("\n").pop(),
          });
        }
      }
    } catch (e) {
      results.push({ ...rec, status: "failed", detail: e.message });
    }
  }
  return results;
}

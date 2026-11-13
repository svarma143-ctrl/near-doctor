import fs from "node:fs";
import path from "node:path";

/**
 * Minimal unified-diff applier (no `patch` binary needed). Supports modified files with context
 * hunks, which is all demo/agent-fixes.patch uses. Throws if a hunk's context does not match.
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  let hunk = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("--- ")) {
      cur = { from: line.slice(4).split("\t")[0].trim(), to: null, hunks: [] };
      files.push(cur);
      hunk = null;
    } else if (line.startsWith("+++ ") && cur && !cur.to) {
      cur.to = line.slice(4).split("\t")[0].trim();
    } else if (line.startsWith("@@") && cur) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Error(`bad hunk header: ${line}`);
      hunk = { oldStart: Number(m[1]), lines: [] };
      cur.hunks.push(hunk);
    } else if (hunk && (line[0] === " " || line[0] === "+" || line[0] === "-")) {
      hunk.lines.push({ op: line[0], text: line.slice(1) });
    } else if (hunk && line.startsWith("\\")) {
      continue; // "\ No newline at end of file"
    } else if (hunk && line === "") {
      // blank context line whose leading space was stripped by an editor, or end of patch
      hunk.lines.push({ op: " ", text: "", maybeEnd: true });
    }
  }
  for (const f of files) for (const h of f.hunks) while (h.lines.length && h.lines[h.lines.length - 1].maybeEnd) h.lines.pop();
  return files;
}

export function applyUnifiedDiff(patchText, root, { strip = 1 } = {}) {
  const changed = [];
  for (const f of parseUnifiedDiff(patchText)) {
    const rel = f.to.split("/").slice(strip).join("/");
    const target = path.join(root, rel);
    const src = fs.readFileSync(target, "utf8");
    const endsWithNewline = src.endsWith("\n");
    const lines = src.split("\n");
    if (endsWithNewline) lines.pop();
    let offset = 0;
    for (const h of f.hunks) {
      const oldLines = h.lines.filter((l) => l.op !== "+").map((l) => l.text);
      const newLines = h.lines.filter((l) => l.op !== "-").map((l) => l.text);
      const expected = h.oldStart - 1 + offset;
      let at = -1;
      for (let d = 0; d <= Math.abs(expected) + lines.length && at < 0; d++) {
        for (const i of d === 0 ? [expected] : [expected - d, expected + d]) {
          if (i >= 0 && i + oldLines.length <= lines.length && oldLines.every((t, k) => lines[i + k] === t)) {
            at = i;
            break;
          }
        }
      }
      if (at < 0) throw new Error(`hunk at line ${h.oldStart} of ${rel} does not match the file`);
      lines.splice(at, oldLines.length, ...newLines);
      offset += newLines.length - oldLines.length;
    }
    fs.writeFileSync(target, lines.join("\n") + (endsWithNewline ? "\n" : ""));
    changed.push(rel);
  }
  return changed;
}

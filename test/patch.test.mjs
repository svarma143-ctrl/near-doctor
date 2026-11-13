import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyUnifiedDiff, parseUnifiedDiff } from "../src/patch.mjs";
import { ROOT } from "./_helpers.mjs";

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "nd-p-"));

test("applies the shipped agent patch to a copy of the broken contract (no `patch` binary)", () => {
  const dir = tmp();
  fs.cpSync(path.join(ROOT, "demo", "broken-contract"), dir, { recursive: true });
  const changed = applyUnifiedDiff(fs.readFileSync(path.join(ROOT, "demo", "agent-fixes.patch"), "utf8"), dir);
  assert.deepEqual(changed.sort(), ["scripts/deploy.sh", "src/lib.rs"]);
  const lib = fs.readFileSync(path.join(dir, "src/lib.rs"), "utf8");
  assert.match(lib, /fn compute_amount_owed\(/);
  assert.match(lib, /pub fn amount_owed\(&self/); // the #[near] method keeps its name
  assert.match(fs.readFileSync(path.join(dir, "scripts/deploy.sh"), "utf8"), /near create-account/);
});

test("handles line offsets, trailing newline and refuses mismatched context", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\ny\nz\n");
  const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -50,2 +50,2 @@\n y\n-z\n+Z\n";
  assert.deepEqual(applyUnifiedDiff(patch, dir), ["a.txt"]); // hunk header is wrong; context search finds it
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "x\ny\nZ\n");
  assert.throws(() => applyUnifiedDiff("--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-nope\n+yes\n", dir), /does not match/);
  assert.equal(parseUnifiedDiff(patch)[0].hunks[0].lines.length, 3);
});

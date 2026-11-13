import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./_helpers.mjs";

// Real toolchain end to end (needs cargo + cargo-near; a few minutes cold). Run: npm run test:slow
test("scripts/demo.mjs: broken contract to clean, verified by the real toolchain", { skip: !process.env.NEAR_DOCTOR_SLOW, timeout: 900000 }, () => {
  const r = spawnSync("node", [path.join(ROOT, "scripts", "demo.mjs")], { encoding: "utf8", timeout: 900000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /DEMO OK/);
  assert.match(r.stdout, /cargo near check: ok/);
  assert.match(r.stdout, /cargo test: ok/);
});

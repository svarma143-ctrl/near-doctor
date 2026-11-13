// One-command demo. Replays the whole flow on a temporary copy of demo/broken-contract with the REAL
// toolchain (no mocks):
//   1. near-doctor finds four problems
//   2. near-doctor fix --safe applies the two deterministic fixes
//   3. the two judgement fixes are applied from demo/agent-fixes.patch (the edits a coding agent made
//      from `near-doctor --json`; stored as a patch so the demo is reproducible)
//   4. near-doctor is clean; cargo near check and cargo test pass
// Usage: node scripts/demo.mjs [--keep] [--no-cargo]   (needs Node 20+ only; steps 4b/4c also use cargo + cargo-near when present)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyUnifiedDiff } from "../src/patch.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "near-doctor.mjs");
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "near-doctor-demo-"));
fs.cpSync(path.join(root, "demo", "broken-contract"), work, { recursive: true });

let failed = false;
let realChecks = false;
const say = (s) => console.log(s);
const step = (s) => say(`\n=== ${s}`);
function run(cmd, args, { cwd = work, expect = 0, show = true } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 600000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.error) say(`!! could not run ${cmd}: ${r.error.message}`);
  const ok = r.status === expect;
  if (show) say(out.trimEnd());
  if (!ok) {
    failed = true;
    say(`!! expected exit ${expect}, got ${r.status}`);
  }
  return { ...r, out, ok };
}
// The command comes first: `near-doctor fix <path> --safe`, `near-doctor <path>` for a plain check.
const doctor = (args, o) => {
  const cmd = args[0] && !args[0].startsWith("-") ? [args.shift()] : [];
  return run("node", [bin, ...cmd, work, ...args], o);
};
const hasCmd = (c, a) => spawnSync(c, a, { encoding: "utf8" }).status === 0;

step("1. near-doctor on the broken contract (exit 1: errors found)");
const first = doctor(["--ignore", "F-010", "--json"], { expect: 1, show: false });
const ids = JSON.parse(first.out).findings.map((f) => f.id);
say(`found: ${ids.join(", ")}`);
for (const id of ["F-001", "F-004", "F-008", "F-012"]) if (!ids.includes(id)) { failed = true; say(`!! missing ${id}`); }

step("2. near-doctor fix --safe (deterministic fixes only)");
doctor(["fix", "--safe", "--ignore", "F-010"], { expect: 1 });

step("3. judgement fixes: apply the agent's edits (demo/agent-fixes.patch, applied in pure Node)");
try {
  const changed = applyUnifiedDiff(fs.readFileSync(path.join(root, "demo", "agent-fixes.patch"), "utf8"), work);
  say(`patched: ${changed.join(", ")}`);
} catch (e) {
  failed = true;
  say(`!! ${e.message}`);
}

step("4a. near-doctor again (expect clean, exit 0)");
doctor(["--ignore", "F-010"]);

if (!process.argv.includes("--no-cargo") && hasCmd("cargo", ["near", "--version"])) {
  step("4b. cargo near check (real)");
  realChecks = true;
  run("cargo", ["near", "check"], { show: false }).ok && say("cargo near check: ok");
  step("4c. cargo test (real)");
  run("cargo", ["test"], { show: false }).ok && say("cargo test: ok");
} else say("\n(real cargo checks skipped: --no-cargo, or cargo-near is not installed; near-doctor reports E-001 for the latter)");

say(
  failed
    ? "\nDEMO FAILED"
    : `\nDEMO OK: broken contract -> findings -> safe fixes -> agent edits -> clean${realChecks ? ", and the real toolchain (cargo near check, cargo test) agrees" : " (real cargo checks skipped: cargo-near not installed)"}`,
);
if (process.argv.includes("--keep")) say(`kept: ${work}`);
else fs.rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

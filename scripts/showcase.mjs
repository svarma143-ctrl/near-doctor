// A paced, real run of the near-doctor workflow, made for screen recording (about a minute).
// Every command shown is executed for real, in a temporary copy of demo/broken-contract.
//
//   node scripts/showcase.mjs            paced, for recording
//   node scripts/showcase.mjs --fast     no delays (used to test the script)
//
// If `near-doctor` is on your PATH (npm i -g near-doctor) that binary is used; otherwise a shim to this
// checkout is put on PATH for the run. Steps that need cargo-near are skipped when it is not installed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyUnifiedDiff } from "../src/patch.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fast = process.argv.includes("--fast");
const tty = process.stdout.isTTY && !fast;
const sleep = (ms) => (fast ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s);

const tmp = process.env.TMPDIR || os.tmpdir();
// A short path keeps the recording readable (near-doctor prints the project path).
const work = fs.mkdtempSync(path.join(fs.existsSync("/tmp") ? "/tmp" : tmp, "tipjar-"));
fs.cpSync(path.join(root, "demo", "broken-contract"), work, { recursive: true, filter: (s) => !s.includes(`${path.sep}target`) });

// Put a `near-doctor` on PATH: the installed one if present, else a shim to this checkout.
const bin = fs.mkdtempSync(path.join(tmp, "near-doctor-bin-"));
const have = spawnSync("sh", ["-c", "command -v near-doctor"], { encoding: "utf8" }).stdout.trim();
const using = have || "this checkout (shim)";
if (!have) {
  const shim = path.join(bin, "near-doctor");
  fs.writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(path.join(root, "bin", "near-doctor.mjs"))} "$@"\n`);
  fs.chmodSync(shim, 0o755);
}
const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...(tty ? {} : { NO_COLOR: "1" }) };
const cargoNear = spawnSync("sh", ["-c", "cargo near --version"], { encoding: "utf8", env }).status === 0;

async function type(text) {
  process.stdout.write(bold("$ "));
  for (const ch of text) {
    process.stdout.write(ch);
    await sleep(28);
  }
  process.stdout.write("\n");
}
// Start a new scene: clear the screen so each step is fully visible (real terminal only).
const scene = () => {
  if (tty) process.stdout.write("\x1bc");
};
const say = async (text, ms = 1600) => {
  console.log(dim(`# ${text}`));
  await sleep(ms);
};
// `hidden` is prepended when executing but not displayed; it is only used for `set -o pipefail`, so a failing
// command before a pipe still fails the run.
async function run(cmd, { pause = 2600, hidden = "" } = {}) {
  await type(cmd);
  await sleep(350);
  const r = spawnSync("sh", ["-c", hidden + cmd], { cwd: work, env, stdio: "inherit" });
  console.log();
  await sleep(pause);
  return r.status;
}

let failed = false;
const expect = (label, got, want) => {
  if (got !== want) {
    failed = true;
    console.log(`!! ${label}: expected exit ${want}, got ${got}`);
  }
};

if (tty) process.stdout.write("\x1bc");
console.log(bold("near-doctor: preflight checks for NEAR projects"));
console.log(dim(`(running ${using}; working in a temporary copy of demo/broken-contract at ${work})\n`));
await sleep(2200);

await say("A small tip-jar contract. The unit tests pass, but it has four problems.");
expect("scan", await run("near-doctor --ignore F-010", { pause: 4500 }), 1);

scene();
await say("Two of them are deterministic. near-doctor fixes those itself:");
expect("fix", await run("near-doctor fix --safe --ignore F-010", { pause: 3500 }), 1);

scene();
await say("The other two need judgement. --json hands each one to a coding agent as a task plus a check.");
await say("Here the agent's edits are applied from demo/agent-fixes.patch:", 1200);
try {
  const changed = applyUnifiedDiff(fs.readFileSync(path.join(root, "demo", "agent-fixes.patch"), "utf8"), work);
  console.log(green(`patched: ${changed.join(", ")}\n`));
} catch (e) {
  failed = true;
  console.log(`!! ${e.message}`);
}
await sleep(2200);

await say("Same command again:");
expect("rescan", await run("near-doctor --ignore F-010", { pause: 2600 }), 0);

if (cargoNear) {
  await say("And the real toolchain agrees:");
  expect("cargo near check", await run("cargo near check >/dev/null 2>&1 && echo \"cargo near check: passed\"", { pause: 2600 }), 0);
} else {
  await say("(cargo-near is not installed here, so the real `cargo near check` step is skipped)", 2000);
}

scene();
await say("Every rule has evidence behind it: what was reproduced, where, and on which versions.");
expect("show", await run("near-doctor show F-001", { pause: 5000 }), 0);

console.log(bold("npx near-doctor") + dim("   |   github.com/svarma143-ctrl/near-doctor"));
await sleep(3000);

fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(bin, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

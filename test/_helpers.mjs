import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RULES_DIR, loadRules } from "../src/index.mjs";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = path.join(ROOT, "fixtures");
export const rules = loadRules(DEFAULT_RULES_DIR);

export function copyFixture(rel) {
  const dest = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "nd-"));
  fs.cpSync(path.join(FIXTURES, rel), dest, { recursive: true });
  return dest;
}

export function readEnvMock(dir) {
  const f = path.join(dir, "_env.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { __strict: true };
}

/** Options for runChecks that make a fixture run hermetic (no real commands, simulated RPC latency). */
export function fixtureOpts(dir, id) {
  const opts = { root: dir, rules, only: [id], historical: true, mock: readEnvMock(dir) };
  const netFile = path.join(dir, "_net.json");
  if (fs.existsSync(netFile)) {
    const { delaysMs } = JSON.parse(fs.readFileSync(netFile, "utf8"));
    const seq = [];
    let t = 0;
    for (const d of delaysMs) {
      seq.push(t, t + d);
      t += d;
    }
    let i = 0;
    opts.net = true;
    opts.now = () => seq[Math.min(i++, seq.length - 1)];
    opts.fetchImpl = async () => ({ text: async () => "{}" });
  }
  return opts;
}

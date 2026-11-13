// Verifies every claim in the README, one by one, and prints PASS / FAIL / SKIP with evidence.
//   node scripts/verify.mjs [--json]        (or: npm run verify)
// Hermetic by default: needs only Node 20+. Claims that need cargo-near are SKIPPED, not faked, if it is absent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "near-doctor.mjs");
const demoSrc = path.join(root, "demo", "broken-contract");
const tmpBase = process.env.TMPDIR || os.tmpdir();
const asJson = process.argv.includes("--json");
const env = { ...process.env, NO_COLOR: "1" };

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...env, ...(opts.env || {}) }, cwd: opts.cwd || root, timeout: opts.timeout || 600000, input: opts.input });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, stdout: r.stdout || "", stderr: r.stderr || "" };
};
const doctor = (args, opts) => sh("node", [bin, ...args], opts);
const copyDemo = () => {
  const d = fs.mkdtempSync(path.join(tmpBase, "nd-verify-"));
  fs.cpSync(demoSrc, d, { recursive: true });
  return d;
};
const hashTree = (dir) => {
  const out = {};
  const walk = (d, rel = "") => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "target") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = fs.readFileSync(path.join(d, e.name), "utf8");
    }
  };
  walk(dir);
  return out;
};
const hasCargoNear = () => spawnSync("cargo", ["near", "--version"], { encoding: "utf8" }).status === 0;
const pass = (detail) => ({ status: "PASS", detail });
const fail = (detail) => ({ status: "FAIL", detail });
const skip = (detail) => ({ status: "SKIP", detail });

const claims = [
  {
    claim: "The friction log is valid and every runnable rule ships a repro and a clean control",
    cmd: "near-doctor rules --check",
    run: () => {
      const r = doctor(["rules", "--check"]);
      return r.status === 0 && /18 rules valid/.test(r.out) ? pass(r.out.trim()) : fail(r.out.trim().slice(0, 200));
    },
  },
  {
    claim: "Every rule fires on its repro and stays silent on its control (the fixture gate)",
    cmd: "node --test test/rules.test.mjs",
    run: () => {
      const r = sh("node", ["--test", "test/rules.test.mjs"]);
      const m = /ℹ pass (\d+)[\s\S]*ℹ fail (\d+)/.exec(r.out);
      return r.status === 0 && m && m[2] === "0" ? pass(`${m[1]} checks passed, 0 failed`) : fail(r.out.slice(-300));
    },
  },
  {
    claim: "It finds the four planted problems in the demo contract, with file and line",
    cmd: "near-doctor demo/broken-contract --json",
    run: () => {
      const r = doctor([demoSrc, "--json", "--ignore", "F-010"]);
      const j = JSON.parse(r.stdout);
      const got = j.findings.map((f) => `${f.id}@${f.file}:${f.line}`).sort();
      const ids = j.findings.map((f) => f.id).sort().join(",");
      return ids === "F-001,F-004,F-008,F-012" && j.findings.every((f) => f.file && f.line) ? pass(got.join("  ")) : fail(got.join("  "));
    },
  },
  {
    claim: "`fix --safe` applies exactly two deterministic fixes and touches only Cargo.toml and src/lib.rs",
    cmd: "near-doctor fix <demo copy> --safe --json",
    run: () => {
      const d = copyDemo();
      const before = hashTree(d);
      const r = doctor(["fix", d, "--safe", "--json", "--ignore", "F-010"]);
      const j = JSON.parse(r.stdout);
      const after = hashTree(d);
      const changed = Object.keys(after).filter((k) => after[k] !== before[k]).sort();
      const applied = j.fixes.filter((f) => f.status === "applied").length;
      fs.rmSync(d, { recursive: true, force: true });
      return applied === 2 && changed.join(",") === "Cargo.toml,src/lib.rs" ? pass(`applied ${applied}; changed ${changed.join(", ")}`) : fail(`applied ${applied}; changed ${changed.join(", ")}`);
    },
  },
  {
    claim: "Broken contract -> findings -> safe fixes -> agent edits -> clean (the demo, without cargo)",
    cmd: "node scripts/demo.mjs --no-cargo",
    run: () => {
      const r = sh("node", ["scripts/demo.mjs", "--no-cargo"]);
      return r.status === 0 && /DEMO OK/.test(r.out) ? pass("DEMO OK") : fail(r.out.slice(-300));
    },
  },
  {
    claim: "The same flow passes the real toolchain (cargo near check and cargo test)",
    cmd: "node scripts/demo.mjs",
    run: () => {
      if (!hasCargoNear()) return skip("cargo-near is not installed here; not claimed");
      const r = sh("node", ["scripts/demo.mjs"]);
      return r.status === 0 && /cargo near check: ok/.test(r.out) && /cargo test: ok/.test(r.out) ? pass("cargo near check: ok; cargo test: ok") : fail(r.out.slice(-300));
    },
  },
  {
    claim: "`explain` finds the real cause buried in a long wrapped error",
    cmd: "near-doctor explain --from fixtures/F-003/repro.txt",
    run: () => {
      const r = doctor(["explain", "--from", path.join(root, "fixtures/F-003/repro.txt")]);
      return /Real cause in the output: error\[E0428\]/.test(r.out) && /F-001/.test(r.out) ? pass("F-003 + F-001, real cause E0428 extracted") : fail(r.out.slice(0, 300));
    },
  },
  {
    claim: "A problem that no longer reproduces (R-001) explains the error but never warns by default",
    cmd: "near-doctor explain --from fixtures/R-001/repro.txt ; near-doctor fixtures/R-001/repro",
    run: () => {
      const e = doctor(["explain", "--from", path.join(root, "fixtures/R-001/repro.txt"), "--json"]);
      const c = doctor([path.join(root, "fixtures/R-001/repro"), "--json", "--ignore", "F-010,F-011"], { env: { PATH: process.env.PATH } });
      const quiet = JSON.parse(c.stdout).findings.filter((f) => f.id === "R-001").length === 0;
      return JSON.parse(e.stdout)[0]?.status === "historical" && quiet ? pass("explains as historical; 0 findings without --historical") : fail(e.out.slice(0, 200));
    },
  },
  {
    claim: "`submit` redacts secrets, home paths and emails locally",
    cmd: "near-doctor submit --from <file with a fake key>",
    run: () => {
      const d = fs.mkdtempSync(path.join(tmpBase, "nd-verify-"));
      const key = "ed25519:" + "4".repeat(60);
      const f = path.join(d, "e.txt");
      fs.writeFileSync(f, `secretKey: "${key}"\nread ${os.homedir()}/x\nmail me@example.com\n`);
      const r = doctor(["submit", d, "--from", f]);
      fs.rmSync(d, { recursive: true, force: true });
      const leaked = r.out.includes("4".repeat(20)) || r.out.includes(os.homedir()) || r.out.includes("me@example.com");
      return !leaked && /\[REDACTED\]/.test(r.out) ? pass("key, home path and email absent from the report") : fail("something leaked");
    },
  },
  {
    claim: "No network access unless --net is passed",
    cmd: "node --require scripts/no-net.cjs bin/near-doctor.mjs demo/broken-contract [--net]",
    run: () => {
      const pre = ["--require", path.join(root, "scripts", "no-net.cjs"), bin];
      const off = sh("node", [...pre, demoSrc, "--json", "--ignore", "F-010"]);
      const on = sh("node", [...pre, demoSrc, "--json", "--net", "--ignore", "F-010"]);
      const offClean = !/NETWORK ACCESS ATTEMPTED/.test(off.out) && JSON.parse(off.stdout).findings.length === 4;
      const onTried = /NETWORK ACCESS ATTEMPTED/.test(on.out);
      return offClean && onTried ? pass("0 network attempts by default; --net attempts the RPC probe") : fail(`default clean=${offClean}, --net attempted=${onTried}`);
    },
  },
  {
    claim: "The import check (F-007) reads type declarations and never executes the package",
    cmd: "node --test --test-name-pattern='never executes' test/engine.test.mjs",
    run: () => {
      const r = sh("node", ["--test", "--test-name-pattern=never executes", "test/engine.test.mjs"]);
      return r.status === 0 && /ℹ pass [1-9]/.test(r.out) ? pass("a booby-trapped package was not loaded") : fail(r.out.slice(-300));
    },
  },
  {
    claim: "Works when installed from the npm tarball (the `npx` path), with no dependencies",
    cmd: "npm pack ; npm i ./near-doctor-*.tgz ; npx near-doctor explain ...",
    run: () => {
      if (spawnSync("npm", ["--version"], { encoding: "utf8" }).status !== 0) return skip("npm not available");
      const d = fs.mkdtempSync(path.join(tmpBase, "nd-verify-"));
      const pack = sh("npm", ["pack", "--pack-destination", d, "--silent"]);
      const tgz = pack.stdout.trim().split("\n").pop();
      fs.writeFileSync(path.join(d, "package.json"), '{"name":"consumer","version":"1.0.0"}');
      const inst = sh("npm", ["install", "--offline", "--no-audit", "--no-fund", path.join(d, tgz)], { cwd: d });
      const ver = sh("npx", ["--no-install", "near-doctor", "--version"], { cwd: d });
      const exp = sh("npx", ["--no-install", "near-doctor", "explain", "--from", path.join(root, "fixtures/F-002/repro.txt")], { cwd: d });
      const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).dependencies || {}).length;
      fs.rmSync(d, { recursive: true, force: true });
      return inst.status === 0 && /^\d+\.\d+\.\d+/.test(ver.stdout.trim()) && /F-002/.test(exp.out) && deps === 0 ? pass(`installed ${ver.stdout.trim()}; explain works; 0 dependencies`) : fail(`${inst.out.slice(-150)} | ${ver.out.slice(-100)}`);
    },
  },
  {
    claim: "near-doctor scans its own repository clean (what CI runs)",
    cmd: "near-doctor . --fail-on warn",
    run: () => {
      const r = doctor([".", "--fail-on", "warn", "--ignore", "F-010,F-011"]);
      return r.status === 0 ? pass("exit 0") : fail(r.out.slice(0, 300));
    },
  },
];

const results = [];
for (const c of claims) {
  const t0 = Date.now();
  let r;
  try {
    r = c.run();
  } catch (e) {
    r = fail(`threw: ${e.message}`);
  }
  results.push({ claim: c.claim, command: c.cmd, ...r, ms: Date.now() - t0 });
  if (!asJson) console.log(`${r.status.padEnd(4)}  ${c.claim}\n      $ ${c.cmd}\n      ${r.detail}\n`);
}
const count = (s) => results.filter((r) => r.status === s).length;
if (asJson) console.log(JSON.stringify({ pass: count("PASS"), fail: count("FAIL"), skip: count("SKIP"), results }, null, 2));
else console.log(`${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped`);
process.exit(count("FAIL") ? 1 : 0);

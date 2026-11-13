import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERSION } from "../src/index.mjs";
import { main } from "../src/cli.mjs";
import { FIXTURES, copyFixture } from "./_helpers.mjs";

async function run(args, io = {}) {
  let out = "";
  let err = "";
  const code = await main(args, { out: (s) => (out += s), err: (s) => (err += s), mock: { __strict: true }, isTTY: false, ...io });
  return { code, out, err };
}

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "nd-c-"));

test("check: reports a finding with file:line and exits 1 on errors", async () => {
  const r = await run([path.join(FIXTURES, "F-001/repro"), "--only", "F-001"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /ERROR\s+F-001/);
  assert.match(r.out, /src\/lib\.rs:\d+/);
  assert.match(r.out, /Evidence: verified-here/);
});

test("check: clean control prints the all-clear and exits 0", async () => {
  const r = await run([path.join(FIXTURES, "F-001/control"), "--only", "F-001"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /No known friction found/);
});

test("--json is machine readable and agent-ready", async () => {
  const r = await run([path.join(FIXTURES, "F-004/repro"), "--only", "F-004", "--json"]);
  const j = JSON.parse(r.out);
  assert.equal(j.tool, "near-doctor");
  assert.equal(j.version, VERSION);
  assert.equal(j.findings[0].id, "F-004");
  assert.equal(j.findings[0].fix.autofix.type, "rust-crate-attr");
  assert.equal(j.findings[0].agent.acceptance.command, "near-doctor --only F-004 --json");
  assert.ok(!("_autofix" in j.findings[0]));
});

test("--fail-on controls the exit code", async () => {
  const dir = path.join(FIXTURES, "F-004/repro");
  assert.equal((await run([dir, "--only", "F-004"])).code, 0); // warn only
  assert.equal((await run([dir, "--only", "F-004", "--fail-on", "warn"])).code, 1);
  assert.equal((await run([path.join(FIXTURES, "F-001/repro"), "--only", "F-001", "--fail-on", "never"])).code, 0);
  assert.equal((await run([dir, "--fail-on", "sometimes"])).code, 2);
});

test("explain: known error gets cause, real error line and fix; unknown gets exit 1", async () => {
  const text = fs.readFileSync(path.join(FIXTURES, "F-003/repro.txt"), "utf8");
  const r = await run(["explain", "--from", "-"], { stdinText: text });
  assert.equal(r.code, 0);
  assert.match(r.out, /F-003/);
  assert.match(r.out, /F-001/);
  assert.match(r.out, /Real cause in the output: error\[E0428\]/);
  const none = await run(["explain", "--from", "-"], { stdinText: "all good here" });
  assert.equal(none.code, 1);
  assert.match(none.out, /No known match/);
  assert.equal((await run(["explain"])).code, 2);
});

test("explain: historical rule answers honestly instead of warning", async () => {
  const text = fs.readFileSync(path.join(FIXTURES, "R-001/repro.txt"), "utf8");
  const r = await run(["explain", "--from", "-", "--json"], { stdinText: text });
  const j = JSON.parse(r.out);
  assert.equal(j[0].id, "R-001");
  assert.equal(j[0].status, "historical");
  assert.match(j[0].why, /could not reproduce/);
});

test("fix requires --safe; --dry-run changes nothing; --safe fixes and re-checks clean", async () => {
  const dir = copyFixture("F-004/repro");
  const file = path.join(dir, "src/lib.rs");
  const before = fs.readFileSync(file, "utf8");
  assert.equal((await run(["fix", dir])).code, 2);
  const dry = await run(["fix", dir, "--safe", "--dry-run", "--only", "F-004"]);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /PLANNED/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  const real = await run(["fix", dir, "--safe", "--only", "F-004"]);
  assert.equal(real.code, 0);
  assert.match(real.out, /APPLIED/);
  assert.match(real.out, /No known friction found/);
  assert.match(fs.readFileSync(file, "utf8"), /#!\[allow\(clippy::too_many_arguments\)\]/);
});

test("fix --json lists fixes and what remains", async () => {
  const dir = copyFixture("F-012/repro");
  const r = await run(["fix", dir, "--safe", "--only", "F-012", "--json"]);
  const j = JSON.parse(r.out);
  assert.equal(j.fixes[0].status, "applied");
  assert.deepEqual(j.remaining, []);
  assert.match(fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8"), /\[dev-dependencies\]\nanyhow = "1"/);
});

test("usage errors, help and version", async () => {
  assert.equal((await run(["--nope"])).code, 2);
  assert.equal((await run(["--only"])).code, 2);
  const h = await run(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.out, /Usage/);
  assert.match(h.out, /never sends data anywhere unless you pass --net/);
  assert.equal((await run(["--version"])).out.trim(), VERSION);
});

test("rules: list, markdown, json and --check", async () => {
  const list = await run(["rules"]);
  assert.match(list.out, /F-001\s+active\s+verified-here/);
  assert.match((await run(["rules", "--markdown"])).out, /^# NEAR friction log/);
  assert.equal(JSON.parse((await run(["rules", "--json"])).out).length, 18);
  const chk = await run(["rules", "--check"], { fixturesDir: FIXTURES });
  assert.equal(chk.code, 0);
  assert.match(chk.out, /18 rules valid/);
});

test("a broken rule pack is rejected with exit 2", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "F-001.json"), JSON.stringify({ id: "F-001", title: "x" }));
  const r = await run([".", "--rules", dir]);
  assert.equal(r.code, 2);
  assert.match(r.err, /invalid/);
});

test("submit redacts secrets, home paths and emails; keeps public data", async () => {
  const dir = tmp();
  const secret = "ed25519:" + "3".repeat(44);
  const errFile = path.join(dir, "err.txt");
  fs.writeFileSync(
    errFile,
    [
      `secretKey: "${secret}"`,
      `loaded ${os.homedir()}/project/.near-credentials/testnet/a.json`,
      "Authorization: Bearer abcdefghijklmnop1234",
      "contact me at dev@example.com",
      "tx 5wQgycq3qknFDpH2VHcmHDJ6JVEXrZ6Ba6PiAZBRXSXW on nearintentfi-vc5f37.testnet failed",
    ].join("\n"),
  );
  const r = await run(["submit", dir, "--from", errFile, "--command", `near call x y --privateKey ${secret}`]);
  assert.equal(r.code, 0);
  assert.ok(!r.out.includes("3".repeat(20)), "key body leaked");
  assert.ok(!r.out.includes(os.homedir()), "home path leaked");
  assert.ok(!r.out.includes("dev@example.com"), "email leaked");
  assert.ok(!r.out.includes("abcdefghijklmnop1234"), "bearer leaked");
  assert.match(r.out, /5wQgycq3qknFDpH2VHcmHDJ6JVEXrZ6Ba6PiAZBRXSXW/);
  assert.match(r.out, /nearintentfi-vc5f37\.testnet/);
  assert.match(r.out, /### Error output/);
  assert.match(r.out, /### Environment/);
});

test("inspect reads wasm target features", async () => {
  const feat = (p, n) => Buffer.concat([Buffer.from([p, n.length]), Buffer.from(n)]);
  const payload = Buffer.concat([Buffer.from([2]), feat(0x2b, "bulk-memory"), feat(0x2b, "mutable-globals")]);
  const name = Buffer.from("target_features");
  const body = Buffer.concat([Buffer.from([name.length]), name, payload]);
  const wasm = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.from([0, body.length]), body]);
  const f = path.join(tmp(), "a.wasm");
  fs.writeFileSync(f, wasm);
  const r = await run(["inspect", f, "--json"]);
  const j = JSON.parse(r.out);
  assert.deepEqual(j.targetFeatures.enabled, ["bulk-memory", "mutable-globals"]);
  assert.deepEqual(j.postMvp, ["bulk-memory"]);
  const bad = path.join(tmp(), "b.wasm");
  fs.writeFileSync(bad, "not wasm");
  assert.equal((await run(["inspect", bad])).code, 2);
});

test("misplaced or extra arguments are rejected instead of silently ignored", async () => {
  const dir = copyFixture("F-004/repro");
  const wrong = await run([dir, "fix", "--safe"]);
  assert.equal(wrong.code, 2);
  assert.match(wrong.err, /did you mean `near-doctor fix <path>`/);
  assert.ok(!fs.readFileSync(path.join(dir, "src/lib.rs"), "utf8").includes("allow(clippy"), "must not modify files");
  const extra = await run([dir, "another-dir"]);
  assert.equal(extra.code, 2);
  assert.match(extra.err, /unexpected argument "another-dir"/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyFixes, matchSymptoms, runChecks, validateRule, validateRules } from "../src/index.mjs";
import { makeRunner } from "../src/util.mjs";
import { FIXTURES, copyFixture, fixtureOpts, readEnvMock, rules } from "./_helpers.mjs";

test("rule pack is valid and every runnable rule has its fixtures", () => {
  assert.deepEqual(validateRules(rules, { fixturesDir: FIXTURES }), []);
  assert.equal(rules.length, 18);
});

// ---------------------------------------------------------------------------
// The verification gate: every rule fires on its repro and stays silent on its control.
// ---------------------------------------------------------------------------
for (const rule of rules) {
  if (rule.detect) {
    test(`${rule.id} scan: fires on repro, silent on control`, async () => {
      const repro = await runChecks(fixtureOpts(path.join(FIXTURES, rule.id, "repro"), rule.id));
      const control = await runChecks(fixtureOpts(path.join(FIXTURES, rule.id, "control"), rule.id));
      assert.ok(repro.findings.some((f) => f.id === rule.id), `${rule.id} did not fire on repro; skipped=${JSON.stringify(repro.skipped)}`);
      assert.equal(control.findings.filter((f) => f.id === rule.id).length, 0, `${rule.id} fired on the control`);
    });
  }
  if (rule.symptoms) {
    test(`${rule.id} explain: matches repro.txt, not control.txt`, () => {
      const repro = fs.readFileSync(path.join(FIXTURES, rule.id, "repro.txt"), "utf8");
      const control = fs.readFileSync(path.join(FIXTURES, rule.id, "control.txt"), "utf8");
      assert.ok(matchSymptoms(repro, rules).some((m) => m.rule.id === rule.id));
      assert.ok(!matchSymptoms(control, rules).some((m) => m.rule.id === rule.id));
    });
  }
}

// ---------------------------------------------------------------------------
// Fix gate: applying the autofix to the repro makes the finding disappear.
// ---------------------------------------------------------------------------
for (const rule of rules.filter((r) => r.detect && r.fix?.autofix && r.fix.autofix.type !== "rustup-target-add")) {
  test(`${rule.id} autofix turns the repro green`, async () => {
    const dir = copyFixture(`${rule.id}/repro`);
    const opts = fixtureOpts(dir, rule.id);
    const before = await runChecks(opts);
    assert.ok(before.findings.length > 0);
    const results = applyFixes(before.findings, { root: before.root, runner: makeRunner(readEnvMock(dir)) });
    assert.ok(results.some((r) => r.status === "applied"), JSON.stringify(results));
    const after = await runChecks(opts);
    assert.equal(after.findings.filter((f) => f.id === rule.id).length, 0);
    // idempotent
    const again = applyFixes((await runChecks(opts)).findings, { root: dir, runner: makeRunner() });
    assert.deepEqual(again, []);
  });
}

test("E-002 autofix runs only the allowlisted rustup command", async () => {
  const dir = copyFixture("E-002/repro");
  const calls = [];
  const mock = readEnvMock(dir);
  const runner = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    return makeRunner(mock)(cmd, args);
  };
  const res = await runChecks({ ...fixtureOpts(dir, "E-002"), runner });
  const results = applyFixes(res.findings, { root: dir, runner });
  assert.equal(results[0].status, "applied");
  assert.ok(calls.includes("rustup target add wasm32-unknown-unknown"));
  const dry = applyFixes(res.findings, { root: dir, runner, dryRun: true });
  assert.equal(dry[0].status, "planned");
});

// ---------------------------------------------------------------------------
// Schema guards: rules stay data-only and honest about evidence.
// ---------------------------------------------------------------------------
const good = () => JSON.parse(JSON.stringify(rules.find((r) => r.id === "F-008")));

test("validator rejects shell-like keys, unknown detectors and bad regexes", () => {
  const a = good();
  a.fix.command = "rm -rf /";
  assert.ok(validateRule(a).some((e) => /data-only/.test(e)));
  const b = good();
  b.detect = { kind: "detector", name: "does-not-exist" };
  assert.ok(validateRule(b).some((e) => /unknown detector/.test(e)));
  const c = good();
  c.detect.any = ["("];
  assert.ok(validateRule(c).some((e) => /invalid regex/.test(e)));
  const d = good();
  d.detect.flags = "g";
  assert.ok(validateRule(d).some((e) => /stateful/.test(e)));
});

test("validator enforces evidence tiers", () => {
  const a = good();
  a.tier = "hypothesis";
  a.severity = "warn";
  assert.ok(validateRule(a).some((e) => /must not warn/.test(e)));
  const b = good();
  delete b.evidence;
  assert.ok(validateRule(b).some((e) => /evidence.observed/.test(e)));
  const c = JSON.parse(JSON.stringify(rules.find((r) => r.id === "R-001")));
  delete c.evidence;
  assert.ok(validateRule(c).some((e) => /reproduction/.test(e)));
  const d = good();
  d.fix.autofix = { type: "shell", description: "x" };
  assert.ok(validateRule(d).some((e) => /autofix.type/.test(e)));
});

test("historical rules stay quiet unless asked", async () => {
  const dir = path.join(FIXTURES, "R-001", "repro");
  const quiet = await runChecks({ ...fixtureOpts(dir, "R-001"), historical: false });
  assert.equal(quiet.findings.length, 0);
  const loud = await runChecks(fixtureOpts(dir, "R-001"));
  assert.equal(loud.findings.length, 1);
});

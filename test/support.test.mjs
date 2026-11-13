import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { matchSymptoms, redact } from "../src/index.mjs";
import { DEFAULT_RULES_DIR, loadRules, validateRule } from "../src/index.mjs";
import { rulesMarkdown } from "../src/report.mjs";
import { nextRuleId, parseIssueBody, triage } from "../scripts/triage.mjs";
import { ROOT, rules } from "./_helpers.mjs";

test("redact: keys, tokens, paths, emails; keeps public identifiers", () => {
  const home = os.homedir();
  const out = redact(
    [
      `"secret_key": "ed25519:${"5".repeat(60)}"`,
      `export TOKEN=abc123`,
      `password = hunter2`,
      "Bearer abcdefghijklmnop",
      "ghp_" + "a".repeat(30),
      "sk-" + "b".repeat(24),
      "seed: " + "A".repeat(43) + "=",
      `${home}/work/near`,
      "/Users/someoneelse/x",
      "me@example.org",
      "account alice.testnet tx 5wQgycq3qknFDpH2VHcmHDJ6JVEXrZ6Ba6PiAZBRXSXW",
    ].join("\n"),
  );
  assert.ok(!out.includes("5".repeat(20)));
  assert.ok(!out.includes("abc123"));
  assert.ok(!out.includes("hunter2"));
  assert.ok(!out.includes("abcdefghijklmnop"));
  assert.ok(!out.includes("ghp_" + "a".repeat(10)));
  assert.ok(!out.includes("sk-" + "b".repeat(10)));
  assert.ok(!out.includes("A".repeat(20)));
  assert.ok(!out.includes(home));
  assert.ok(out.includes("/Users/<user>/x"));
  assert.ok(!out.includes("me@example.org"));
  assert.ok(out.includes("alice.testnet"));
  assert.ok(out.includes("5wQgycq3qknFDpH2VHcmHDJ6JVEXrZ6Ba6PiAZBRXSXW"));
});

test("triage: issue-form parsing", () => {
  const s = parseIssueBody("### Command\n\n```\ncargo near check\n```\n\n### Error output\n\n```\nboom\n```\n");
  assert.equal(s.command, "cargo near check");
  assert.equal(s["error output"], "boom");
});

test("triage: a known error is answered from the log", () => {
  const err = fs.readFileSync(path.join(ROOT, "fixtures/F-001/repro.txt"), "utf8");
  const r = triage(`### Command\n\ncargo near build\n\n### Error output\n\n${err}`, rules, { issue: 7 });
  assert.equal(r.action, "known");
  assert.deepEqual(r.matches, ["F-001"]);
  assert.match(r.comment, /F-001/);
  assert.match(r.comment, /Rename the free helper function `amount_owed`/);
});

test("triage: an unknown error becomes a valid, unreproduced draft rule that matches its own report", () => {
  const line = "error: failed to run custom build command for `near-fancy v0.3.1`";
  const secret = "ed25519:" + "7".repeat(50);
  const r = triage(`### Command\n\ncargo near build --key ${secret}\n\n### Error output\n\n${line}\nmore text\n`, rules, { issue: 9 });
  assert.equal(r.action, "draft");
  assert.deepEqual(r.problems, []);
  assert.equal(r.draft.id, "F-015");
  assert.equal(r.draft.tier, "hypothesis");
  assert.match(r.draft.evidence.observed, /issue #9/);
  assert.ok(!JSON.stringify(r).includes("7".repeat(20)), "secret leaked into draft");
  // a different version number still matches (digits generalised), so it is a usable pattern
  const hits = matchSymptoms("error: failed to run custom build command for `near-fancy v0.9.12`", [r.draft]);
  assert.equal(hits.length, 1);
  assert.equal(nextRuleId(rules), "F-015");
});

test("triage: missing or unrecognisable output asks for more information", () => {
  assert.equal(triage("### Command\n\nfoo\n\n### Error output\n\n(none provided; re-run with --from FILE)\n", rules).action, "needs-info");
  assert.equal(triage("### Error output\n\nnothing to see\n", rules).action, "needs-info");
});

test("docs/FRICTION_LOG.md is generated from the rules and up to date", () => {
  const file = path.join(ROOT, "docs/FRICTION_LOG.md");
  assert.ok(fs.existsSync(file), "run: npm run log");
  assert.equal(fs.readFileSync(file, "utf8"), rulesMarkdown(loadRules(DEFAULT_RULES_DIR)));
});

test("every shipped rule passes the validator on its own", () => {
  for (const r of rules) assert.deepEqual(validateRule(r), [], r.id);
});

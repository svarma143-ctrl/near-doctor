import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { matchSymptoms, redact } from "../src/index.mjs";
import { DEFAULT_RULES_DIR, loadRules, validateRule } from "../src/index.mjs";
import { renderSteps, rulesMarkdown } from "../src/report.mjs";
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

test("explain never prints blank placeholders, for every rule's repro output", () => {
  for (const r of rules.filter((x) => x.symptoms)) {
    const text = fs.readFileSync(path.join(ROOT, "fixtures", r.id, "repro.txt"), "utf8");
    const m = matchSymptoms(text, rules).find((x) => x.rule.id === r.id);
    assert.ok(m, r.id);
    const steps = renderSteps(r, m.vars);
    assert.ok(steps.length > 0, `${r.id} renders no fix steps in explain mode`);
    for (const t of steps) {
      assert.ok(!/\{\w+\}/.test(t), `${r.id}: unresolved placeholder in "${t}"`);
      assert.ok(!/``|` = "| in \.$/.test(t), `${r.id}: blank placeholder in "${t}"`);
    }
  }
});

test("redact: broader credential formats (best effort)", () => {
  const cases = {
    "client_secret": 'client_secret=Zx9Qm2LpWv8Rt4Ys6Hn',
    "clientSecret json": '{"clientSecret": "Zx9Qm2LpWv8Rt4Ys6Hn"}',
    "AWS secret": "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYzzzzzzzzzz",
    "AWS access key id": "id AKIAIOSFODNN7EXAMPLE here",
    "openssh block": "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\nAAAAB3NzaC1lZDI1NTE5AAAAIPlaceholderplaceholder\n-----END OPENSSH PRIVATE KEY-----",
    "truncated pem": "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAzzzzzzzzzzzzzzzzzzzzzz",
    "url credentials": "git clone https://deploy:hunter2secret@github.com/org/repo.git",
    "hex 64 with 0x": "0x" + "ab12".repeat(16),
    "hex 64 bare": "key " + "cd34".repeat(16),
    "hex 128": "sk " + "ef56".repeat(32),
    "bare base58 key": "key " + "5" + "K".repeat(86) + " end",
    "jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "npm token": "npm_" + "a1B2c3D4".repeat(5),
    "basic auth": "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "db url": "DATABASE_URL=postgres://u:pw1234@db.internal:5432/app",
    "windows profile": "C:\\Users\\Sarah Jones\\proj",
  };
  const needles = {
    "client_secret": "Zx9Qm2LpWv8Rt4Ys6Hn", "clientSecret json": "Zx9Qm2LpWv8Rt4Ys6Hn", "AWS secret": "wJalrXUtnFEMI", "AWS access key id": "AKIAIOSFODNN7EXAMPLE",
    "openssh block": "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU", "truncated pem": "MIIEowIBAAKCAQEA", "url credentials": "hunter2secret", "hex 64 with 0x": "ab12ab12", "hex 64 bare": "cd34cd34",
    "hex 128": "ef56ef56", "bare base58 key": "KKKKKKKKKK", "jwt": "eyJzdWIi", "npm token": "a1B2c3D4a1B2", "basic auth": "dXNlcjpwYXNzd29yZA", "db url": "pw1234", "windows profile": "Sarah",
  };
  for (const [name, text] of Object.entries(cases)) {
    const out = redact(text, { home: "/nonexistent-home", hostname: "" });
    assert.ok(!out.includes(needles[name]), `${name} leaked: ${out}`);
  }
  // the redacted URL keeps the host and user so the report still says what failed
  assert.match(redact("https://deploy:hunter2secret@github.com/o/r.git", { hostname: "" }), /https:\/\/deploy:\[REDACTED\]@github\.com/);
  // public identifiers are still kept
  const pub = redact("alice.testnet 5wQgycq3qknFDpH2VHcmHDJ6JVEXrZ6Ba6PiAZBRXSXW cargo-near 0.23.0", { hostname: "" });
  assert.match(pub, /alice\.testnet 5wQgycq3qknFDpH2VHcmHDJ6JVEXrZ6Ba6PiAZBRXSXW cargo-near 0\.23\.0/);
  // the hostname is replaced
  assert.equal(redact("on MyBox-3.local failed", { home: "/nonexistent-home", hostname: "MyBox-3.local" }), "on <host> failed");
  // redaction is idempotent
  const once = redact("password=hunter2 and Bearer abcdefghijklmnop", { hostname: "" });
  assert.equal(redact(once, { hostname: "" }), once);
});

test("redact stays fast on large hostile-looking input (each case is killed after 20 s)", async () => {
  const { spawnSync } = await import("node:child_process");
  const redactUrl = new URL("../src/redact.mjs", import.meta.url).href;
  const inputs = [
    'process.argv[1] = "a".repeat(1_000_000)',
    '"secret".repeat(100_000)',
    '("key=" + "x".repeat(1000) + "\\n").repeat(1000)',
    '"-----BEGIN PRIVATE KEY-----" + "A".repeat(500_000)',
    '("1".repeat(80) + " ").repeat(5000)',
    '"https://" + "u".repeat(5000) + ":" + "p".repeat(5000)',
    '"x".repeat(60) + "@" + "y".repeat(500_000)',
  ].map((e) => e.replace('process.argv[1] = ', ""));
  for (const expr of inputs) {
    const code = `import { redact } from ${JSON.stringify(redactUrl)};
      const text = ${expr};
      const t0 = Date.now();
      redact(text, { home: "/nonexistent-home", hostname: "" });
      console.log(Date.now() - t0);`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 20000 });
    assert.ok(!r.error, `${expr}: did not finish within 20 s (${r.error?.code})`);
    assert.equal(r.status, 0, r.stderr.slice(0, 300));
    assert.ok(Number(r.stdout.trim()) < 2000, `${expr}: ${r.stdout.trim()} ms`);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { insertCrateAttr, insertDevDep, publicResult, runChecks, scanNear, stripRust } from "../src/index.mjs";
import { globToRegex, parseSemver } from "../src/util.mjs";
import { FIXTURES, copyFixture, fixtureOpts, rules } from "./_helpers.mjs";

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "nd-e-"));

// ------------------------------------------------------------------ scanner
test("stripRust keeps length and newlines, blanks comments and strings", () => {
  const src = 'fn a() { // c {\n let s = "x { y"; /* { */ let c = \'{\'; let r = r#"}"#; }\n';
  const out = stripRust(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split("\n").length, src.split("\n").length);
  assert.ok(!out.includes('"x'));
  assert.equal((out.match(/\{/g) || []).length, 1);
  assert.equal((out.match(/\}/g) || []).length, 1);
});

test("scanNear: methods, params (incl. self and generics), visibility", () => {
  const s = scanNear(`
    use near_sdk::near;
    #[near]
    impl C {
        pub fn plain(&self) {}
        pub fn generic<F: Fn(u8) -> u8>(&self, f: F, a: u8) -> u8 { f(a) }
        pub fn takes_impl(&self, a: impl Into<String>) -> impl Iterator<Item = u8> { std::iter::empty() }
        pub fn after_impl(&mut self, a: u8, b: u8) {}
        pub(crate) fn hidden(&self) {}
        fn private(&self) {}
    }
  `);
  const byName = Object.fromEntries(s.methods.map((m) => [m.name, m.params]));
  assert.deepEqual(byName, { plain: 1, generic: 3, takes_impl: 2, after_impl: 3 });
});

test("scanNear: struct attribute does not make later impls #[near]; near_bindgen counts", () => {
  const s = scanNear(`
    #[near(contract_state)]
    pub struct C {}
    impl Default for C { pub fn default() -> Self { C {} } }
    #[near_bindgen]
    impl C { pub fn exported(&self) {} }
  `);
  assert.deepEqual(s.methods.map((m) => m.name), ["exported"]);
});

test("scanNear: free fns per module; fn pointer types ignored; braces in strings/chars ok", () => {
  const s = scanNear(`
    struct S { f: fn(u8) -> u8 }
    const T: &str = "fn fake() { ";
    fn top() { let c = '{'; }
    mod inner {
        fn nested() {}
        mod deeper { fn deepest() {} }
    }
    #[cfg(test)]
    mod tests { fn top() {} }
  `);
  const names = s.freeFns.map((f) => `${f.module}::${f.name}`);
  assert.deepEqual(names.sort(), ["::top", "inner::deeper::deepest", "inner::nested", "tests::top"].sort());
});

test("scanNear: detects crate-level allow", () => {
  assert.ok(scanNear("#![allow(clippy::too_many_arguments)]\nfn a() {}").allowsTooManyArgs);
  assert.ok(!scanNear("// #![allow(clippy::too_many_arguments)]\nfn a() {}").allowsTooManyArgs);
});

test("name collision: same module flagged, different module and comments/strings not", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "Cargo.toml"), '[dependencies]\nnear-sdk = "5"\n');
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "src/lib.rs"),
    `#[near]\nimpl C { pub fn a(&self) {} pub fn b(&self) {} }\nfn b() {}\nmod m { fn a() {} }\n// fn a() {}\nconst S: &str = "fn a() {}";\n`,
  );
  const r = await runChecks({ root: dir, rules, only: ["F-001"], mock: { __strict: true } });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].vars.name, "b");
});

test("too-many-args honours the 7-parameter limit and a crate-level allow in lib.rs from another file", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "Cargo.toml"), '[dependencies]\nnear-sdk = "5"\n');
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/lib.rs"), "#![allow(clippy::too_many_arguments)]\nmod other;\n");
  fs.writeFileSync(path.join(dir, "src/other.rs"), "#[near]\nimpl C { pub fn big(&self, a: u8, b: u8, c: u8, d: u8, e: u8, f: u8, g: u8) {} }\n");
  const r = await runChecks({ root: dir, rules, only: ["F-004"], mock: { __strict: true } });
  assert.equal(r.findings.length, 0);
  fs.writeFileSync(path.join(dir, "src/lib.rs"), "mod other;\n");
  const r2 = await runChecks({ root: dir, rules, only: ["F-004"], mock: { __strict: true } });
  assert.equal(r2.findings.length, 1);
  assert.equal(r2.findings[0].target.file, "src/lib.rs");
});

// ------------------------------------------------------------------ helpers
test("glob and semver helpers", () => {
  assert.ok(globToRegex("**/tests/**/*.rs").test("tests/a.rs"));
  assert.ok(globToRegex("**/tests/**/*.rs").test("crate/tests/x/y.rs"));
  assert.ok(!globToRegex("**/tests/**/*.rs").test("src/a.rs"));
  assert.ok(globToRegex("scripts/**").test("scripts/deploy.sh"));
  assert.deepEqual(parseSemver("near-cli-rs 0.20.0"), [0, 20, 0]);
  assert.equal(parseSemver("nope"), null);
});

test("insertCrateAttr: after docs, no-comment file, idempotent", () => {
  const attr = "#![allow(clippy::too_many_arguments)]";
  const a = insertCrateAttr("//! Docs.\n\nuse x;\n", attr, "why");
  assert.match(a, /^\/\/! Docs\.\n\n\/\/ why\n#!\[allow\(clippy::too_many_arguments\)\]\n\nuse x;/);
  const b = insertCrateAttr("use x;\n", attr, "why");
  assert.match(b, /^\/\/ why\n#!\[allow/);
  assert.equal(insertCrateAttr(a, attr, "why"), a);
});

test("insertDevDep: existing section, new section, idempotent", () => {
  const a = insertDevDep('[package]\nname = "x"\n\n[dev-dependencies]\ntokio = "1"\n', "anyhow", "1");
  assert.match(a, /\[dev-dependencies\]\nanyhow = "1"\ntokio/);
  const b = insertDevDep('[package]\nname = "x"\n', "anyhow", "1");
  assert.match(b, /\n\[dev-dependencies\]\nanyhow = "1"\n$/);
  assert.equal(insertDevDep(b, "anyhow", "1"), b);
});

// ------------------------------------------------------------------ engine behaviour
test(".near-doctorignore is honoured and non-NEAR projects get a note", async () => {
  const dir = copyFixture("F-008/repro");
  assert.equal((await runChecks({ root: dir, rules, only: ["F-008"], mock: { __strict: true } })).findings.length, 1);
  fs.writeFileSync(path.join(dir, ".near-doctorignore"), "# comment\npackage.json\n");
  assert.equal((await runChecks({ root: dir, rules, only: ["F-008"], mock: { __strict: true } })).findings.length, 0);
  const empty = tmp();
  const r = await runChecks({ root: empty, rules, mock: { __strict: true } });
  assert.match(r.notes.join(" "), /No NEAR project detected/);
  assert.equal(r.findings.length, 0);
});

test("findings are agent-ready and JSON output hides internals", async () => {
  const r = await runChecks(fixtureOpts(path.join(FIXTURES, "F-001", "repro"), "F-001"));
  const f = r.findings[0];
  assert.equal(f.file, "src/lib.rs");
  assert.ok(f.line > 0);
  assert.match(f.agent.task, /rename the free function `amount_owed` to `compute_amount_owed`/);
  assert.equal(f.agent.acceptance.command, "near-doctor --only F-001 --json");
  const pub = publicResult(r);
  assert.ok(!("_autofix" in pub.findings[0]));
  assert.equal(pub.summary.error, 1);
});

test("deep mode: explains cargo near check output, de-duplicates against the static finding", async () => {
  const dir = path.join(FIXTURES, "F-001", "repro");
  const text = fs.readFileSync(path.join(FIXTURES, "F-001", "repro.txt"), "utf8");
  const mock = { __strict: true, "cargo --version": { stdout: "cargo 1.100.0" }, "cargo near --version": { stdout: "ok" }, "cargo near check": { code: 101, stderr: text } };
  const r = await runChecks({ root: dir, rules, mock, deep: true });
  const f001 = r.findings.filter((f) => f.id === "F-001");
  assert.equal(f001.length, 1);
  assert.equal(f001[0].source, "static");
  assert.ok(f001[0].line > 0);
});

test("deep mode: passing, missing cargo-near, and unknown failures", async () => {
  const dir = path.join(FIXTURES, "F-001", "control");
  const base = { root: dir, rules, only: ["F-001"], deep: true };
  const ok = await runChecks({ ...base, mock: { __strict: true, "cargo near check": { code: 0 } } });
  assert.match(ok.notes.join(" "), /cargo near check passed/);
  const missing = await runChecks({ ...base, mock: { __strict: true } });
  assert.match(missing.skipped.map((s) => s.reason).join(" "), /not installed/);
  const unknown = await runChecks({ ...base, mock: { __strict: true, "cargo near check": { code: 101, stderr: "error[E0599]: no method named `frobnicate` found" } } });
  assert.equal(unknown.findings[0].id, "UNKNOWN");
  assert.match(unknown.findings[0].message, /E0599/);
});

test("F-007 skips quietly when near-api-js is not installed", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "package.json"), '{"dependencies":{"near-api-js":"^7"}}');
  fs.writeFileSync(path.join(dir, "app.mjs"), 'import { WalletConnection } from "near-api-js";\n');
  const r = await runChecks({ root: dir, rules, only: ["F-007"], mock: { __strict: true } });
  assert.equal(r.findings.length, 0);
  assert.match(r.skipped[0].reason, /not installed|not loadable/);
});

test("F-007 hints name the replacement and handle require() destructuring", async () => {
  const dir = copyFixture("F-007/repro");
  fs.writeFileSync(path.join(dir, "old.cjs"), 'const { keyStores, connect } = require("near-api-js");\n');
  const r = await runChecks({ root: dir, rules, only: ["F-007"], mock: { __strict: true } });
  const names = r.findings.map((f) => f.vars.name).sort();
  assert.deepEqual(names, ["WalletConnection", "connect", "keyStores"]);
  assert.match(r.findings.find((f) => f.vars.name === "keyStores").message, /no KeyStore implementation/);
});

test("F-011: RPC probe stays silent when the node is fast and records a note", async () => {
  const r = await runChecks(fixtureOpts(path.join(FIXTURES, "F-011", "control"), "F-011"));
  assert.equal(r.findings.length, 0);
  assert.match(r.notes.join(" "), /median 300 ms/);
  const slow = await runChecks(fixtureOpts(path.join(FIXTURES, "F-011", "repro"), "F-011"));
  assert.match(slow.findings[0].message, /3000 ms/);
  assert.match(slow.findings[0].fix.steps[0], /25000 ms/);
});

test("net probe is off by default (no network without --net)", async () => {
  const dir = path.join(FIXTURES, "F-011", "repro");
  let called = false;
  const r = await runChecks({ root: dir, rules, only: ["F-011"], mock: { __strict: true }, fetchImpl: async () => { called = true; return { text: async () => "" }; } });
  assert.equal(called, false);
  assert.equal(r.findings.length, 0);
});

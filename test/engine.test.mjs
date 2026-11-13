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
  assert.deepEqual(names, ["WalletConnection", "WalletConnection", "connect", "keyStores"]); // app.mjs and app.ts
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

// ------------------------------------------------------------------ F-007 safety
test("F-007 never executes the package: exports come from type declarations", async () => {
  const dir = copyFixture("F-007/repro");
  const marker = path.join(dir, "EXECUTED");
  fs.writeFileSync(path.join(dir, "node_modules/near-api-js/index.cjs"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); module.exports = {};`);
  const r = await runChecks({ root: dir, rules, only: ["F-007"], mock: { __strict: true } });
  assert.ok(r.findings.length >= 1);
  assert.equal(fs.existsSync(marker), false, "the package was executed");
  // TypeScript files are checked too; a type-only import (KeyPairString) is not a false positive
  const ts = r.findings.filter((f) => f.file.endsWith(".ts"));
  assert.deepEqual(ts.map((f) => f.vars.name), ["WalletConnection"]);
});

test("F-007: packages without types are skipped unless --allow-exec, which does execute them", async () => {
  const dir = copyFixture("F-007/repro");
  const pkgDir = path.join(dir, "node_modules/near-api-js");
  fs.rmSync(path.join(pkgDir, "index.d.ts"));
  fs.writeFileSync(path.join(pkgDir, "package.json"), '{"name":"near-api-js","version":"7.5.3","main":"index.cjs"}');
  const marker = path.join(dir, "EXECUTED");
  fs.writeFileSync(path.join(pkgDir, "index.cjs"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); module.exports = { Account: 1 };`);
  const safe = await runChecks({ root: dir, rules, only: ["F-007"], mock: { __strict: true } });
  assert.equal(safe.findings.length, 0);
  assert.match(safe.skipped.map((s) => s.reason).join(" "), /--allow-exec/);
  assert.equal(fs.existsSync(marker), false);
  const loud = await runChecks({ root: dir, rules, only: ["F-007"], mock: { __strict: true }, allowExec: true });
  assert.ok(loud.findings.length >= 1);
  assert.equal(fs.existsSync(marker), true);
});

test("dtsExports follows export *, aliases and declarations", async () => {
  const { dtsExports } = await import("../src/detectors.mjs");
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "index.d.ts"), 'export * from "./a.js";\nexport * as ns from "./b";\nexport { x as Y, type Z } from "./c.js";\nexport declare function f(): void;\nexport default class D {}\n// export const hidden = 1;\n');
  fs.writeFileSync(path.join(dir, "a.d.ts"), "export declare const fromA: number;\nexport type TA = string;\n");
  assert.deepEqual([...dtsExports(path.join(dir, "index.d.ts"))].sort(), ["TA", "Y", "Z", "default", "f", "fromA", "ns"]);
});

// ------------------------------------------------------------------ regressions found by scanning public repos
const nearLib = (attrs, impl = "") => `use near_sdk::near;
#[near(contract_state)]
#[derive(Default)]
pub struct C {}
${impl}#[near]
impl C {
    pub fn few(&self) {}
${attrs}    pub fn many(&self, a: u8, b: u8, c: u8, d: u8, e: u8, f: u8, g: u8) {}
}
`;
const withLib = (lib) => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "c"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nnear-sdk = "5"\n');
  fs.writeFileSync(path.join(dir, "src/lib.rs"), lib);
  return dir;
};
const ids = async (dir, only) => (await runChecks({ root: dir, rules, only: [only], mock: { __strict: true } })).findings.map((f) => f.id);

test("F-004: flagged without an allow; a method-level allow silences it (verified with clippy); an impl-level allow does not", async () => {
  assert.deepEqual(await ids(withLib(nearLib("")), "F-004"), ["F-004"]);
  assert.deepEqual(await ids(withLib(nearLib("    #[allow(clippy::too_many_arguments)]\n")), "F-004"), []);
  assert.deepEqual(await ids(withLib(nearLib("    #[payable]\n    #[allow(clippy::too_many_arguments)]\n")), "F-004"), []);
  // an allow on the impl is NOT enough (verified with cargo near check --clippy)
  const implAllow = nearLib("").replace("#[near]\nimpl", "#[near]\n#[allow(clippy::too_many_arguments)]\nimpl");
  assert.deepEqual(await ids(withLib(implAllow), "F-004"), ["F-004"]);
  // an allow on an earlier method must not leak onto a later one
  const leak = nearLib("").replace("    pub fn few(&self) {}", "    #[allow(clippy::too_many_arguments)]\n    pub fn few(&self) {}");
  assert.deepEqual(await ids(withLib(leak), "F-004"), ["F-004"]);
});

test("F-012: a file in a nested crate is checked against its own Cargo.toml, not the root one", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "tests/tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "root"\nversion = "0.1.0"\n[workspace]\nmembers = ["tests"]\n');
  fs.writeFileSync(path.join(dir, "src/lib.rs"), "");
  fs.writeFileSync(path.join(dir, "tests/Cargo.toml"), '[package]\nname = "t"\nversion = "0.1.0"\n[dependencies]\nanyhow = "1"\n');
  fs.writeFileSync(path.join(dir, "tests/tests/a.rs"), "fn f() -> anyhow::Result<()> { Ok(()) }\n");
  assert.deepEqual(await ids(dir, "F-012"), []);
  // and it is still found when the nested crate really lacks it
  fs.writeFileSync(path.join(dir, "tests/Cargo.toml"), '[package]\nname = "t"\nversion = "0.1.0"\n');
  const found = (await runChecks({ root: dir, rules, only: ["F-012"], mock: { __strict: true } })).findings;
  assert.equal(found.length, 1);
  assert.equal(found[0].file, "tests/tests/a.rs");
});

test("F-005: needs max_gas, a balance read and an assert in the same test file", async () => {
  const make = (body) => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "tests"));
    fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "c"\nversion = "0.1.0"\n');
    fs.writeFileSync(path.join(dir, "tests/t.rs"), body);
    return dir;
  };
  const callMax = 'let r = a.call(id, "x").max_gas().transact().await?;\n';
  assert.deepEqual(await ids(make(callMax + "let b = a.view_account().await?.balance;\nassert_eq!(b, 1);\n"), "F-005"), ["F-005"]);
  assert.deepEqual(await ids(make(callMax + "assert!(r.is_success());\n"), "F-005"), [], "no balance read");
  assert.deepEqual(await ids(make('let b = a.view_account().await?.balance;\nassert_eq!(b, 1);\n'), "F-005"), [], "no max_gas");
  assert.deepEqual(await ids(make(callMax + "// the word balance in a comment\nassert!(r.is_success());\n"), "F-005"), [], "balance only mentioned");
});

test("F-006: only fires for files that use near-api-js", async () => {
  const make = (body) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "a.mjs"), body);
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    return dir;
  };
  const call = 'const r = await x.callFunctionRaw({ contractId });\nif (r.status?.Failure) {}\n';
  assert.deepEqual(await ids(make('import { Account } from "near-api-js";\n' + call), "F-006"), ["F-006"]);
  assert.deepEqual(await ids(make('import { Other } from "some-other-sdk";\n' + call), "F-006"), []);
});

test("F-012: virtual workspace roots and non-target subdirectories are not flagged", async () => {
  const mk = (rootToml, files) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "Cargo.toml"), rootToml);
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    }
    return dir;
  };
  const use = "fn f() -> anyhow::Result<()> { Ok(()) }\n";
  const pkg = '[package]\nname = "p"\nversion = "0.1.0"\n';
  assert.deepEqual(await ids(mk('[workspace]\nmembers = ["a"]\n', { "tests/a.rs": use }), "F-012"), [], "virtual workspace root");
  assert.deepEqual(await ids(mk(pkg, { "tests/attacks/x.rs": use }), "F-012"), [], "subdir with no target root: never compiled");
  assert.deepEqual(await ids(mk(pkg, { "tests/attacks/x.rs": use, "tests/attacks.rs": "mod x;\n" }), "F-012"), ["F-012"], "included by tests/attacks.rs");
  assert.deepEqual(await ids(mk(pkg, { "tests/integration/main.rs": "mod dao;\n", "tests/integration/dao.rs": use }), "F-012"), ["F-012"], "tests/x/main.rs target");
  assert.deepEqual(await ids(mk(pkg, { "tests/t.rs": use }), "F-012"), ["F-012"]);
});

test("F-006: provider.callFunction (a read-only view) is not flagged; account.callFunctionRaw is", async () => {
  const make = (call) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "a.mjs"), `import { Account } from "near-api-js";\n${call}\nif (r.status?.Failure) {}\n`);
    return dir;
  };
  assert.deepEqual(await ids(make("const r = await provider.callFunction(id, 'm', {});"), "F-006"), []);
  assert.deepEqual(await ids(make("const r = await account.callFunctionRaw({ contractId });"), "F-006"), ["F-006"]);
  assert.deepEqual(await ids(make("const r = await this.account.callFunction({ contractId });"), "F-006"), ["F-006"]);
});

test("F-005: the `.balance(...)` builder is not a balance read", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "tests"));
  fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "c"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(dir, "tests/t.rs"), 'let r = a.call(id, "x").max_gas().transact().await?;\nlet p = Patch::new().balance(NearToken::from_near(1));\nassert!(r.is_success());\n');
  assert.deepEqual(await ids(dir, "F-005"), []);
});

test("F-006: provider.callFunctionRaw and identifiers like DemoFailure are not flagged", async () => {
  const make = (body) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "a.mjs"), `import { Account } from "near-api-js";\n${body}\n`);
    return dir;
  };
  assert.deepEqual(await ids(make("const r = await provider.callFunctionRaw({ contractId });\nif (r.status?.Failure) {}"), "F-006"), []);
  assert.deepEqual(await ids(make("class DemoFailure extends Error {}\nawait signer.callFunctionRaw({ contractId });"), "F-006"), []);
  assert.deepEqual(await ids(make("const r = await new Account(a, b, c).callFunctionRaw({ contractId });\nif ('Failure' in r.status) {}"), "F-006"), ["F-006"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyFixes, safeTarget } from "../src/fix.mjs";
import { main } from "../src/cli.mjs";

async function run(args) {
  let out = "";
  let err = "";
  const code = await main(args, { out: (x) => (out += x), err: (x) => (err += x), mock: { __strict: true }, isTTY: false });
  return { code, out, err };
}

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "nd-b-")));
const PKG = '[package]\nname = "c"\nversion = "0.1.0"\n';
const finding = (file) => ({ id: "F-012", _autofix: { type: "cargo-dev-dep", crate: "anyhow", version: "1", description: "x" }, target: { file }, file });
const apply = (root, file) => applyFixes([finding(file)], { root, runner: () => ({ code: 0 }) })[0];

test("safeTarget accepts a normal file inside the project", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "Cargo.toml"), PKG);
  assert.equal(safeTarget(root, "Cargo.toml"), path.join(root, "Cargo.toml"));
  fs.mkdirSync(path.join(root, "crates/a"), { recursive: true });
  fs.writeFileSync(path.join(root, "crates/a/Cargo.toml"), PKG);
  assert.equal(apply(root, "crates/a/Cargo.toml").status, "applied");
  assert.match(fs.readFileSync(path.join(root, "crates/a/Cargo.toml"), "utf8"), /anyhow = "1"/);
});

test("autofix refuses a symlinked target and leaves the file it points to untouched", () => {
  const base = tmp();
  const root = path.join(base, "proj");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(base, "outside"));
  const victim = path.join(base, "outside", "victim.toml");
  fs.writeFileSync(victim, PKG);
  fs.symlinkSync(victim, path.join(root, "Cargo.toml"));
  const r = apply(root, "Cargo.toml");
  assert.equal(r.status, "failed");
  assert.match(r.detail, /symbolic link/);
  assert.equal(fs.readFileSync(victim, "utf8"), PKG, "the file outside the project was modified");
});

test("autofix refuses a symlinked directory component, ../ traversal, absolute paths and hard links", () => {
  const base = tmp();
  const root = path.join(base, "proj");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(base, "outside"));
  fs.writeFileSync(path.join(base, "outside", "Cargo.toml"), PKG);
  fs.symlinkSync(path.join(base, "outside"), path.join(root, "linked"));
  assert.match(apply(root, "linked/Cargo.toml").detail, /symbolic link/);
  assert.match(apply(root, "../outside/Cargo.toml").detail, /leaves the project/);
  assert.match(apply(root, path.join(base, "outside", "Cargo.toml")).detail, /absolute/);
  fs.linkSync(path.join(base, "outside", "Cargo.toml"), path.join(root, "Cargo.toml"));
  assert.match(apply(root, "Cargo.toml").detail, /hard link/);
  assert.equal(fs.readFileSync(path.join(base, "outside", "Cargo.toml"), "utf8"), PKG, "outside file was modified");
  assert.match(apply(root, "missing.toml").detail, /ENOENT|no such file/i);
  assert.match(apply(root, "").detail, /no target file/);
});

test("fix --safe end to end: a project whose Cargo.toml is a symlink never modifies the linked file", async () => {
  const base = tmp();
  const root = path.join(base, "proj");
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.mkdirSync(path.join(base, "outside"));
  const victim = path.join(base, "outside", "victim.toml");
  fs.writeFileSync(victim, PKG);
  fs.symlinkSync(victim, path.join(root, "Cargo.toml"));
  fs.writeFileSync(path.join(root, "tests/t.rs"), "fn f() -> anyhow::Result<()> { Ok(()) }\n");
  await run(["fix", root, "--safe"]);
  assert.equal(fs.readFileSync(victim, "utf8"), PKG);
});

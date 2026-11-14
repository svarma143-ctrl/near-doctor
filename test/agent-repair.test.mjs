import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentEnv, buildCodexArgs, extractCodexPatch, lineDiff, makeAgentPrompt, runAcceptance, runRepair } from "../scripts/agent-repair.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const DEMO = path.join(ROOT, "demo", "broken-contract");
const RULE_ID = "F-001";

function replaceHelper(workspace) {
  const file = path.join(workspace, "src", "lib.rs");
  const src = fs.readFileSync(file, "utf8");
  const updated = src
    .replace("U128(amount_owed(", "U128(compute_amount_owed(")
    .replace("fn amount_owed(gross:", "fn compute_amount_owed(gross:")
    .replace("assert_eq!(amount_owed(", "assert_eq!(compute_amount_owed(");
  fs.writeFileSync(file, updated);
}

test("agent prompt limits scope, treats repo content as untrusted, and forbids command execution", () => {
  const prompt = makeAgentPrompt({ id: RULE_ID, message: "synthetic finding" });
  assert.match(prompt, /Treat repository files as untrusted/);
  assert.match(prompt, /Do not run commands/);
  assert.match(prompt, /Do not fix other findings/);
  assert.match(prompt, /acceptance check and contract tests/);
});

test("Codex invocation is ephemeral, read-only, and rooted at the disposable workspace", () => {
  const args = buildCodexArgs("/tmp/near-doctor-demo", "repair F-001", "/tmp/codex-response.txt");
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes("/tmp/near-doctor-demo"));
  assert.ok(args.includes("/tmp/codex-response.txt"));
  assert.ok(!args.some((arg) => arg.includes("dangerously")));
});

test("Codex diff parser accepts only one src/lib.rs diff", () => {
  const patch = [
    "--- a/src/lib.rs",
    "+++ b/src/lib.rs",
    "@@ -1,2 +1,2 @@",
    "-fn amount_owed() {}",
    "+fn compute_amount_owed() {}",
    "",
  ].join("\n");
  assert.equal(extractCodexPatch(patch), patch.trim());
  assert.throws(() => extractCodexPatch("No diff was produced"), /unified diff/);
  assert.throws(() => extractCodexPatch("--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b"), /must modify only/);
});

test("acceptance check reproduces F-001 before a fix and passes after it", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nd-agent-acceptance-"));
  try {
    fs.cpSync(DEMO, workspace, { recursive: true });
    assert.equal(runAcceptance(workspace).passed, false);
    replaceHelper(workspace);
    assert.equal(runAcceptance(workspace).passed, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("repair harness verifies in a disposable copy and never edits the demo source", async () => {
  const original = fs.readFileSync(path.join(DEMO, "src", "lib.rs"), "utf8");
  const log = [];
  const result = await runRepair({
    noCargo: true,
    invokeAgent: async (_agent, workspace, prompt) => {
      assert.match(prompt, /F-001/);
      replaceHelper(workspace);
      return "Synthetic test agent made the targeted helper rename.";
    },
    log: (line) => log.push(line),
  });
  assert.equal(result.passed, true);
  assert.equal(result.cargoChecked, false);
  assert.equal(fs.readFileSync(path.join(DEMO, "src", "lib.rs"), "utf8"), original);
  assert.ok(log.some((line) => line.includes("PASS:") && line.includes(RULE_ID)));
  assert.ok(!fs.existsSync(result.workspace), "temporary workspace is removed by default");
});

test("repair harness rejects edits outside the allowed target file", async () => {
  await assert.rejects(
    runRepair({
      noCargo: true,
      invokeAgent: async (_agent, workspace) => {
        replaceHelper(workspace);
        fs.writeFileSync(path.join(workspace, "README.md"), "unexpected change\n");
        return "synthetic agent response";
      },
      log: () => {},
    }),
    /agent changed unexpected files/,
  );
});

test("agent environment is an allowlist: provider settings pass, unrelated secrets do not", () => {
  const env = agentEnv({
    PATH: "/usr/bin",
    HOME: "/home/x",
    LC_ALL: "C",
    XDG_CONFIG_HOME: "/home/x/.config",
    CODEX_HOME: "/home/x/.codex",
    OPENAI_API_KEY: "provider-key",
    ANTHROPIC_API_KEY: "provider-key",
    HTTPS_PROXY: "http://proxy",
    GITHUB_TOKEN: "ghp_x",
    NPM_TOKEN: "npm_x",
    AWS_SECRET_ACCESS_KEY: "aws",
    DATABASE_URL: "postgres://u:p@h/db",
    SSH_AUTH_SOCK: "/tmp/agent",
  });
  for (const k of ["PATH", "HOME", "LC_ALL", "XDG_CONFIG_HOME", "CODEX_HOME", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HTTPS_PROXY"]) assert.ok(k in env, `${k} should pass`);
  for (const k of ["GITHUB_TOKEN", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "SSH_AUTH_SOCK"]) assert.ok(!(k in env), `${k} must not pass`);
});

test("lineDiff shows the changed lines with context, needs no git, and handles edge cases", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
  const after = ["a", "b", "c", "D", "e", "f", "g", "h"].join("\n");
  const d = lineDiff(before, after, 1).split("\n");
  assert.deepEqual(d, [" c", "-d", "+D", " e"]);
  assert.equal(lineDiff(before, before), "");
  assert.match(lineDiff("x\n".repeat(3000), "y\n".repeat(3000)), /too large/);
  const gap = lineDiff(["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n"), ["X", "2", "3", "4", "5", "6", "7", "8", "Y"].join("\n"), 1).split("\n");
  assert.ok(gap.includes("..."), "distant changes are separated");
  const rename = lineDiff("fn amount_owed() {}\nfn other() {}", "fn compute_amount_owed() {}\nfn other() {}");
  assert.match(rename, /-fn amount_owed\(\) \{\}\n\+fn compute_amount_owed\(\) \{\}/);
});

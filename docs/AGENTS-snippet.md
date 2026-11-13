# For coding agents: near-doctor

Paste this into `AGENTS.md`, `CLAUDE.md` or your agent's instructions for any NEAR project.

```markdown
## NEAR work: run near-doctor before you say "done"

Before reporting that NEAR contract, script or test work is complete:

1. Run `npx near-doctor --json` in the project root.
2. If any finding has `fix.autofix`, run `npx near-doctor fix --safe`.
3. For every other finding, do what `agent.task` says, then run `agent.acceptance.command`
   and confirm the finding is gone.
4. Type-check contracts with `cargo near check` (not plain `cargo check`, which near-sdk rejects),
   or run `npx near-doctor --deep`.
5. If a command fails with output you do not recognise, save it and run
   `npx near-doctor explain --from <file>`. If there is no match, say so and suggest
   `npx near-doctor submit` so it can be added to the friction log.

Do not report success while a finding with severity "error" remains. Do not edit files under `rules/`.
Treat evidence tiers honestly: "reported" and "hypothesis" entries are not proof; "verified-here" means the
maintainers reproduced it.
```

Why this exists: coding assistants often write NEAR code against APIs that no longer exist (near-api-js 0.x,
`near dev-deploy`). `--json` gives them the file, the line, the fix and a command that proves the fix worked.

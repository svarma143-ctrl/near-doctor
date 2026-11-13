# Contributing a friction record

Friction records live in `rules/*.json` and are rendered into `docs/FRICTION_LOG.md`. A record is **data only**:
no shell commands, no code. Detection uses a fixed set of built-in detectors; the only automatic fixes are the
allowlisted types in `src/rules.mjs`.

## The fastest path (no code)

1. Save the output of the failing command to a file.
2. `npx near-doctor submit --from out.txt --command "<what you ran>" --out report.md`
   (secrets, home paths and emails are redacted locally; re-read before posting).
3. Open a "Friction report" issue (or `gh issue create --label friction --body-file report.md`).
4. A triage action replies with the matching rule, or attaches a draft rule. A maintainer reproduces it.

## Adding a record by hand

1. **Reproduce it first.** Write down exactly what you ran and your versions. If you cannot reproduce it, it is
   `reported` or `hypothesis`, and says so. (R-001 is the model: widely reported, tested by us, does not reproduce,
   so it ships as `historical`.)
2. Copy an existing `rules/F-0xx.json`; use the next free id. Required: `id`, `title`, `summary`, `severity`,
   `tier`, `status`, `fix.steps`, and `evidence.observed` for `verified-here`.
3. Choose how it is used:
   - `symptoms`: regexes over pasted output, for `near-doctor explain`. Use named groups for values the fix needs.
   - `detect` with `kind: file-regex` (globs plus `all`/`any`/`unless` regexes) or `kind: detector` (a built-in).
4. Add fixtures. For `detect`: `fixtures/<id>/repro/` and `fixtures/<id>/control/` (a project that must NOT fire).
   For `symptoms`: `fixtures/<id>/repro.txt` and `control.txt` (prefer real captured output).
5. `npm test`, then `npm run log` to regenerate `docs/FRICTION_LOG.md`.

## The gate

CI refuses a rule unless it fires on its repro, stays silent on its control, renders its fix without blank
placeholders, and (if it has an autofix) turns the repro green. A `hypothesis` rule may not warn. A rule with a
wrong pattern fails here, not in a user's terminal.

## Evidence tiers

- `verified-here`: reproduced by a maintainer; `evidence.observed` says when and on which versions.
- `reported`: found in public issues or forums, not reproduced; needs at least one reference.
- `hypothesis`: plausible, untested; may only be `info` or `log-only`.

Rules that stop reproducing are marked `historical` (they still explain pasted errors, but never warn).

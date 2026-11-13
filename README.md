# near-doctor

[![CI](https://github.com/svarma143-ctrl/near-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/svarma143-ctrl/near-doctor/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/near-doctor)](https://www.npmjs.com/package/near-doctor) ![license](https://img.shields.io/badge/license-MIT-blue)

Preflight checks and an evidence-backed friction log for NEAR developers and their coding agents.

NEAR work fails in the same small, expensive ways for many people: a contract that passes `cargo test` but not the
wasm build, a script that calls a CLI command that no longer exists, a client written against an API that was removed.
`near-doctor` scans a project for these in under a second, explains pasted error output, applies the safe fixes, and
hands everything else to your coding agent as a precise task with a command that proves it worked.

Status: hackathon prototype (NEAR HACKATHON, Open Innovation track), version 0.1.0. Tested on macOS 15 arm64 only.
See [Limitations](#limitations).

## Use it on your project

```bash
cd my-near-project
npx near-doctor            # scan: findings with file, line and the first fix step
npx near-doctor --deep     # also runs the real `cargo near check` (needs cargo-near)
npx near-doctor fix --safe # apply the deterministic fixes
```

Needs Node 20+ and has no dependencies. To keep it installed: `npm i -g near-doctor`.

## Try it on the broken demo contract (about one minute)

The demo lives in the git repository, not in the npm package.

Requires Node 20+. The last two demo steps also need Rust and [cargo-near](https://github.com/near/cargo-near).

```bash
git clone https://github.com/svarma143-ctrl/near-doctor && cd near-doctor
node scripts/demo.mjs
```

The same flow, paced for a screen recording (about 50 seconds, every command executed for real): `node scripts/showcase.mjs`.

You should see: a deliberately broken contract (`demo/broken-contract`) produce four findings, two fixed by
`near-doctor fix --safe`, two fixed by applying the edits an agent made from `near-doctor --json`, then a clean report,
and finally `cargo near check` and `cargo test` passing for real. The last line is `DEMO OK`. A recorded run is in
[docs/demo-run.txt](docs/demo-run.txt).

Step by step on the broken contract:

```bash
node bin/near-doctor.mjs demo/broken-contract          # 4 findings with file:line (F-001, F-004, F-008, F-012)
node bin/near-doctor.mjs demo/broken-contract --json   # agent-ready: task + acceptance command per finding
node bin/near-doctor.mjs explain --from fixtures/F-003/repro.txt   # paste any tool output, get cause + fix
node bin/near-doctor.mjs show F-001                    # one friction record with its evidence
node bin/near-doctor.mjs rules                         # the friction log (18 records)
npm run verify                                         # checks every claim in this README, prints PASS/FAIL
node bin/near-doctor.mjs . --net                       # also measures your public RPC latency (only network access)
```

## What it does

| Command | What you get |
| --- | --- |
| `near-doctor [path]` | Static and environment checks, no network. Compact output: file, line, first fix step, evidence tier. `--verbose` adds the why and every step. |
| `near-doctor show F-001` | The full record for one friction entry: summary, evidence, fix steps, fixtures. |
| `near-doctor --deep` | Also runs the real `cargo near check` and explains its output. |
| `near-doctor explain --from FILE` | Paste output (or `--from -`); get the known cause and fix, including the real error buried in long dumps. |
| `near-doctor fix --safe` | Applies deterministic, allowlisted fixes, then re-checks. `--dry-run` previews. |
| `near-doctor submit` | Builds a redacted friction report (secrets, home paths, emails stripped locally) for a GitHub issue. |
| `near-doctor inspect X.wasm` | Shows wasm sections and target features. |
| `near-doctor rules [--markdown\|--json\|--check]` | The friction log; `--check` validates rules and fixtures. |

Exit codes: 0 clean, 1 findings at or above `--fail-on` (default `error`), 2 usage error. Unknown or misplaced
arguments are rejected, never ignored.

### For coding agents

`--json` gives each finding a `file`, `line`, a self-contained `agent.task` and `agent.acceptance.command`
(`near-doctor --only F-001 --json`, expect no finding). Paste [docs/AGENTS-snippet.md](docs/AGENTS-snippet.md) into
your `AGENTS.md` so agents run it before saying "done". Assistants often write NEAR code against APIs that no longer
exist (near-api-js 0.x, `near dev-deploy`); F-007 and F-008 catch exactly that.

## The friction log

18 records in [`rules/`](rules), rendered to [docs/FRICTION_LOG.md](docs/FRICTION_LOG.md). Every record carries an
evidence tier:

- **verified-here** (13): reproduced on a Mac with rustc 1.100.0, cargo-near 0.23.0, near-sdk 5.30.1, near-api-js 7.5.3,
  node 26, near-cli 4.0.13, with the date and result in `evidence.observed`.
- **reported** (3): found in public issues or forums, not reproduced by us.
- **hypothesis** (2): plausible and untested; never warns.

One record shows the discipline. **R-001** (`CompilationError(PrepareError(Deserialization))`) is the most-reported
NEAR build error (Reddit, near-sdk-rs #1035, near-workspaces-js #225, Stack Overflow). We tested it: a raw plain-cargo
wasm with post-MVP features deployed and initialised on the sandbox and on live testnet (node 2.14.1, protocol 88). It
does not reproduce today, so it is `historical`: it explains the error when pasted but never warns.

### Tested on real code

I ran the static rules over 150 public repos from this hackathon (50 each of Rust, TypeScript and JavaScript) and
read a sample of the flagged source by hand. Results in [docs/STUDY.md](docs/STUDY.md): 21 of 50 Rust repos have a
`#[near]` method that makes clippy warn (F-004), 17 of 100 JS/TS repos call `Account.callFunction[Raw]` and then inspect `Failure` without
`throwOnFailure: false` (F-006), 49 of 150 have at least one finding. The study also exposed false positives in four of my
own first-version rules (F-004, F-005, F-006, F-012); they are fixed and each has a regression test. It is a convenience sample, flagged repos were
not compiled, and build-breaking problems such as F-001 and F-008 show zero hits because published code has already
been fixed.

Example, found while building a lending contract for the same hackathon: **F-001**. A helper function with the same
name as a public `#[near]` method breaks only the wasm build. `cargo test --lib` still passed 18/18 with the bug;
`cargo near check` reports it in seconds.

## Contributing a friction record (and how agents help)

1. `near-doctor submit --from out.txt --command "..." --out report.md`, then open a *Friction report* issue
   ([form](.github/ISSUE_TEMPLATE/friction-report.yml)) or `gh issue create --label friction --body-file report.md`.
2. A triage workflow ([`.github/workflows/triage.yml`](.github/workflows/triage.yml), script
   [`scripts/triage.mjs`](scripts/triage.mjs)) matches the report against the log and replies with the rule, or
   attaches a **draft rule** generated from the first error line.
3. A maintainer reproduces it and adds fixtures. CI refuses a rule unless it fires on its `repro`, stays silent on its
   `control`, renders its fix without blank placeholders, and (for autofixes) turns the repro green.

Details in [CONTRIBUTING.md](CONTRIBUTING.md). Rules are data only: no shell commands or code. The only automatic fixes
are three allowlisted types (add a crate-level lint allow, add a dev-dependency, `rustup target add`).

## How it fits with existing tools

`cargo near check` (cargo-near) already type-checks a contract under the real build environment. near-doctor wraps it
for `--deep` and explains its errors; it does not replace it. `near/agent-skills` gives agents static guidance;
near-doctor adds executable checks, a verified rule database and a contribution loop.

## Limitations

- **Scanners are lightweight, not compilers.** The Rust scanner strips comments and strings and tracks braces; it is
  not a parser, so it can miss or misjudge unusual code (macro-generated items, `#[path]` modules). F-007 reads the
  installed package's type declarations and never runs the package unless you pass `--allow-exec`.
- **Evidence is narrow.** Rules were reproduced on one machine and one set of versions (macOS 15 arm64, rustc 1.100.0,
  cargo-near 0.23.0, near-sdk 5.30.1). Linux, Windows and mainnet are untested. The test suite and the demo pass on
  Node 20.20.2, 22.23.5 and 26.12.1.
- **Precision is sampled, not measured.** False positives were hunted by reading flagged source in public repos (see
  [docs/STUDY.md](docs/STUDY.md)). F-005 is a pattern match (`info`), and about a quarter of F-006 hits have the
  `Failure` check far from the call.
- **"Agents fix" is limited.** Three allowlisted autofixes plus agent-ready tasks. LLM-drafted rules are not
  implemented; the triage script drafts rules deterministically from the first error line.
- **CI and triage have each run on GitHub.** CI is green on Node 20 and 22. The triage workflow matched a test issue to F-012 and replied (one test issue, with real rustc output). Neither has had sustained use.
- **Rules ship with the tool.** `--rules DIR` loads another pack, but there is no update channel yet.
- **The npm package ships code and rules only** (no fixtures, demo or tests). `rules --check` therefore validates the rule schema only, and the demo needs the git clone.
- `explain` knows 6 error signatures. Unknown output returns exit 1 and suggests `submit`.
- Telemetry: none. Network: none unless you pass `--net`.

## Hackathon notes

- **Track:** Open Innovation (`open`).
- **What NEAR has to do with it:** near-doctor is developer tooling, not a contract. Its evidence comes from running the
  NEAR toolchain (near-sdk 5.30, cargo-near 0.23, near-api-js 7.5, near-cli 4.0.13, testnet RPC). It sends no
  transactions, holds no keys, and spent no funds, on testnet or mainnet.
- **AI assistance:** written together with an AI coding agent (Hermes Agent by Nous Research, running a Claude model),
  directed by the maintainer. The agent wrote most of the code and tests and ran the experiments recorded in the friction
  log; the maintainer chose the scope and decided what shipped. The rule-matching code has no AI in it: rules are data,
  and the merge gate is a deterministic fixture test.
- **Libraries:** none at runtime (Node standard library only). The demo contract in `demo/broken-contract` uses near-sdk 5.30.
- **When it was built:** 13 Nov 2026, inside the hackathon window, from an empty repository. Git history was rewritten once
  before the first push to replace the author email, so the earliest commits share a rewrite timestamp.
- **What is not done:** see [Limitations](#limitations).

## Development

```bash
npm test                                   # 84 tests (1 slow end-to-end test is skipped unless NEAR_DOCTOR_SLOW=1), including the fixture gate
npm run verify                             # checks each README claim: 13 PASS lines with the command behind each
npm run test:slow                          # real toolchain end to end (needs cargo + cargo-near)
npm run log                                # regenerate docs/FRICTION_LOG.md
node bin/near-doctor.mjs . --fail-on warn  # near-doctor scans itself (fixtures, rules and docs are ignored)
```

Zero runtime dependencies. License: MIT.

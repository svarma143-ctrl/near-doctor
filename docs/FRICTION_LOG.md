# NEAR friction log

Generated from `rules/*.json` by `npm run log`. Do not edit by hand.

Evidence tiers: **verified-here** = reproduced by the maintainers; **reported** = found in public issues or forums, not reproduced by us; **hypothesis** = plausible, untested (never warns).

| ID | Status | Tier | Severity | How it is used | Friction |
| --- | --- | --- | --- | --- | --- |
| E-001 | active | verified-here | error | scan | cargo-near is not installed |
| E-002 | active | reported | error | scan | The wasm32-unknown-unknown Rust target is not installed |
| F-001 | active | verified-here | error | scan+explain | Helper function has the same name as a public #[near] method (wasm-only build error) |
| F-002 | active | verified-here | error | explain | Plain `cargo check` is rejected on a contract crate |
| F-003 | active | verified-here | info | explain | near-workspaces wraps the real compile error in a long, misleading dump |
| F-004 | active | verified-here | warn | scan+explain | clippy::too_many_arguments fires on #[near] method wrappers |
| F-005 | active | verified-here | warn | scan | Sandbox balance assertions race with gas refunds when using max_gas() |
| F-006 | active | verified-here | warn | scan | near-api-js callFunction throws on failed transactions (and prints the whole outcome) |
| F-007 | active | verified-here | error | scan | Import from near-api-js that the installed version does not export (API drift) |
| F-008 | active | verified-here | error | scan | `near dev-deploy` is used but the Node near CLI no longer has it |
| F-009 | log-only | hypothesis | info | log only | npm 12 skips dependency install scripts with only a warning |
| F-010 | active | verified-here | info | scan | Two different `near` CLIs exist; the Node one is installed |
| F-011 | active | verified-here | warn | scan | Public testnet RPC is slow (several seconds per call) |
| F-012 | active | verified-here | error | scan+explain | Tests use a crate that Cargo.toml does not declare (anyhow) |
| F-013 | log-only | verified-here | info | log only | cargo near compiles the dependency tree twice on a cold cache |
| F-014 | log-only | hypothesis | info | log only | Time-based contract paths in sandbox tests (untested) |
| R-001 | historical | reported | info | scan+explain | CompilationError(PrepareError(Deserialization)) on deploy (does not reproduce on current testnet) |
| R-002 | log-only | reported | info | log only | Apple Silicon wasm build failure (R_WASM_MEMORY_ADDR_SLEB, -fPIC), unconfirmed |

## E-001: cargo-near is not installed

- Status: active; tier: verified-here; severity: error

Contracts are built with cargo-near. Without it, `cargo near ...` fails with `no such command: near`.

Evidence:
- observed: Observed 2026-11-13 on a freshly formatted Mac: `cargo near --version` failed with 'error: no such command: `near`' until the prebuilt installer script above was run.

Fix:
1. curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh
2. Verify with `cargo near --version`.

References:
- https://github.com/near/cargo-near

## E-002: The wasm32-unknown-unknown Rust target is not installed

- Status: active; tier: reported; severity: error

NEAR contracts compile to wasm32-unknown-unknown. Without the target, wasm builds fail until it is added with rustup.

Evidence:
- note: cargo-near's own proposal for `cargo near check` lists verifying that this target is installed. We installed it up front and did not observe the failure.

Fix:
1. Run `rustup target add wasm32-unknown-unknown`.

Auto-fix: `rustup-target-add`: Run `rustup target add wasm32-unknown-unknown`

References:
- https://github.com/near/cargo-near/issues/439

## F-001: Helper function has the same name as a public #[near] method (wasm-only build error)

- Status: active; tier: verified-here; severity: error

#[near] exports every public method of a contract impl as a wasm entry point with the same name, so a free function with that name in the same module collides (E0428). The host build used by `cargo test` does not generate those exports, so unit tests still pass and the error only appears when building for wasm.

Evidence:
- observed: Reproduced 2026-11-13 (macOS 15 arm64, rustc 1.100.0, cargo-near 0.23.0, near-sdk 5.30.1, node 26.12.1): with the clash, `cargo test --lib` passed 18/18 while the wasm build failed with E0428. `cargo near check` reported it in 8.5 s on a cold cache; the fixed control passed in 0.4 s.

Fix:
1. Rename the free helper function `{name}` to something that is not a public method name (for example a `compute_` prefix) and update its call sites.
2. Use `cargo near check` in your edit loop: it reports this in seconds, while `cargo test --lib` still passes with the bug present.

References:
- https://github.com/near/cargo-near/issues/439

## F-002: Plain `cargo check` is rejected on a contract crate

- Status: active; tier: verified-here; severity: error

On a contract crate, plain `cargo check` (host target) fails with near-sdk's guard even though `cargo test` works, because the guard is only lifted by the unit-testing feature or by the on-chain build environment that cargo-near sets up.

Evidence:
- observed: Reproduced 2026-11-13 (macOS 15 arm64, rustc 1.100.0, cargo-near 0.23.0, near-sdk 5.30.1, node 26.12.1): `cargo check` on the contract crate failed with this message while `cargo test --lib` passed. Whether editors (rust-analyzer) surface it was not tested.

Fix:
1. Use `cargo near check` to type-check a contract (add `--clippy` for lints). It uses the same environment as `cargo near build`.
2. Keep using `cargo test` for unit tests.

References:
- https://github.com/near/cargo-near

## F-003: near-workspaces wraps the real compile error in a long, misleading dump

- Status: active; tier: verified-here; severity: info

`near_workspaces::compile_project` reports a failed build as `error running a build command with cargo near`, followed by a note that cargo-near may not be installed, even when cargo-near is installed and the real cause is a compiler error far below in the output.

Evidence:
- observed: Reproduced 2026-11-13 (macOS 15 arm64, rustc 1.100.0, cargo-near 0.23.0, near-sdk 5.30.1, node 26.12.1): sandbox tests printed about 150 lines ending in a build failure; the real cause (E0428) was roughly 100 lines below the misleading note.

Fix:
1. Ignore the 'cargo-near is not installed' note unless `cargo near --version` itself fails.
2. Read the first `error[E....]` line in the dump (shown above as the real cause).
3. Reproduce faster with `cargo near check` in the contract directory.

## F-004: clippy::too_many_arguments fires on #[near] method wrappers

- Status: active; tier: verified-here; severity: warn

A public #[near] method with more than 7 parameters (counting self) makes clippy fail with `too many arguments` on code the macro generates. An allow attribute on the impl did not silence it; a crate-level allow did.

Evidence:
- observed: Reproduced 2026-11-13 (macOS 15 arm64, rustc 1.100.0, cargo-near 0.23.0, near-sdk 5.30.1, node 26.12.1): `cargo clippy -D warnings` failed with 'too many arguments (8/7)' on a #[near] impl; an allow on the impl did not help; a crate-level allow did.

Fix:
1. Add `#![allow(clippy::too_many_arguments)]` at the top of the crate root (after any `//!` docs) with a comment; an attribute on the impl does not silence the generated wrapper.
2. Or group the arguments into a struct if you can change the JSON interface.

Auto-fix: `rust-crate-attr`: Add a crate-level #![allow(clippy::too_many_arguments)] to the crate root

## F-005: Sandbox balance assertions race with gas refunds when using max_gas()

- Status: active; tier: verified-here; severity: warn

Prepaid gas from `.max_gas()` is refunded asynchronously, so a balance read right after a transaction can be off by up to about 1 NEAR and the refund lands later.

Evidence:
- observed: Reproduced 2026-11-13 (macOS 15 arm64, rustc 1.100.0, cargo-near 0.23.0, near-sdk 5.30.1, node 26.12.1): with max_gas the borrower balance delta read 11.0007 NEAR instead of 10 NEAR right after the transaction; explicit 60 Tgas plus fast_forward(5) gave stable results.

Fix:
1. Attach explicit gas (about 60 Tgas) instead of `.max_gas()`.
2. Call `worker.fast_forward(5)` before reading balances.
3. Allow a small gas tolerance in balance assertions.

## F-006: near-api-js callFunction throws on failed transactions (and prints the whole outcome)

- Status: active; tier: verified-here; severity: warn

In near-api-js v7, `callFunction` and `callFunctionRaw` throw when the transaction fails, and the thrown error prints the entire raw outcome (about 100 lines). Code that expects to inspect `Failure` afterwards never gets the chance.

Evidence:
- observed: Reproduced 2026-11-13 with near-api-js 7.5.3: `callFunctionRaw` threw on a failed transaction and printed the raw outcome (about 100 lines). The package README states that Account throws on failure by default.

Fix:
1. To record an expected failure use `account.signAndSendTransaction({ receiverId, actions: [actions.functionCall(...)], waitUntil: 'FINAL', throwOnFailure: false })` and inspect `status.Failure` and each `receipts_outcome[].outcome.status.Failure`.
2. Otherwise wrap the call in try/catch and catch the exported error classes instead of parsing messages.

References:
- https://www.npmjs.com/package/near-api-js

## F-007: Import from near-api-js that the installed version does not export (API drift)

- Status: active; tier: verified-here; severity: error

near-api-js v7 removed or renamed many names from 0.x (WalletConnection, keyStores, connect, nearProviders). Tutorials and coding assistants still produce 0.x code, which fails at import or at first use. This check compares each named import with the exports of the version actually installed. JavaScript files only (TypeScript type-only imports would be false positives).

Evidence:
- observed: Checked 2026-11-13: the exports of near-api-js 7.5.3 include Account, JsonRpcProvider, KeyPair, KeyPairSigner, Signer and actions, but not WalletConnection, nearProviders, keyStores, connect or Near. The migration guide states that no KeyStore implementation is included.

Fix:
1. {hint}
2. See the migration guide: https://github.com/near/near-api-js/blob/HEAD/MIGRATION.md

References:
- https://raw.githubusercontent.com/near/near-api-js/HEAD/MIGRATION.md

## F-008: `near dev-deploy` is used but the Node near CLI no longer has it

- Status: active; tier: verified-here; severity: error

Older tutorials deploy with `near dev-deploy` (or `near dev deploy`). The Node near-cli 4.0.13 command list has no such command, so scripts and instructions copied from them fail.

Evidence:
- observed: Checked 2026-11-13: `near --help` for near-cli 4.0.13 lists add-credentials, call, create-account, delete-account, deploy, generate-key, state, view and others, and no dev-deploy. The NEAR docs show `near create-account <account-id> --useFaucet` and `near deploy <account-id> <wasm-file>`.

Fix:
1. Create a funded testnet account: `near create-account <account-id>.testnet --useFaucet`.
2. Deploy with `near deploy <account-id> <wasm-file>`.

References:
- https://docs.near.org/smart-contracts/release/upgrade

## F-009: npm 12 skips dependency install scripts with only a warning

- Status: log-only; tier: hypothesis; severity: info

npm 12 blocks install scripts unless they are approved. `near-sdk-js` has a postinstall that downloads CLI dependencies, and it was skipped with a warning. Whether that breaks later builds was not observed.

Evidence:
- observed: Warning observed 2026-11-13 (npm 12.0.2): 4 packages had install scripts blocked, including near-sdk-js postinstall, node-hid, usb and fsevents. The downstream effect was not observed.

Fix:
1. If a package's tooling is missing after install, run `npm install-scripts ls` and approve only packages you trust.

## F-010: Two different `near` CLIs exist; the Node one is installed

- Status: active; tier: verified-here; severity: info

The older Node `near-cli` and the Rust `near-cli-rs` have different command sets, and tutorials mix them. The near-cli-rs site describes itself as the recommended CLI for new users.

Evidence:
- observed: Observed 2026-11-13: `npm i -g near-cli` printed about 15 deprecation warnings (@ledgerhq/*, prebuild-install, base-x) and `near --version` printed 4.0.13; near.cli.rs says near-cli-rs is recommended.

Fix:
1. Know which CLI you are using before following a tutorial: this one is the Node `near-cli`.
2. near-cli-rs is described as the recommended CLI for new users at https://near.cli.rs.

References:
- https://near.cli.rs/

## F-011: Public testnet RPC is slow (several seconds per call)

- Status: active; tier: verified-here; severity: warn

The public testnet RPC answered in 3.7 to 4.8 seconds per query. A short client timeout looks like a logic failure rather than a slow node.

Evidence:
- observed: Measured 2026-11-13: curl timings of 3.7 s and 4.8 s for two queries against https://rpc.testnet.near.org, and an 8 s timeout on RPC reads failed in a scorer service. Latency varies with time and location; run `near-doctor --net` to measure yours.

Fix:
1. Use client timeouts of at least {recommended} ms for public RPC calls.
2. Issue independent reads in parallel.
3. For anything user-facing, use a dedicated or failover RPC provider: https://docs.near.org/api/rpc/providers

References:
- https://docs.near.org/api/rpc/providers

## F-012: Tests use a crate that Cargo.toml does not declare (anyhow)

- Status: active; tier: verified-here; severity: error

Sandbox tests commonly use `anyhow::Result`. If `anyhow` is not declared, the build fails with E0433 even though near-workspaces is already a dev-dependency.

Evidence:
- observed: Reproduced 2026-11-13 (macOS 15 arm64, rustc 1.100.0, cargo-near 0.23.0, near-sdk 5.30.1, node 26.12.1): sandbox tests using `anyhow::Result` failed with E0433 until `anyhow` was added to [dev-dependencies].

Fix:
1. Add `{crate} = "1"` under [dev-dependencies] in {manifest}.

Auto-fix: `cargo-dev-dep`: Add anyhow = "1" to [dev-dependencies]

## F-013: cargo near compiles the dependency tree twice on a cold cache

- Status: log-only; tier: verified-here; severity: info

`cargo near build` and `cargo near check` first generate the ABI in a dev-profile pass and then build the wasm in a release pass, so the first build compiles all dependencies twice.

Evidence:
- observed: Observed 2026-11-13 (macOS 15 arm64, rustc 1.100.0, cargo-near 0.23.0, near-sdk 5.30.1, node 26.12.1): the build output listed about 100 crates compiled under 'Generating ABI' and again under 'Building contract'.

Fix:
1. Expect a slow first build; later builds reuse the cache.
2. Use `cargo near check` while iterating.

## F-014: Time-based contract paths in sandbox tests (untested)

- Status: log-only; tier: hypothesis; severity: info

To test a due date we waited about 62 seconds of real time. We did not test whether `worker.fast_forward` alone advances block time enough, so this entry makes no claim.

Evidence:
- observed: Not tested (2026-11-13). Kept so nobody repeats the assumption as fact.

## R-001: CompilationError(PrepareError(Deserialization)) on deploy (does not reproduce on current testnet)

- Status: historical; tier: reported; severity: info

Reports from 2023 to 2025 attribute this deploy-time error to wasm built with newer Rust (1.82+) enabling wasm features that nearcore did not yet accept; `cargo near build` post-processes the module. We could not reproduce it on current infrastructure, so this rule is historical: it explains the error when pasted but never warns by default.

Evidence:
- reproduction: {"result":"did not reproduce","sandbox":"near-workspaces 0.24: a raw plain-cargo wasm (rustc 1.100.0; target_features bulk-memory, bulk-memory-opt, call-indirect-overlong, multivalue, mutable-globals, nontrapping-fptoint, reference-types, sign-ext) deployed and `new` succeeded","testnet":"the same wasm deployed and initialised on live testnet (node 2.14.1, protocol 88) on 2026-11-13","untested":"mainnet and older nodes"}

Fix:
1. If you see this error, build with `cargo near build` (it post-processes the wasm) and compare against a known-good example contract.
2. On older nodes or toolchains, reports mention pinning Rust to 1.81 or running wasm-opt manually; check which node version you deploy to.
3. The most-cited cause is the wasm module's features, not the RPC or the SDK; check how the wasm was built before changing either.

References:
- https://reddit.com/r/nearprotocol/comments/1jt9d53/anyone_having_issues_with_latest_version_near
- https://github.com/near/near-sdk-rs/issues/1035
- https://github.com/near/near-workspaces-js/issues/225
- https://stackoverflow.com/questions/71661190/near-protocol-rpc-contract-deployment-deserialization-error

## R-002: Apple Silicon wasm build failure (R_WASM_MEMORY_ADDR_SLEB, -fPIC), unconfirmed

- Status: log-only; tier: reported; severity: info

A hackathon project README reports `relocation R_WASM_MEMORY_ADDR_SLEB cannot be used against symbol ... recompile with -fPIC` on Apple Silicon and works around it with Docker. We did not reproduce it: a pure-Rust contract built and deployed on an arm64 Mac. It is plausibly tied to C dependencies.

Evidence:
- observed: Not reproduced 2026-11-13: a pure-Rust contract built with cargo near and deployed on macOS 15 arm64.

Fix:
1. Unconfirmed. If you hit this, run `near-doctor submit` with the full error so the cause can be pinned down.

References:
- https://ethglobal.com/showcase/1inchtents-near-ffevd

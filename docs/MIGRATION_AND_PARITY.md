# Rust Migration and Parity Guide

This repository has completed migration to Rust as the active implementation.
The canonical runtime is `rust/`.

Release reference version: `v1.2.0`

## Version policy

- Merge-safe patch PRs (tests/docs/hardening only): bump patch versions.
- Feature/compatibility-impacting PRs: bump minor versions.
- Never reuse or regress below the highest existing repository tag.

Merge checklist:

- bump version in all policy sources and run `./.github/scripts/verify-version-sync.sh ...`.
- build a release binary and confirm `./rust/target/release/apw --version` and `apw status --json` report expected release shape.
- ensure the release tag is `v<version>` (for example `v1.2.0`) before pushing.

## What is archived

- Legacy Deno implementation: `legacy/deno/`
- Historical lockfile and dependencies: `legacy/deno/deno.lock`

`legacy/deno/` is intentionally frozen. It should be used for behavioral
reference only.

Archive policy:

- `legacy/deno/` is immutable by default and should not receive feature work.
- Maintenance, packaging, and release changes belong only in the Rust implementation.
- Deno tests should be run manually and only for audit/compatibility review.

Canonical archive path and governance: [`docs/ARCHIVE_POLICY.md`](docs/ARCHIVE_POLICY.md).

## Parity surface covered by Rust

- Auth flows: `auth request`, `auth response`, `auth logout`
- Session/runtime introspection: `status`
- Password flows: `start`, `pw list`, `pw get`
- OTP flows: `otp list`, `otp get`
- CLI output modes: human output plus `--json` where implemented

## Running parity checks

1. Use a temporary home for each implementation to avoid shared state.
2. Run the Rust tests:
   - `cargo test --manifest-path rust/Cargo.toml`
3. Run Rust parity harness against archived fixtures:
   - `cargo test --manifest-path rust/Cargo.toml --test legacy_parity`
4. (Optional) If you still have Deno available and need a direct re-run of the archived
   implementation, run:
   - `cd legacy/deno`
   - `deno test --allow-env --allow-read --allow-write --allow-net src/*.test.ts`
4. For manual command parity, run equivalent commands in each tool and compare
   success/error envelopes.

## Distribution targets

- Homebrew fork flow (recommended for users): create a tap/formula in your fork and
  install with `brew install <you>/apw/apw`.
- Source release flow: `cargo build --manifest-path rust/Cargo.toml --release`
  and publish `rust/target/release/apw`.

## Recommended handoff workflow

When you fork this project, keep `legacy/deno/` intact for a historical
compatibility reference while making `rust/` the only maintained delivery
path.

Before cutting a fork tag, run the security regression matrix in
`docs/SECURITY_POSTURE_AND_TESTING.md` in addition to the legacy parity checklist.

# Legacy Deno Archive

This folder contains the pre-migration Deno implementation.

Canonical archive location: `../legacy/deno/` (repo root: `legacy/deno/`).
Do not run active feature or security work from this directory.

It is intentionally preserved for:

- behavior audits
- offline historical comparison
- migration or rollback reference

## What changed

- The active implementation is now Rust-only in `../rust`.
- CI and release paths use `rust/` directly.
- `legacy/deno` is not expected to receive new feature work.

## Re-running legacy checks (optional)

If you still need a final parity pass against Deno:

- `deno test --allow-env --allow-read --allow-write --allow-net src/*.test.ts`

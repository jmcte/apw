# Security posture and test matrix (Rust)

This document tracks security-focused runtime checks and the validation commands to
run before publishing a forked release.

## 1) Rust security gates

Run these in order:

```bash
cargo fmt --manifest-path rust/Cargo.toml -- --check
cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml
cargo build --manifest-path rust/Cargo.toml --release
cd browser-bridge && npm test
```

## 2) Security-focused regression suite

The following integration cases are now covered by `rust/tests/security_regressions.rs`:

- `command_invalid_pin_is_rejected_without_network`
  - `apw --json auth --pin 12ab` returns `InvalidParam` before transport use.
- `command_invalid_url_rejected_before_auth_dependency`
  - `apw --json pw list "bad host"` does not attempt daemon contact.
- `status_json_has_stable_shape`
  - verifies machine-readable status schema with known keys and types.
- `status_binary_with_nonexistent_home_directory_isolated`
  - status command survives unusual `HOME` values.
- `pw_list_reports_failed_launch_state_before_invalid_session`
  - launch failure diagnostics win over misleading session errors.
- `status_json_preserves_failed_launch_metadata_after_command_failure`
  - launch metadata remains visible after follow-up command failures.

Targeted helper/parser security tests also run in unit tests:

- oversized/invalid config payload protection
- manifest/object shape guards
- signed envelope parsing guards
- PIN normalization and URL parsing hardening
- framed payload length and status mapping guards
- browser bridge attach/disconnect persistence and request forwarding guards
- browser-mode missing-bridge and native-host error mapping guards

## 3) Browser bridge tests

The Chrome companion extension is a self-contained package under `browser-bridge/`.
Its local unit coverage runs with the Node built-in test runner:

```bash
cd browser-bridge
npm test
```

Current coverage focuses on:

- native host connect/disconnect lifecycle
- daemon request queueing and response/request-id correlation
- reconnect after daemon WebSocket restart
- forwarding helper error envelopes verbatim
- malformed native payload handling

## 4) Manual compatibility checks

Manual command parity checks are still required for edge behavior:

```bash
cargo test --manifest-path rust/Cargo.toml --test legacy_parity
```

When Deno is available, you can additionally compare output envelopes against the
archived `legacy/deno` implementation for:

- `status --json`
- `auth request`
- `auth response`
- `pw list/get`
- `otp list/get`

## 5) Distribution checks

For release validation, keep:

```bash
./packaging/homebrew/install-from-source.sh
```

This validates:
- source tarball build
- formula install path
- `apw --version`
- `apw status --json`

For the real browser-backed helper path, use the local host smoke:

```bash
./scripts/browser-host-smoke.sh --pw-domain example.com
```

It writes a timestamped evidence bundle under `dist/host-smoke/<timestamp>/`
containing daemon logs, status snapshots, auth output, `pw`/`otp` results, and
helper crash-report diffs.

## 6) Ongoing cadence

- Run the above on every release tag.
- Keep `legacy/deno` as a read-only reference.
- Record any divergence in `docs/MIGRATION_AND_PARITY.md` before release.

## 7) Legacy archive governance

- `legacy/deno/` is an archived reference only. Canonical path and constraints are
  defined in [docs/ARCHIVE_POLICY.md](docs/ARCHIVE_POLICY.md).
- No security hardening, regression fixes, or behavior changes should be implemented there.
- Deno usage is optional and intended only for compatibility audit and historical
  comparison in release reviews.

## APW (Rust) Installation and Local Run Guide

This repo ships a Rust-native CLI/daemon (`rust/` workspace). The legacy TypeScript/Deno
implementation is retained as a read-only archive under `legacy/deno/`.
See [docs/ARCHIVE_POLICY.md](docs/ARCHIVE_POLICY.md) for the canonical archive rules.

Release reference version: `v1.2.0`

## 1) Build and install from source

```bash
cd /Users/<you>/src/omt-global/apw-native
cargo build --manifest-path rust/Cargo.toml --release
```

### Install binary manually

```bash
cp rust/target/release/apw /usr/local/bin/apw
```

### Install with Cargo

```bash
cargo install --path rust
```

or

```bash
cargo install --path rust --locked
```

## 2) Homebrew distribution path (recommended for ongoing maintenance)

### Local formula install

Use the local smoke installer script to validate Homebrew installation from this
checkout:

```bash
./packaging/homebrew/install-from-source.sh
```

The script creates a temporary tap, builds a source archive, installs, validates
`apw --version` and `apw status --json`, then cleans up automatically.

Once you publish a release with a real tap, use the formula in
`packaging/homebrew/apw.rb` with a concrete release `url`/`sha256`.

### Remote fork tap (recommended once you publish a release)

1. Fork a tap repo like `github.com/omt-global/homebrew-apw-native`.
2. Add a formula at `Formula/apw.rb` from this project’s template.
3. Fill release details (`url` + `sha256`) for the tag you publish.
4. Publish and run:

```bash
brew tap <you>/apw-native
brew install <you>/apw-native/apw-native
brew services start apw
```

## 3) Run the app

### Install the Chrome bridge on macOS 26.x

```bash
./scripts/install-browser-bridge.sh
```

Then open `chrome://extensions`, enable Developer mode, and load the unpacked
extension from:

```text
browser-bridge/
```

The extension defaults to `127.0.0.1:10000`. If you intentionally start `apw`
on a different bind or port, update the extension popup to match.

### Start the daemon

```bash
apw start
```

Optional bind/port override:

```bash
apw start --bind 127.0.0.1 --port 10000
```

### Authenticate

```bash
apw auth
```

Non-interactive PIN:

```bash
apw auth --pin 123456
```

### Check daemon/session status

```bash
apw status
apw status --json
```

## 4) Verify you’re healthy

```bash
apw status --json
```

Expected healthy shape includes:

- `daemon.host` and `daemon.port`
- `bridge.status`, `bridge.browser`, `bridge.connectedAt`
- `session.authenticated`
- `session.createdAt`
- `session.expired`

## 5) One-command local parity test

```bash
cargo test --manifest-path rust/Cargo.toml
```

For regression checks against the frozen Deno archive (optional, requires Deno CLI):

```bash
cargo test --manifest-path rust/Cargo.toml --test legacy_parity
```

### Browser-backed helper workflow (macOS 26)

On macOS 26.x, `apw start` defaults to browser mode. The daemon starts a local
UDP listener for the CLI plus a loopback WebSocket bridge on the same numeric
port. The Chrome extension then attaches through native messaging and forwards
requests to Apple’s helper.

Healthy status flow looks like:

1. `apw start`
2. `apw status --json`
   - `daemon.runtimeMode = "browser"`
   - `bridge.status = "waiting"`
3. Load the Chrome bridge extension or let it reconnect automatically
4. `apw status --json`
   - `bridge.status = "attached"`
   - `bridge.browser = "chrome"`
5. `apw auth`
6. `apw status --json`
   - `session.authenticated = true`

If you try `apw auth`, `apw pw list`, or `apw otp list` before Chrome attaches,
the CLI now returns `ProcessNotRunning` with browser-specific remediation that
points back to the extension and `bridge.status=attached`.

### Legacy direct-launch diagnostics

Direct CLI helper launch is still supported as an explicit diagnostic mode:

```bash
apw start --runtime-mode direct --dry-run
```

If the host still reports:

- `Helper process was terminated by SIGKILL (Code Signature Constraint Violation).`

then the OS is rejecting the direct-parent path and you should stay on the
browser-backed workflow above. `apw status --json` continues to preserve
`daemon.lastLaunchStatus`, `daemon.lastLaunchError`, and
`daemon.lastLaunchStrategy` for those explicit direct/launchd diagnostic runs.

## 6) Fork release workflow

This repo includes a release workflow at:

```text
.github/workflows/release.yml
```

For a local full release bootstrap (format, lint, tests, build, tag, smoke), use:

```bash
./scripts/release-bootstrap.sh
```

To include the real browser-backed helper smoke in that release gate:

```bash
./scripts/release-bootstrap.sh --host-smoke --pw-domain example.com
./scripts/release-bootstrap.sh --host-smoke --pw-domain example.com --otp-domain example.com
```

The host smoke writes a timestamped evidence bundle under:

```text
dist/host-smoke/<timestamp>/
```

Optional:

```bash
./scripts/release-bootstrap.sh --tag v1.2.0 --push
./scripts/release-bootstrap.sh --skip-tests --skip-brew-smoke
./scripts/release-bootstrap.sh --tag v1.2.1 --push --publish
```

For `--publish`:

- `gh` CLI must be logged in (`gh auth login`).
- A tarball is generated at `dist/apw-macos-<version>.tar.gz`.
- `packaging/homebrew/apw.rb` is validated so its `url` points to the same tag before publish.

Current release behavior (tag-triggered):

- runs format/lint/tests
- builds release binary
- runs `apw --version` and `apw status --json` checks
- optionally runs the browser-backed host smoke (`scripts/browser-host-smoke.sh`)
- builds a local source tarball and runs a Homebrew smoke install test
- publishes `dist/apw-macos-vX.X.X.tar.gz` as release assets

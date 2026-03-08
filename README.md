<div align="center">
  <a href="https://github.com/omt-global/apw-native">
    <img src="icon.png" alt="Logo" width="80" height="80">
  </a>

<h3 align="center">Apple Passwords CLI</h3>

<p align="center">
    A CLI for access to Apple Passwords. A foundation for enabling integration and automation.
    <br />
    <a href="https://github.com/omt-global/apw-native"><strong>Explore the docs »</strong></a>
    <br />
    <br />
    <a href="https://github.com/omt-global/apw-native">View Demo</a>
    ·
    <a href="https://github.com/omt-global/apw-native/issues">Report Bug</a>
    ·
    <a href="https://github.com/omt-global/apw-native/issues">Request Feature</a>
  </p>

[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url] [![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]
<br />

</div>

<!-- ABOUT THE PROJECT -->

## About The Project

This project introduces a CLI interface designed to access iCloud passwords and
OTP tokens. The core objective is to provide a secure and straightforward way to
retrieve iCloud passwords, facilitating integration with other systems or for
personal convenience.

This repository is now a Rust-first implementation (`rust/`). The original
TypeScript/Deno implementation is retained as a read-only archive under
`legacy/deno/` for behavior audit and rollback reference only.
[See the archive policy](docs/ARCHIVE_POLICY.md) for the canonical archived path and rules.

It utilises a built in helper tool in macOS 14 and above to facilitate this
functionality.

https://github.com/user-attachments/assets/8cb45571-d164-4e28-aa6e-64d27705d6d2

## Getting Started

See [docs/INSTALLATION.md](docs/INSTALLATION.md) for current install, Homebrew,
and local run instructions.

### Installation

#### Homebrew (recommended for day-to-day)

This repo does not ship a maintained public tap by default. For your fork, you can:

```shell
brew tap <you>/apw-native
brew install <you>/apw-native/apw-native  # once formula is published in your fork tap
brew services start apw
```

or validate local source installation with:

```shell
./packaging/homebrew/install-from-source.sh
```

The template points to release tarballs by default. Update `homepage`, `url`, and `sha256`
before publishing in your own tap.

#### Source install

From the repo root:

```shell
cd rust
cargo build --release
cp target/release/apw /usr/local/bin/apw  # or any PATH directory
```

or

```shell
cargo install --path rust
```

### Version policy

This fork is now at Release reference version: `v1.2.0`.

Release bumps are controlled by CI policy:

- Merge-safe patch PRs (tests/docs/hardening): bump patch versions.
- Feature/compatibility-impacting PRs: bump minor versions.
- Never reuse or regress below the highest existing repository tag.

When bumping, update all version surfaces listed in the CI sync check:

- `rust/Cargo.toml`
- `rust/src/main.rs` (`APP_VERSION`)
- `packaging/homebrew/apw.rb` (`version` and tag URL)
- `README.md`, `docs/INSTALLATION.md`, `docs/MIGRATION_AND_PARITY.md` release reference line.

Recommended merge-time gate:

1. Update all version surfaces
2. Run `./.github/scripts/verify-version-sync.sh rust/Cargo.toml rust/src/cli.rs rust/src/main.rs packaging/homebrew/apw.rb README.md docs/INSTALLATION.md docs/MIGRATION_AND_PARITY.md`
3. Build a release binary and verify `./rust/target/release/apw --version` reports the same version before tagging.
4. Optional: run `./scripts/release-bootstrap.sh --tag vX.Y.Z --push --publish` for local release artifact publish (requires `gh` CLI).

## Integrations

The following integrations have been completed:

- Raycast (extension link) to provide quick access to passwords and OTP tokens.
  Will automatically retrieve the keychain entry for the currently active
  webpage.

The following are some future integration ideas:

- SSH Agent to allow storing and using SSH keys/passwords via iCloud
- Menubar application to provide a standalone interface

## Usage

Ensure the daemon is running in the background, either via
`brew services start apw` (Homebrew) or `apw start`.

To authenticate the daemon interactively:

_This is required every time the daemon starts i.e on boot_

`apw auth`

Logout when a machine is handed over:

`apw auth logout`

Query for available passwords (Interactive):

`apw pw`

Query for available passwords (JSON output):

`apw pw list google.com`

View more commands & help:

`apw --help`

```shell
Options:

  -h, --help     - Show this help.                            
  -V, --version  - Show the version number for this program.  

Commands:

  auth   - Authenticate CLI with daemon.         
  status - Show daemon and session status.
  pw     - Interactively list accounts/passwords.
  otp    - Interactively list accounts/OTPs.     
  start  - Start the daemon.

Authentication/session status:

- `apw status` shows daemon host/port and stored session metadata.
- `apw status --json` returns machine-readable output.

On macOS 26.x, `auto` now resolves to a browser-backed runtime instead of trying
to launch Apple’s helper directly from `apw`. Direct CLI launch remains available
as a legacy diagnostic mode (`--runtime-mode direct` or `launchd`), but the
default supported path is:

1. Install the per-user native messaging manifest:
   `./scripts/install-browser-bridge.sh`
2. Load the unpacked extension from `browser-bridge/` in
   `chrome://extensions`.
3. Start the daemon:
   `apw start`
4. Wait for `apw status --json` to report:
   `bridge.status=attached`
5. Authenticate:
   `apw auth`

Status output now includes a top-level `bridge` object:

- `bridge.status`
- `bridge.browser`
- `bridge.connectedAt`
- `bridge.lastError`

If helper-backed commands run before Chrome attaches, they fail with
`ProcessNotRunning` and browser-specific remediation instead of a generic session
error. If the daemon is up but you have not re-authenticated since startup, the
CLI now tells you explicitly:

- `Daemon is running but not authenticated. Run \`apw auth\`.`

Direct helper launch is still useful for diagnosing host policy failures. On an
affected host, run:

- `apw start --runtime-mode direct --dry-run`
- `apw status --json`
- `ls -t ~/Library/Logs/DiagnosticReports | rg "PasswordManagerBrowserExtensionHelper" | head -n 5`

If the direct helper still reports
`Helper process was terminated by SIGKILL (Code Signature Constraint Violation).`,
that confirms the host requires the browser/native-host parent path rather than
the legacy CLI launch path.

To verify, inspect the latest crash report entries:

```bash
ls -t ~/Library/Logs/DiagnosticReports | rg \"PasswordManagerBrowserExtensionHelper\" | head -n 5
```

If this helper constraint is new in your environment, capture this for the next
release cycle; the Rust CLI is behaving as intended and the fix requires host
policy/browser-framework changes rather than CLI logic changes.

Security and storage:

- Config data is stored in `~/.apw/config.json`.
- `.apw` directory is created with mode `0700`.
- `config.json` is written with mode `0600` and replaced atomically.
- On macOS, `sharedKey` is persisted in the user keychain and `config.json`
  keeps only key metadata (`secretSource`).
- On non-macOS or legacy configs, `sharedKey` remains in `config.json` as before.
- Invalid or stale config (including missing session values, malformed timestamps or schema drift) is cleared and requires re-authentication.
```

<!-- CONTRIBUTING -->

## Building

This project ships a native Rust implementation in `rust/` for the primary CLI
daemon and runtime path.

## Legacy Deno Archive

The archived Deno implementation lives in `legacy/deno/` and is intentionally
frozen. It is not used by CI or normal install flows.

Use `legacy/deno/` only when you need a behavior audit or to diff the old and
new CLI flow.

Archive rules for this path are documented in
`docs/ARCHIVE_POLICY.md`.

Archive policy:

- `legacy/deno/` is immutable by default and should not receive new feature work.
- No compatibility behavior changes should be introduced there unless required for
  reproducible historical inspection.
- Rust (`rust/`) is the only maintained path for bug fixes, hardening, releases,
  and packaging.

First-run rule:

- On first run, follow only the Rust path and ignore `legacy/deno/` unless you are
  explicitly doing an optional compatibility audit.

### Running the Project

To run the project whilst developing:

```
cargo run --manifest-path rust/Cargo.toml -- <OPTIONS>
```

Daemon startup and CLI examples:

- `apw start --bind 127.0.0.1 --port 0`
- `apw auth --pin 123456`

### Building a release version

To run full local release bootstrap (version sync + fmt/clippy/tests + build + tag + Homebrew smoke):

```bash
./scripts/release-bootstrap.sh
```

To build just a release binary:

```
cargo build --manifest-path rust/Cargo.toml --release
```

The resulting binary is at `rust/target/release/apw`.

## Rust migration checks

Use this matrix before shipping a new fork:

- `auth request` / `auth response`
- `auth logout`
- `status`
- `pw list`
- `pw get`
- `otp list`
- `otp get`

Suggested parity workflow:

- run the Rust suite:
  - `cargo test --manifest-path rust/Cargo.toml`
- run migration compatibility checks that use archived fixtures:
  - `cargo test --manifest-path rust/Cargo.toml --test legacy_parity`
- optional legacy audit (manual only): run the archived suite in `legacy/deno/`
  when Deno is installed and you need direct behavioral re-checks.

For a full parity checklist and handoff notes, see
`docs/MIGRATION_AND_PARITY.md`.
For security regression and release hardening checks, see
`docs/SECURITY_POSTURE_AND_TESTING.md`.

## Contributing

Contributions are what make the open source community such an amazing place to
learn, inspire, and create. Any contributions you make are **greatly
appreciated**.

If you have a suggestion that would make this better, please fork the repo and
create a pull request. You can also simply open an issue with the tag
"enhancement". Don't forget to give the project a star! Thanks again!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

Distributed under the GPL V3.0 License. See `LICENSE` for more information.

## Contact

Ben Dews - [#](https://bendews.com)

Project Link: [https://github.com/omt-global/apw-native](https://github.com/omt-global/apw-native)

<!-- ACKNOWLEDGMENTS -->

## Acknowledgments

- [au2001 - iCloud Passwords for Firefox](https://github.com/au2001/icloud-passwords-firefox) -
  their SRP implementation was _so_ much better than mine.

<!-- MARKDOWN LINKS & IMAGES -->
<!-- https://www.markdownguide.org/basic-syntax/#reference-style-links -->

[contributors-shield]: https://img.shields.io/github/contributors/omt-global/apw-native.svg?style=for-the-badge
[contributors-url]: https://github.com/omt-global/apw-native/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/omt-global/apw-native.svg?style=for-the-badge
[forks-url]: https://github.com/omt-global/apw-native/network/members
[stars-shield]: https://img.shields.io/github/stars/omt-global/apw-native.svg?style=for-the-badge
[stars-url]: https://github.com/omt-global/apw-native/stargazers
[issues-shield]: https://img.shields.io/github/issues/omt-global/apw-native.svg?style=for-the-badge
[issues-url]: https://github.com/omt-global/apw-native/issues
[license-shield]: https://img.shields.io/github/license/omt-global/apw-native.svg?style=for-the-badge
[license-url]: https://github.com/omt-global/apw-native/blob/main/LICENSE
[product-screenshot]: images/screenshot.png

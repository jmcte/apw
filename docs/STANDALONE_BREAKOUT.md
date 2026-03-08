# Standalone project breakout (omt-global / apw-native)

Use these commands to create an independent standalone project copy under
`/Users/<you>/src/omt-global/apw-native` and keep this repo as the new maintained
origin.

1. Run the one-shot bootstrap helper:

```bash
cd /Users/<you>/src/apw
./scripts/bootstrap-apw-native-standalone.sh
```

2. Or run manually:

```bash
mkdir -p /Users/<you>/src/omt-global
cd /Users/<you>/src/apw
rsync -a --exclude='.git' --exclude='target' --exclude='dist' --exclude='build' . /Users/<you>/src/omt-global/apw-native/
```

3. Initialize the standalone repo and repoint remotes:

```bash
cd /Users/<you>/src/omt-global/apw-native
git init -b main
git remote add origin git@github.com:omt-global/apw-native.git
git remote -v
```

4. Commit and push:

```bash
git add -A
git commit -m "chore: rebrand repository to apw-native under omt-global"
git push -u origin <branch>
```

5. For Homebrew formula publication, keep taps aligned with the `apw-native` namespace:

- `brew tap <you>/apw-native`
- `brew install <you>/apw-native/apw-native`

Notes:

- `README.md`, `packaging/homebrew/apw.rb`, and
  `packaging/homebrew/install-from-source.sh` are set for `omt-global/apw-native`.
- `legacy/deno/` remains a read-only archive and is preserved only for compatibility
  audits/rollback.

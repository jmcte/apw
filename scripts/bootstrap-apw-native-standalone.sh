#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/bootstrap-apw-native-standalone.sh [--source PATH] [--dest PATH] [--remote URL] [--branch BRANCH]

Options:
  --source PATH    Source repo path. Default: directory of this script's parent.
  --dest PATH      Destination path for standalone repo.
                   Default: ~/src/omt-global/apw-native
  --remote URL     Git remote for standalone repo.
                   Default: git@github.com:omt-global/apw-native.git
  --branch BRANCH  Initial git branch for the new repo.
                   Default: main
  -h, --help      Show this help message.
EOF
}

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR"
DEST_DIR="${HOME}/src/omt-global/apw-native"
REMOTE_URL="git@github.com:omt-global/apw-native.git"
INITIAL_BRANCH="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_DIR="$2"
      shift 2
      ;;
    --dest)
      DEST_DIR="$2"
      shift 2
      ;;
    --remote)
      REMOTE_URL="$2"
      shift 2
      ;;
    --branch)
      INITIAL_BRANCH="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  echo "Expected a git checkout at SOURCE_DIR: $SOURCE_DIR"
  exit 1
fi

mkdir -p "$(dirname "$DEST_DIR")"
rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"

rsync -a \
  --exclude='.git' \
  --exclude='target' \
  --exclude='dist' \
  --exclude='build' \
  "$SOURCE_DIR"/ \
  "$DEST_DIR"/

cd "$DEST_DIR"
git init -b "$INITIAL_BRANCH"
git remote add origin "$REMOTE_URL"

echo "Standalone checkout created at $DEST_DIR"
echo "Remote set to $REMOTE_URL"

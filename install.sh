#!/usr/bin/env bash
# Build the latest Ken Markdown Editor and install it into VS Code.
#
#   ./install.sh                      # VS Code (`code`)
#   CODE=code-insiders ./install.sh   # or any VS Code-compatible CLI (cursor, codium, …)
set -euo pipefail

cd "$(dirname "$0")"
CODE="${CODE:-code}"

if ! command -v "$CODE" >/dev/null 2>&1; then
  echo "error: '$CODE' not found. In VS Code run 'Shell Command: Install 'code' command in PATH', or set CODE=…" >&2
  exit 1
fi

# Latest source, when this checkout tracks a remote.
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  echo "› Updating source"
  git pull --ff-only --quiet
fi

# Dependencies, when missing or out of date with the lockfile.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "› Installing dependencies"
  npm ci --no-audit --no-fund --loglevel=error
fi

version="$(node -p "require('./package.json').version")"
vsix="ken-markdown-editor-${version}.vsix"

echo "› Building ${vsix}"
log="$(mktemp)"
if ! npm run --silent package >"$log" 2>&1; then
  cat "$log" >&2
  exit 1
fi
rm -f "$log"

echo "› Installing into ${CODE}"
"$CODE" --install-extension "$vsix" --force 2>/dev/null

echo "✓ Ken Markdown Editor ${version} installed. Reload open VS Code windows (Developer: Reload Window)."

#!/usr/bin/env bash
# Verify desktop version is consistent across package.json, desktop/daemon Cargo.toml, tauri.conf.json.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PKG_VERSION="$(node -e "console.log(require('./package.json').version)")"
CARGO_VERSION="$(node -e "
const fs = require('fs');
const line = fs.readFileSync('apps/desktop/Cargo.toml','utf8').match(/^version\\s*=\\s*\"([^\"]+)\"/m);
if (!line) { console.error('version not found in Cargo.toml'); process.exit(1); }
console.log(line[1]);
")"
TAURI_VERSION="$(node -e "console.log(require('./apps/desktop/tauri.conf.json').version)")"
DAEMON_VERSION="$(node -e "
const fs = require('fs');
const line = fs.readFileSync('apps/daemon/Cargo.toml','utf8').match(/^version\\s*=\\s*\"([^\"]+)\"/m);
if (!line) { console.error('version not found in apps/daemon/Cargo.toml'); process.exit(1); }
console.log(line[1]);
")"

echo "Desktop version sources:"
echo "  package.json:            $PKG_VERSION"
echo "  apps/desktop/Cargo.toml: $CARGO_VERSION"
echo "  tauri.conf.json:         $TAURI_VERSION"
echo "  apps/daemon/Cargo.toml:  $DAEMON_VERSION"

if [[ "$PKG_VERSION" == "$CARGO_VERSION" && "$CARGO_VERSION" == "$TAURI_VERSION" && "$TAURI_VERSION" == "$DAEMON_VERSION" ]]; then
  echo "✓ All desktop version sources match ($PKG_VERSION)"
  exit 0
fi

echo "✗ Version mismatch — run: pnpm release:bump <version>"
exit 1

#!/usr/bin/env bash
# Refresh Cargo.lock package versions after a desktop version bump, then verify --locked builds.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DESKTOP_VERSION="$(node -e "console.log(require('./package.json').version)")"

echo "Syncing Cargo.lock for desktop v${DESKTOP_VERSION}…"
cargo build --manifest-path apps/desktop/Cargo.toml -p teamclaw-introspect -p amuxd >/dev/null

LOCK_TEAMCLAW="$(node -e "
const fs = require('fs');
const lock = fs.readFileSync('Cargo.lock', 'utf8');
const m = lock.match(/\\[\\[package\\]\\]\\nname = \"teamclaw\"\\nversion = \"([^\"]+)\"/);
if (!m) process.exit(1);
console.log(m[1]);
")"
LOCK_AMUXD="$(node -e "
const fs = require('fs');
const lock = fs.readFileSync('Cargo.lock', 'utf8');
const m = lock.match(/\\[\\[package\\]\\]\\nname = \"amuxd\"\\nversion = \"([^\"]+)\"/);
if (!m) process.exit(1);
console.log(m[1]);
")"

if [[ "$LOCK_TEAMCLAW" != "$DESKTOP_VERSION" || "$LOCK_AMUXD" != "$DESKTOP_VERSION" ]]; then
  echo "✗ Cargo.lock mismatch after build:"
  echo "  expected teamclaw/amuxd = ${DESKTOP_VERSION}"
  echo "  got teamclaw = ${LOCK_TEAMCLAW}, amuxd = ${LOCK_AMUXD}"
  exit 1
fi

echo "Verifying cargo build --locked…"
cargo build --locked --manifest-path apps/desktop/Cargo.toml -p teamclaw-introspect -p amuxd >/dev/null

echo "✓ Cargo.lock synced (teamclaw + amuxd = ${DESKTOP_VERSION})"

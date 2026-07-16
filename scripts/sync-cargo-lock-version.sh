#!/usr/bin/env bash
# Refresh Cargo.lock package versions after a desktop version bump, then verify --locked builds.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DESKTOP_VERSION="$(node -e "console.log(require('./package.json').version)")"

echo "Syncing Cargo.lock for desktop v${DESKTOP_VERSION}…"
cargo build --manifest-path apps/desktop/Cargo.toml -p teamclaw-introspect -p amuxd >/dev/null

# \r? on every newline: the repo ships no .gitattributes, so Git for Windows
# checks Cargo.lock out with CRLF endings on the windows runner. An \n-anchored
# regex silently misses there, node exits non-zero with no output, and `set -e`
# kills this script with no diagnostic at all — which is exactly how it failed.
lock_version() {
  node -e "
const fs = require('fs');
const lock = fs.readFileSync('Cargo.lock', 'utf8');
const name = process.argv[1];
const re = new RegExp('\\\\[\\\\[package\\\\]\\\\]\\\\r?\\\\nname = \"' + name + '\"\\\\r?\\\\nversion = \"([^\"]+)\"');
const m = lock.match(re);
if (!m) {
  console.error('✗ Cargo.lock has no [[package]] entry for ' + name);
  process.exit(1);
}
console.log(m[1]);
" "$1"
}

LOCK_TEAMCLAW="$(lock_version teamclaw)"
LOCK_AMUXD="$(lock_version amuxd)"

if [[ "$LOCK_TEAMCLAW" != "$DESKTOP_VERSION" || "$LOCK_AMUXD" != "$DESKTOP_VERSION" ]]; then
  echo "✗ Cargo.lock mismatch after build:"
  echo "  expected teamclaw/amuxd = ${DESKTOP_VERSION}"
  echo "  got teamclaw = ${LOCK_TEAMCLAW}, amuxd = ${LOCK_AMUXD}"
  exit 1
fi

echo "Verifying cargo build --locked…"
cargo build --locked --manifest-path apps/desktop/Cargo.toml -p teamclaw-introspect -p amuxd >/dev/null

echo "✓ Cargo.lock synced (teamclaw + amuxd = ${DESKTOP_VERSION})"

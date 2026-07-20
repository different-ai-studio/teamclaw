#!/usr/bin/env bash
# Refresh Cargo.lock package versions after a desktop version bump, then verify --locked builds.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DESKTOP_VERSION="$(node -e "console.log(require('./package.json').version)")"

echo "Syncing Cargo.lock for desktop v${DESKTOP_VERSION}…"
# Re-resolve ONLY the workspace members, so the `teamclaw` / `amuxd` entries pick
# up the version just written into their Cargo.toml. Third-party dependencies are
# left pinned exactly as the lock has them — this is not `generate-lockfile`.
#
# This used to be a `cargo build` of teamclaw-introspect + amuxd, relying on the
# fact that any build refreshes the lock as a side effect. That worked, but it
# paid for two full debug compiles (~290s on the windows runner, ~190s on macOS,
# per release job) and threw the artifacts away — they are debug profile, so they
# did not even warm the release build that follows.
cargo update --workspace --manifest-path apps/desktop/Cargo.toml

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

# Prove the lock is complete and consistent with every Cargo.toml, which is the
# only thing the subsequent `cargo build --locked` steps need from it. `cargo
# metadata --locked` resolves the full graph and fails if the lock would have to
# change — same guarantee as the old verification build, without compiling.
echo "Verifying Cargo.lock is up to date (--locked)…"
cargo metadata --locked --format-version 1 --manifest-path apps/desktop/Cargo.toml >/dev/null

echo "✓ Cargo.lock synced (teamclaw + amuxd = ${DESKTOP_VERSION})"

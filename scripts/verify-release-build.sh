#!/usr/bin/env bash
# Verify the full release build locally (frontend + tauri build).
# Run from repo root. Requires: rust, pnpm.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Host target triple (e.g. aarch64-apple-darwin)
TARGET="$(rustc -vV | grep '^host:' | awk '{print $2}')"
echo "Target: $TARGET"

echo "Running pnpm tauri build..."
# Unset CI so tauri build doesn't get --ci 1 (invalid); CI=true is only needed in release.yml
# Skip updater artifacts (no TAURI_SIGNING_PRIVATE_KEY locally); CI creates them with the key
env -u CI pnpm tauri build -c '{"bundle": { "createUpdaterArtifacts": false }}'

echo "Verify release build OK."

#!/usr/bin/env bash
# Verify the full release build locally (frontend + binaries + tauri build).
# externalBin in tauri.conf.json only requires opencode; rag-mcp-server/rag-mcp-bridge/autoui-mcp removed.
# Run from repo root. Requires: rust, pnpm, gh (for opencode download).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
BINARIES="$REPO_ROOT/src-tauri/binaries"
mkdir -p "$BINARIES"

# Host target triple (e.g. aarch64-apple-darwin)
TARGET="$(rustc -vV | grep '^host:' | awk '{print $2}')"
echo "Target: $TARGET"

# OpenCode (only externalBin required by tauri.conf.json)
if [ ! -f "$BINARIES/opencode-$TARGET" ]; then
  echo "Downloading opencode..."
  "$REPO_ROOT/src-tauri/binaries/download-opencode.sh" || { echo "::error::opencode download failed (need gh)"; exit 1; }
else
  echo "opencode-$TARGET present"
fi

echo "All binaries ready. Running pnpm tauri build..."
# Unset CI so tauri build doesn't get --ci 1 (invalid); CI=true is only needed in release.yml
# Skip updater artifacts (no TAURI_SIGNING_PRIVATE_KEY locally); CI creates them with the key
env -u CI pnpm tauri build -c '{"bundle": { "createUpdaterArtifacts": false }}'

echo "Verify release build OK."

#!/bin/bash
# Download the latest OpenCode binary for Tauri sidecar bundling.
# Run this after cloning the repo or anytime to upgrade.
#
# Usage:
#   pnpm update-opencode              # latest version
#   pnpm update-opencode -- v1.2.1    # specific version
#   ./src-tauri/binaries/download-opencode.sh          # latest
#   ./src-tauri/binaries/download-opencode.sh v1.2.1   # specific

set -euo pipefail

REPO="anomalyco/opencode"
BINDIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="${1:-}"

# Detect platform
ARCH="$(uname -m)"
OS="$(uname -s)"

case "$OS-$ARCH" in
  Darwin-arm64)
    ASSET_PATTERN="opencode-darwin-arm64.zip"
    TARGET_NAME="opencode-aarch64-apple-darwin"
    ;;
  Darwin-x86_64)
    ASSET_PATTERN="opencode-darwin-x64.zip"
    TARGET_NAME="opencode-x86_64-apple-darwin"
    ;;
  Linux-x86_64)
    ASSET_PATTERN="opencode-linux-x64.tar.gz"
    TARGET_NAME="opencode-x86_64-unknown-linux-gnu"
    ;;
  *)
    echo "Error: Unsupported platform $OS-$ARCH"
    exit 1
    ;;
esac

TARGET_PATH="$BINDIR/$TARGET_NAME"
VERSION_FILE="$BINDIR/.opencode-version"

# Resolve latest version
LATEST=$(gh release view --repo "$REPO" --json tagName -q '.tagName' 2>/dev/null || echo "unknown")

if [ -z "$VERSION" ]; then
  VERSION="$LATEST"
fi

# Check if already up to date
if [ -f "$TARGET_PATH" ] && [ -f "$VERSION_FILE" ]; then
  CURRENT=$(cat "$VERSION_FILE")
  if [ "$CURRENT" = "$VERSION" ]; then
    echo "OpenCode $VERSION already installed (up to date)"
    echo "  Latest: $LATEST"
    exit 0
  fi
  echo "Upgrading OpenCode: $CURRENT -> $VERSION"
else
  echo "Installing OpenCode $VERSION for $OS/$ARCH..."
fi

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

gh release download "$VERSION" --repo "$REPO" --pattern "$ASSET_PATTERN" --dir "$TMPDIR"

# Extract
if [[ "$ASSET_PATTERN" == *.zip ]]; then
  unzip -o "$TMPDIR/$ASSET_PATTERN" -d "$TMPDIR/extract" > /dev/null
elif [[ "$ASSET_PATTERN" == *.tar.gz ]]; then
  mkdir -p "$TMPDIR/extract"
  tar -xzf "$TMPDIR/$ASSET_PATTERN" -C "$TMPDIR/extract"
fi

# Install
mv "$TMPDIR/extract/opencode" "$TARGET_PATH"
chmod +x "$TARGET_PATH"

# macOS: remove quarantine and ad-hoc sign
if [ "$OS" = "Darwin" ]; then
  xattr -cr "$TARGET_PATH" 2>/dev/null || true
  codesign --force --sign - "$TARGET_PATH" 2>/dev/null || true
fi

# Record installed version
echo "$VERSION" > "$VERSION_FILE"

echo "OpenCode $VERSION installed -> $TARGET_NAME"
if [ "$VERSION" != "$LATEST" ] && [ "$LATEST" != "unknown" ]; then
  echo "  Note: latest available is $LATEST"
fi

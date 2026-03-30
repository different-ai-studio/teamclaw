#!/usr/bin/env bash
# Download OpenCode binaries for all macOS architectures (ARM64 + Intel)
# Required for dual-arch builds (pnpm tauri:build:mac:all)

set -euo pipefail

REPO="anomalyco/opencode"
BINDIR="$(cd "$(dirname "$0")/../src-tauri/binaries" && pwd)"
VERSION="${1:-}"

echo "📦 Downloading OpenCode for both macOS architectures..."
echo ""

# Resolve latest version if not specified
if [ -z "$VERSION" ]; then
  VERSION=$(gh release view --repo "$REPO" --json tagName -q '.tagName' 2>/dev/null || echo "")
  if [ -z "$VERSION" ]; then
    echo "❌ Error: Cannot determine latest OpenCode version"
    echo "   Make sure 'gh' CLI is installed and authenticated"
    exit 1
  fi
  echo "📌 Using latest version: $VERSION"
else
  echo "📌 Using specified version: $VERSION"
fi
echo ""

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# Download and install ARM64 (Apple Silicon)
echo "🔽 Downloading ARM64 (aarch64-apple-darwin)..."
gh release download "$VERSION" --repo "$REPO" --pattern "opencode-darwin-arm64.zip" --dir "$TMPDIR" --clobber
unzip -o "$TMPDIR/opencode-darwin-arm64.zip" -d "$TMPDIR/arm64" > /dev/null
mv "$TMPDIR/arm64/opencode" "$BINDIR/opencode-aarch64-apple-darwin"
chmod +x "$BINDIR/opencode-aarch64-apple-darwin"
xattr -cr "$BINDIR/opencode-aarch64-apple-darwin" 2>/dev/null || true
codesign --force --sign - "$BINDIR/opencode-aarch64-apple-darwin" 2>/dev/null || true
echo "✅ ARM64 binary installed"

# Download and install Intel (x86_64)
echo "🔽 Downloading Intel (x86_64-apple-darwin)..."
gh release download "$VERSION" --repo "$REPO" --pattern "opencode-darwin-x64.zip" --dir "$TMPDIR" --clobber
unzip -o "$TMPDIR/opencode-darwin-x64.zip" -d "$TMPDIR/x64" > /dev/null
mv "$TMPDIR/x64/opencode" "$BINDIR/opencode-x86_64-apple-darwin"
chmod +x "$BINDIR/opencode-x86_64-apple-darwin"
xattr -cr "$BINDIR/opencode-x86_64-apple-darwin" 2>/dev/null || true
codesign --force --sign - "$BINDIR/opencode-x86_64-apple-darwin" 2>/dev/null || true
echo "✅ Intel binary installed"

# Record version
echo "$VERSION" > "$BINDIR/.opencode-version"

echo ""
echo "🎉 OpenCode $VERSION installed for both architectures:"
ls -lh "$BINDIR/opencode-"* | grep -v ".sh\|README"
echo ""
echo "Now you can run: BUILD_ENV=production pnpm tauri:build:mac:all"

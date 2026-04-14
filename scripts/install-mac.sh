#!/bin/bash
set -euo pipefail

REPO="different-ai-studio/teamclaw"
APP_NAME="TeamClaw"
MOUNT_POINT="/Volumes/${APP_NAME}"

echo "Installing ${APP_NAME}..."

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  arm64)
    DMG_PATTERN="aarch64.dmg"
    echo "Detected Apple Silicon (arm64)"
    ;;
  x86_64)
    DMG_PATTERN="x64.dmg"
    echo "Detected Intel (x86_64)"
    ;;
  *)
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

# Get matching DMG URL from latest release
DMG_URL=$(curl -sL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep -o '"browser_download_url":\s*"[^"]*'"${DMG_PATTERN}"'"' \
  | head -1 \
  | cut -d'"' -f4)

if [ -z "$DMG_URL" ]; then
  echo "Error: Could not find ${DMG_PATTERN} in latest release"
  exit 1
fi

echo "Downloading from: ${DMG_URL}"
DMG_FILE=$(mktemp /tmp/teamclaw-XXXXXX.dmg)
curl -L --progress-bar -o "$DMG_FILE" "$DMG_URL"

# Unmount if already mounted
if [ -d "$MOUNT_POINT" ]; then
  hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
fi

echo "Mounting DMG..."
hdiutil attach "$DMG_FILE" -quiet -nobrowse

# Find .app in mounted volume
APP_PATH=$(find "$MOUNT_POINT" -maxdepth 1 -name "*.app" -type d | head -1)
if [ -z "$APP_PATH" ]; then
  echo "Error: No .app found in DMG"
  hdiutil detach "$MOUNT_POINT" -quiet
  rm -f "$DMG_FILE"
  exit 1
fi

# Close app if running
if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  echo "Closing running ${APP_NAME}..."
  osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true
  sleep 2
fi

echo "Installing to /Applications..."
rm -rf "/Applications/${APP_NAME}.app"
cp -R "$APP_PATH" /Applications/

# Remove quarantine attribute
xattr -dr com.apple.quarantine "/Applications/${APP_NAME}.app" 2>/dev/null || true

# Cleanup
hdiutil detach "$MOUNT_POINT" -quiet
rm -f "$DMG_FILE"

echo ""
echo "${APP_NAME} installed successfully!"
echo "Opening ${APP_NAME}..."
open "/Applications/${APP_NAME}.app"

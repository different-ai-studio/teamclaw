#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="$ROOT_DIR/apps/ios"
DERIVED_DATA_PATH="$IOS_DIR/build"
APP_PATH="$DERIVED_DATA_PATH/Build/Products/Debug-iphonesimulator/AMUX.app"
SCHEME="${IOS_SCHEME:-AMUX}"
SIMULATOR_NAME="${IOS_SIMULATOR_NAME:-iPhone 16e}"
DESTINATION="${IOS_DESTINATION:-platform=iOS Simulator,name=$SIMULATOR_NAME}"
BUNDLE_ID="${IOS_BUNDLE_ID:-tech.teamclaw.mobile}"

cd "$ROOT_DIR"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is required. Install it with: brew install xcodegen" >&2
  exit 1
fi

open -a Simulator

if ! xcrun simctl list devices booted | grep -q "(Booted)"; then
  SIMULATOR_UDID="$(
    xcrun simctl list devices available |
      awk -v name="$SIMULATOR_NAME" '
        index($0, name) && $0 ~ /\([0-9A-F-]{36}\)/ {
          match($0, /\([0-9A-F-]{36}\)/)
          print substr($0, RSTART + 1, RLENGTH - 2)
          exit
        }
      '
  )"

  if [[ -z "$SIMULATOR_UDID" ]]; then
    echo "Simulator '$SIMULATOR_NAME' not found. Set IOS_SIMULATOR_NAME to an available simulator." >&2
    xcrun simctl list devices available >&2
    exit 1
  fi

  xcrun simctl boot "$SIMULATOR_UDID" || true
  xcrun simctl bootstatus "$SIMULATOR_UDID" -b
fi

(
  cd "$IOS_DIR"
  xcodegen generate
)

xcodebuild \
  -project "$IOS_DIR/AMUX.xcodeproj" \
  -scheme "$SCHEME" \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  build

xcrun simctl install booted "$APP_PATH"
xcrun simctl launch booted "$BUNDLE_ID"

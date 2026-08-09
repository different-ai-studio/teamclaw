#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="$ROOT_DIR/apps/ios"
DERIVED_DATA_PATH="$IOS_DIR/build"
APP_PATH="$DERIVED_DATA_PATH/Build/Products/Debug-iphonesimulator/AMUX.app"
SCHEME="${IOS_SCHEME:-AMUX}"
SIMULATOR_NAME="${IOS_SIMULATOR_NAME:-iPhone 17e}"
# Filled in below once the device is resolved; targeting by id rather than by
# name keeps xcodebuild on the exact device this script booted.
DESTINATION="${IOS_DESTINATION:-}"
BUNDLE_ID="${IOS_BUNDLE_ID:-com.teamclu.mobile}"

cd "$ROOT_DIR"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is required. Install it with: brew install xcodegen" >&2
  exit 1
fi

# Resolve the target device up front, and match on "<name> (" so a name that
# is a prefix of another ("iPhone 17" vs "iPhone 17e") cannot pick the wrong
# device.
SIMULATOR_UDID="$(
  xcrun simctl list devices available |
    awk -v name="$SIMULATOR_NAME (" '
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

# Boot THIS device, not "is anything booted". Asking the looser question is how
# you end up with two simulators: Simulator.app restores whatever it had open
# last, that satisfies an "any device booted" check, and then xcodebuild boots
# the one it was actually asked for.
if ! xcrun simctl list devices booted | grep -q "$SIMULATOR_UDID"; then
  xcrun simctl boot "$SIMULATOR_UDID" || true
  xcrun simctl bootstatus "$SIMULATOR_UDID" -b
fi

# After the boot, so the window that comes up is the device we are about to
# install onto rather than whichever one was open last.
open -a Simulator

DESTINATION="${DESTINATION:-platform=iOS Simulator,id=$SIMULATOR_UDID}"

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

xcrun simctl install "$SIMULATOR_UDID" "$APP_PATH"
xcrun simctl launch "$SIMULATOR_UDID" "$BUNDLE_ID"

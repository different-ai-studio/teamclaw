#!/usr/bin/env bash
#
# run-ios-sim.sh — Build TeamClawMobile and launch it in an iOS simulator.
#
# Usage:
#   scripts/run-ios-sim.sh                       # 默认 iPhone 17 Pro
#   scripts/run-ios-sim.sh "iPhone 17"           # 指定机型
#   SIM_DEVICE="iPad Pro 13-inch (M5)" scripts/run-ios-sim.sh
#   scripts/run-ios-sim.sh --logs                # 启动后持续 stream 日志
#   scripts/run-ios-sim.sh --clean               # 清理 build/ 再构建
#
# 依赖: Xcode 26+, xcodegen (brew install xcodegen)

set -euo pipefail

# ---- Config --------------------------------------------------------------
BUNDLE_ID="tech.teamclaw.mobile"
SCHEME="TeamClawMobile"
CONFIGURATION="Debug"

# 解析路径: 本脚本位于 <repo>/scripts/run-ios-sim.sh
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_ROOT="$REPO_ROOT/TeamClawMobile"
BUILD_DIR="$IOS_ROOT/build"

# ---- Args ----------------------------------------------------------------
DEVICE="${SIM_DEVICE:-iPhone 17 Pro}"
STREAM_LOGS=0
CLEAN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --logs)  STREAM_LOGS=1; shift ;;
        --clean) CLEAN=1; shift ;;
        -h|--help)
            sed -n '2,15p' "$0"; exit 0 ;;
        *)       DEVICE="$1"; shift ;;
    esac
done

# ---- Pretty print helpers ------------------------------------------------
c_cyan()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
c_green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }

step() { c_cyan "▶ $*"; }
ok()   { c_green "✓ $*"; }
die()  { c_red "✗ $*"; exit 1; }

# ---- Preflight -----------------------------------------------------------
command -v xcodebuild >/dev/null || die "xcodebuild 未找到, 请先装 Xcode"
command -v xcrun      >/dev/null || die "xcrun 未找到"
command -v xcodegen   >/dev/null || die "xcodegen 未找到 (brew install xcodegen)"

[[ -d "$IOS_ROOT" ]] || die "找不到 iOS 工程目录: $IOS_ROOT"

# ---- Step 1: regen Xcode project from project.yml ------------------------
step "1/6  xcodegen generate"
( cd "$IOS_ROOT" && xcodegen generate >/dev/null )
ok "项目已生成"

# ---- Step 2: resolve simulator UDID --------------------------------------
step "2/6  定位 simulator: $DEVICE"
UDID="$(xcrun simctl list devices available \
    | grep -F "$DEVICE (" \
    | head -n1 \
    | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"

[[ -n "${UDID:-}" ]] || die "找不到可用 simulator: $DEVICE
可用机型:
$(xcrun simctl list devices available | grep -E 'iPhone|iPad' | sed 's/^ */  /')"
ok "UDID = $UDID"

# ---- Step 3: boot simulator (若未启动) -----------------------------------
step "3/6  启动 simulator"
STATE="$(xcrun simctl list devices | grep "$UDID" | sed -E 's/.*\((Booted|Shutdown|Booting)\).*/\1/')"
if [[ "$STATE" != "Booted" ]]; then
    xcrun simctl boot "$UDID"
fi
open -a Simulator
ok "simulator 已就绪 ($STATE → Booted)"

# ---- Step 4: build -------------------------------------------------------
if [[ "$CLEAN" == "1" ]]; then
    step "4/6  清理 build/ 目录"
    rm -rf "$BUILD_DIR"
fi

step "4/6  xcodebuild (scheme=$SCHEME, config=$CONFIGURATION)"
xcodebuild \
    -project "$IOS_ROOT/$SCHEME.xcodeproj" \
    -scheme "$SCHEME" \
    -configuration "$CONFIGURATION" \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath "$BUILD_DIR" \
    -quiet \
    build
ok "构建成功"

APP_PATH="$BUILD_DIR/Build/Products/$CONFIGURATION-iphonesimulator/$SCHEME.app"
[[ -d "$APP_PATH" ]] || die "构建产物缺失: $APP_PATH"

# ---- Step 5: install -----------------------------------------------------
step "5/6  安装到 simulator"
xcrun simctl install "$UDID" "$APP_PATH"
ok "已安装"

# ---- Step 6: launch ------------------------------------------------------
step "6/6  启动 $BUNDLE_ID"
# 若已经在运行, 先结束掉保证冷启动
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null
ok "启动成功 🎉"

echo
echo "  Simulator : $DEVICE"
echo "  UDID      : $UDID"
echo "  App       : $APP_PATH"
echo

# ---- Optional: stream logs -----------------------------------------------
if [[ "$STREAM_LOGS" == "1" ]]; then
    step "stream 日志 (Ctrl-C 退出)"
    xcrun simctl spawn "$UDID" log stream \
        --level=debug \
        --predicate "subsystem == \"$BUNDLE_ID\" OR processImagePath CONTAINS \"$SCHEME\""
fi

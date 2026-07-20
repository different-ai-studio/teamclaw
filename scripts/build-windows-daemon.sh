#!/usr/bin/env bash
# build-windows-daemon.sh — Cross-compile amuxd for Windows (x86_64) on macOS,
# then package amuxd.exe + a README + a PowerShell setup script into a zip.
#
# The zip is self-contained: copy it to a Windows machine, unzip, edit
# setup.ps1 to fill in the invite URL, run setup.ps1.
#
# Prerequisites (auto-checked):
#   - Rust + target x86_64-pc-windows-gnu
#   - mingw-w64 (brew install mingw-w64) — needed by ring's C build
#
# Usage:
#   scripts/build-windows-daemon.sh                          # all defaults
#   scripts/build-windows-daemon.sh --cloud-api-url https://copilot.example.io
#   scripts/build-windows-daemon.sh --mqtt-url wss://copilot.example.io/mqtt
#   scripts/build-windows-daemon.sh --skip-build             # reuse existing binary
#   scripts/build-windows-daemon.sh --output /tmp/my-daemon.zip
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

TARGET="x86_64-pc-windows-gnu"
DAEMON_VERSION="$(grep '^version' apps/daemon/Cargo.toml | head -1 | sed 's/.*"\(.*\)"/\1/')"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

# ── defaults (overridable via flags) ────────────────────────────────────────
CLOUD_API_URL=""
MQTT_URL=""
SKIP_BUILD=0
OUTPUT_ZIP="${ROOT_DIR}/target/amuxd-windows-${DAEMON_VERSION}-${GIT_SHA}.zip"
EXTRA_CARGO_ARGS=()

# ── parse args ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cloud-api-url)  CLOUD_API_URL="$2"; shift 2 ;;
    --mqtt-url)       MQTT_URL="$2"; shift 2 ;;
    --skip-build)     SKIP_BUILD=1; shift ;;
    --output)         OUTPUT_ZIP="$2"; shift 2 ;;
    --target)         TARGET="$2"; shift 2 ;;
    --)               shift; EXTRA_CARGO_ARGS+=("$@"); break ;;
    -h|--help)
      sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "error: unknown option: $1" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*" >&2; }
err()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }

# ── 1. prerequisite checks ──────────────────────────────────────────────────
say "checking prerequisites"

# rust target
if ! rustup target list --installed 2>/dev/null | grep -q "${TARGET}"; then
  say "installing rust target ${TARGET}"
  rustup target add "${TARGET}"
fi

# mingw-w64 (only for gnu target)
if [[ "${TARGET}" == *"-gnu" ]]; then
  MINGW_GCC="x86_64-w64-mingw32-gcc"
  if ! command -v "${MINGW_GCC}" &>/dev/null; then
    warn "mingw-w64 not found — installing via Homebrew"
    brew install mingw-w64
  fi
  if ! command -v "${MINGW_GCC}" &>/dev/null; then
    err "mingw-w64 install failed. Run: brew install mingw-w64"
    exit 1
  fi
  say "found ${MINGW_GCC}: $(command -v ${MINGW_GCC})"
fi

# ── 2. build ────────────────────────────────────────────────────────────────
if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  say "building amuxd ${DAEMON_VERSION} for ${TARGET} (${GIT_BRANCH}@${GIT_SHA})"
  # ring needs to know the C cross-compiler; cc crate auto-detects x86_64-w64-mingw32-gcc
  # but we set the env explicitly for robustness.
  export CC_x86_64_pc_windows_gnu="${MINGW_GCC:-x86_64-w64-mingw32-gcc}"
  export AR_x86_64_pc_windows_gnu="x86_64-w64-mingw32-ar"
  cargo build -p amuxd --release --target "${TARGET}" ${EXTRA_CARGO_ARGS[@]+"${EXTRA_CARGO_ARGS[@]}"}
fi

BINARY="target/${TARGET}/release/amuxd.exe"
if [[ ! -f "${BINARY}" ]]; then
  err "binary not found: ${BINARY}"
  exit 1
fi

BINARY_SIZE="$(du -h "${BINARY}" | cut -f1)"
say "built: ${BINARY} (${BINARY_SIZE})"

# ── 3. stage package contents ───────────────────────────────────────────────
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "${STAGE_DIR}"' EXIT

mkdir -p "${STAGE_DIR}/amuxd-windows"

# copy binary
cp "${BINARY}" "${STAGE_DIR}/amuxd-windows/amuxd.exe"

# ── 4. generate setup.ps1 ───────────────────────────────────────────────────
# The setup script runs on the Windows target machine. It:
#   1. copies amuxd.exe to ~/.amuxd/bin/
#   2. sets TEAMCLAW_CLOUD_API_URL (if provided)
#   3. runs amuxd init with the invite URL (if provided)
#   4. registers the scheduled task (install-service)
#   5. starts the daemon
say "generating setup.ps1"

# Escape values for PowerShell single-quoted strings
ps_escape() { echo "$1" | sed "s/'/''/g"; }

cat > "${STAGE_DIR}/amuxd-windows/setup.ps1" << PS_EOF
# setup.ps1 — Configure and start amuxd on Windows.
#
# Edit the variables below, then run in PowerShell:
#   .\setup.ps1
# Or with an invite URL:
#   .\setup.ps1 -InviteUrl 'teamclaw://invite?token=...'
#
# To re-onboard with a different invite, run:
#   .\setup.ps1 -InviteUrl 'teamclaw://invite?...' -Force
param(
    [string]\$InviteUrl = '',
    [string]\$CloudApiUrl = '$(ps_escape "${CLOUD_API_URL}")',
    [string]\$MqttUrl = '$(ps_escape "${MQTT_URL}")',
    [switch]\$Force,
    [switch]\$SkipInit,
    [switch]\$SkipService
)

\$ErrorActionPreference = 'Stop'
\$ScriptDir = Split-Path -Parent \$MyInvocation.MyCommand.Path
\$AmuxdHome = Join-Path \$env:USERPROFILE '.amuxd'
\$BinDir = Join-Path \$AmuxdHome 'bin'
\$ExePath = Join-Path \$BinDir 'amuxd.exe'

Write-Host '[setup] amuxd Windows setup' -ForegroundColor Cyan
Write-Host "[setup] binary: \$ExePath"
Write-Host "[setup] cloud API: \$CloudApiUrl"
if (\$MqttUrl) { Write-Host "[setup] MQTT URL: \$MqttUrl" }

# 1. install binary
Write-Host '[setup] installing binary...' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path \$BinDir | Out-Null
Copy-Item (Join-Path \$ScriptDir 'amuxd.exe') \$ExePath -Force
Write-Host '[setup] binary installed.' -ForegroundColor Green

# 2. set environment variable (persistent, user-level)
if (\$CloudApiUrl) {
    [Environment]::SetEnvironmentVariable('TEAMCLAW_CLOUD_API_URL', \$CloudApiUrl, 'User')
    \$env:TEAMCLAW_CLOUD_API_URL = \$CloudApiUrl
    Write-Host "[setup] set TEAMCLAW_CLOUD_API_URL = \$CloudApiUrl" -ForegroundColor Green
}

# 3. onboarding (amuxd init)
if (-not \$SkipInit) {
    if (\$InviteUrl) {
        Write-Host '[setup] running onboarding...' -ForegroundColor Cyan
        & \$ExePath init \$InviteUrl
        if (\$LASTEXITCODE -ne 0) {
            Write-Error "amuxd init failed (exit \$LASTEXITCODE)"
            exit 1
        }
        Write-Host '[setup] onboarding complete.' -ForegroundColor Green
    } else {
        Write-Host '[setup] no invite URL provided — skipping onboarding.' -ForegroundColor Yellow
        Write-Host '[setup] run: amuxd.exe init "teamclaw://invite?token=..."' -ForegroundColor Yellow
    }
}

# 4. register service (scheduled task / autostart)
if (-not \$SkipService) {
    Write-Host '[setup] registering service...' -ForegroundColor Cyan
    & \$ExePath install-service
    if (\$LASTEXITCODE -ne 0) {
        Write-Warning "install-service failed (exit \$LASTEXITCODE); starting manually"
    }
    Write-Host '[setup] service registered.' -ForegroundColor Green
}

# 5. start daemon
Write-Host '[setup] starting daemon...' -ForegroundColor Cyan
& \$ExePath start
if (\$LASTEXITCODE -ne 0) {
    Write-Warning "amuxd start exited with code \$LASTEXITCODE (may already be running)"
}
Write-Host '[setup] done.' -ForegroundColor Green
Write-Host ''
Write-Host 'Useful commands:' -ForegroundColor Cyan
Write-Host '  amuxd.exe status     # check if daemon is running'
Write-Host '  amuxd.exe stop       # stop the daemon'
Write-Host '  amuxd.exe config list # view current config'
Write-Host '  amuxd.exe doctor     # run diagnostics'
PS_EOF

# ── 5. generate README ──────────────────────────────────────────────────────
say "generating README.md"

cat > "${STAGE_DIR}/amuxd-windows/README.md" << MD_EOF
# amuxd Windows Daemon v${DAEMON_VERSION}

Build: ${GIT_BRANCH}@${GIT_SHA}
Target: ${TARGET}
Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')

## Quick start

1. Unzip this archive on a Windows machine.
2. Edit \`setup.ps1\` or pass parameters, then run in PowerShell:

\`\`\`powershell
# Option A: provide values as parameters
.\setup.ps1 -CloudApiUrl 'https://copilot.accounting.i.test.shopee.io' \`
            -InviteUrl 'teamclaw://invite?token=YOUR_TOKEN&cloud_api_url=https%3A%2F%2Fcopilot.accounting.i.test.shopee.io'

# Option B: interactive (no invite URL — just installs the binary)
.\setup.ps1 -SkipInit
\`\`\`

3. Check status:

\`\`\`powershell
amuxd.exe status
\`\`\`

## What setup.ps1 does

1. Copies \`amuxd.exe\` to \`%USERPROFILE%\.amuxd\bin\amuxd.exe\`
2. Sets \`TEAMCLAW_CLOUD_API_URL\` as a persistent user env var
3. Runs \`amuxd init\` with the invite URL (creates \`backend.toml\` + \`daemon.toml\`)
4. Registers a Windows scheduled task (login autostart) via \`amuxd install-service\`
5. Starts the daemon

## Manual setup (without setup.ps1)

\`\`\`powershell
# 1. Install binary
mkdir %USERPROFILE%\.amuxd\bin
copy amuxd.exe %USERPROFILE%\.amuxd\bin\

# 2. Set Cloud API URL
setx TEAMCLAW_CLOUD_API_URL "https://copilot.accounting.i.test.shopee.io"

# 3. Onboard with invite
%USERPROFILE%\.amuxd\bin\amuxd.exe init "teamclaw://invite?token=YOUR_TOKEN"

# 4. Register autostart
%USERPROFILE%\.amuxd\bin\amuxd.exe install-service

# 5. Start
%USERPROFILE%\.amuxd\bin\amuxd.exe start
\`\`\`

## Configuration files

| File | Location | Purpose |
|------|----------|---------|
| \`backend.toml\` | \`%USERPROFILE%\\.amuxd\backend.toml\` | Cloud API credentials (refresh token, team ID, actor ID) |
| \`daemon.toml\` | \`%USERPROFILE%\\.amuxd\daemon.toml\` | Daemon config (MQTT, agents, HTTP) |

## Network endpoints

- **Cloud API**: \`$(if [[ -n "${CLOUD_API_URL}" ]]; then echo "${CLOUD_API_URL}"; else echo "<set via --cloud-api-url or setup.ps1 -CloudApiUrl>"; fi)\`
- **MQTT WS**: \`$(if [[ -n "${MQTT_URL}" ]]; then echo "${MQTT_URL}"; else echo "<auto-resolved from Cloud API /v1/config/bootstrap>"; fi)\`

The MQTT broker URL is auto-discovered: at startup the daemon calls \`GET /v1/config/bootstrap\` on the Cloud API, which returns the \`mqtt.url\` (e.g. \`wss://host/mqtt\`).

## Useful commands

\`\`\`powershell
amuxd.exe status          # check daemon status
amuxd.exe stop            # stop running daemon
amuxd.exe config list     # view full config
amuxd.exe config get mqtt.broker_url
amuxd.exe config set mqtt.broker_url "wss://host/mqtt"
amuxd.exe doctor          # run diagnostics
amuxd.exe uninstall-service  # remove autostart task
\`\`\`

## Firewall

Allow outbound HTTPS (443) for \`amuxd.exe\` — both Cloud API and MQTT-over-WSS use port 443.
MD_EOF

# ── 6. generate .env.example ────────────────────────────────────────────────
say "generating .env.example"

cat > "${STAGE_DIR}/amuxd-windows/.env.example" << ENV_EOF
# Set these in PowerShell before running setup.ps1, or pass as parameters.
# Cloud API endpoint (required for onboarding)
TEAMCLAW_CLOUD_API_URL=${CLOUD_API_URL:-https://copilot.accounting.i.test.shopee.io}

# MQTT broker URL (optional — auto-discovered from Cloud API bootstrap)
# MQTT_URL=wss://copilot.accounting.i.test.shopee.io/mqtt

# MQTT username/password (optional — auto-discovered from Cloud API bootstrap)
# MQTT_USERNAME=teamclaw
# MQTT_PASSWORD=teamclaw2026
ENV_EOF

# ── 7. zip ──────────────────────────────────────────────────────────────────
say "packaging zip"
mkdir -p "$(dirname "${OUTPUT_ZIP}")"

# remove old zip if exists
rm -f "${OUTPUT_ZIP}"

# zip from inside the stage dir so paths are clean
(cd "${STAGE_DIR}" && zip -r "${OUTPUT_ZIP}" amuxd-windows/)

ZIP_SIZE="$(du -h "${OUTPUT_ZIP}" | cut -f1)"

# ── 8. report ───────────────────────────────────────────────────────────────
echo
say "build complete"
echo "  version : ${DAEMON_VERSION}"
echo "  git     : ${GIT_BRANCH}@${GIT_SHA}"
echo "  target  : ${TARGET}"
echo "  binary  : ${BINARY} (${BINARY_SIZE})"
echo "  zip     : ${OUTPUT_ZIP} (${ZIP_SIZE})"
echo
if [[ -z "${CLOUD_API_URL}" ]]; then
  warn "Cloud API URL not set — edit setup.ps1 or pass --cloud-api-url"
fi
echo "Next: copy the zip to a Windows machine, unzip, run setup.ps1"

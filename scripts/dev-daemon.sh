#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_CLOUD_API_URL="https://api.teamclaw-dev.ucar.cc"
CLOUD_API_URL="${1:-${TEAMCLAW_CLOUD_API_URL:-${DEFAULT_CLOUD_API_URL}}}"
LOG_DIR="${ROOT_DIR}/logs/dev"
LOG_FILE="${LOG_DIR}/amuxd.log"

export CARGO_TARGET_DIR="${ROOT_DIR}/.cargo-target"
export TEAMCLAW_CLOUD_API_URL="${CLOUD_API_URL}"
export RUST_LOG="${RUST_LOG:-info,amuxd=debug,agent_trace=info}"

mkdir -p "${LOG_DIR}"
cd "${ROOT_DIR}"

echo "==> Cloud API: ${TEAMCLAW_CLOUD_API_URL}"
echo "==> Log file: ${LOG_FILE}"
echo "==> Stopping existing amuxd processes"

if [[ -x "${HOME}/.amuxd/bin/amuxd" ]]; then
  "${HOME}/.amuxd/bin/amuxd" stop >/dev/null 2>&1 || true
fi

if [[ -x "${CARGO_TARGET_DIR}/debug/amuxd" ]]; then
  "${CARGO_TARGET_DIR}/debug/amuxd" stop >/dev/null 2>&1 || true
fi

echo "==> Building latest amuxd"
cargo build -p amuxd

echo "==> Starting amuxd from latest debug build"
exec "${CARGO_TARGET_DIR}/debug/amuxd" start 2>&1 | tee "${LOG_FILE}"

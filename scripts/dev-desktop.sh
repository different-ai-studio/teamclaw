#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_CLOUD_API_URL="https://api.teamclaw-dev.ucar.cc"
CLOUD_API_URL="${1:-${VITE_CLOUD_API_URL:-${DEFAULT_CLOUD_API_URL}}}"
LOG_DIR="${ROOT_DIR}/logs/dev"
LOG_FILE="${LOG_DIR}/desktop.log"

export VITE_CLOUD_API_URL="${CLOUD_API_URL}"
export RUST_LOG="${RUST_LOG:-info,teamclaw=debug,amux=debug}"

mkdir -p "${LOG_DIR}"
cd "${ROOT_DIR}"

echo "==> Cloud API: ${VITE_CLOUD_API_URL}"
echo "==> Log file: ${LOG_FILE}"
echo "==> Starting desktop dev build"
exec pnpm tauri:dev 2>&1 | tee "${LOG_FILE}"

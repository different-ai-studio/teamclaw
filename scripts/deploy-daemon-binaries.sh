#!/usr/bin/env bash
# deploy-daemon-binaries — build amuxd + teamclu-introspect from the current
# checkout and overwrite ~/.amuxd/bin/{amuxd,teamclu-introspect}, then reload
# the user service (launchd / systemd).
#
# Uses .cargo-target/ (same as pnpm rust:build / dev:daemon), not target/.
#
# Usage:
#   scripts/deploy-daemon-binaries.sh              # debug build, overwrite + reload
#   scripts/deploy-daemon-binaries.sh --release    # release build
#   scripts/deploy-daemon-binaries.sh --skip-build # use existing .cargo-target/<profile>/*
#   scripts/deploy-daemon-binaries.sh --no-reload  # copy only, don't touch the service
#   scripts/deploy-daemon-binaries.sh --no-sidecar # don't refresh apps/desktop/binaries/*
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${ROOT_DIR}/.cargo-target}"

LABEL="cc.ucar.amuxd"
AMUXD_HOME="${HOME}/.amuxd"
BIN_DIR="${AMUXD_HOME}/bin"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

PROFILE="debug"
SKIP_BUILD=0
NO_RELOAD=0
NO_SIDECAR=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)    PROFILE="release"; shift ;;
    --debug)      PROFILE="debug"; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-reload)  NO_RELOAD=1; shift ;;
    --no-sidecar) NO_SIDECAR=1; shift ;;
    -h|--help)
      sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "error: unknown option: $1" >&2; exit 1 ;;
  esac
done

case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*)
  AMUXD_NAME="amuxd.exe"
  INTROSPECT_NAME="teamclu-introspect.exe"
  SIDE_EXT=".exe"
  ;;
*)
  AMUXD_NAME="amuxd"
  INTROSPECT_NAME="teamclu-introspect"
  SIDE_EXT=""
  ;;
esac

TARGET="${TARGET:-$(rustc -vV 2>/dev/null | awk '/^host:/{print $2}')}"
SRC_AMUXD="${CARGO_TARGET_DIR}/${PROFILE}/${AMUXD_NAME}"
SRC_INTROSPECT="${CARGO_TARGET_DIR}/${PROFILE}/${INTROSPECT_NAME}"
DEST_AMUXD="${BIN_DIR}/${AMUXD_NAME}"
DEST_INTROSPECT="${BIN_DIR}/${INTROSPECT_NAME}"
SIDECAR_AMUXD="${ROOT_DIR}/apps/desktop/binaries/amuxd-${TARGET}${SIDE_EXT}"
SIDECAR_INTROSPECT="${ROOT_DIR}/apps/desktop/binaries/teamclu-introspect-${TARGET}${SIDE_EXT}"

GIT_SHA="$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_BRANCH="$(git -C "${ROOT_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
GIT_DIRTY=""
git -C "${ROOT_DIR}" diff --quiet 2>/dev/null || GIT_DIRTY=" (dirty)"

say() { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }

install_binary() {
  local src="$1"
  local dest="$2"
  [[ -x "${src}" ]] || { echo "error: built binary not found at ${src}" >&2; exit 1; }
  say "installing -> ${dest}"
  mkdir -p "$(dirname "${dest}")"
  local tmp="${dest}.new.$$"
  cp "${src}" "${tmp}"
  chmod +x "${tmp}"
  mv -f "${tmp}" "${dest}"
}

refresh_sidecar() {
  local src="$1"
  local dest="$2"
  say "refreshing bundled sidecar -> ${dest}"
  mkdir -p "$(dirname "${dest}")"
  local tmp="${dest}.new.$$"
  cp "${src}" "${tmp}"
  chmod +x "${tmp}"
  mv -f "${tmp}" "${dest}"
}

# ── 1. build ────────────────────────────────────────────────────────────────
if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  say "building amuxd + teamclu-introspect (${PROFILE}) from ${GIT_BRANCH}@${GIT_SHA}${GIT_DIRTY}"
  RELEASE_FLAG=()
  if [[ "${PROFILE}" == "release" ]]; then
    RELEASE_FLAG=(--release)
  fi
  cargo build -p amuxd "${RELEASE_FLAG[@]}"
  cargo build --manifest-path apps/desktop/Cargo.toml -p teamclu-introspect "${RELEASE_FLAG[@]}"
fi

# ── 2. detect platform service manager ──────────────────────────────────────
OS="$(uname -s)"
UID_NUM="$(id -u)"

service_running() {
  case "${OS}" in
    Darwin) launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 ;;
    *)      systemctl --user is-active --quiet amuxd 2>/dev/null ;;
  esac
}

stop_service() {
  case "${OS}" in
    Darwin) launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true ;;
    Linux)  systemctl --user stop amuxd 2>/dev/null || true ;;
  esac
}

start_service() {
  case "${OS}" in
    Darwin)
      if [[ -f "${PLIST}" ]]; then
        local i
        for i in 1 2 3 4 5; do
          if launchctl bootstrap "gui/${UID_NUM}" "${PLIST}" 2>/dev/null; then
            return 0
          fi
          sleep 0.5
        done
        echo "warn: launchctl bootstrap did not succeed; try: launchctl bootstrap gui/${UID_NUM} ${PLIST}" >&2
      else
        say "no launchd plist yet — registering service via 'amuxd install-service'"
        "${DEST_AMUXD}" install-service
      fi
      ;;
    Linux)
      systemctl --user restart amuxd 2>/dev/null \
        || { say "no systemd unit yet — registering via 'amuxd install-service'"; "${DEST_AMUXD}" install-service; }
      ;;
    *) echo "warn: unknown OS '${OS}', binaries copied but service not reloaded" >&2 ;;
  esac
}

# ── 3. stop, replace binaries, reload ───────────────────────────────────────
WAS_RUNNING=0
if service_running; then WAS_RUNNING=1; fi

if [[ "${NO_RELOAD}" -eq 0 && "${WAS_RUNNING}" -eq 1 ]]; then
  say "stopping ${LABEL}"
  stop_service
  for _ in $(seq 1 20); do service_running || break; sleep 0.25; done
fi

install_binary "${SRC_AMUXD}" "${DEST_AMUXD}"
install_binary "${SRC_INTROSPECT}" "${DEST_INTROSPECT}"
printf '%s  %s@%s%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${GIT_BRANCH}" "${GIT_SHA}" "${GIT_DIRTY}" "${PROFILE}" \
  > "${BIN_DIR}/amuxd.deployed"

if [[ "${NO_SIDECAR}" -eq 0 && -n "${TARGET}" ]]; then
  refresh_sidecar "${SRC_AMUXD}" "${SIDECAR_AMUXD}"
  refresh_sidecar "${SRC_INTROSPECT}" "${SIDECAR_INTROSPECT}"
elif [[ "${NO_SIDECAR}" -eq 0 ]]; then
  echo "warn: could not resolve host target (rustc missing?) — skipped sidecar refresh" >&2
fi

if [[ "${NO_RELOAD}" -eq 1 ]]; then
  say "skipped service reload (--no-reload); restart it yourself to pick up the new binaries"
else
  say "reloading service"
  start_service
fi

# ── 4. report ───────────────────────────────────────────────────────────────
echo
say "deployed amuxd + teamclu-introspect  (${GIT_BRANCH}@${GIT_SHA}${GIT_DIRTY}, ${PROFILE})"
for dest in "${DEST_AMUXD}" "${DEST_INTROSPECT}"; do
  stat -f "  %N : %Sm  %z bytes" -t "%Y-%m-%d %H:%M:%S" "${dest}" 2>/dev/null \
    || stat -c "  %n : %y  %s bytes" "${dest}" 2>/dev/null || true
done
if [[ "${NO_SIDECAR}" -eq 0 && -n "${TARGET}" ]]; then
  echo "  sidecars: apps/desktop/binaries/{amuxd,teamclu-introspect}-${TARGET}${SIDE_EXT}"
fi
if [[ "${NO_RELOAD}" -eq 0 && "${OS}" == "Darwin" ]]; then
  PID="$(launchctl print "gui/${UID_NUM}/${LABEL}" 2>/dev/null | awk -F'= ' '/[^a-z]pid =/{print $2; exit}')"
  echo "  service: ${LABEL}  pid=${PID:-<not running>}"
  echo "  logs   : tail -f ${AMUXD_HOME}/amuxd.out.log"
fi

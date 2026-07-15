#!/usr/bin/env bash
# deploy-daemon — build amuxd from the *current* checkout and overwrite the
# installed daemon that Tauri auto-starts (the launchd/systemd service binary
# at ~/.amuxd/bin/amuxd), then reload the service.
#
# Why this exists: `amuxd install-service` only (re)writes the service
# definition; it never copies a fresh binary into ~/.amuxd/bin. So after a
# `cargo build` the service keeps running the *old* binary. This script closes
# that gap: build here -> stop service -> replace binary -> reload.
#
# `amuxd --version` is hard-coded to 0.1.0 and useless for telling builds apart,
# so we stamp ~/.amuxd/bin/amuxd.deployed with the git sha + time we deployed.
#
# Usage:
#   scripts/deploy-daemon.sh              # debug build, overwrite + reload
#   scripts/deploy-daemon.sh --release    # release build (smaller/faster)
#   scripts/deploy-daemon.sh --skip-build # use the existing target/<profile>/amuxd
#   scripts/deploy-daemon.sh --no-reload  # copy only, don't touch the service
#   scripts/deploy-daemon.sh --no-sidecar # don't refresh the desktop-bundled sidecar
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

LABEL="cc.ucar.amuxd"
AMUXD_HOME="${HOME}/.amuxd"
DEST_BIN="${AMUXD_HOME}/bin/amuxd"
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
      sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "error: unknown option: $1" >&2; exit 1 ;;
  esac
done

# host target triple for the desktop sidecar filename (apps/desktop/binaries/
# amuxd-<target>). Honors $TARGET like scripts/ensure-amuxd-sidecar.js.
TARGET="${TARGET:-$(rustc -vV 2>/dev/null | awk '/^host:/{print $2}')}"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SIDE_EXT=".exe" ;; *) SIDE_EXT="" ;; esac
SIDECAR_DEST="${ROOT_DIR}/apps/desktop/binaries/amuxd-${TARGET}${SIDE_EXT}"

SRC_BIN="${ROOT_DIR}/target/${PROFILE}/amuxd"
GIT_SHA="$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_BRANCH="$(git -C "${ROOT_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
GIT_DIRTY=""
git -C "${ROOT_DIR}" diff --quiet 2>/dev/null || GIT_DIRTY=" (dirty)"

say() { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }

# ── 1. build ────────────────────────────────────────────────────────────────
if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  say "building amuxd (${PROFILE}) from ${GIT_BRANCH}@${GIT_SHA}${GIT_DIRTY}"
  if [[ "${PROFILE}" == "release" ]]; then
    cargo build -p amuxd --release
  else
    cargo build -p amuxd
  fi
fi
[[ -x "${SRC_BIN}" ]] || { echo "error: built binary not found at ${SRC_BIN}" >&2; exit 1; }

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
        # bootout is async; bootstrap can race it ("Bootstrap failed: 5: I/O
        # error"). Retry a few times.
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
        "${DEST_BIN}" install-service
      fi
      ;;
    Linux)
      systemctl --user restart amuxd 2>/dev/null \
        || { say "no systemd unit yet — registering via 'amuxd install-service'"; "${DEST_BIN}" install-service; }
      ;;
    *) echo "warn: unknown OS '${OS}', binary copied but service not reloaded" >&2 ;;
  esac
}

# ── 3. stop, replace binary, reload ─────────────────────────────────────────
WAS_RUNNING=0
if service_running; then WAS_RUNNING=1; fi

if [[ "${NO_RELOAD}" -eq 0 && "${WAS_RUNNING}" -eq 1 ]]; then
  say "stopping ${LABEL}"
  stop_service
  # wait for the process to actually exit so we can replace its file safely
  for _ in $(seq 1 20); do service_running || break; sleep 0.25; done
fi

say "installing -> ${DEST_BIN}"
mkdir -p "$(dirname "${DEST_BIN}")"
# write to a temp file then mv: atomic, and avoids ETXTBSY on a busy binary
TMP_BIN="${DEST_BIN}.new.$$"
cp "${SRC_BIN}" "${TMP_BIN}"
chmod +x "${TMP_BIN}"
mv -f "${TMP_BIN}" "${DEST_BIN}"
printf '%s  %s@%s%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${GIT_BRANCH}" "${GIT_SHA}" "${GIT_DIRTY}" "${PROFILE}" \
  > "${AMUXD_HOME}/bin/amuxd.deployed"

# ── 3b. refresh the desktop-bundled sidecar ─────────────────────────────────
# ensureAmuxdSidecar (run before `tauri:dev`/`tauri:build`) skips rebuilding
# when apps/desktop/binaries/amuxd-<target> already exists, so the bundle —
# and therefore what onboarding/setup copies back into ~/.amuxd/bin — would
# stay frozen at an old build. Overwrite it with this build so a re-onboard
# can't quietly revert the daemon to stale code.
if [[ "${NO_SIDECAR}" -eq 0 ]]; then
  if [[ -n "${TARGET}" ]]; then
    say "refreshing bundled sidecar -> apps/desktop/binaries/amuxd-${TARGET}${SIDE_EXT}"
    mkdir -p "$(dirname "${SIDECAR_DEST}")"
    cp "${SRC_BIN}" "${SIDECAR_DEST}.new.$$"
    chmod +x "${SIDECAR_DEST}.new.$$"
    mv -f "${SIDECAR_DEST}.new.$$" "${SIDECAR_DEST}"
  else
    echo "warn: could not resolve host target (rustc missing?) — skipped sidecar refresh" >&2
  fi
fi

if [[ "${NO_RELOAD}" -eq 1 ]]; then
  say "skipped service reload (--no-reload); restart it yourself to pick up the new binary"
else
  say "reloading service"
  start_service
fi

# ── 4. report ───────────────────────────────────────────────────────────────
echo
say "deployed amuxd  (${GIT_BRANCH}@${GIT_SHA}${GIT_DIRTY}, ${PROFILE})"
stat -f "  binary : %Sm  %z bytes" -t "%Y-%m-%d %H:%M:%S" "${DEST_BIN}" 2>/dev/null \
  || stat -c "  binary : %y  %s bytes" "${DEST_BIN}" 2>/dev/null || true
if [[ "${NO_SIDECAR}" -eq 0 && -n "${TARGET}" ]]; then
  echo "  sidecar: ${SIDECAR_DEST}  (onboarding/setup installs this into ~/.amuxd/bin)"
fi
if [[ "${NO_RELOAD}" -eq 0 && "${OS}" == "Darwin" ]]; then
  PID="$(launchctl print "gui/${UID_NUM}/${LABEL}" 2>/dev/null | awk -F'= ' '/[^a-z]pid =/{print $2; exit}')"
  echo "  service: ${LABEL}  pid=${PID:-<not running>}"
  echo "  logs   : tail -f ${AMUXD_HOME}/amuxd.out.log   (needs #344 plist; else stdout is dropped)"
fi

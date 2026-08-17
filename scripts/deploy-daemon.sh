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

# Where cargo actually writes. This used to be hardcoded to
# "${ROOT_DIR}/target", which is wrong the moment CARGO_TARGET_DIR or
# .cargo/config.toml redirects the build — and this checkout does redirect it.
# The build then succeeded, this script picked a *five-day-old* binary out of
# the abandoned target/ directory, and deployed it while printing "deployed
# amuxd". Ask cargo where it writes instead of assuming.
resolve_target_dir() {
  local from_cargo
  from_cargo="$(cd "${ROOT_DIR}" && cargo metadata --format-version 1 --no-deps 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])' 2>/dev/null)"
  if [[ -n "${from_cargo}" ]]; then
    printf '%s' "${from_cargo}"
  elif [[ -n "${CARGO_TARGET_DIR:-}" ]]; then
    printf '%s' "${CARGO_TARGET_DIR}"
  else
    printf '%s' "${ROOT_DIR}/target"
  fi
}
TARGET_DIR="$(resolve_target_dir)"
SRC_BIN="${TARGET_DIR}/${PROFILE}/amuxd"
GIT_SHA="$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_BRANCH="$(git -C "${ROOT_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
GIT_DIRTY=""
git -C "${ROOT_DIR}" diff --quiet 2>/dev/null || GIT_DIRTY=" (dirty)"

say() { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }

# ── 1. build ────────────────────────────────────────────────────────────────
if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  say "building amuxd (${PROFILE}) from ${GIT_BRANCH}@${GIT_SHA}${GIT_DIRTY}"
  say "  target dir: ${TARGET_DIR}"
  if [[ "${PROFILE}" == "release" ]]; then
    cargo build -p amuxd --release
  else
    cargo build -p amuxd
  fi
fi
[[ -x "${SRC_BIN}" ]] || { echo "error: built binary not found at ${SRC_BIN}" >&2; exit 1; }

# Refuse to ship a binary older than the sources it is supposed to contain.
#
# Not "older than this run": an up-to-date rebuild legitimately does nothing and
# leaves the mtime alone. What is never legitimate is deploying a binary that
# predates a source edit — which is what both known failure modes look like. A
# redirected target dir put a five-day-old file here once, and cargo has been
# seen returning a cached artifact that skipped the bin target entirely. Neither
# says anything at the call site: the deploy reports success and the change
# quietly does not take effect.
if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  STALE_SRC="$(find "${ROOT_DIR}/apps/daemon" "${ROOT_DIR}/crates" \
                    -name target -prune -o \
                    -type f \( -name '*.rs' -o -name 'Cargo.toml' \) \
                    -newer "${SRC_BIN}" -print -quit 2>/dev/null || true)"
  if [[ -n "${STALE_SRC}" ]]; then
    cat >&2 <<EOF
error: ${SRC_BIN}
       is older than ${STALE_SRC}
       so the build did not produce it and deploying would ship stale code.
       Check that cargo writes to ${TARGET_DIR} (CARGO_TARGET_DIR /
       .cargo/config.toml), then re-run. To ship this file anyway: --skip-build.
EOF
    exit 1
  fi
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

# Whether a service *definition* exists at all — distinct from `service_running`,
# which only says whether it is up right now. This gates the ~/.amuxd/bin
# install: without a service, that copy is a second amuxd nobody runs, and
# having two made "which binary am I actually testing?" unanswerable.
service_installed() {
  case "${OS}" in
    Darwin) [[ -f "${PLIST}" ]] ;;
    Linux)  systemctl --user cat amuxd >/dev/null 2>&1 ;;
    *)      return 1 ;;
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

# The service binary is only worth writing when something will run it: either a
# service is already installed, or we are about to install one below (the reload
# path registers it via `amuxd install-service`, which needs this file). With
# neither, ~/.amuxd/bin/amuxd is a second copy that nothing launches — and a
# second copy is how a debugging session ends up testing the wrong binary.
INSTALLED_BIN=0
if service_installed || [[ "${NO_RELOAD}" -eq 0 ]]; then
  say "installing -> ${DEST_BIN}"
  mkdir -p "$(dirname "${DEST_BIN}")"
  # write to a temp file then mv: atomic, and avoids ETXTBSY on a busy binary
  TMP_BIN="${DEST_BIN}.new.$$"
  cp "${SRC_BIN}" "${TMP_BIN}"
  chmod +x "${TMP_BIN}"
  mv -f "${TMP_BIN}" "${DEST_BIN}"
  printf '%s  %s@%s%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${GIT_BRANCH}" "${GIT_SHA}" "${GIT_DIRTY}" "${PROFILE}" \
    > "${AMUXD_HOME}/bin/amuxd.deployed"
  INSTALLED_BIN=1
else
  say "no service installed (and --no-reload) — leaving ${DEST_BIN} alone"
fi

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
# Report whichever file this run actually wrote, so the size/mtime printed here
# is the one that will run — the whole point of the checks above.
REPORT_BIN="${SRC_BIN}"
[[ "${INSTALLED_BIN}" -eq 1 ]] && REPORT_BIN="${DEST_BIN}"
stat -f "  binary : %Sm  %z bytes" -t "%Y-%m-%d %H:%M:%S" "${REPORT_BIN}" 2>/dev/null \
  || stat -c "  binary : %y  %s bytes" "${REPORT_BIN}" 2>/dev/null || true
if [[ "${NO_SIDECAR}" -eq 0 && -n "${TARGET}" ]]; then
  echo "  sidecar: ${SIDECAR_DEST}  (onboarding/setup installs this into ~/.amuxd/bin)"
fi
if [[ "${NO_RELOAD}" -eq 0 && "${OS}" == "Darwin" ]]; then
  PID="$(launchctl print "gui/${UID_NUM}/${LABEL}" 2>/dev/null | awk -F'= ' '/[^a-z]pid =/{print $2; exit}')"
  echo "  service: ${LABEL}  pid=${PID:-<not running>}"
  echo "  logs   : tail -f ${AMUXD_HOME}/amuxd.out.log   (needs #344 plist; else stdout is dropped)"
fi

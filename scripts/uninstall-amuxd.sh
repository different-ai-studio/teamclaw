#!/usr/bin/env bash
# Uninstall the locally-installed amuxd daemon and/or the opencode runtime so the
# first-run setup + daemon-onboarding flow can be tested again from a clean state.
#
# Everything amuxd installs lives UNDER ~/.amuxd (per-user, NOT system-global):
#   ~/.amuxd/bin/amuxd          - the daemon binary (copied by the setup wizard)
#   ~/.amuxd/bin/opencode       - the opencode runtime (downloaded by `amuxd install-opencode`)
#   ~/.amuxd/.opencode-version  - records the installed opencode version
#   ~/.amuxd/daemon.toml | backend.toml | members.toml | sessions.toml | workspaces.toml
#   ~/.amuxd/amuxd.http.{port,token} | amuxd.pid | amuxd.sock
# The background SERVICE definition lives OUTSIDE ~/.amuxd:
#   macOS:  ~/Library/LaunchAgents/cc.ucar.amuxd.plist  (+ launchctl registration)
#   Linux:  ~/.config/systemd/user/amuxd.service        (+ systemctl --user)
#
# Usage:
#   scripts/uninstall-amuxd.sh                 # full: stop service + remove ~/.amuxd (amuxd + opencode + config)
#   scripts/uninstall-amuxd.sh --opencode-only # only remove the opencode runtime (keep amuxd + onboarding)
#   scripts/uninstall-amuxd.sh --keep-config   # remove binaries + service + runtime files, KEEP team identity (daemon.toml/backend.toml)
#
# Safe + idempotent: only touches amuxd-owned paths; missing items are skipped.

set -euo pipefail

AMUXD_DIR="$HOME/.amuxd"
LAUNCHD_LABEL="cc.ucar.amuxd"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
SYSTEMD_UNIT="$HOME/.config/systemd/user/amuxd.service"

mode="full"
case "${1:-}" in
  --opencode-only) mode="opencode" ;;
  --keep-config)   mode="keep-config" ;;
  "")              mode="full" ;;
  *) echo "unknown option: $1" >&2; echo "usage: $0 [--opencode-only|--keep-config]" >&2; exit 2 ;;
esac

remove_opencode() {
  rm -f "$AMUXD_DIR/bin/opencode" "$AMUXD_DIR/bin/opencode.exe" "$AMUXD_DIR/.opencode-version"
  echo "  removed opencode runtime (~/.amuxd/bin/opencode + .opencode-version)"
}

stop_service() {
  # Prefer the daemon's own deregister command when the binary is still present.
  if [ -x "$AMUXD_DIR/bin/amuxd" ]; then
    "$AMUXD_DIR/bin/amuxd" uninstall-service >/dev/null 2>&1 || true
  fi
  case "$(uname -s)" in
    Darwin)
      local uid; uid="$(id -u)"
      launchctl bootout "gui/${uid}/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
      rm -f "$LAUNCHD_PLIST"
      echo "  stopped + removed launchd service ($LAUNCHD_LABEL)"
      ;;
    Linux)
      systemctl --user disable --now amuxd.service >/dev/null 2>&1 || true
      rm -f "$SYSTEMD_UNIT"
      echo "  stopped + removed systemd --user unit (amuxd.service)"
      ;;
    *)
      echo "  (note: stop the amuxd service manually on this OS, e.g. delete the scheduled task)"
      ;;
  esac
}

case "$mode" in
  opencode)
    echo "Uninstalling opencode runtime only..."
    remove_opencode
    echo "Done. amuxd + onboarding state left intact."
    ;;
  keep-config)
    echo "Uninstalling amuxd binaries + service + opencode (keeping team identity)..."
    stop_service
    remove_opencode
    rm -f "$AMUXD_DIR/bin/amuxd" "$AMUXD_DIR/bin/amuxd.exe"
    rm -f "$AMUXD_DIR/amuxd.http.port" "$AMUXD_DIR/amuxd.http.token" \
          "$AMUXD_DIR/amuxd.pid" "$AMUXD_DIR/amuxd.sock"
    echo "  removed amuxd binary + runtime files (kept daemon.toml/backend.toml)"
    echo "Done."
    ;;
  full)
    echo "Full uninstall: stopping service and removing ~/.amuxd ..."
    stop_service
    rm -rf "$AMUXD_DIR"
    echo "  removed $AMUXD_DIR (amuxd binary, opencode, all config + runtime state)"
    echo "Done. Next app launch starts from a clean daemon state."
    ;;
esac

#!/usr/bin/env bash
# Wipe all TeamClaw / amuxd local config and cache so the next launch starts
# from a clean slate (first-run setup, daemon onboarding, login, etc.).
#
# Safe + idempotent: only touches TeamClaw-owned paths; missing items are skipped.
#
# Usage:
#   scripts/reset-local-state.sh                 # interactive confirm
#   scripts/reset-local-state.sh -y              # skip confirm
#   scripts/reset-local-state.sh -n              # dry-run (list only)
#   scripts/reset-local-state.sh -y --short-name copilot361 --app-id com.copilot361.app
#   scripts/reset-local-state.sh -y --keep-workspace      # skip <workspace>/.teamclaw
#   scripts/reset-local-state.sh -y --keep-opencode      # skip global OpenCode dirs
#
# Does NOT delete:
#   - Cloud account / team data (Supabase / Cloud API)
#   - Workspace content outside `.teamclaw/` (e.g. `teamclaw-team/` synced files)
#   - The workspace directory itself

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

AMUXD_DIR="${HOME}/.amuxd"
LAUNCHD_LABEL="cc.ucar.amuxd"
LAUNCHD_PLIST="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
SYSTEMD_UNIT="${HOME}/.config/systemd/user/amuxd.service"

# Legacy hardcoded keys in the frontend (session-store, etc.) survive white-label builds.
LEGACY_STORAGE_PREFIX="teamclaw"

yes_mode=0
dry_run=0
include_workspace=1
include_opencode=1
explicit_workspace=0
brand_only=0
cli_app_id=""
cli_short_name=""
WORKSPACE_PATHS=()
BRAND_APP_IDS=()
BRAND_SHORT_NAMES=()
BRAND_DISPLAY_NAMES=()
STORAGE_KEY_PREFIXES=()

expand_path() {
  local p="$1"
  if [[ "$p" == "~" ]]; then
    printf '%s\n' "$HOME"
  elif [[ "$p" == "~/"* ]]; then
    printf '%s\n' "${HOME}/${p#~/}"
  else
    printf '%s\n' "$p"
  fi
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  -y, --yes                 Skip confirmation prompt
  -n, --dry-run             Print paths that would be removed; do not delete
  --include-workspace       Also remove workspace .teamclaw dirs (default: on)
  --keep-workspace          Do not remove <workspace>/.teamclaw
  --workspace PATH          Extra workspace whose .teamclaw/ dir to remove (repeatable)
  --app-id ID               Limit reset to one brand (e.g. com.copilot361.app)
  --short-name NAME         Limit reset to one brand (e.g. copilot361)
  --include-opencode        Remove global OpenCode data (default: on)
  --keep-opencode           Do not remove global OpenCode data
  -h, --help                Show this help

Removes (user-level):
  - ~/.amuxd                     amuxd daemon binary, config, team sync state
  - ~/.teamclaw, ~/.copilot361   per-brand desktop cache, secrets, local-cache.db
  - Tauri app data/cache/logs    per bundle id (e.g. com.copilot361.app)
  - WebKit / WebView2 profile     localStorage (auth session), IndexedDB, cookies
  - ~/.config/<shortName>        global skills, cron-global (Linux/macOS XDG path)
  - <workspace>/.<shortName>     per-workspace config (auto-discovered from webview)
  - Legacy ~/.config/amux, ~/Library/Application Support/{amux,teamclaw,copilot361}
  - ~/.opencode (+ ~/.local/share/opencode, ~/.config/opencode, ~/.cache/opencode)
    global OpenCode runtime and data (default: on; use --keep-opencode to skip)

Quit the desktop app before running. The script unloads the amuxd launchd/systemd
job before killing the process so KeepAlive cannot recreate ~/.amuxd.

By default the script resets every detected brand profile (TeamClaw, Copilot 361,
and any profile found in build.config.json or on disk).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes) yes_mode=1 ;;
    -n|--dry-run) dry_run=1 ;;
    --include-workspace) include_workspace=1 ;;
    --keep-workspace) include_workspace=0 ;;
    --include-opencode) include_opencode=1 ;;
    --keep-opencode) include_opencode=0 ;;
    --workspace)
      shift
      [[ $# -gt 0 ]] || { echo "error: --workspace requires a path" >&2; exit 2; }
      WORKSPACE_PATHS+=("$(expand_path "$1")")
      include_workspace=1
      explicit_workspace=1
      ;;
    --app-id)
      shift
      [[ $# -gt 0 ]] || { echo "error: --app-id requires a value" >&2; exit 2; }
      cli_app_id="$1"
      brand_only=1
      ;;
    --short-name)
      shift
      [[ $# -gt 0 ]] || { echo "error: --short-name requires a value" >&2; exit 2; }
      cli_short_name="$1"
      brand_only=1
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

brand_profile_key() {
  printf '%s\0%s' "$1" "$2"
}

add_brand_profile() {
  local app_id="$1"
  local short_name="$2"
  local display_name="${3:-$short_name}"
  local key existing i

  [[ -n "$app_id" && -n "$short_name" ]] || return 0
  key="$(brand_profile_key "$app_id" "$short_name")"

  for i in "${!BRAND_APP_IDS[@]}"; do
    existing="$(brand_profile_key "${BRAND_APP_IDS[$i]}" "${BRAND_SHORT_NAMES[$i]}")"
    if [[ "$existing" == "$key" ]]; then
      return 0
    fi
  done

  BRAND_APP_IDS+=("$app_id")
  BRAND_SHORT_NAMES+=("$short_name")
  BRAND_DISPLAY_NAMES+=("$display_name")
}

add_storage_key_prefix() {
  local prefix="$1"
  local p

  [[ -n "$prefix" ]] || return 0
  for p in "${STORAGE_KEY_PREFIXES[@]:-}"; do
    [[ "$p" == "$prefix" ]] && return 0
  done
  STORAGE_KEY_PREFIXES+=("$prefix")
}

load_brand_profiles_from_build_config() {
  local line app_id short_name display_name

  while IFS=$'\t' read -r app_id short_name display_name; do
    [[ -n "$app_id" && -n "$short_name" ]] || continue
    add_brand_profile "$app_id" "$short_name" "$display_name"
  done < <(node "${SCRIPT_DIR}/lib/resolve-brand-profiles.mjs" 2>/dev/null || true)
}

infer_app_id_for_short_name() {
  local short_name="$1"
  case "$(uname -s)" in
    Darwin)
      if [[ -d "${HOME}/Library/WebKit/com.${short_name}.app" ]]; then
        printf 'com.%s.app\n' "$short_name"
        return 0
      fi
      if [[ -d "${HOME}/Library/Application Support/com.${short_name}.app" ]]; then
        printf 'com.%s.app\n' "$short_name"
        return 0
      fi
      ;;
  esac
  if [[ "$short_name" == "teamclaw" ]]; then
    printf '%s\n' "com.teamclaw.app"
  else
    printf '%s\n' "com.${short_name}.app"
  fi
}

detect_brand_profiles_from_disk() {
  local app_id short_name home_dir

  case "$(uname -s)" in
    Darwin)
      for app_id in com.teamclaw.app com.copilot361.app; do
        short_name="${app_id#com.}"
        short_name="${short_name%.app}"
        if [[ -d "${HOME}/Library/WebKit/${app_id}" || -d "${HOME}/Library/Application Support/${app_id}" || -d "${HOME}/.${short_name}" ]]; then
          add_brand_profile "$app_id" "$short_name"
        fi
      done
      if [[ -d "${HOME}/Library/WebKit/teamclaw" ]]; then
        add_brand_profile "com.teamclaw.app" "teamclaw" "TeamClaw"
      fi
      ;;
  esac

  for home_dir in "${HOME}"/.[a-z0-9]*; do
    [[ -d "$home_dir" ]] || continue
    short_name="${home_dir##*/}"
    short_name="${short_name#.}"
    [[ "$short_name" == "amuxd" || "$short_name" == "config" || "$short_name" == "local" ]] && continue
    if [[ -f "${home_dir}/local-cache.db" || -d "${home_dir}/secrets" ]]; then
      app_id="$(infer_app_id_for_short_name "$short_name")"
      add_brand_profile "$app_id" "$short_name"
    fi
  done
}

resolve_brand_profiles() {
  BRAND_APP_IDS=()
  BRAND_SHORT_NAMES=()
  BRAND_DISPLAY_NAMES=()

  if [[ "$brand_only" -eq 1 ]]; then
    local short_name="${cli_short_name:-teamclaw}"
    local app_id="${cli_app_id:-$(infer_app_id_for_short_name "$short_name")}"
    if [[ -n "$cli_app_id" && -z "$cli_short_name" ]]; then
      short_name="${cli_app_id#com.}"
      short_name="${short_name%.app}"
    fi
    add_brand_profile "$app_id" "$short_name"
  else
    load_brand_profiles_from_build_config
    detect_brand_profiles_from_disk
  fi

  if ((${#BRAND_APP_IDS[@]} == 0)); then
    add_brand_profile "com.teamclaw.app" "teamclaw" "TeamClaw"
  fi

  STORAGE_KEY_PREFIXES=()
  add_storage_key_prefix "$LEGACY_STORAGE_PREFIX"
  local i
  for i in "${!BRAND_SHORT_NAMES[@]}"; do
    add_storage_key_prefix "${BRAND_SHORT_NAMES[$i]}"
  done
}

remove_path() {
  local target="$1"
  if [[ ! -e "$target" ]]; then
    return 0
  fi
  if [[ "$dry_run" -eq 1 ]]; then
    echo "  [dry-run] would remove: $target"
    return 0
  fi
  rm -rf "$target"
  echo "  removed: $target"
}

unload_amuxd_background_service() {
  case "$(uname -s)" in
    Darwin)
      local uid
      uid="$(id -u)"
      # Unload before killing the process: launchd KeepAlive respawns amuxd and
      # recreates ~/.amuxd if we pkill first.
      launchctl bootout "gui/${uid}/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
      rm -f "$LAUNCHD_PLIST"
      ;;
    Linux)
      systemctl --user disable --now amuxd.service >/dev/null 2>&1 || true
      rm -f "$SYSTEMD_UNIT"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      ;;
    MINGW*|MSYS*|CYGWIN*)
      schtasks /Delete /F /TN amuxd >/dev/null 2>&1 || true
      ;;
  esac
}

wait_for_amuxd_exit() {
  local i
  for i in $(seq 1 25); do
    pgrep -x amuxd >/dev/null 2>&1 || return 0
    sleep 0.2
  done
  pkill -9 -x amuxd >/dev/null 2>&1 || true
  sleep 0.5
}

amuxd_service_loaded() {
  case "$(uname -s)" in
    Darwin)
      local uid
      uid="$(id -u)"
      launchctl print "gui/${uid}/${LAUNCHD_LABEL}" >/dev/null 2>&1
      ;;
    Linux)
      systemctl --user is-active amuxd.service >/dev/null 2>&1
      ;;
    MINGW*|MSYS*|CYGWIN*)
      schtasks /Query /TN amuxd >/dev/null 2>&1
      ;;
    *)
      return 1
      ;;
  esac
}

verify_amuxd_fully_stopped() {
  local issues=0

  if pgrep -x amuxd >/dev/null 2>&1; then
    echo "  warning: amuxd process still running after stop/uninstall" >&2
    issues=1
  fi

  if [[ -f "$LAUNCHD_PLIST" || -f "$SYSTEMD_UNIT" ]]; then
    echo "  warning: amuxd service registration file still present" >&2
    issues=1
  fi

  if amuxd_service_loaded; then
    echo "  warning: amuxd background service still loaded in the session manager" >&2
    issues=1
  fi

  if [[ -e "$AMUXD_DIR" ]]; then
    echo "  warning: ${AMUXD_DIR} still exists (service may have respawned the daemon)" >&2
    issues=1
  fi

  return "$issues"
}

stop_amuxd_service() {
  if [[ "$dry_run" -eq 1 ]]; then
    echo "  [dry-run] would stop and fully uninstall amuxd background service"
    return 0
  fi

  # 1. Drop launchd/systemd/schtasks registration first so KeepAlive cannot respawn.
  unload_amuxd_background_service

  # 2. Graceful stop + redundant uninstall hook when the installed binary exists.
  if [[ -x "${AMUXD_DIR}/bin/amuxd" ]]; then
    "${AMUXD_DIR}/bin/amuxd" stop >/dev/null 2>&1 || true
    "${AMUXD_DIR}/bin/amuxd" uninstall-service >/dev/null 2>&1 || true
  fi

  # 3. Kill any leftover dev/foreground instances, then wait for exit.
  pkill -x amuxd >/dev/null 2>&1 || true
  wait_for_amuxd_exit

  # 4. Belt-and-suspenders: ensure registration files and loaded jobs are gone.
  unload_amuxd_background_service
}

warn_running_app() {
  local found=0
  case "$(uname -s)" in
    Darwin)
      if pgrep -xq "TeamClaw" 2>/dev/null; then found=1; fi
      if pgrep -xq "teamclaw" 2>/dev/null; then found=1; fi
      if pgrep -f "Copilot 361" >/dev/null 2>&1; then found=1; fi
      ;;
    Linux)
      if pgrep -xf ".*[Tt]eam[Cc]law.*" >/dev/null 2>&1; then found=1; fi
      if pgrep -xf ".*[Cc]opilot.*361.*" >/dev/null 2>&1; then found=1; fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      if tasklist 2>/dev/null | grep -qiE "TeamClaw|Copilot 361"; then found=1; fi
      ;;
  esac
  if [[ "$found" -eq 1 ]]; then
    echo "warning: a TeamClaw / Copilot desktop app appears to be running — quit it first to avoid stale locks." >&2
  fi
}

tauri_paths_for_brand() {
  local app_id="$1"
  case "$(uname -s)" in
    Darwin)
      echo "${HOME}/Library/Application Support/${app_id}"
      echo "${HOME}/Library/Caches/${app_id}"
      echo "${HOME}/Library/Logs/${app_id}"
      ;;
    Linux)
      echo "${HOME}/.local/share/${app_id}"
      echo "${HOME}/.cache/${app_id}"
      echo "${HOME}/.local/state/${app_id}"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      if [[ -n "${APPDATA:-}" ]]; then
        echo "${APPDATA}/${app_id}"
      fi
      if [[ -n "${LOCALAPPDATA:-}" ]]; then
        echo "${LOCALAPPDATA}/${app_id}"
        echo "${LOCALAPPDATA}/${app_id}/cache"
      fi
      ;;
  esac
}

# Webview profile data (localStorage auth session, IndexedDB, cookies). On macOS
# this lives under ~/Library/WebKit/<app>, NOT under Application Support.
desktop_webview_paths_for_brand() {
  local app_id="$1"
  local short_name="$2"
  case "$(uname -s)" in
    Darwin)
      echo "${HOME}/Library/WebKit/${short_name}"
      echo "${HOME}/Library/WebKit/${app_id}"
      echo "${HOME}/Library/Caches/${short_name}"
      echo "${HOME}/Library/Caches/${app_id}"
      echo "${HOME}/Library/Preferences/${short_name}.plist"
      echo "${HOME}/Library/HTTPStorages/${short_name}"
      echo "${HOME}/Library/HTTPStorages/${short_name}.binarycookies"
      echo "${HOME}/Library/Saved Application State/${app_id}.savedState"
      ;;
    Linux)
      echo "${HOME}/.local/share/${short_name}"
      echo "${HOME}/.cache/${short_name}"
      echo "${HOME}/.local/state/${short_name}"
      echo "${HOME}/.config/${short_name}/WebKit"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      if [[ -n "${LOCALAPPDATA:-}" ]]; then
        echo "${LOCALAPPDATA}/${short_name}"
        echo "${LOCALAPPDATA}/${short_name}/EBWebView"
        echo "${LOCALAPPDATA}/${app_id}/EBWebView"
      fi
      if [[ -n "${APPDATA:-}" ]]; then
        echo "${APPDATA}/${short_name}"
      fi
      ;;
  esac
}

xdg_paths_for_brand() {
  local short_name="$1"
  echo "${HOME}/.config/${short_name}"
}

legacy_config_paths_for_brand() {
  local short_name="$1"
  case "$(uname -s)" in
    Darwin)
      echo "${HOME}/Library/Application Support/amux"
      echo "${HOME}/Library/Application Support/${short_name}"
      ;;
    Linux)
      echo "${HOME}/.config/amux"
      echo "${HOME}/.config/${short_name}"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      if [[ -n "${APPDATA:-}" ]]; then
        echo "${APPDATA}/amux"
        echo "${APPDATA}/${short_name}"
      fi
      ;;
  esac
}

home_dir_for_brand() {
  local short_name="$1"
  printf '%s/.%s\n' "$HOME" "$short_name"
}

opencode_paths() {
  # Official installer target (amuxd doctor / setup_install probe this path).
  echo "${HOME}/.opencode"
  echo "${HOME}/.local/share/opencode"
  echo "${HOME}/.config/opencode"
  echo "${HOME}/.cache/opencode"
  echo "${HOME}/.local/state/plugin-update-check.json"
}

resolve_workspace_dot_dir() {
  local ws="$1"
  local short_name="$2"
  ws="$(expand_path "$ws")"
  printf '%s/.%s\n' "$ws" "$short_name"
}

is_valid_workspace_path() {
  local ws="$1"
  [[ -n "$ws" && "$ws" == /* && "$ws" != "/" ]]
}

webkit_localstorage_roots_for_brand() {
  local app_id="$1"
  local short_name="$2"
  case "$(uname -s)" in
    Darwin)
      echo "${HOME}/Library/WebKit/${app_id}"
      echo "${HOME}/Library/WebKit/${short_name}"
      ;;
    Linux)
      echo "${HOME}/.local/share/${short_name}"
      echo "${HOME}/.local/share/${app_id}"
      ;;
    *)
      ;;
  esac
}

discover_workspace_paths_from_db() {
  local db="$1"
  local prefix ws val key

  for prefix in "${STORAGE_KEY_PREFIXES[@]}"; do
    val="$(sqlite3 "$db" "SELECT value FROM ItemTable WHERE key='${prefix}-workspace-path' LIMIT 1;" 2>/dev/null || true)"
    if is_valid_workspace_path "$val"; then
      WORKSPACE_PATHS+=("$val")
    fi

    while IFS= read -r key; do
      [[ -n "$key" ]] || continue
      case "$key" in
        "${prefix}-selected-model::"*)
          ws="${key#"${prefix}-selected-model::"}"
          ws="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.argv[1]))' "$ws" 2>/dev/null || printf '%s' "$ws")"
          is_valid_workspace_path "$ws" && WORKSPACE_PATHS+=("$ws")
          ;;
        "${prefix}-pre-team-model::"*)
          ws="${key#"${prefix}-pre-team-model::"}"
          ws="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.argv[1]))' "$ws" 2>/dev/null || printf '%s' "$ws")"
          is_valid_workspace_path "$ws" && WORKSPACE_PATHS+=("$ws")
          ;;
      esac
    done < <(sqlite3 "$db" "SELECT key FROM ItemTable WHERE key LIKE '${prefix}-selected-model::%' OR key LIKE '${prefix}-pre-team-model::%';" 2>/dev/null || true)
  done
}

# Read persisted workspace paths from webview localStorage before we delete it.
discover_workspace_paths() {
  local i root db

  for i in "${!BRAND_APP_IDS[@]}"; do
    while IFS= read -r root; do
      [[ -n "$root" && -d "$root" ]] || continue
      while IFS= read -r db; do
        [[ -f "$db" ]] || continue
        discover_workspace_paths_from_db "$db"
      done < <(find "$root" -name 'localstorage.sqlite3' 2>/dev/null)
    done < <(webkit_localstorage_roots_for_brand "${BRAND_APP_IDS[$i]}" "${BRAND_SHORT_NAMES[$i]}")
  done
}

collect_workspace_dot_dir_targets() {
  local -a ws_paths=()
  local ws dot short_name display_name i

  if [[ "$explicit_workspace" -eq 0 ]]; then
    for i in "${!BRAND_DISPLAY_NAMES[@]}"; do
      display_name="${BRAND_DISPLAY_NAMES[$i]}"
      ws_paths+=("${HOME}/${display_name}")
    done
    ws_paths+=("${HOME}/TeamClaw")
    ws_paths+=("${HOME}/Copilot 361")
    discover_workspace_paths
  fi
  if ((${#WORKSPACE_PATHS[@]} > 0)); then
    ws_paths+=("${WORKSPACE_PATHS[@]}")
  fi

  local -a unique_ws=()
  local seen=0 u
  if ((${#ws_paths[@]} == 0)); then
    return 0
  fi
  for ws in "${ws_paths[@]}"; do
    [[ -n "$ws" ]] || continue
    is_valid_workspace_path "$ws" || continue
    seen=0
    if ((${#unique_ws[@]} > 0)); then
      for u in "${unique_ws[@]}"; do
        if [[ "$u" == "$ws" ]]; then
          seen=1
          break
        fi
      done
    fi
    if [[ "$seen" -eq 0 ]]; then
      unique_ws+=("$ws")
    fi
  done

  for ws in "${unique_ws[@]}"; do
    for short_name in "${BRAND_SHORT_NAMES[@]}"; do
      dot="$(resolve_workspace_dot_dir "$ws" "$short_name")"
      TARGETS+=("$dot")
    done
    # Older white-label builds still wrote workspace metadata under teamclaw keys
    # but may have kept the legacy .teamclaw workspace dir name.
    dot="$(resolve_workspace_dot_dir "$ws" "$LEGACY_STORAGE_PREFIX")"
    TARGETS+=("$dot")
  done
}

collect_targets() {
  TARGETS=()
  local i p

  TARGETS+=("$AMUXD_DIR")

  for i in "${!BRAND_APP_IDS[@]}"; do
    TARGETS+=("$(home_dir_for_brand "${BRAND_SHORT_NAMES[$i]}")")
    while IFS= read -r p; do
      [[ -n "$p" ]] && TARGETS+=("$p")
    done < <(tauri_paths_for_brand "${BRAND_APP_IDS[$i]}")
    while IFS= read -r p; do
      [[ -n "$p" ]] && TARGETS+=("$p")
    done < <(desktop_webview_paths_for_brand "${BRAND_APP_IDS[$i]}" "${BRAND_SHORT_NAMES[$i]}")
    while IFS= read -r p; do
      [[ -n "$p" ]] && TARGETS+=("$p")
    done < <(xdg_paths_for_brand "${BRAND_SHORT_NAMES[$i]}")
    while IFS= read -r p; do
      [[ -n "$p" ]] && TARGETS+=("$p")
    done < <(legacy_config_paths_for_brand "${BRAND_SHORT_NAMES[$i]}")
  done

  if [[ "$include_opencode" -eq 1 ]]; then
    while IFS= read -r p; do
      [[ -n "$p" ]] && TARGETS+=("$p")
    done < <(opencode_paths)
  fi

  if [[ "$include_workspace" -eq 1 ]]; then
    collect_workspace_dot_dir_targets
  fi
}

dedupe_targets() {
  local -a unique=()
  local target u seen
  ((${#TARGETS[@]} > 0)) || return 0
  for target in "${TARGETS[@]}"; do
    seen=0
    if ((${#unique[@]} > 0)); then
      for u in "${unique[@]}"; do
        if [[ "$u" == "$target" ]]; then
          seen=1
          break
        fi
      done
    fi
    if [[ "$seen" -eq 0 ]]; then
      unique+=("$target")
    fi
  done
  TARGETS=("${unique[@]}")
}

confirm() {
  if [[ "$yes_mode" -eq 1 || "$dry_run" -eq 1 ]]; then
    return 0
  fi
  echo
  echo "This will permanently delete local TeamClaw / amuxd state listed above"
  echo "(including webview login session, setup flags, and cached preferences)."
  echo "You will need to sign in and complete setup again."
  printf "Proceed? [y/N]: "
  local answer
  read -r answer
  case "$answer" in
    y|Y|yes|YES|Yes) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
}

main() {
  warn_running_app
  resolve_brand_profiles

  echo "TeamClaw local reset"
  echo "===================="
  echo "Brand profiles:"
  local i
  for i in "${!BRAND_APP_IDS[@]}"; do
    echo "  - ${BRAND_DISPLAY_NAMES[$i]} (${BRAND_APP_IDS[$i]}, .${BRAND_SHORT_NAMES[$i]})"
  done

  collect_targets
  dedupe_targets

  local existing=0
  local target
  echo
  echo "Targets:"
  for target in "${TARGETS[@]}"; do
    if [[ -e "$target" ]]; then
      echo "  - $target"
      existing=1
    else
      echo "  - $target (absent)"
    fi
  done

  if [[ "$existing" -eq 0 && "$dry_run" -eq 0 ]]; then
    echo
    echo "Nothing to clear — already clean."
    exit 0
  fi

  confirm

  echo
  echo "Stopping amuxd service..."
  stop_amuxd_service

  echo
  echo "Removing local state..."
  for target in "${TARGETS[@]}"; do
    remove_path "$target"
  done

  if [[ "$dry_run" -eq 0 ]]; then
    echo
    echo "Verifying amuxd is fully uninstalled..."
    if ! verify_amuxd_fully_stopped; then
      echo "  retrying amuxd cleanup..."
      stop_amuxd_service
      remove_path "$AMUXD_DIR"
      if ! verify_amuxd_fully_stopped; then
        echo
        echo "amuxd could not be fully removed. Quit TeamClaw, run:" >&2
        echo "  launchctl bootout gui/\$(id -u)/${LAUNCHD_LABEL}" >&2
        echo "  pkill -x amuxd" >&2
        echo "then re-run: pnpm reset:local -y" >&2
        exit 1
      fi
    fi
  fi

  echo
  if [[ "$dry_run" -eq 1 ]]; then
    echo "Dry-run complete. Re-run with -y to apply."
  else
    echo "Done. Launch the desktop app to start from a clean local state."
  fi
}

main

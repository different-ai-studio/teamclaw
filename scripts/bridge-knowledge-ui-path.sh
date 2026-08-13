#!/usr/bin/env bash
# =============================================================================
# bridge-knowledge-ui-path.sh
#
# 临时绕过（App 已按 brand 解析 amuxd home 后，新版本通常不再需要本脚本；
# 仍可用于尚未升级的安装，或本机 ~/.amuxd 与白牌 home 不一致时的手工对齐）。
#
# 白牌 App（如 Copilot 361）同步成功后，知识库侧栏仍显示
# 「本机还没有设置团队共享目录。」
#
# 历史原因：旧前端硬编码读官方路径
#   ~/.amuxd/daemon.toml
#   ~/.amuxd/teams/<team_id>/shared/teamclu-team
# 而白牌 daemon 的真实数据在
#   ~/.amuxd-<brand>/teams/<team_id>/shared/teamclu-team
#
# 本脚本在 ~/.amuxd 下写入/补齐 UI 要读的路径（软链到白牌真实目录），
# 不改云端数据。优先升级到含 brand-aware Knowledge 路径的版本。
#
# 适用：macOS / Linux，已完成本机团队同步、知识库列仍为空的成员。
#
# 用法（可单独拷贝本文件发给同事）：
#   chmod +x bridge-knowledge-ui-path.sh
#   ./bridge-knowledge-ui-path.sh -n                  # 先看会改什么
#   ./bridge-knowledge-ui-path.sh                     # 执行
#   ./bridge-knowledge-ui-path.sh --brand copilot361  # 指定白牌
#   ./bridge-knowledge-ui-path.sh --workspace ~/proj  # 顺带修该 workspace 的 symlink
#   ./bridge-knowledge-ui-path.sh --force             # 官方路径已是真目录时，挪走并改软链
#
# 执行后：回到 App → 知识库 → 点刷新（或切走再切回）。
# =============================================================================

set -euo pipefail

dry_run=0
force=0
cli_brand=""
workspaces=()

OFFICIAL_AMUXD="${HOME}/.amuxd"
TEAM_LINK_NAME="teamclu-team"

usage() {
  sed -n '3,28p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--dry-run) dry_run=1; shift ;;
    --brand)
      cli_brand="${2:-}"
      [[ -n "$cli_brand" ]] || { echo "--brand needs a value (e.g. copilot361)" >&2; exit 1; }
      shift 2
      ;;
    --workspace)
      [[ -n "${2:-}" ]] || { echo "--workspace needs a path" >&2; exit 1; }
      workspaces+=("$2")
      shift 2
      ;;
    --force) force=1; shift ;;
    -h|--help) usage 0 ;;
    *)
      echo "Unknown arg: $1" >&2
      usage 1
      ;;
  esac
done

say() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }
run() {
  if [[ "$dry_run" -eq 1 ]]; then
    say "DRY  $*"
  else
    say "+ $*"
    "$@"
  fi
}

abs_path() {
  local p="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath "$p" 2>/dev/null || printf '%s\n' "$p"
  else
    (cd "$p" 2>/dev/null && pwd -P) || printf '%s\n' "$p"
  fi
}

read_active_team() {
  local toml="$1"
  [[ -f "$toml" ]] || return 1
  local team
  team="$(
    awk '
      /^[[:space:]]*(active_team|team_id)[[:space:]]*=/ {
        if (match($0, /"[^"]+"/)) {
          print substr($0, RSTART + 1, RLENGTH - 2)
          exit
        }
      }
    ' "$toml"
  )"
  team="${team//[[:space:]]/}"
  [[ -n "$team" && "$team" != "_unclaimed" ]] || return 1
  printf '%s\n' "$team"
}

brand_home_for() {
  local brand="$1"
  if [[ "$brand" == "teamclu" ]]; then
    printf '%s\n' "$OFFICIAL_AMUXD"
  else
    printf '%s\n' "${HOME}/.amuxd-${brand}"
  fi
}

# Score a candidate home: must have claimed daemon.toml + a shared tree
# (or v1 teamclu-team) that contains knowledge/.
candidate_shared() {
  local home="$1"
  local team shared v1
  team="$(read_active_team "${home}/daemon.toml" || true)"
  [[ -n "${team:-}" ]] || return 1
  shared="${home}/teams/${team}/shared/${TEAM_LINK_NAME}"
  if [[ -d "$shared/knowledge" ]]; then
    printf '%s\t%s\t%s\n' "$home" "$team" "$shared"
    return 0
  fi
  v1="${home}/teams/${team}/${TEAM_LINK_NAME}"
  if [[ -d "$v1/knowledge" ]]; then
    printf '%s\t%s\t%s\n' "$home" "$team" "$v1"
    return 0
  fi
  return 1
}

list_brand_homes() {
  ls -1dt "${HOME}"/.amuxd-* 2>/dev/null || true
}

discover_source() {
  local line home team shared

  if [[ -n "$cli_brand" ]]; then
    home="$(brand_home_for "$cli_brand")"
    if [[ ! -d "$home" ]]; then
      err "Brand home missing: ${home}"
      err "Hint: ls -d ~/.amuxd-*"
      exit 1
    fi
    if ! line="$(candidate_shared "$home")"; then
      err "No usable knowledge tree under ${home}"
      err "Need: daemon.toml (active_team) + teams/<id>/shared/teamclu-team/knowledge"
      exit 1
    fi
    printf '%s\n' "$line"
    return 0
  fi

  # Prefer white-label homes (newest first) — that is the usual broken case.
  while IFS= read -r home; do
    [[ -d "$home" ]] || continue
    if line="$(candidate_shared "$home")"; then
      printf '%s\n' "$line"
      return 0
    fi
  done < <(list_brand_homes)

  # Official ~/.amuxd already has what the UI wants — nothing to bridge, but
  # still report it so the operator can tell "UI path is fine; refresh App".
  if line="$(candidate_shared "$OFFICIAL_AMUXD")"; then
    printf '%s\n' "$line"
    return 0
  fi

  err "找不到可用的本地团队共享目录。"
  err ""
  err "请确认："
  err "  1) 已用白牌/官方 App 完成团队同步"
  err "  2) 存在 ~/.amuxd-<brand>/daemon.toml（含 active_team）"
  err "  3) 存在 .../teams/<team_id>/shared/teamclu-team/knowledge/"
  err ""
  err "本机看到的 amuxd home："
  if [[ -d "$OFFICIAL_AMUXD" ]]; then
    err "  ${OFFICIAL_AMUXD}"
  fi
  while IFS= read -r home; do
    err "  ${home}"
  done < <(list_brand_homes)
  err ""
  err "也可显式指定：  $0 --brand copilot361"
  exit 1
}

ensure_dir() {
  local d="$1"
  [[ -d "$d" ]] && return 0
  run mkdir -p "$d"
}

# Patch/create ~/.amuxd/daemon.toml so the frontend can read active_team.
# Only touches the team id line; keeps the rest of an existing file.
ensure_official_daemon_toml() {
  local team_id="$1"
  local path="${OFFICIAL_AMUXD}/daemon.toml"
  ensure_dir "$OFFICIAL_AMUXD"

  if [[ -f "$path" ]]; then
    local current=""
    current="$(read_active_team "$path" || true)"
    if [[ "$current" == "$team_id" ]]; then
      say "ok  ${path} already has active_team=\"${team_id}\""
      return 0
    fi
    if [[ "$dry_run" -eq 1 ]]; then
      say "DRY  set active_team=\"${team_id}\" in ${path}"
      return 0
    fi
    say "+ set active_team=\"${team_id}\" in ${path}"
    local tmp
    tmp="$(mktemp)"
    grep -vE '^\s*(active_team|team_id)\s*=' "$path" >"$tmp" || true
    { printf 'active_team = "%s"\n' "$team_id"; cat "$tmp"; } >"$path"
    rm -f "$tmp"
    return 0
  fi

  if [[ "$dry_run" -eq 1 ]]; then
    say "DRY  write ${path} (active_team only)"
  else
    say "+ write ${path} (active_team only)"
    printf 'active_team = "%s"\n' "$team_id" >"$path"
  fi
}

ensure_shared_bridge() {
  local team_id="$1"
  local real_shared="$2"
  local bridge_parent="${OFFICIAL_AMUXD}/teams/${team_id}/shared"
  local bridge="${bridge_parent}/${TEAM_LINK_NAME}"
  local real_abs bridge_abs

  ensure_dir "$bridge_parent"
  real_abs="$(abs_path "$real_shared")"

  if [[ -e "$bridge" || -L "$bridge" ]]; then
    bridge_abs="$(abs_path "$bridge")"
    if [[ "$bridge_abs" == "$real_abs" ]]; then
      say "ok  UI path already resolves to the same tree"
      say "    ${bridge}"
      return 0
    fi
  fi

  if [[ -L "$bridge" ]]; then
    run ln -sfn "$real_abs" "$bridge"
    return 0
  fi

  if [[ -d "$bridge" ]]; then
    if [[ -d "$bridge/knowledge" && "$force" -ne 1 ]]; then
      say "ok  ${bridge} already has knowledge/ — UI can read it"
      say "    若你希望强制改成指向白牌目录的软链，请加 --force"
      return 0
    fi
    if [[ "$force" -eq 1 ]]; then
      local bak="${bridge}.bak-$(date +%Y%m%d%H%M%S)"
      run mv "$bridge" "$bak"
      say "    previous tree moved to ${bak}"
      run ln -sfn "$real_abs" "$bridge"
      return 0
    fi
    err "拒绝覆盖已存在的目录: ${bridge}"
    err "加 --force 会先挪到旁路再创建软链。"
    exit 1
  fi

  if [[ -e "$bridge" ]]; then
    err "拒绝覆盖非目录条目: ${bridge}"
    exit 1
  fi

  run ln -sfn "$real_abs" "$bridge"
}

# Fix one workspace's teamclu-team link so FileBrowser (workspace-relative
# knowledgeRoot) sees the same tree as the bridge.
fix_workspace_link() {
  local ws="$1"
  local real_shared="$2"
  local link target real_abs

  # Allow either the workspace root or the link path itself.
  if [[ "$(basename "$ws")" == "$TEAM_LINK_NAME" ]]; then
    link="$ws"
    ws="$(dirname "$ws")"
  else
    link="${ws%/}/${TEAM_LINK_NAME}"
  fi

  real_abs="$(abs_path "$real_shared")"

  if [[ ! -e "$ws" ]]; then
    err "workspace 不存在，跳过: ${ws}"
    return 0
  fi

  if [[ -L "$link" ]]; then
    target="$(readlink "$link" || true)"
    if [[ "$(abs_path "$link")" == "$real_abs" ]]; then
      say "ok  workspace link already correct: ${link}"
      return 0
    fi
    say "fix workspace link: ${link}"
    say "  was → ${target}"
    say "  now → ${real_abs}"
    run ln -sfn "$real_abs" "$link"
    return 0
  fi

  if [[ -e "$link" ]]; then
    err "workspace 下已有非软链的 ${TEAM_LINK_NAME}，跳过: ${link}"
    err "请手工确认后删除/挪走，再重跑并带 --workspace"
    return 0
  fi

  say "create workspace link: ${link} → ${real_abs}"
  run ln -sfn "$real_abs" "$link"
}

# ── main ───────────────────────────────────────────────────────────────────

LINE="$(discover_source)"
SOURCE_HOME="$(printf '%s\n' "$LINE" | cut -f1)"
TEAM_ID="$(printf '%s\n' "$LINE" | cut -f2)"
REAL_SHARED="$(printf '%s\n' "$LINE" | cut -f3)"
REAL_SHARED="$(abs_path "$REAL_SHARED")"
UI_PATH="${OFFICIAL_AMUXD}/teams/${TEAM_ID}/shared/${TEAM_LINK_NAME}"

say "======== Knowledge UI path bridge ========"
say "Source home : ${SOURCE_HOME}"
say "Team id     : ${TEAM_ID}"
say "Real shared : ${REAL_SHARED}"
say "UI expects  : ${UI_PATH}"
[[ "$dry_run" -eq 1 ]] && say "Mode        : dry-run (no changes)"
say ""

if [[ -d "${REAL_SHARED}/knowledge" ]]; then
  say "knowledge/ 里有："
  ls -1 "${REAL_SHARED}/knowledge" | sed 's/^/  /' || true
  say ""
else
  err "警告: ${REAL_SHARED}/knowledge 不存在，桥接后侧栏仍可能为空。"
fi

# Source already IS the official UI path → only need workspace link fixes.
if [[ "$(abs_path "$SOURCE_HOME")" == "$(abs_path "$OFFICIAL_AMUXD")" ]] \
  && [[ "$(abs_path "$REAL_SHARED")" == "$(abs_path "$UI_PATH" 2>/dev/null || echo "")" ]]; then
  say "官方 ~/.amuxd 路径本身已可用，无需桥接。"
else
  ensure_official_daemon_toml "$TEAM_ID"
  ensure_shared_bridge "$TEAM_ID" "$REAL_SHARED"
fi

if [[ ${#workspaces[@]} -gt 0 ]]; then
  say ""
  say "---- workspace links ----"
  for ws in "${workspaces[@]}"; do
    fix_workspace_link "$ws" "$REAL_SHARED"
  done
fi

say ""
say "完成。请在 App 里打开「知识库」并点刷新。"
say "若仍为空，把当前打开的 workspace 路径加上再跑一次："
say "  $0 --workspace \"/path/to/your/workspace\""
say ""
say "自检："
say "  cat ~/.amuxd/daemon.toml | head"
say "  ls ~/.amuxd/teams/${TEAM_ID}/shared/teamclu-team/knowledge"

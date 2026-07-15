#!/bin/bash
# Shared macOS DMG install helpers — sourced by install-mac.sh / install-mac-cn.sh.
# Mount point and app name are discovered from the DMG (works for TeamClaw, Copilot 361, …).

set -euo pipefail

INSTALL_MOUNT_POINT=""
INSTALL_APP_PATH=""
INSTALL_APP_NAME=""

# Optional override before sourcing: APP_NAME (product display name).
# When unset, the name is taken from the .app bundle inside the DMG.

install_mac_read_config_app_name() {
  local config_path="$1"
  [[ -f "$config_path" ]] || return 0
  python3 - <<'PY' "$config_path" 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1]) as f:
        name = json.load(f).get("app", {}).get("name")
    if isinstance(name, str) and name.strip():
        print(name.strip())
except Exception:
    pass
PY
}

# Collect candidate product names for OSS DMG filename guessing (deduped, order preserved).
install_mac_product_name_candidates() {
  local repo_root="${1:-}"
  local seen=""
  local name

  if [[ -n "${APP_NAME:-}" ]]; then
    echo "$APP_NAME"
    seen="|${APP_NAME}|"
  fi

  if [[ -n "$repo_root" ]]; then
    for config in \
      "$repo_root/build.config.json" \
      "$repo_root/build.config.local.json"; do
      name=$(install_mac_read_config_app_name "$config")
      if [[ -n "$name" ]] && [[ "$seen" != *"|${name}|"* ]]; then
        echo "$name"
        seen="${seen}${name}|"
      fi
    done
  fi

  for name in TeamClaw "Copilot 361"; do
    if [[ "$seen" != *"|${name}|"* ]]; then
      echo "$name"
      seen="${seen}${name}|"
    fi
  done
}

# Mount dmg_file; sets INSTALL_MOUNT_POINT, INSTALL_APP_PATH, INSTALL_APP_NAME.
install_mac_mount_dmg() {
  local dmg_file="$1"
  local attach_line

  if [[ -n "${INSTALL_MOUNT_POINT:-}" ]] && [[ -d "$INSTALL_MOUNT_POINT" ]]; then
    hdiutil detach "$INSTALL_MOUNT_POINT" -quiet 2>/dev/null || true
  fi

  attach_line=$(hdiutil attach "$dmg_file" -nobrowse 2>&1 | grep -E '/Volumes/' | tail -1 || true)
  if [[ -z "$attach_line" ]]; then
    echo "Error: Failed to mount DMG" >&2
    return 1
  fi

  INSTALL_MOUNT_POINT=$(printf '%s\n' "$attach_line" | awk -F'\t' '{print $NF}')
  INSTALL_APP_PATH=$(find "$INSTALL_MOUNT_POINT" -maxdepth 1 -name '*.app' -type d 2>/dev/null | head -1 || true)
  if [[ -z "$INSTALL_APP_PATH" ]]; then
    echo "Error: No .app found in DMG (mounted at ${INSTALL_MOUNT_POINT})" >&2
    hdiutil detach "$INSTALL_MOUNT_POINT" -quiet 2>/dev/null || true
    INSTALL_MOUNT_POINT=""
    return 1
  fi

  INSTALL_APP_NAME=$(basename "$INSTALL_APP_PATH" .app)
}

install_mac_quit_if_running() {
  local app_name="$1"
  if pgrep -x "$app_name" >/dev/null 2>&1; then
    echo "Closing running ${app_name}..."
    osascript -e "tell application \"${app_name}\" to quit" 2>/dev/null || true
    sleep 2
  fi
}

install_mac_copy_to_applications() {
  local app_path="$1"
  local app_name="$2"
  local dest="/Applications/${app_name}.app"

  install_mac_quit_if_running "$app_name"
  echo "Installing to ${dest}..."
  rm -rf "$dest"
  cp -R "$app_path" "$dest"
  xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
}

install_mac_cleanup() {
  local dmg_file="${1:-}"
  if [[ -n "${INSTALL_MOUNT_POINT:-}" ]] && [[ -d "$INSTALL_MOUNT_POINT" ]]; then
    hdiutil detach "$INSTALL_MOUNT_POINT" -quiet 2>/dev/null || true
    INSTALL_MOUNT_POINT=""
  fi
  if [[ -n "$dmg_file" ]] && [[ -f "$dmg_file" ]]; then
    rm -f "$dmg_file"
  fi
}

# Return 0 when url responds with HTTP 200 (HEAD).
install_mac_url_exists() {
  local url="$1"
  local code
  code=$(curl -sL -o /dev/null -w '%{http_code}' -I "$url" || echo "000")
  [[ "$code" == "200" ]]
}

# Tauri release assets slugify product names (e.g. "Copilot 361" → "Copilot.361").
install_mac_asset_slug() {
  tr ' ' '.' <<<"$1"
}

# Latest release tag without relying on the REST /releases/latest JSON (rate-limit friendly).
install_mac_github_latest_tag() {
  local repo="$1"
  local tag effective

  if command -v gh >/dev/null 2>&1; then
    tag=$(gh release view --repo "$repo" --json tagName -q .tagName 2>/dev/null || true)
    if [[ -n "$tag" ]]; then
      printf '%s\n' "$tag"
      return 0
    fi
  fi

  effective=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${repo}/releases/latest" || true)
  if [[ "$effective" =~ /releases/tag/(v[^/?#]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi

  return 1
}

install_mac_parse_github_release_dmg() {
  local json="$1"
  local pattern="$2"
  printf '%s' "$json" | python3 - "$pattern" <<'PY'
import json, sys
pattern = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not isinstance(data, dict):
    sys.exit(1)
for asset in data.get("assets") or []:
    url = asset.get("browser_download_url") or ""
    name = asset.get("name") or ""
    if name.endswith(pattern) or url.endswith(pattern):
        print(url)
        sys.exit(0)
sys.exit(1)
PY
}

install_mac_fetch_github_release_json() {
  local repo="$1"
  local tag="${2:-}"
  local url auth=()

  if [[ -n "$tag" ]]; then
    url="https://api.github.com/repos/${repo}/releases/tags/${tag}"
  else
    url="https://api.github.com/repos/${repo}/releases/latest"
  fi

  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  fi

  curl -fsSL "${auth[@]}" "$url" 2>/dev/null || return 1
}

# Resolve a GitHub Release DMG URL (handles API rate limits + branded asset names).
install_mac_resolve_github_dmg_url() {
  local repo="$1"
  local arch_suffix="$2"
  local repo_root="${3:-}"
  local json tag version_num name slug url

  if command -v gh >/dev/null 2>&1; then
    url=$(gh release view --repo "$repo" --json assets -q \
      ".assets[] | select(.name | test(\"${arch_suffix}\$\")) | .url" 2>/dev/null | head -1 || true)
    if [[ -n "$url" ]]; then
      printf '%s\n' "$url"
      return 0
    fi
  fi

  json=$(install_mac_fetch_github_release_json "$repo" "" || true)
  if [[ -n "$json" ]]; then
    url=$(install_mac_parse_github_release_dmg "$json" "$arch_suffix" 2>/dev/null || true)
    if [[ -n "$url" ]]; then
      printf '%s\n' "$url"
      return 0
    fi
  fi

  tag=$(install_mac_github_latest_tag "$repo" || true)
  if [[ -z "$tag" ]]; then
    return 1
  fi
  version_num="${tag#v}"

  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    slug=$(install_mac_asset_slug "$name")
    url="https://github.com/${repo}/releases/download/${tag}/${slug}_${version_num}_${arch_suffix}"
    if install_mac_url_exists "$url"; then
      printf '%s\n' "$url"
      return 0
    fi
  done < <(install_mac_product_name_candidates "$repo_root")

  return 1
}

# Pick the first reachable DMG URL from candidate product names.
install_mac_resolve_oss_dmg_url() {
  local oss_base="$1"
  local version_tag="$2"
  local version_num="$3"
  local arch_suffix="$4"
  local repo_root="$5"
  local name slug url

  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    slug=$(install_mac_asset_slug "$name")
    url="${oss_base}/releases/${version_tag}/${slug}_${version_num}_${arch_suffix}"
    if install_mac_url_exists "$url"; then
      printf '%s\n' "$url"
      return 0
    fi
    # Legacy OSS layout kept spaces in filenames.
    url="${oss_base}/releases/${version_tag}/${name}_${version_num}_${arch_suffix}"
    if install_mac_url_exists "$url"; then
      printf '%s\n' "$url"
      return 0
    fi
  done < <(install_mac_product_name_candidates "$repo_root")

  return 1
}

install_mac_finish() {
  local dmg_file="${1:-}"
  local app_name="$2"
  local app_path="/Applications/${app_name}.app"
  install_mac_cleanup "$dmg_file"
  echo ""
  echo "${app_name} installed successfully!"
  echo "If macOS blocks launch, run:"
  echo "  sudo xattr -dr com.apple.quarantine \"${app_path}\""
  echo "Opening ${app_name}..."
  open "$app_path"
}

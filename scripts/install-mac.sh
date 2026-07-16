#!/bin/bash
set -euo pipefail

REPO="different-ai-studio/teamclaw"
TEAMCLAW_SCRIPTS_RAW="${TEAMCLAW_SCRIPTS_RAW:-https://raw.githubusercontent.com/${REPO}/main/scripts}"

# curl | bash has no on-disk script path — fetch shared helpers from GitHub when needed.
source_install_mac_common() {
  local script_dir="${1:-}"
  local local_lib="${script_dir}/lib/install-mac-common.sh"
  if [[ -n "$script_dir" && -f "$local_lib" ]]; then
    # shellcheck source=lib/install-mac-common.sh
    source "$local_lib"
    return 0
  fi
  local tmp
  tmp="$(mktemp /tmp/teamclaw-install-common-XXXXXX.sh)"
  if ! curl -fsSL "${TEAMCLAW_SCRIPTS_RAW}/lib/install-mac-common.sh" -o "$tmp"; then
    rm -f "$tmp"
    echo "Error: failed to download install helpers from ${TEAMCLAW_SCRIPTS_RAW}" >&2
    return 1
  fi
  # shellcheck source=/dev/null
  source "$tmp"
  rm -f "$tmp"
}

SCRIPT_DIR=""
REPO_ROOT=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi
source_install_mac_common "$SCRIPT_DIR"

echo "Installing macOS app..."

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  arm64)
    DMG_PATTERN="aarch64.dmg"
    echo "Detected Apple Silicon (arm64)"
    ;;
  x86_64)
    DMG_PATTERN="x64.dmg"
    echo "Detected Intel (x86_64)"
    ;;
  *)
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

if [[ -n "${LOCAL_DMG:-}" ]]; then
  if [[ ! -f "$LOCAL_DMG" ]]; then
    echo "Error: LOCAL_DMG not found: ${LOCAL_DMG}"
    exit 1
  fi
  DMG_FILE="$LOCAL_DMG"
  echo "Using local DMG: ${DMG_FILE}"
else
  DMG_URL="${DMG_URL:-}"
  if [[ -z "$DMG_URL" ]]; then
    DMG_URL=$(install_mac_resolve_github_dmg_url "$REPO" "$DMG_PATTERN" "$REPO_ROOT" || true)
  fi

  if [[ -z "$DMG_URL" ]]; then
    echo "Error: Could not find ${DMG_PATTERN} in latest release" >&2
    echo "Hint: set DMG_URL to the full download URL, or export GITHUB_TOKEN / run: gh auth login" >&2
    exit 1
  fi

  echo "Downloading from: ${DMG_URL}"
  DMG_FILE=$(mktemp /tmp/teamclaw-install-XXXXXX.dmg)
  curl -L --progress-bar -o "$DMG_FILE" "$DMG_URL"
fi

echo "Mounting DMG..."
install_mac_mount_dmg "$DMG_FILE"

echo "Installing ${INSTALL_APP_NAME}..."
install_mac_copy_to_applications "$INSTALL_APP_PATH" "$INSTALL_APP_NAME"
install_mac_finish "$DMG_FILE" "$INSTALL_APP_NAME"

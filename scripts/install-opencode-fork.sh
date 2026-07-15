#!/usr/bin/env bash
# Overwrite the user-local OpenCode binary (~/.opencode/bin/opencode) with a fork
# build — no TeamClaw rebuild or build.config.json changes required.
#
# Default source: different-ai-studio/opencode fork releases.
# Publish a GitHub Release on the fork with the standard asset names first, then run:
#
#   curl -fsSL https://raw.githubusercontent.com/different-ai-studio/teamclaw-next/main/scripts/install-opencode-fork.sh | bash
#
# Or from a checkout:
#   scripts/install-opencode-fork.sh
#
# Overrides:
#   OPENCODE_DOWNLOAD_BASE   Base URL (no trailing slash). Default: GitHub release dir below.
#   OPENCODE_RELEASE_TAG     Release tag when using the default GitHub base (default: v1.17.7).
#
# If ~/.amuxd/bin/amuxd exists, delegates to `amuxd install-opencode --force` (same unpack path).
# Otherwise downloads with curl and installs directly.

set -euo pipefail

REPO="${OPENCODE_FORK_REPO:-different-ai-studio/opencode}"
DEFAULT_TAG="${OPENCODE_RELEASE_TAG:-v1.17.7}"
DOWNLOAD_BASE="${OPENCODE_DOWNLOAD_BASE:-https://github.com/${REPO}/releases/download/${DEFAULT_TAG}}"

BIN_DIR="${HOME}/.opencode/bin"
BIN_NAME="opencode"
if [[ "$(uname -s)" == "MINGW"* || "$(uname -s)" == "MSYS"* || "$(uname -s)" == "CYGWIN"* ]]; then
  BIN_NAME="opencode.exe"
fi
DEST="${BIN_DIR}/${BIN_NAME}"

detect_asset() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os/$arch" in
    Darwin/arm64|Darwin/aarch64) echo "opencode-darwin-arm64.zip" ;;
    Darwin/x86_64)               echo "opencode-darwin-x64.zip" ;;
    Linux/aarch64|Linux/arm64)   echo "opencode-linux-arm64.tar.gz" ;;
    Linux/x86_64)                echo "opencode-linux-x64.tar.gz" ;;
    *)
      echo "unsupported platform: $os $arch" >&2
      exit 1
      ;;
  esac
}

try_amuxd() {
  local amuxd="${AMUXD_BIN:-${HOME}/.amuxd/bin/amuxd}"
  [[ -x "$amuxd" ]] || return 1
  echo "→ Using ${amuxd} install-opencode --force"
  echo "  OPENCODE_DOWNLOAD_BASE=${DOWNLOAD_BASE}"
  OPENCODE_DOWNLOAD_BASE="${DOWNLOAD_BASE}" "$amuxd" install-opencode --force
  return 0
}

install_standalone() {
  local asset url tmpdir dest_tmp old
  asset="$(detect_asset)"
  url="${DOWNLOAD_BASE%/}/${asset}"

  echo "→ Downloading ${url}"
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  if ! curl -fsSL "$url" -o "${tmpdir}/${asset}"; then
    echo "Error: download failed." >&2
    echo "Hint: publish a GitHub Release on ${REPO} with tag ${DEFAULT_TAG}" >&2
    echo "      and asset ${asset}, or set OPENCODE_DOWNLOAD_BASE to your mirror." >&2
    exit 1
  fi

  mkdir -p "$BIN_DIR"
  dest_tmp="${DEST}.download.tmp"

  if [[ "$asset" == *.zip ]]; then
    unzip -o "${tmpdir}/${asset}" -d "$tmpdir/unpack" >/dev/null
    found="$(find "$tmpdir/unpack" -name "$BIN_NAME" -type f | head -1)"
    [[ -n "$found" ]] || { echo "Error: ${BIN_NAME} not found in ${asset}" >&2; exit 1; }
    cp "$found" "$dest_tmp"
  elif [[ "$asset" == *.tar.gz ]]; then
    tar -xzf "${tmpdir}/${asset}" -C "$tmpdir"
    found="$(find "$tmpdir" -name "$BIN_NAME" -type f | head -1)"
    [[ -n "$found" ]] || { echo "Error: ${BIN_NAME} not found in ${asset}" >&2; exit 1; }
    cp "$found" "$dest_tmp"
  else
    echo "Error: unsupported asset type: ${asset}" >&2
    exit 1
  fi

  chmod +x "$dest_tmp"

  if [[ -f "$DEST" ]]; then
    old="${DEST}.old"
    rm -f "$old"
    mv "$DEST" "$old"
    echo "→ Moved previous binary to ${old}"
  fi
  mv "$dest_tmp" "$DEST"

  if [[ "$(uname -s)" == "Darwin" ]]; then
    xattr -cr "$DEST" 2>/dev/null || true
    codesign --force --sign - "$DEST" 2>/dev/null || true
  fi
}

main() {
  echo "OpenCode fork installer"
  echo "  dest:  ${DEST}"
  echo "  base:  ${DOWNLOAD_BASE}"
  echo ""

  if try_amuxd; then
    :
  else
    echo "→ amuxd not found; installing standalone via curl"
    install_standalone
  fi

  echo ""
  if [[ -x "$DEST" ]]; then
    echo "✓ Installed: $("$DEST" --version 2>/dev/null || echo "$DEST")"
  else
    echo "✓ Install finished (verify: ${DEST} --version)"
  fi
  echo ""
  echo "Restart TeamClaw / amuxd so the new OpenCode binary is picked up."
}

main "$@"

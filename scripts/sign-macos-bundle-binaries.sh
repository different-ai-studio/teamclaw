#!/usr/bin/env bash
# Deep-sign Mach-O binaries under apps/desktop/binaries/ before Tauri bundles them.
# Bridge sidecars ship ripgrep/sharp/native addons that fail Apple notarization if
# unsigned. No-op when APPLE_SIGNING_IDENTITY is unset (ad-hoc local builds).
set -euo pipefail

ROOT="${1:-apps/desktop/binaries}"
IDENT="${APPLE_SIGNING_IDENTITY:-}"

if [[ ! -d "$ROOT" ]]; then
  echo "sign-macos-bundle-binaries: skip — $ROOT not found"
  exit 0
fi

if [[ -z "$IDENT" ]]; then
  echo "sign-macos-bundle-binaries: skip — APPLE_SIGNING_IDENTITY unset"
  exit 0
fi

count=0
while IFS= read -r -d '' f; do
  echo "Signing $f"
  codesign --force --options runtime --timestamp --sign "$IDENT" "$f"
  count=$((count + 1))
done < <(
  find -L "$ROOT" -type f -print0 | while IFS= read -r -d '' candidate; do
    if file -b "$candidate" | grep -q 'Mach-O'; then
      printf '%s\0' "$candidate"
    fi
  done
)

echo "sign-macos-bundle-binaries: signed $count file(s) under $ROOT"

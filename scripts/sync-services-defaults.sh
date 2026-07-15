#!/usr/bin/env bash
# Sync config/services.default.json to platform-specific resource copies that
# can't reference the canonical file directly. Run after editing the canonical
# file. CI invokes this with --check to fail if copies have drifted.
#
# Canonical:
#   config/services.default.json
#
# Copies kept in sync:
#   apps/ios/Packages/AMUXCore/Sources/AMUXCore/Resources/services.default.json
#     (SwiftPM resource bundle — symlinks aren't followed into the built bundle)
#
# Rust (daemon + desktop) reads the canonical directly via `include_str!` in
# crates/teamclaw-types/src/services_defaults.rs, so no copy needed there.

set -euo pipefail

cd "$(dirname "$0")/.."

CANONICAL="config/services.default.json"
IOS_COPY="apps/ios/Packages/AMUXCore/Sources/AMUXCore/Resources/services.default.json"

if [[ ! -f "$CANONICAL" ]]; then
  echo "error: canonical $CANONICAL not found" >&2
  exit 1
fi

if [[ "${1:-}" == "--check" ]]; then
  if ! diff -q "$CANONICAL" "$IOS_COPY" >/dev/null 2>&1; then
    echo "error: $IOS_COPY is out of sync with $CANONICAL" >&2
    echo "       run scripts/sync-services-defaults.sh to fix" >&2
    exit 1
  fi
  echo "services.default.json copies are in sync"
  exit 0
fi

cp "$CANONICAL" "$IOS_COPY"
echo "synced $CANONICAL -> $IOS_COPY"

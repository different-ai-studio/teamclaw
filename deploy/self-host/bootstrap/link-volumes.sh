#!/usr/bin/env bash
# podman-compose resolves bind-mount paths in the included supabase compose file
# relative to deploy/self-host/, not supabase/. Docker Compose v2 with
# project_directory behaves correctly; podman-compose does not — symlink fixes both.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TARGET="supabase/volumes"
LINK="volumes"

if [ -L "$LINK" ]; then
  echo "link-volumes: $LINK already symlinked"
  exit 0
fi

if [ -d "$LINK" ] && [ ! -L "$LINK" ]; then
  if [ -z "$(find "$LINK" -mindepth 1 -maxdepth 2 -type f 2>/dev/null | head -1)" ]; then
    rmdir "$LINK"/{api,functions,logs,storage,db} 2>/dev/null || true
    rmdir "$LINK" 2>/dev/null || {
      echo "error: $LINK exists and is not empty — remove or merge manually, then re-run" >&2
      exit 1
    }
  else
    echo "error: $LINK exists and is not a symlink — expected $TARGET" >&2
    exit 1
  fi
fi

ln -s "$TARGET" "$LINK"
echo "link-volumes: $LINK -> $TARGET"

#!/usr/bin/env bash
# Wipe self-host volumes and re-bootstrap from .env (fixes POSTGRES_PASSWORD drift).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE not found" >&2; exit 1; }

use_podman_compose() {
  command -v podman-compose >/dev/null || return 1
  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi
  docker compose version 2>&1 | grep -q podman-compose
}

if use_podman_compose; then
  RUN=( podman-compose --in-pod false -f docker-compose.yml -f docker-compose.podman.yml )
  RUNTIME=podman
else
  RUN=( docker compose -f docker-compose.yml )
  RUNTIME=docker
fi

wipe_bind_mounts() {
  echo "==> remove bind-mounted state (compose down -v does NOT delete these)"
  # Postgres PGDATA — password drift survives down -v without this.
  rm -rf "$ROOT/supabase/volumes/db/data"
  # Supabase storage file backend (optional local blobs)
  if [ -d "$ROOT/supabase/volumes/storage" ]; then
    find "$ROOT/supabase/volumes/storage" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  fi
}

echo "reset-data: removes named volumes AND bind mounts under supabase/volumes/."
echo "reset-data: use when POSTGRES_PASSWORD in .env no longer matches the initialized db."
echo "reset-data: Postgres data: supabase/volumes/db/data"
echo ""
read -r -p "Type 'yes' to continue: " confirm
[ "$confirm" = "yes" ] || { echo "reset-data: aborted"; exit 1; }

echo "==> compose down (release bind mounts)"
"${RUN[@]}" down --remove-orphans 2>/dev/null || true
if [ "$RUNTIME" = podman ]; then
  podman pod rm -f pod_teamclaw-self-host 2>/dev/null || true
  podman rm -f $(podman ps -aq --filter label=com.docker.compose.project=teamclaw-self-host) 2>/dev/null || true
fi

wipe_bind_mounts

echo "==> compose down -v (named volumes)"
"${RUN[@]}" down -v --remove-orphans 2>/dev/null || true
if [ "$RUNTIME" = podman ]; then
  podman pod rm -f pod_teamclaw-self-host 2>/dev/null || true
  podman rm -f $(podman ps -aq --filter label=com.docker.compose.project=teamclaw-self-host) 2>/dev/null || true
fi

echo "==> gen-secrets + up"
"$ROOT/bootstrap/gen-secrets.sh"
"$ROOT/bootstrap/up.sh"

echo "==> check"
"$ROOT/bootstrap/check.sh"

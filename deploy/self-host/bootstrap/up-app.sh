#!/usr/bin/env bash
# Start FC + Caddy after the base Supabase stack and migrate are already healthy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

use_podman_compose() {
  command -v podman-compose >/dev/null || return 1
  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi
  docker compose version 2>&1 | grep -q podman-compose
}

if use_podman_compose; then
  COMPOSE=( -f docker-compose.yml -f docker-compose.podman.yml )
  RUNTIME=podman
  RUN=( podman-compose --in-pod false "${COMPOSE[@]}" )
else
  COMPOSE=( -f docker-compose.yml )
  RUNTIME=docker
  RUN=( docker compose "${COMPOSE[@]}" )
fi

MIGRATE=teamclaw-self-host_migrate_1
status="$("$RUNTIME" inspect "$MIGRATE" --format '{{.State.Status}}' 2>/dev/null || echo missing)"
code="$("$RUNTIME" inspect "$MIGRATE" --format '{{.State.ExitCode}}' 2>/dev/null || echo "?")"
if [ "$status" != "exited" ] || [ "$code" != "0" ]; then
  echo "error: $MIGRATE must be Exited (0) before starting fc — run ./bootstrap/up.sh first" >&2
  exit 1
fi

for svc in fc caddy; do
  echo "up-app: recreate $svc (--no-deps)"
  "$RUNTIME" rm -f "teamclaw-self-host_${svc}_1" 2>/dev/null || true
  "${RUN[@]}" up -d --no-deps --build "$svc"
done

echo "up-app: waiting for FC /healthz..."
for i in $(seq 1 40); do
  if curl -fsS --connect-timeout 2 http://127.0.0.1:9000/healthz >/dev/null 2>&1; then
    echo "up-app: OK — http://127.0.0.1:9000/healthz"
    exit 0
  fi
  sleep 3
done
echo "error: fc /healthz not ready — run ./bootstrap/check.sh" >&2
exit 1

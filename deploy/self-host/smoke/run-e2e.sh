#!/usr/bin/env sh
# Run the self-host E2E test suite against the running docker compose stack.
#
# Usage (from deploy/self-host/):
#   sh smoke/run-e2e.sh
#
# Discovers container IPs automatically via docker inspect.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

FC_IP=$(docker inspect teamclaw-self-host-fc-1 \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null || echo "")
KONG_IP=$(docker inspect supabase-kong \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null || echo "")

[ -n "$FC_IP" ]   || { echo "FAIL: teamclaw-self-host-fc-1 not running"; exit 1; }
[ -n "$KONG_IP" ] || { echo "FAIL: supabase-kong not running"; exit 1; }

cd "$REPO_ROOT/services/fc"
FC_E2E=1 \
FC_E2E_BASE_URL="http://$FC_IP:9000" \
FC_E2E_KONG_URL="http://$KONG_IP:8000" \
FC_E2E_ENV_FILE="$REPO_ROOT/deploy/self-host/.env" \
  node --import tsx --test test/self-host-e2e.test.ts

#!/usr/bin/env bash
# Compare TeamClaw inventory: test RDS vs live RDS (supabase_db).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
INV="$ROOT/inventory.sql"

if ! command -v psql >/dev/null 2>&1; then
  export PATH="/opt/homebrew/opt/libpq/bin:${PATH}"
fi

TEST_URL="${TEST_DB_URL:-postgresql://${TEST_RDS_USER:-supabase_admin}:${TEST_RDS_PASSWORD:?set TEST_RDS_PASSWORD}@${TEST_RDS_HOST:?set TEST_RDS_HOST}:${TEST_RDS_PORT:-5432}/supabase_db?sslmode=disable}"

LIVE_URL="${LIVE_DB_URL:-postgresql://${LIVE_RDS_USER:-supabase_admin}:${LIVE_RDS_PASSWORD:?set LIVE_RDS_PASSWORD}@${LIVE_RDS_HOST:?set LIVE_RDS_HOST}:${LIVE_RDS_PORT:-5432}/supabase_db?sslmode=disable}"

run_inv() {
  local label="$1" url="$2"
  echo "########## $label ##########"
  psql "$url" -v ON_ERROR_STOP=1 -f "$INV"
  echo
}

run_inv "TEST" "$TEST_URL"
run_inv "LIVE" "$LIVE_URL"

TMP="$(mktemp -d)"
psql "$TEST_URL" -At -c "select table_name from information_schema.tables where table_schema='amux' and table_type='BASE TABLE' order by 1" >"$TMP/test.txt"
psql "$LIVE_URL" -At -c "select table_name from information_schema.tables where table_schema='amux' and table_type='BASE TABLE' order by 1" >"$TMP/live.txt"
echo "==> amux tables only in TEST"
comm -23 "$TMP/test.txt" "$TMP/live.txt" || true
echo "==> amux tables only in LIVE"
comm -13 "$TMP/test.txt" "$TMP/live.txt" || true
rm -rf "$TMP"

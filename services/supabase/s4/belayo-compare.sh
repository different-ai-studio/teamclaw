#!/usr/bin/env bash
# Compare TeamClaw inventory: belayo_test vs belayo_live (supabase_db).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
INV="$ROOT/belayo-inventory.sql"

if ! command -v psql >/dev/null 2>&1; then
  export PATH="/opt/homebrew/opt/libpq/bin:${PATH}"
fi

TEST_URL="${BELAYO_TEST_DB_URL:-postgresql://${BELAYO_TEST_RDS_USER:-supabase_admin}:${BELAYO_TEST_RDS_PASSWORD:?set BELAYO_TEST_RDS_PASSWORD}@${BELAYO_TEST_RDS_HOST:-pgm-wz9e7zgczy2wdp7qgo.pg.rds.aliyuncs.com}:${BELAYO_TEST_RDS_PORT:-5432}/supabase_db?sslmode=disable}"

LIVE_URL="${BELAYO_LIVE_DB_URL:-postgresql://${BELAYO_LIVE_RDS_USER:-supabase_admin}:${BELAYO_LIVE_RDS_PASSWORD:?set BELAYO_LIVE_RDS_PASSWORD}@${BELAYO_LIVE_RDS_HOST:-pgm-wz9269brt4zi9k91bo.pg.rds.aliyuncs.com}:${BELAYO_LIVE_RDS_PORT:-5432}/supabase_db?sslmode=disable}"

run_inv() {
  local label="$1" url="$2"
  echo "########## $label ##########"
  psql "$url" -v ON_ERROR_STOP=1 -f "$INV"
  echo
}

run_inv "BELAYO_TEST" "$TEST_URL"
run_inv "BELAYO_LIVE" "$LIVE_URL"

TMP="$(mktemp -d)"
psql "$TEST_URL" -At -c "select table_name from information_schema.tables where table_schema='amux' and table_type='BASE TABLE' order by 1" >"$TMP/test.txt"
psql "$LIVE_URL" -At -c "select table_name from information_schema.tables where table_schema='amux' and table_type='BASE TABLE' order by 1" >"$TMP/live.txt"
echo "==> amux tables only in TEST"
comm -23 "$TMP/test.txt" "$TMP/live.txt" || true
echo "==> amux tables only in LIVE"
comm -13 "$TMP/test.txt" "$TMP/live.txt" || true
rm -rf "$TMP"

#!/usr/bin/env bash
# ============================================================================
# Live RDS clone: copy TeamClaw from the test RDS to the live RDS (supabase_db).
#
# Verified layout on the test RDS (2026-06):
#   - amux schema only (37 tables, views, ~89 functions incl. is_team_member, create_team, …)
#   - NO app schema
#   - public.claim_team_invite only (FC auth path; also exists in amux)
#
# Does NOT touch: public tables, storage.*, auth.*, or any other public functions.
#
# Usage:
#   export TEST_RDS_PASSWORD='...'
#   export LIVE_RDS_PASSWORD='...'
#   ./live-clone.sh preflight
#   ./live-clone.sh dump-only
#   ./live-clone.sh apply              # schema-only (default)
#   WITH_DATA=1 ./live-clone.sh apply  # include row data from test amux
#   ./live-clone.sh rollback
#   ./live-clone.sh postgrest-reload   # idempotent grants + NOTIFY (already-migrated live)
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/_dump"
MODE="${1:-apply}"

TEST_HOST="${TEST_RDS_HOST:?set TEST_RDS_HOST}"
TEST_PORT="${TEST_RDS_PORT:-5432}"
TEST_USER="${TEST_RDS_USER:-supabase_admin}"
TEST_PASS="${TEST_RDS_PASSWORD:?set TEST_RDS_PASSWORD}"
TEST_DB="${TEST_RDS_DATABASE:-supabase_db}"

LIVE_HOST="${LIVE_RDS_HOST:?set LIVE_RDS_HOST}"
LIVE_PORT="${LIVE_RDS_PORT:-5432}"
LIVE_USER="${LIVE_RDS_USER:-supabase_admin}"
LIVE_PASS="${LIVE_RDS_PASSWORD:?set LIVE_RDS_PASSWORD}"
LIVE_DB="${LIVE_RDS_DATABASE:-supabase_db}"

TEST_URL="postgresql://${TEST_USER}@${TEST_HOST}:${TEST_PORT}/${TEST_DB}?sslmode=disable"
LIVE_URL="postgresql://${LIVE_USER}@${LIVE_HOST}:${LIVE_PORT}/${LIVE_DB}?sslmode=disable"

if ! command -v psql >/dev/null 2>&1; then
  export PATH="/opt/homebrew/opt/libpq/bin:${PATH}"
fi

mkdir -p "$OUT"

psql_test() {
  PGPASSWORD="$TEST_PASS" psql "$TEST_URL" -v ON_ERROR_STOP=1 "$@"
}

psql_live() {
  PGPASSWORD="$LIVE_PASS" psql "$LIVE_URL" -v ON_ERROR_STOP=1 "$@"
}

preflight() {
  echo "==> test RDS  $TEST_HOST / $TEST_DB"
  psql_test -At -c "select count(*) from information_schema.tables where table_schema='amux' and table_type='BASE TABLE';" \
    | xargs -I{} echo "    amux tables: {}"
  psql_test -At -c "select exists(select 1 from information_schema.schemata where schema_name='app');" \
    | xargs -I{} echo "    has app schema (expect f): {}"

  echo "==> live RDS $LIVE_HOST / $LIVE_DB"
  psql_live <<'SQL'
do $$ begin
  if exists (select 1 from information_schema.schemata where schema_name = 'amux') then
    raise exception 'live already has schema amux — abort';
  end if;
  if not exists (select 1 from information_schema.tables where table_schema='public' and table_name='orgs') then
    raise exception 'public.orgs missing on live';
  end if;
end $$;
SQL
  psql_live -At -c "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';" \
    | xargs -I{} echo "    public tables (baseline): {}"
  echo "    OK"
}

dump_from_test() {
  echo "==> pg_dump amux from test RDS (schema-only)"
  PGPASSWORD="$TEST_PASS" pg_dump "$TEST_URL" \
    --schema=amux --schema-only --no-owner --no-privileges \
    -f "$OUT/01_amux_schema.sql"

  echo "==> dump public.claim_team_invite only (FC auth RPC)"
  psql_test -At -o "$OUT/02_public_claim_team_invite.sql" <<'SQL'
select pg_get_functiondef(p.oid) || ';'
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'claim_team_invite';
SQL
  if [ ! -s "$OUT/02_public_claim_team_invite.sql" ]; then
    echo "!! warning: public.claim_team_invite not found on test" >&2
    : > "$OUT/02_public_claim_team_invite.sql"
  fi

  if [ "${WITH_DATA:-0}" = "1" ]; then
    echo "==> pg_dump amux data from test RDS"
    PGPASSWORD="$TEST_PASS" pg_dump "$TEST_URL" \
      --schema=amux --data-only --no-owner --no-privileges \
      -f "$OUT/03_amux_data.sql"
  else
    echo "-- no data (schema-only)" > "$OUT/03_amux_data.sql"
  fi
}

load_into_live() {
  local public_before public_after
  public_before="$(psql_live -At -c "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';")"
  echo "==> live public table count before: $public_before"

  echo "==> load amux schema"
  psql_live -c "set check_function_bodies = off;" -f "$OUT/01_amux_schema.sql"

  if [ -s "$OUT/02_public_claim_team_invite.sql" ]; then
    echo "==> load public.claim_team_invite (CREATE OR REPLACE)"
    psql_live -c "set check_function_bodies = off;" -f "$OUT/02_public_claim_team_invite.sql"
  fi

  if [ "${WITH_DATA:-0}" = "1" ] && [ -s "$OUT/03_amux_data.sql" ]; then
    echo "==> load amux data"
    psql_live -f "$OUT/03_amux_data.sql"
  fi

  grant_amux_postgrest
  reload_postgrest

  public_after="$(psql_live -At -c "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';")"
  echo "==> live public table count after:  $public_after"
  if [ "$public_before" != "$public_after" ]; then
    echo "!! ABORT: public table count changed ($public_before -> $public_after)" >&2
    exit 1
  fi

  echo "==> acceptance"
  psql_live -f "$ROOT/inventory.sql"
}

grant_amux_postgrest() {
  echo "==> grant amux to PostgREST roles (anon, authenticated, service_role)"
  psql_live <<'SQL'
grant usage on schema amux to anon, authenticated, service_role;
grant all on all tables in schema amux to anon, authenticated, service_role;
grant all on all routines in schema amux to anon, authenticated, service_role;
grant all on all sequences in schema amux to anon, authenticated, service_role;
SQL
}

reload_postgrest() {
  echo "==> PostgREST: authenticator.pgrst.db_schemas + NOTIFY reload"
  psql_live <<'SQL'
alter role authenticator set pgrst.db_schemas to 'public, amux, storage, graphql_public';
notify pgrst, 'reload schema';
SQL
  echo "    DB side done. Also ensure live Supabase rest container has:"
  echo "      PGRST_DB_SCHEMAS=public, amux, storage, graphql_public"
  echo "    (container env overrides role default until recreated — see LIVE-CLONE.md)"
}

rollback() {
  echo "==> rollback teamclaw on live (amux + public.claim_team_invite only)"
  psql_live <<'SQL'
drop schema if exists amux cascade;
drop function if exists public.claim_team_invite(text);
SQL
  echo "rollback done"
}

case "$MODE" in
  preflight) preflight ;;
  dump-only)
    dump_from_test
    echo "artifacts in $OUT"
    ;;
  apply)
    preflight
    dump_from_test
    load_into_live
    echo "DONE. Remaining ops: rest container PGRST_DB_SCHEMAS (if not already), FC SUPABASE_URL → live."
    ;;
  postgrest-reload)
    grant_amux_postgrest
    reload_postgrest
    echo "postgrest-reload done"
    ;;
  rollback) rollback ;;
  *)
    echo "usage: $0 {preflight|dump-only|apply|postgrest-reload|rollback}" >&2
    exit 1
    ;;
esac

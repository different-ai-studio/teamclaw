#!/usr/bin/env bash
# ============================================================================
# S4: transplant teamclaw's schema from 47.x (SRC) into saas-mono (DST).
# (spec: docs/specs/2026-06-08-teamclaw-saas-mono-integration.md  Step D)
#
# Moves the teamclaw-owned `amux` + `app` schemas and teamclaw's `public`
# FUNCTIONS into saas-mono. SCHEMA-ONLY (no data — D6 "不做数据迁移").
#
# Why not a plain `pg_dump --schema=amux`:
#   - amux RLS policies call app.* functions; amux triggers call public/app
#     functions; amux FKs reference public.orgs + auth.users.
#   - So we also carry `app` + teamclaw's public functions, and load in 3
#     phases to satisfy the table<->function<->trigger dependency cycle.
#
# Requires: pg_dump + psql (matching PG 18) and network to BOTH databases.
# Both instances are confirmed identical (PG 18.3, same extensions).
#
# Usage:
#   export SRC_DB_URL='postgres://USER:PW@47.115.253.201:5432/postgres'
#   export DST_DB_URL='postgres://USER:PW@<saas-mono-host>:5432/postgres'
#   ./transplant-amux.sh            # full run (preflight -> dump -> load)
#   ./transplant-amux.sh dump-only  # just produce the .sql artifacts
# ============================================================================
set -euo pipefail

SRC="${SRC_DB_URL:?set SRC_DB_URL (47.x)}"
DST="${DST_DB_URL:?set DST_DB_URL (saas-mono)}"
MODE="${1:-full}"
OUT="$(cd "$(dirname "$0")" && pwd)/_dump"
mkdir -p "$OUT"

echo "==> [0] DST preflight (must not already have amux; warn on public-fn name collisions)"
psql "$DST" -v ON_ERROR_STOP=1 <<'SQL'
do $$ begin
  if exists (select 1 from information_schema.schemata where schema_name='amux') then
    raise exception 'DST already has schema "amux" — abort (already transplanted?)';
  end if;
  if exists (select 1 from information_schema.schemata where schema_name='app') then
    raise warning 'DST already has schema "app" — teamclaw app functions may overwrite. Review.';
  end if;
end $$;
SQL

# Collision report: teamclaw public functions whose (name,args) already exist on DST.
echo "==> [0b] public-function name collisions (SRC teamclaw fns already on DST public):"
psql "$SRC" -At -c "select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p')" | sort > "$OUT/src_public_fns.txt"
psql "$DST" -At -c "select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p')" | sort > "$OUT/dst_public_fns.txt"
comm -12 "$OUT/src_public_fns.txt" "$OUT/dst_public_fns.txt" | tee "$OUT/collisions.txt"
if [ -s "$OUT/collisions.txt" ]; then
  echo "!! Collisions above will be OVERWRITTEN by CREATE OR REPLACE. Review before continuing." >&2
  if [ "$MODE" = "full" ]; then read -r -p "Continue and overwrite? [y/N] " a; [ "$a" = "y" ] || exit 1; fi
fi

echo "==> [1] dump amux + app (pre-data: schemas, tables, functions, enums)"
pg_dump "$SRC" --schema=amux --schema=app --schema-only --section=pre-data \
  --no-owner --no-privileges -f "$OUT/01_amux_app_pre.sql"

echo "==> [2] dump teamclaw public FUNCTIONS (47.x public = teamclaw-only)"
# Emitted as CREATE OR REPLACE; reference amux tables (exist after step 1).
psql "$SRC" -At -v ON_ERROR_STOP=1 -o "$OUT/02_public_fns.sql" <<'SQL'
select string_agg(pg_get_functiondef(p.oid), E';\n\n') || ';'
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.prokind in ('f','p');
SQL

echo "==> [3] dump amux + app (post-data: constraints, indexes, triggers, RLS policies)"
pg_dump "$SRC" --schema=amux --schema=app --schema-only --section=post-data \
  --no-owner --no-privileges -f "$OUT/03_amux_app_post.sql"

# orgs RLS view policy + teamclaw extras that live on public objects saas-mono owns
echo "==> [3b] dump orgs_view_policy (teamclaw policy on saas-mono's public.orgs)"
psql "$SRC" -At -v ON_ERROR_STOP=1 -o "$OUT/03b_orgs_policy.sql" <<'SQL'
select 'drop policy if exists orgs_view_policy on public.orgs;' || E'\n' ||
       'create policy orgs_view_policy on public.orgs for select using (id = (select app.current_org_id()));';
SQL

if [ "$MODE" = "dump-only" ]; then echo "dump-only: artifacts in $OUT"; exit 0; fi

echo "==> [4] load into DST (check_function_bodies off; phased)"
psql "$DST" -v ON_ERROR_STOP=1 -c "set check_function_bodies = off;" -f "$OUT/01_amux_app_pre.sql"
psql "$DST" -v ON_ERROR_STOP=1 -c "set check_function_bodies = off;" -f "$OUT/02_public_fns.sql"
psql "$DST" -v ON_ERROR_STOP=1 -f "$OUT/03_amux_app_post.sql"
psql "$DST" -v ON_ERROR_STOP=1 -f "$OUT/03b_orgs_policy.sql"
psql "$DST" -v ON_ERROR_STOP=1 -c "grant usage on schema amux to anon, authenticated, service_role;"

echo "==> DONE (DB side). MANUAL steps remaining on saas-mono — see README:"
echo "    1) GoTrue: set custom access-token hook -> public.amux_access_token_hook"
echo "    2) PostgREST: add 'amux' to PGRST_DB_SCHEMAS (keep public) + restart"
echo "    3) Reconcile public.plans (stub) / public.users (subset) vs saas-mono's real DDL"
echo "    4) Unify GoTrue JWT_SECRET so teamclaw FC tokens interoperate"
echo "    5) FC: point SUPABASE_URL at saas-mono (deploys on PR merge)"

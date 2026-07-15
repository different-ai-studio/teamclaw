-- ============================================================================
-- Stage 2 of teamclaw × saas-mono integration
-- (spec: docs/specs/2026-06-08-teamclaw-saas-mono-integration.md)
--
-- Moves all teamclaw business tables from public -> amux, points teams at the
-- canonical tenant via teams.oid -> public.orgs(id), and rewrites every
-- function whose body referenced public.<moved table> to use amux.<moved table>.
--
-- ⚠️ NOT GRADUAL. The instant the tables move, FC's existing .from() calls
--    (which default to the public schema) break until FC is deployed with
--    db.schema='amux' (Stage 2d) AND the PostgREST container exposes amux via
--    PGRST_DB_SCHEMAS (ops). Run all three together inside a maintenance window.
--
-- Stays in public (NOT moved):
--   - orgs, plans, users     : saas-mono tenant mirror (Stage 1 / 3A)
--   - account, session, user,
--     verification, jwks      : Better-Auth tables (kept, not moved)
--
-- RLS note: policies move with their tables and keep their team-scoped semantics.
--   The `team.oid == jwt.org_id` org-consistency guard is deferred to Stage 3
--   (it needs org_id present in the JWT, which the auth-alignment stage provides).
--
-- Dry-run validated on 47.x: 35 tables moved, 64 functions rewritten, rolled back
-- clean (zero residue). Idempotent: re-running after success is a no-op.
-- ============================================================================
do $stage2$
declare
  v_move text[];
  v_t text;
  r record;
  v_def text;
  v_fn integer := 0;
  v_tbl integer := 0;
begin
  set local check_function_bodies = off;

  -- Move-list = every public base table EXCEPT the tenant mirror + Better-Auth.
  -- (After a successful run these live in amux, so the list is empty on re-run.)
  select array_agg(table_name order by table_name) into v_move
  from information_schema.tables
  where table_schema='public' and table_type='BASE TABLE'
    and table_name <> all (array['orgs','plans','users','account','session','user','verification','jwks']);

  if v_move is null then
    raise notice 'Stage 2: nothing to move (already applied)';
    return;
  end if;

  -- 2a: schema + usage grants (table privileges + RLS policies move with tables)
  create schema if not exists amux;
  grant usage on schema amux to anon, authenticated, service_role;

  -- 2b: move teamclaw business tables
  foreach v_t in array v_move loop
    execute format('alter table public.%I set schema amux', v_t);
    v_tbl := v_tbl + 1;
  end loop;

  -- teams.oid -> public.orgs (canonical tenant); cross-schema FK
  execute 'alter table amux.teams add column if not exists oid uuid';
  if not exists (select 1 from pg_constraint where conname='teams_oid_fkey') then
    execute 'alter table amux.teams add constraint teams_oid_fkey foreign key (oid) references public.orgs(id)';
  end if;

  -- 2c: rewrite functions that referenced moved tables
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','app') and p.prokind='f'
      and exists (select 1 from unnest(v_move) m where pg_get_functiondef(p.oid) ~ ('\mpublic\.'||m||'\M'))
  loop
    v_def := pg_get_functiondef(r.oid);
    foreach v_t in array v_move loop
      v_def := regexp_replace(v_def, '\mpublic\.'||v_t||'\M', 'amux.'||v_t, 'g');
    end loop;
    -- ensure amux is on the function's search_path (for any unqualified refs)
    if v_def ~* 'search_path' and v_def !~ 'search_path[^;]*\mamux\M' then
      v_def := regexp_replace(v_def, '(SET\s+search_path\s+(TO|=)\s+)', '\1amux, ', 'i');
    end if;
    execute v_def;
    v_fn := v_fn + 1;
  end loop;

  raise notice 'Stage 2 applied: moved % tables, rewrote % functions', v_tbl, v_fn;
end $stage2$;

-- ---------------------------------------------------------------------------
-- Ops checklist to run TOGETHER with this migration (not SQL):
--   1. PostgREST container env: add `amux` to PGRST_DB_SCHEMAS (keep public,
--      graphql_public), then restart PostgREST.
--   2. Deploy FC with supabase client db.schema='amux' (Stage 2d).
-- ---------------------------------------------------------------------------

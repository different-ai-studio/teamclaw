-- TeamClaw × saas-mono schema inventory (run against supabase_db)
\set ON_ERROR_STOP on

\echo '=== schemas ==='
SELECT schema_name FROM information_schema.schemata
 WHERE schema_name IN ('amux', 'app')
 ORDER BY 1;

\echo '=== amux tables ==='
SELECT count(*) AS amux_base_tables
  FROM information_schema.tables
 WHERE table_schema = 'amux' AND table_type = 'BASE TABLE';

SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'amux' AND table_type = 'BASE TABLE'
 ORDER BY 1;

\echo '=== amux views ==='
SELECT table_name FROM information_schema.views
 WHERE table_schema = 'amux' ORDER BY 1;

\echo '=== teams.oid ==='
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'amux' AND table_name = 'teams' AND column_name = 'oid';

\echo '=== RLS helper location (is_team_member etc.) ==='
SELECT n.nspname AS schema, p.proname AS function
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.proname IN (
   'is_team_member', 'current_actor_id_for_team', 'current_member_id',
   'current_org_id', 'ensure_personal_org', 'ensure_org_default_team'
 )
 ORDER BY p.proname, n.nspname;

\echo '=== function counts by schema ==='
SELECT n.nspname AS schema, count(*) AS fn_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('amux', 'app', 'public')
   AND p.prokind = 'f'
 GROUP BY n.nspname
 ORDER BY 1;

\echo '=== teamclaw public RPCs (sample) ==='
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname ~ '^(create_team|claim_team|amux_|ensure_personal|create_idea|create_session)'
 ORDER BY 1, 2;

\echo '=== amux.apps (apps module) ==='
SELECT EXISTS (
  SELECT 1 FROM information_schema.tables
   WHERE table_schema = 'amux' AND table_name = 'apps'
) AS has_amux_apps;

\echo '=== teams_org_guard ==='
SELECT count(*) FROM pg_policies
 WHERE schemaname = 'amux' AND policyname = 'teams_org_guard';

\echo '=== public table count (saas-mono sanity) ==='
SELECT count(*) FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

\echo '=== storage policies touched by teamclaw? ==='
SELECT policyname FROM pg_policies
 WHERE schemaname = 'storage'
   AND policyname IN (
     'avatars_public_read', 'avatars_owner_insert',
     'session_participants_can_download', 'attachments_public_read'
   )
 ORDER BY 1;

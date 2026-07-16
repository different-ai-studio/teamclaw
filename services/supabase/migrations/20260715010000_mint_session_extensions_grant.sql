-- Fix: POST /v1/teams/:id/activate fails with
--   {"code":"forbidden","message":"permission denied for schema extensions"}
--
-- Chain:
--   /v1/teams/:id/activate
--     -> amux.switch_active_team(uuid)        SECURITY DEFINER, owner postgres
--       -> auth._mint_session(uuid)           SECURITY DEFINER, owner supabase_auth_admin
--         -> extensions.gen_random_bytes(6)   <-- permission denied
--
-- A SECURITY DEFINER function executes as its OWNER, so _mint_session runs as
-- `supabase_auth_admin`. That role owns auth.sessions / auth.refresh_tokens
-- (which is exactly why the function should keep running as it), but it was
-- never granted USAGE on the `extensions` schema — where pgcrypto's
-- gen_random_bytes lives. Every other role that needs it (postgres, anon,
-- authenticated, service_role, dashboard_user) has the grant; this one was
-- missed.
--
-- 20260706000000_add_auth_mint_session.sql restored the function body verbatim
-- from the pre-baseline archive but carried no grant, so any database rebuilt
-- from the baseline has a _mint_session that cannot mint. It fails only on the
-- team-switch path, which is why it went unnoticed: joining your first team
-- never calls it.
--
-- Granting USAGE is preferred over reassigning the function to `postgres`:
-- the function's whole job is writing GoTrue's own tables, and
-- supabase_auth_admin is the role that owns them.

grant usage on schema extensions to supabase_auth_admin;

-- Belt and braces: the function calls extensions.gen_random_bytes explicitly and
-- its search_path already lists `extensions`, but EXECUTE on the function itself
-- must also be reachable for the owner's role. pgcrypto installs with EXECUTE to
-- PUBLIC, so this is a no-op on a stock install and a repair on one where the
-- default was tightened.
grant execute on function extensions.gen_random_bytes(integer) to supabase_auth_admin;

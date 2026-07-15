-- ============================================================================
-- Fix: S2 (20260608010000) only moved BASE TABLES; it missed the actor_directory
-- VIEW, leaving it in public. With FC's default schema = amux, `.from('actor_directory')`
-- would 404. Move the view to amux and fix the one function that referenced it
-- by qualified name (public.update_current_actor_profile -> public.actor_directory).
--
-- Idempotent. Applies after S2. (actor_directory is security_invoker=true, so RLS
-- on the underlying amux.actors still applies as the querying user.)
-- ============================================================================
do $$
declare v_def text;
begin
  set local check_function_bodies = off;

  if exists (select 1 from information_schema.views where table_schema='public' and table_name='actor_directory') then
    alter view public.actor_directory set schema amux;
  end if;

  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='update_current_actor_profile';
  if v_def is not null and v_def ~ 'public\.actor_directory' then
    execute replace(v_def, 'public.actor_directory', 'amux.actor_directory');
  end if;
end $$;

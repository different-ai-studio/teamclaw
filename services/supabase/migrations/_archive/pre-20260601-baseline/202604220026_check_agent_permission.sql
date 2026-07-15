-- Daemon-side permission lookup. Called by amuxd over the REST PostgREST
-- bridge: given the daemon's own agent actor id and the iOS caller's
-- Supabase actor id, returns `agent_member_access.permission_level`
-- ('admin' | 'write' | 'view') or NULL if there is no grant.

create or replace function public.check_agent_permission(
  p_agent_id uuid,
  p_actor_id uuid
) returns text
language sql security definer set search_path = public
as $$
  select ama.permission_level
    from public.agent_member_access ama
   where ama.agent_id = p_agent_id and ama.member_id = p_actor_id
   limit 1;
$$;

revoke all on function public.check_agent_permission(uuid, uuid) from public;
grant execute on function public.check_agent_permission(uuid, uuid) to authenticated;

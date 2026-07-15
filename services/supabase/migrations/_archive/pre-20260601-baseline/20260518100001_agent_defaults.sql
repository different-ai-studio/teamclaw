-- Per-agent defaults: surface agents.default_workspace_id in actor_directory
-- and add an RPC any teammate can call to update an agent's
-- default_workspace_id and agent_kind. Lets iOS new-session flow skip the
-- workspace/agent-type picker by using each agent's preconfigured defaults.

begin;

-- ===========================================================================
-- 1. Re-create actor_directory to include default_workspace_id
-- ===========================================================================
drop view if exists public.actor_directory;

create view public.actor_directory
  with (security_invoker = true)
as
select
  a.id, a.team_id, a.actor_type, a.user_id, a.invited_by_actor_id,
  a.display_name, a.avatar_url, a.last_active_at, a.created_at, a.updated_at,
  m.status      as member_status,
  tm.role       as team_role,
  ag.agent_kind as agent_kind,
  ag.status     as agent_status,
  ag.default_workspace_id as default_workspace_id
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id
where a.actor_type <> 'agent'
   or ag.visibility = 'team';

grant select on public.actor_directory to authenticated;

-- ===========================================================================
-- 2. Keep update_current_actor_profile returning the new column too so
--    callers that decode actor_directory rows from it stay consistent.
-- ===========================================================================
-- Drop first: adding default_workspace_id changes the RETURNS TABLE shape,
-- which `create or replace` is not allowed to do for set-returning fns.
drop function if exists public.update_current_actor_profile(uuid, text, text);

create or replace function public.update_current_actor_profile(
  p_actor_id uuid,
  p_display_name text,
  p_avatar_url text default null
)
returns table (
  id uuid,
  team_id uuid,
  actor_type text,
  user_id uuid,
  invited_by_actor_id uuid,
  display_name text,
  avatar_url text,
  last_active_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  member_status text,
  team_role text,
  agent_kind text,
  agent_status text,
  default_workspace_id uuid
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_display_name text := nullif(btrim(p_display_name), '');
  v_avatar_url text := nullif(btrim(coalesce(p_avatar_url, '')), '');
begin
  if v_display_name is null then
    raise exception 'display name is required'
      using errcode = '23514';
  end if;

  update public.actors a
     set display_name = v_display_name,
         avatar_url = v_avatar_url,
         updated_at = now()
   where a.id = p_actor_id
     and a.actor_type = 'member'
     and a.user_id = auth.uid();

  if not found then
    raise exception 'actor profile update is not allowed'
      using errcode = '42501';
  end if;

  return query
  select
    ad.id, ad.team_id, ad.actor_type, ad.user_id, ad.invited_by_actor_id,
    ad.display_name, ad.avatar_url, ad.last_active_at, ad.created_at, ad.updated_at,
    ad.member_status, ad.team_role, ad.agent_kind, ad.agent_status,
    ad.default_workspace_id
  from public.actor_directory ad
  where ad.id = p_actor_id;
end;
$$;

revoke all on function public.update_current_actor_profile(uuid, text, text) from public;
grant execute on function public.update_current_actor_profile(uuid, text, text) to authenticated;

-- ===========================================================================
-- 3. update_agent_defaults — any teammate can set an agent's
--    default workspace + agent_kind. Both args are optional; nulls leave
--    the existing value untouched (use a sentinel-less coalesce because
--    'clearing' a default is rare and reachable via member workspace
--    deletion which already nulls the FK via ON DELETE SET NULL).
-- ===========================================================================
create or replace function public.update_agent_defaults(
  p_agent_id uuid,
  p_default_workspace_id uuid default null,
  p_agent_kind text default null
)
returns table (
  agent_id uuid,
  default_workspace_id uuid,
  agent_kind text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_team_id     uuid;
  v_caller      uuid := auth.uid();
  v_new_kind    text := nullif(btrim(coalesce(p_agent_kind, '')), '');
begin
  if v_caller is null then
    raise exception 'update_agent_defaults requires authentication'
      using errcode = '42501';
  end if;

  select a.team_id into v_team_id
    from public.actors a
   where a.id = p_agent_id and a.actor_type = 'agent';

  if v_team_id is null then
    raise exception 'agent not found' using errcode = '23503';
  end if;

  -- Caller must be a teammate of the agent (any role).
  if not app.is_team_member(v_team_id) then
    raise exception 'caller is not a member of the agent team'
      using errcode = '42501';
  end if;

  -- Workspace, if specified, must belong to the same team.
  if p_default_workspace_id is not null then
    if not exists (
      select 1 from public.workspaces w
       where w.id = p_default_workspace_id and w.team_id = v_team_id
    ) then
      raise exception 'workspace is not in the agent team'
        using errcode = '23514';
    end if;
  end if;

  update public.agents ag
     set default_workspace_id = coalesce(p_default_workspace_id, ag.default_workspace_id),
         agent_kind           = coalesce(v_new_kind, ag.agent_kind),
         updated_at           = now()
   where ag.id = p_agent_id;

  if not found then
    raise exception 'agent row missing' using errcode = '23503';
  end if;

  return query
  select ag.id, ag.default_workspace_id, ag.agent_kind
    from public.agents ag
   where ag.id = p_agent_id;
end;
$$;

revoke all on function public.update_agent_defaults(uuid, uuid, text) from public;
grant execute on function public.update_agent_defaults(uuid, uuid, text) to authenticated;

commit;

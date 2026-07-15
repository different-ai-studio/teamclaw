-- Fix: agent ownership / access checks must be team-scoped.
--
-- Root cause: `app.current_member_id()` is NOT team-scoped. It returns the
-- caller's oldest member actor across ALL teams (`order by created_at limit 1`).
-- A user who belongs to more than one team has a distinct actor per team, so
-- every agent-ownership comparison of the form
--     agents.owner_member_id = app.current_member_id()
-- (and the matching agent_member_access self-checks) resolved against the wrong
-- actor in every team except the one holding the caller's oldest actor.
--
-- Symptom: a user who invited / owns a daemon in their non-oldest team saw the
-- agent filtered out of `list_connected_agents` entirely (personal visibility),
-- `is_owner = false`, and every write path (update_owned_agent_profile,
-- share_agent_to_team, make_agent_personal, agent_member_access management RLS)
-- rejected them with "only agent owner can ...". The owner DATA is correct
-- (`claim_team_invite` sets owner_member_id = inviter); only the resolution of
-- the *caller's* actor was wrong.
--
-- Fix: resolve the caller's actor within the agent's OWN team. A new helper
-- `app.current_actor_for_agent(agent_id)` builds on the existing team-scoped
-- `app.current_actor_id_for_team` (added in 202604220015) and replaces every
-- agent-domain use of `app.current_member_id()`.
--
-- NOTE: non-agent uses of `app.current_member_id()` (sessions, personal
-- shortcuts, core team_members RLS) share the same latent multi-team bug and are
-- intentionally left for a separate, separately-tested change.

-- 1. Team-scoped helper: the caller's actor id within the agent's own team.
create or replace function app.current_actor_for_agent(p_agent_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select app.current_actor_id_for_team(a.team_id)
    from public.actors a
   where a.id = p_agent_id
$$;

grant execute on function app.current_actor_for_agent(uuid) to authenticated;

-- 2. list_connected_agents — uses p_team_id directly (already team-scoped).
create or replace function public.list_connected_agents(p_team_id uuid)
returns table (
  agent_id uuid,
  display_name text,
  agent_types jsonb,
  default_agent_type text,
  permission_level text,
  visibility text,
  is_owner boolean,
  device_id text,
  last_active_at timestamptz
)
language sql
security definer
set search_path = public, auth
as $$
  select
    ag.id as agent_id,
    a.display_name,
    ag.agent_types,
    ag.default_agent_type,
    coalesce(ama.permission_level, case when app.is_team_member(p_team_id) then 'view' end) as permission_level,
    ag.visibility,
    ag.owner_member_id = app.current_actor_id_for_team(p_team_id) as is_owner,
    ag.device_id,
    a.last_active_at
  from public.agents ag
  join public.actors a on a.id = ag.id
  left join public.agent_member_access ama
    on ama.agent_id = ag.id
   and ama.member_id = app.current_actor_id_for_team(p_team_id)
  where a.team_id = p_team_id
    and ag.status = 'active'
    and (
      ag.visibility = 'team'
      or ag.owner_member_id = app.current_actor_id_for_team(p_team_id)
      or ama.member_id is not null
    )
$$;

revoke all on function public.list_connected_agents(uuid) from public;
grant execute on function public.list_connected_agents(uuid) to authenticated;

-- 3. agents SELECT RLS — let owners see their own personal agents.
drop policy if exists agents_select_if_visible on public.agents;
create policy agents_select_if_visible on public.agents
for select to authenticated using (
  exists (
    select 1
      from public.actors a
     where a.id = agents.id
       and app.is_team_member(a.team_id)
       and (
         agents.visibility = 'team'
         or agents.owner_member_id = app.current_actor_id_for_team(a.team_id)
       )
  )
);

-- 4. agent_member_access SELECT RLS — self rows or rows on agents I own.
drop policy if exists agent_member_access_select_if_agent_owner_or_self on public.agent_member_access;
create policy agent_member_access_select_if_agent_owner_or_self on public.agent_member_access
for select to authenticated using (
  member_id = app.current_actor_for_agent(agent_member_access.agent_id)
  or exists (
    select 1
      from public.agents ag
     where ag.id = agent_member_access.agent_id
       and ag.owner_member_id = app.current_actor_for_agent(ag.id)
  )
);

-- 5. agent_member_access manage (ALL) RLS — only the agent owner.
drop policy if exists agent_member_access_manage_if_agent_owner on public.agent_member_access;
create policy agent_member_access_manage_if_agent_owner on public.agent_member_access
for all to authenticated using (
  exists (
    select 1
      from public.agents ag
     where ag.id = agent_member_access.agent_id
       and ag.owner_member_id = app.current_actor_for_agent(ag.id)
  )
)
with check (
  exists (
    select 1
      from public.agents ag
     where ag.id = agent_member_access.agent_id
       and ag.owner_member_id = app.current_actor_for_agent(ag.id)
  )
);

-- 6. can_prompt_agent — caller has prompt/admin on a visible/owned agent.
create or replace function app.can_prompt_agent(target_agent_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.agent_member_access ama
      join public.agents ag on ag.id = ama.agent_id
      join public.actors act on act.id = ag.id
     where ama.agent_id = target_agent_id
       and ama.member_id = app.current_actor_id_for_team(act.team_id)
       and ama.permission_level in ('prompt', 'admin')
       and app.is_team_member(act.team_id)
       and (
         ag.visibility = 'team'
         or ag.owner_member_id = app.current_actor_id_for_team(act.team_id)
       )
  )
$$;

-- 7. share_agent_to_team — only the agent owner.
create or replace function public.share_agent_to_team(
  p_agent_id uuid
) returns void
language plpgsql security definer set search_path = public, auth, app
as $$
begin
  if not exists (
    select 1
      from public.agents ag
     where ag.id = p_agent_id
       and ag.owner_member_id = app.current_actor_for_agent(p_agent_id)
  ) then
    raise exception 'only agent owner can share agent to team'
      using errcode = '42501';
  end if;

  update public.agents
     set visibility = 'team',
         updated_at = now()
   where id = p_agent_id;
end;
$$;

-- 8. make_agent_personal — only the agent owner.
create or replace function public.make_agent_personal(
  p_agent_id uuid
) returns void
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_owner uuid;
begin
  select owner_member_id into v_owner
    from public.agents
   where id = p_agent_id;

  if v_owner is null or v_owner <> app.current_actor_for_agent(p_agent_id) then
    raise exception 'only agent owner can make agent personal'
      using errcode = '42501';
  end if;

  update public.agents
     set visibility = 'personal',
         updated_at = now()
   where id = p_agent_id;

  delete from public.agent_member_access
   where agent_id = p_agent_id
     and member_id <> v_owner;

  insert into public.agent_member_access (
    agent_id,
    member_id,
    permission_level,
    granted_by_member_id
  )
  values (p_agent_id, v_owner, 'admin', v_owner)
  on conflict (agent_id, member_id) do update
    set permission_level = 'admin',
        granted_by_member_id = excluded.granted_by_member_id,
        updated_at = now();
end;
$$;

-- 9. update_owned_agent_profile — only the agent owner.
create or replace function public.update_owned_agent_profile(
  p_agent_id uuid,
  p_display_name text,
  p_visibility text default null
)
returns table (
  agent_id uuid,
  display_name text,
  visibility text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth, app
as $$
declare
  v_display_name text := nullif(btrim(p_display_name), '');
  v_visibility text := nullif(btrim(coalesce(p_visibility, '')), '');
begin
  if v_display_name is null then
    raise exception 'display name is required'
      using errcode = '23514';
  end if;

  if v_visibility is not null and v_visibility not in ('personal', 'team') then
    raise exception 'visibility must be personal or team'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
      from public.agents ag
     where ag.id = p_agent_id
       and ag.owner_member_id = app.current_actor_for_agent(p_agent_id)
  ) then
    raise exception 'only agent owner can update agent profile'
      using errcode = '42501';
  end if;

  update public.actors a
     set display_name = v_display_name,
         updated_at = now()
   where a.id = p_agent_id
     and a.actor_type = 'agent';

  update public.agents ag
     set visibility = coalesce(v_visibility, ag.visibility),
         updated_at = now()
   where ag.id = p_agent_id;

  return query
  select ag.id, a.display_name, ag.visibility, greatest(a.updated_at, ag.updated_at)
    from public.agents ag
    join public.actors a on a.id = ag.id
   where ag.id = p_agent_id;
end;
$$;

revoke all on function public.update_owned_agent_profile(uuid, text, text) from public;
grant execute on function public.update_owned_agent_profile(uuid, text, text) to authenticated;

-- 10. list_agent_admin_member_actor_ids — owner branch must be team-scoped.
create or replace function public.list_agent_admin_member_actor_ids(
  p_agent_actor_id uuid
)
returns table (member_actor_id uuid)
language sql
stable
security definer
set search_path = public, app
as $$
  select ama.member_id
    from public.agent_member_access as ama
    join public.agents as ag on ag.id = ama.agent_id
   where ama.agent_id = p_agent_actor_id
     and ama.permission_level = 'admin'
     and (
       p_agent_actor_id = app.current_actor_id()
       or ag.owner_member_id = app.current_actor_for_agent(p_agent_actor_id)
     )
   order by ama.created_at;
$$;

revoke all on function public.list_agent_admin_member_actor_ids(uuid) from public, anon, authenticated;
grant execute on function public.list_agent_admin_member_actor_ids(uuid) to authenticated;

-- Per-member "default agent" preference.
--
-- Each human member (actor_type='member') may pick one agent actor in the same
-- team as their personal default (e.g. pre-selected when starting a session, and
-- pinned in the desktop "Recents" list). The column lives on public.members and
-- is cleared automatically (ON DELETE SET NULL) when the referenced agent is
-- removed.
--
-- Reads/writes go exclusively through the two SECURITY DEFINER RPCs below, which
-- resolve the caller's own actor for the team (never trusting a client-supplied
-- id) and enforce that the chosen agent is in the team, active, and visible to
-- the caller. This mirrors the pg-repo implementation in
-- services/fc/src/lib/pg-repo/actors.ts.

begin;

alter table public.members
  add column if not exists default_agent_id uuid
    references public.agents(id) on delete set null;

-- Returns the caller's default agent id for the given team (or null).
create or replace function public.get_member_default_agent(p_team_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_caller uuid := app.current_actor_id_for_team(p_team_id);
  v_default uuid;
begin
  if v_caller is null then
    raise exception 'caller is not a member of this team'
      using errcode = '42501';
  end if;

  select m.default_agent_id into v_default
    from public.members m
   where m.id = v_caller;

  return v_default;
end;
$$;

-- Sets (or clears, when p_agent_id is null) the caller's default agent for the
-- team. Rejects agents that are not in the team / not active / not visible to
-- the caller. Returns the new default agent id.
create or replace function public.set_member_default_agent(
  p_team_id uuid,
  p_agent_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_caller     uuid := app.current_actor_id_for_team(p_team_id);
  v_agent_team uuid;
  v_actor_type text;
  v_status     text;
  v_visibility text;
  v_owner      uuid;
begin
  if v_caller is null then
    raise exception 'caller is not a member of this team'
      using errcode = '42501';
  end if;

  if p_agent_id is not null then
    select a.team_id, a.actor_type, ag.status, ag.visibility, ag.owner_member_id
      into v_agent_team, v_actor_type, v_status, v_visibility, v_owner
      from public.actors a
      join public.agents ag on ag.id = a.id
     where a.id = p_agent_id;

    if v_agent_team is null or v_actor_type <> 'agent' or v_agent_team <> p_team_id then
      raise exception 'agent is not in this team' using errcode = '23514';
    end if;

    if v_status <> 'active' then
      raise exception 'agent is not active' using errcode = '23514';
    end if;

    -- Visibility gate: team-visible agents are fine; personal agents only when
    -- the caller owns them.
    if v_visibility <> 'team' and v_owner is distinct from v_caller then
      raise exception 'agent is not visible to caller' using errcode = '42501';
    end if;
  end if;

  update public.members m
     set default_agent_id = p_agent_id,
         updated_at = now()
   where m.id = v_caller;

  if not found then
    raise exception 'member not found' using errcode = '23503';
  end if;

  return p_agent_id;
end;
$$;

revoke all on function public.get_member_default_agent(uuid) from public;
grant execute on function public.get_member_default_agent(uuid) to authenticated;
revoke all on function public.set_member_default_agent(uuid, uuid) from public;
grant execute on function public.set_member_default_agent(uuid, uuid) to authenticated;

commit;

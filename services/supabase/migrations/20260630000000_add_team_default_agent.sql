-- 20260630000000_add_team_default_agent.sql
-- Team-level default agent: a single fallback agent for the whole team,
-- settable by owner/admin only. Resolution precedence is member > team.

set search_path = amux, public;

alter table amux.teams
  add column if not exists default_agent_id uuid
  references amux.agents(id) on delete set null;

-- Set the team default. Owner/admin only. Agent must be team-visible & active.
create or replace function amux.set_team_default_agent(
  p_team_id uuid,
  p_agent_id uuid default null
) returns uuid
  language plpgsql security definer
  set search_path to 'amux', 'public', 'auth'
as $$
declare
  v_role       text := amux.current_team_role(p_team_id);
  v_agent_team uuid;
  v_actor_type text;
  v_status     text;
  v_visibility text;
begin
  if v_role is null or v_role not in ('owner','admin') then
    raise exception 'only team owner/admin can set the team default agent'
      using errcode = '42501';
  end if;

  if p_agent_id is not null then
    select a.team_id, a.actor_type, ag.status, ag.visibility
      into v_agent_team, v_actor_type, v_status, v_visibility
      from amux.actors a
      join amux.agents ag on ag.id = a.id
     where a.id = p_agent_id;

    if v_agent_team is null or v_actor_type <> 'agent' or v_agent_team <> p_team_id then
      raise exception 'agent is not in this team' using errcode = '23514';
    end if;
    if v_status <> 'active' then
      raise exception 'agent is not active' using errcode = '23514';
    end if;
    -- Team default must be visible to the whole team (no personal agents).
    if v_visibility <> 'team' then
      raise exception 'team default agent must be team-visible' using errcode = '23514';
    end if;
  end if;

  update amux.teams t
     set default_agent_id = p_agent_id,
         updated_at = now()
   where t.id = p_team_id;

  if not found then
    raise exception 'team not found' using errcode = '23503';
  end if;

  return p_agent_id;
end;
$$;

-- Read the raw team default. Any member may call.
create or replace function amux.get_team_default_agent(p_team_id uuid)
  returns uuid
  language plpgsql stable security definer
  set search_path to 'amux', 'public', 'auth'
as $$
declare
  v_caller uuid := amux.current_actor_id_for_team(p_team_id);
  v_default uuid;
begin
  if v_caller is null then
    raise exception 'caller is not a member of this team' using errcode = '42501';
  end if;
  select t.default_agent_id into v_default from amux.teams t where t.id = p_team_id;
  return v_default;
end;
$$;

-- Resolve the caller's effective default: member default, else team default.
create or replace function amux.get_effective_default_agent(p_team_id uuid)
  returns uuid
  language plpgsql stable security definer
  set search_path to 'amux', 'public', 'auth'
as $$
declare
  v_caller uuid := amux.current_actor_id_for_team(p_team_id);
  v_member uuid;
  v_team   uuid;
begin
  if v_caller is null then
    raise exception 'caller is not a member of this team' using errcode = '42501';
  end if;
  select m.default_agent_id into v_member from amux.members m where m.id = v_caller;
  if v_member is not null then
    return v_member;
  end if;
  select t.default_agent_id into v_team from amux.teams t where t.id = p_team_id;
  return v_team;
end;
$$;

grant execute on function amux.set_team_default_agent(uuid, uuid) to authenticated;
grant execute on function amux.get_team_default_agent(uuid) to authenticated;
grant execute on function amux.get_effective_default_agent(uuid) to authenticated;

-- Relax agents.status to allow the 'invited' intermediate state used by
-- create_daemon_invite / claim_daemon_invite.
alter table public.agents
  drop constraint if exists agents_status_check;

alter table public.agents
  add constraint agents_status_check
  check (status in ('invited', 'active', 'disabled', 'archived'));

create or replace function public.create_daemon_invite(
  p_team_id uuid,
  p_display_name text
)
returns table (
  invite_token uuid,
  agent_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_caller_member uuid := app.current_member_id();
  v_agent_actor uuid;
  v_agent uuid;
  v_invite record;
begin
  if v_caller_member is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.team_members
    where team_id = p_team_id and member_id = v_caller_member
  ) then
    raise exception 'caller not in team' using errcode = '42501';
  end if;

  insert into public.actors (team_id, actor_type, display_name)
    values (p_team_id, 'agent', p_display_name)
    returning id into v_agent_actor;

  insert into public.agents (id, created_by_member_id, agent_kind, status)
    values (v_agent_actor, v_caller_member, 'claude', 'invited')
    returning id into v_agent;

  insert into public.daemon_invites
    (team_id, agent_id, created_by_member_id, expires_at)
    values (p_team_id, v_agent, v_caller_member, now() + interval '15 minutes')
    returning daemon_invites.invite_token,
              daemon_invites.agent_id,
              daemon_invites.expires_at
      into v_invite;

  return query select v_invite.invite_token, v_invite.agent_id, v_invite.expires_at;
end;
$$;

grant execute on function public.create_daemon_invite(uuid, text) to authenticated;

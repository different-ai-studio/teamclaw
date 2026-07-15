alter table public.workspaces
  add column agent_id uuid null references public.agents(id) on delete set null;

update public.workspaces w
set agent_id = a.id
from public.agents a
where a.default_workspace_id = w.id
  and w.agent_id is null;

create index if not exists idx_workspaces_agent_id on public.workspaces(agent_id);

create or replace function app.enforce_parent_integrity()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'actors' then
    if new.actor_type is distinct from old.actor_type then
      if exists (select 1 from public.members where id = new.id) and new.actor_type <> 'member' then
        raise exception 'actors.actor_type cannot diverge from members.id'
          using errcode = '23514';
      end if;

      if exists (select 1 from public.agents where id = new.id) and new.actor_type <> 'agent' then
        raise exception 'actors.actor_type cannot diverge from agents.id'
          using errcode = '23514';
      end if;
    end if;

    if new.team_id is distinct from old.team_id then
      if exists (select 1 from public.members where id = new.id)
        or exists (select 1 from public.agents where id = new.id)
        or exists (select 1 from public.team_members where member_id = new.id)
        or exists (select 1 from public.workspaces where created_by_member_id = new.id or agent_id = new.id)
        or exists (select 1 from public.agent_member_access where member_id = new.id or granted_by_member_id = new.id or agent_id = new.id)
        or exists (select 1 from public.ideas where created_by_actor_id = new.id)
        or exists (select 1 from public.idea_external_refs where linked_by_actor_id = new.id)
        or exists (select 1 from public.sessions where created_by_actor_id = new.id or primary_agent_id = new.id)
        or exists (select 1 from public.session_participants where actor_id = new.id)
        or exists (select 1 from public.messages where sender_actor_id = new.id)
        or exists (select 1 from public.agent_runtimes where agent_id = new.id) then
        perform app.reject_team_reassignment('actors.team_id');
      end if;
    end if;
  elsif tg_table_name = 'workspaces' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from public.agents where default_workspace_id = new.id)
        or old.agent_id is not null
        or exists (select 1 from public.ideas where workspace_id = new.id)
        or exists (select 1 from public.agent_runtimes where workspace_id = new.id)
      ) then
      perform app.reject_team_reassignment('workspaces.team_id');
    end if;
  elsif tg_table_name = 'ideas' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from public.ideas where parent_idea_id = new.id)
        or exists (select 1 from public.idea_external_refs where idea_id = new.id)
        or exists (select 1 from public.sessions where idea_id = new.id)
      ) then
      perform app.reject_team_reassignment('ideas.team_id');
    end if;
  elsif tg_table_name = 'sessions' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from public.session_participants where session_id = new.id)
        or exists (select 1 from public.messages where session_id = new.id)
        or exists (select 1 from public.agent_runtimes where session_id = new.id)
      ) then
      perform app.reject_team_reassignment('sessions.team_id');
    end if;
  else
    raise exception 'app.enforce_parent_integrity is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$$;

create or replace function app.enforce_core_team_integrity()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'team_members' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.member_id),
      'team_members.member_id'
    );
  elsif tg_table_name = 'workspaces' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_member_id),
      'workspaces.created_by_member_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.agent_id),
      'workspaces.agent_id'
    );
  elsif tg_table_name = 'agents' then
    perform app.require_same_team(
      app.actor_team_id(new.id),
      app.actor_team_id(new.created_by_member_id),
      'agents.created_by_member_id'
    );
    perform app.require_same_team(
      app.actor_team_id(new.id),
      app.table_team_id('public.workspaces'::regclass, new.default_workspace_id),
      'agents.default_workspace_id'
    );
  elsif tg_table_name = 'agent_member_access' then
    perform app.require_same_team(
      app.actor_team_id(new.agent_id),
      app.actor_team_id(new.member_id),
      'agent_member_access.member_id'
    );
    perform app.require_same_team(
      app.actor_team_id(new.agent_id),
      app.actor_team_id(new.granted_by_member_id),
      'agent_member_access.granted_by_member_id'
    );
  elsif tg_table_name = 'ideas' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.workspaces'::regclass, new.workspace_id),
      'ideas.workspace_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.ideas'::regclass, new.parent_idea_id),
      'ideas.parent_idea_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_actor_id),
      'ideas.created_by_actor_id'
    );
  elsif tg_table_name = 'idea_external_refs' then
    perform app.require_same_team(
      app.table_team_id('public.ideas'::regclass, new.idea_id),
      app.actor_team_id(new.linked_by_actor_id),
      'idea_external_refs.linked_by_actor_id'
    );
  elsif tg_table_name = 'sessions' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.ideas'::regclass, new.idea_id),
      'sessions.idea_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_actor_id),
      'sessions.created_by_actor_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.primary_agent_id),
      'sessions.primary_agent_id'
    );
  elsif tg_table_name = 'session_participants' then
    perform app.require_same_team(
      app.table_team_id('public.sessions'::regclass, new.session_id),
      app.actor_team_id(new.actor_id),
      'session_participants.actor_id'
    );
  elsif tg_table_name = 'messages' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.sessions'::regclass, new.session_id),
      'messages.session_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.sender_actor_id),
      'messages.sender_actor_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.messages'::regclass, new.reply_to_message_id),
      'messages.reply_to_message_id'
    );
  elsif tg_table_name = 'agent_runtimes' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.agent_id),
      'agent_runtimes.agent_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.sessions'::regclass, new.session_id),
      'agent_runtimes.session_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.workspaces'::regclass, new.workspace_id),
      'agent_runtimes.workspace_id'
    );
  else
    raise exception 'app.enforce_core_team_integrity is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$$;

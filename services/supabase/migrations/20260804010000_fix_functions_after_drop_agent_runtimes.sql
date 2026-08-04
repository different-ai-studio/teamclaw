-- 20260803010000 dropped amux.agent_runtimes but left trigger helpers pointing at
-- it. Any UPDATE sessions (including bump_session_last_message after INSERT
-- messages) hit enforce_parent_integrity → 42P01.
--
-- Rewrite the two integrity functions without agent_runtimes references.
-- Workspace bindings now live on session_participants.workspace_id (ADR-0005).

create or replace function amux.enforce_core_team_integrity()
returns trigger
language plpgsql
as $function$
begin
  if tg_table_name = 'team_members' then
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.member_id),
      'team_members.member_id'
    );
  elsif tg_table_name = 'workspaces' then
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.created_by_member_id),
      'workspaces.created_by_member_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.agent_id),
      'workspaces.agent_id'
    );
  elsif tg_table_name = 'agents' then
    perform amux.require_same_team(
      amux.actor_team_id(new.id),
      amux.table_team_id('amux.workspaces'::regclass, new.default_workspace_id),
      'agents.default_workspace_id'
    );
  elsif tg_table_name = 'agent_member_access' then
    perform amux.require_same_team(
      amux.actor_team_id(new.agent_id),
      amux.actor_team_id(new.member_id),
      'agent_member_access.member_id'
    );
    perform amux.require_same_team(
      amux.actor_team_id(new.agent_id),
      amux.actor_team_id(new.granted_by_member_id),
      'agent_member_access.granted_by_member_id'
    );
  elsif tg_table_name = 'ideas' then
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.workspaces'::regclass, new.workspace_id),
      'ideas.workspace_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.ideas'::regclass, new.parent_idea_id),
      'ideas.parent_idea_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.created_by_actor_id),
      'ideas.created_by_actor_id'
    );
  elsif tg_table_name = 'idea_external_refs' then
    perform amux.require_same_team(
      amux.table_team_id('amux.ideas'::regclass, new.idea_id),
      amux.actor_team_id(new.linked_by_actor_id),
      'idea_external_refs.linked_by_actor_id'
    );
  elsif tg_table_name = 'sessions' then
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.ideas'::regclass, new.idea_id),
      'sessions.idea_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.created_by_actor_id),
      'sessions.created_by_actor_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.primary_agent_id),
      'sessions.primary_agent_id'
    );
  elsif tg_table_name = 'session_participants' then
    perform amux.require_same_team(
      amux.table_team_id('amux.sessions'::regclass, new.session_id),
      amux.actor_team_id(new.actor_id),
      'session_participants.actor_id'
    );
  elsif tg_table_name = 'messages' then
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.sessions'::regclass, new.session_id),
      'messages.session_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.sender_actor_id),
      'messages.sender_actor_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.messages'::regclass, new.reply_to_message_id),
      'messages.reply_to_message_id'
    );
  else
    raise exception 'amux.enforce_core_team_integrity is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$function$;

create or replace function amux.enforce_parent_integrity()
returns trigger
language plpgsql
as $function$
begin
  if tg_table_name = 'actors' then
    if new.actor_type is distinct from old.actor_type then
      if exists (select 1 from amux.members where id = new.id) and new.actor_type <> 'member' then
        raise exception 'actors.actor_type cannot diverge from members.id'
          using errcode = '23514';
      end if;

      if exists (select 1 from amux.agents where id = new.id) and new.actor_type <> 'agent' then
        raise exception 'actors.actor_type cannot diverge from agents.id'
          using errcode = '23514';
      end if;
    end if;

    if new.team_id is distinct from old.team_id then
      if exists (select 1 from amux.members where id = new.id)
        or exists (select 1 from amux.agents where id = new.id)
        or exists (select 1 from amux.team_members where member_id = new.id)
        or exists (select 1 from amux.workspaces where created_by_member_id = new.id or agent_id = new.id)
        or exists (select 1 from amux.agent_member_access where member_id = new.id or granted_by_member_id = new.id or agent_id = new.id)
        or exists (select 1 from amux.ideas where created_by_actor_id = new.id)
        or exists (select 1 from amux.idea_external_refs where linked_by_actor_id = new.id)
        or exists (select 1 from amux.sessions where created_by_actor_id = new.id or primary_agent_id = new.id)
        or exists (select 1 from amux.session_participants where actor_id = new.id)
        or exists (select 1 from amux.messages where sender_actor_id = new.id) then
        perform amux.reject_team_reassignment('actors.team_id');
      end if;
    end if;
  elsif tg_table_name = 'workspaces' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from amux.agents where default_workspace_id = new.id)
        or old.agent_id is not null
        or exists (select 1 from amux.ideas where workspace_id = new.id)
        or exists (select 1 from amux.session_participants where workspace_id = new.id)
      ) then
      perform amux.reject_team_reassignment('workspaces.team_id');
    end if;
  elsif tg_table_name = 'ideas' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from amux.ideas where parent_idea_id = new.id)
        or exists (select 1 from amux.idea_external_refs where idea_id = new.id)
        or exists (select 1 from amux.sessions where idea_id = new.id)
      ) then
      perform amux.reject_team_reassignment('ideas.team_id');
    end if;
  elsif tg_table_name = 'sessions' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from amux.session_participants where session_id = new.id)
        or exists (select 1 from amux.messages where session_id = new.id)
      ) then
      perform amux.reject_team_reassignment('sessions.team_id');
    end if;
  else
    raise exception 'amux.enforce_parent_integrity is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$function$;

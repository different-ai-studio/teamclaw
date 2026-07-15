begin;

create or replace function pg_temp.raises_sqlstate(p_sql text, p_expected_sqlstate text)
returns boolean
language plpgsql
as $$
declare
  v_sqlstate text;
begin
  execute p_sql;
  return false;
exception
  when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    return v_sqlstate = p_expected_sqlstate;
end;
$$;

select plan(68);

select has_schema('app');
select has_table('public', 'teams');
select has_table('public', 'actors');
select has_table('public', 'members');
select has_table('public', 'team_members');
select has_table('public', 'workspaces');
select has_table('public', 'agents');
select has_table('public', 'agent_member_access');
select has_table('public', 'ideas');
select has_table('public', 'idea_activities');
select has_table('public', 'idea_external_refs');
select has_table('public', 'sessions');
select has_table('public', 'session_participants');
select has_table('public', 'messages');
select has_table('public', 'agent_runtimes');

select col_type_is('public', 'actors', 'last_active_at', 'timestamp with time zone');
select col_type_is('public', 'actors', 'avatar_url', 'text');
select col_type_is('public', 'members', 'id', 'uuid');
select col_type_is('public', 'agents', 'id', 'uuid');
select col_type_is('public', 'workspaces', 'agent_id', 'uuid');
select col_type_is('public', 'ideas', 'sort_order', 'integer');
select col_type_is('public', 'idea_activities', 'activity_type', 'text');
select col_type_is('public', 'idea_activities', 'attachment_urls', 'text[]');

select fk_ok('public', 'members', 'id', 'public', 'actors', 'id');
select fk_ok('public', 'agents', 'id', 'public', 'actors', 'id');
select fk_ok('public', 'workspaces', 'agent_id', 'public', 'agents', 'id');
select fk_ok('public', 'idea_activities', 'idea_id', 'public', 'ideas', 'id');
select fk_ok('public', 'sessions', 'idea_id', 'public', 'ideas', 'id');
select fk_ok('public', 'messages', 'session_id', 'public', 'sessions', 'id');
select fk_ok('public', 'agent_runtimes', 'agent_id', 'public', 'agents', 'id');

select has_trigger('public', 'members', 'enforce_members_actor_type');
select has_trigger('public', 'agents', 'enforce_agents_actor_type');
select has_trigger('public', 'team_members', 'enforce_team_members_same_team');
select has_trigger('public', 'workspaces', 'enforce_workspaces_same_team');
select has_trigger('public', 'actors', 'enforce_actors_parent_integrity');
select has_trigger('public', 'agents', 'enforce_agents_same_team');
select has_trigger('public', 'agent_member_access', 'enforce_agent_member_access_same_team');
select has_trigger('public', 'ideas', 'enforce_ideas_same_team');
select has_trigger('public', 'idea_activities', 'set_idea_activities_updated_at');
select has_trigger('public', 'workspaces', 'enforce_workspaces_parent_integrity');
select has_trigger('public', 'idea_external_refs', 'enforce_idea_external_refs_same_team');
select has_trigger('public', 'sessions', 'enforce_sessions_same_team');
select has_trigger('public', 'ideas', 'enforce_ideas_parent_integrity');
select has_trigger('public', 'session_participants', 'enforce_session_participants_same_team');
select has_trigger('public', 'messages', 'enforce_messages_same_team');
select has_trigger('public', 'sessions', 'enforce_sessions_parent_integrity');
select has_trigger('public', 'agent_runtimes', 'enforce_agent_runtimes_same_team');

insert into public.teams (id, slug, name)
values
  ('00000000-0000-0000-0000-000000000001', 'team-one', 'Team One'),
  ('00000000-0000-0000-0000-000000000002', 'team-two', 'Team Two');

insert into public.actors (id, team_id, actor_type, display_name)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'member', 'Subtype Member'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'member', 'Scoped Member');

insert into public.members (id, status)
values
  ('10000000-0000-0000-0000-000000000001', 'active'),
  ('10000000-0000-0000-0000-000000000002', 'active');

insert into public.team_members (id, team_id, member_id, role)
values (
  '20000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'member'
);

insert into public.workspaces (id, team_id, created_by_member_id, name)
values (
  '30000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'Workspace One'
);

insert into public.actors (id, team_id, actor_type, display_name)
values (
  '10000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000002',
  'agent',
  'Scoped Agent'
);

insert into public.agents (id, owner_member_id, agent_kind, status)
values (
  '10000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000002',
  'amuxd',
  'active'
);

insert into public.ideas (id, team_id, workspace_id, created_by_actor_id, title, status)
values (
  '40000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'Idea One',
  'open'
);

insert into public.sessions (id, team_id, idea_id, created_by_actor_id, mode, title)
values (
  '50000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'solo',
  'Session One'
);

insert into public.sessions (id, team_id, idea_id, created_by_actor_id, mode, title)
values (
  '50000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  null,
  '10000000-0000-0000-0000-000000000002',
  'collab',
  'Session Without Idea'
);

insert into public.messages (id, team_id, session_id, sender_actor_id, kind, content)
values (
  '60000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'text',
  'Hello'
);

insert into public.agent_runtimes (team_id, agent_id, session_id, backend_type, status)
values (
  '00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003',
  '50000000-0000-0000-0000-000000000001',
  'claude',
  'idle'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$update public.actors
          set actor_type = 'agent'
          where id = '10000000-0000-0000-0000-000000000001'$sql$,
    '23514'
  ),
  'actors.actor_type update is rejected when a members row exists'
);

select ok(
  exists(
    select 1
    from public.sessions
    where id = '50000000-0000-0000-0000-000000000002'
      and idea_id is null
  ),
  'sessions.idea_id may be null'
);

select ok(
  exists(
    select 1
    from public.agent_runtimes
    where agent_id = '10000000-0000-0000-0000-000000000003'
      and status = 'idle'
  ),
  'agent_runtimes.status accepts idle'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$update public.actors
          set team_id = '00000000-0000-0000-0000-000000000002'
          where id = '10000000-0000-0000-0000-000000000002'$sql$,
    '23514'
  ),
  'actors.team_id update is rejected when dependents exist'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$update public.workspaces
          set team_id = '00000000-0000-0000-0000-000000000002'
          where id = '30000000-0000-0000-0000-000000000001'$sql$,
    '23514'
  ),
  'workspaces.team_id update is rejected when dependent ideas exist'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$update public.workspaces
          set agent_id = '10000000-0000-0000-0000-000000000003'
          where id = '30000000-0000-0000-0000-000000000001'$sql$,
    '23514'
  ),
  'workspaces.agent_id enforces same-team scoping'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$update public.ideas
          set team_id = '00000000-0000-0000-0000-000000000002'
          where id = '40000000-0000-0000-0000-000000000001'$sql$,
    '23514'
  ),
  'ideas.team_id update is rejected when dependent sessions exist'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$update public.sessions
          set team_id = '00000000-0000-0000-0000-000000000002'
          where id = '50000000-0000-0000-0000-000000000001'$sql$,
    '23514'
  ),
  'sessions.team_id update is rejected when dependent messages exist'
);

-- 202604220008: workspaces unique is (team_id, agent_id, name)
do $$
declare
  v_team uuid := gen_random_uuid();
  v_agent_a uuid := gen_random_uuid();
  v_agent_b uuid := gen_random_uuid();
begin
  insert into public.teams (id, slug, name) values (v_team, 'dup-ws', 'dup-ws');
  insert into public.actors (id, team_id, actor_type, display_name)
    values ('10000000-0000-0000-0000-0000000000aa', v_team, 'member', 'owner'),
           (v_agent_a, v_team, 'agent', 'a'),
           (v_agent_b, v_team, 'agent', 'b');
  insert into public.members (id, status)
    values ('10000000-0000-0000-0000-0000000000aa', 'active');
  insert into public.team_members (team_id, member_id, role)
    values (v_team, '10000000-0000-0000-0000-0000000000aa', 'owner');
  insert into public.agents (id, owner_member_id, agent_kind, status) values
    (v_agent_a, '10000000-0000-0000-0000-0000000000aa', 'claude', 'active'),
    (v_agent_b, '10000000-0000-0000-0000-0000000000aa', 'claude', 'active');

  -- Same name on two different agents in the same team must now be allowed.
  insert into public.workspaces (team_id, agent_id, name) values (v_team, v_agent_a, 'amux');
  insert into public.workspaces (team_id, agent_id, name) values (v_team, v_agent_b, 'amux');

  -- Duplicate on the SAME agent must still fail.
  if not pg_temp.raises_sqlstate(
    format('insert into public.workspaces (team_id, agent_id, name) values (%L, %L, %L)',
           v_team, v_agent_a, 'amux'),
    '23505'
  ) then
    raise exception 'expected unique violation on (team_id, agent_id, name)';
  end if;
end;
$$;

select ok(
  true,
  'workspaces unique constraint is (team_id, agent_id, name)'
);

-- 202604220015: actor unified identity assertions
select col_type_is('public', 'actors', 'user_id',             'uuid');
select col_type_is('public', 'actors', 'invited_by_actor_id', 'uuid');
select col_is_null('public', 'actors', 'user_id');
select col_is_null('public', 'actors', 'invited_by_actor_id');
select fk_ok('public', 'actors', 'invited_by_actor_id', 'public', 'actors', 'id');
select has_table('public', 'team_invites');
select hasnt_table('public', 'daemon_invites');
select has_view('public',  'actor_directory');
select has_column('public', 'actor_directory', 'avatar_url');
select has_column('public', 'actor_directory', 'agent_visibility');
select has_function('public', 'update_current_actor_profile', array['uuid', 'text', 'text']);
select hasnt_column('public', 'members', 'user_id');
select hasnt_column('public', 'agents',  'created_by_member_id');

select * from finish();
rollback;

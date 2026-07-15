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

select plan(47);

select lives_ok(
$$
  select app.current_member_id();
$$,
'helper function exists'
);

select lives_ok(
$$
  select app.current_actor_id();
$$,
'actor helper exists'
);

select lives_ok(
$$
  select app.is_team_member(gen_random_uuid());
$$,
'team membership helper exists'
);

select lives_ok(
$$
  select app.can_prompt_agent(gen_random_uuid());
$$,
'agent prompt helper exists'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.update_current_actor_profile(uuid,text,text)',
    'EXECUTE'
  ),
  'authenticated can execute actor profile update rpc'
);

select policies_are('public', 'teams', array[
  'teams_select_if_member'
]);

select policies_are('public', 'sessions', array[
  'sessions_select_if_team_member',
  'sessions_insert_if_team_member',
  'sessions_update_if_team_member'
]);

select policies_are('public', 'messages', array[
  'messages_select_if_session_participant',
  'messages_insert_if_session_participant'
]);

select policies_are('public', 'agent_member_access', array[
  'agent_member_access_select_if_agent_owner_or_self',
  'agent_member_access_manage_if_agent_owner'
]);

select policies_are('public', 'agent_runtimes', array[
  'agent_runtimes_select_if_team_member'
]);

insert into auth.users (id, email)
values
  ('90000000-0000-0000-0000-000000000001', 'active-member@example.com'),
  ('90000000-0000-0000-0000-000000000002', 'other-member@example.com'),
  ('90000000-0000-0000-0000-000000000003', 'admin-member@example.com');

insert into public.teams (id, slug, name)
values (
  '00000000-0000-0000-0000-000000000001',
  'team-one',
  'Team One'
);

insert into public.actors (id, team_id, actor_type, display_name)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'member', 'Active Member'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'member', 'Other Member'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'member', 'Admin Member'),
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'agent', 'Build Agent');

insert into public.members (id, user_id, status)
values
  ('10000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001', 'active'),
  ('10000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000002', 'active'),
  ('10000000-0000-0000-0000-000000000003', '90000000-0000-0000-0000-000000000003', 'active');

insert into public.team_members (id, team_id, member_id, role)
values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'member'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'member'),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'admin');

insert into public.workspaces (id, team_id, created_by_member_id, name)
values (
  '30000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'Workspace One'
);

insert into public.agents (id, default_workspace_id, owner_member_id, visibility, agent_kind, status)
values (
  '10000000-0000-0000-0000-0000000000a1',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'team',
  'codex',
  'active'
);

insert into public.ideas (id, team_id, workspace_id, created_by_actor_id, title, status)
values (
  '40000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'Idea One',
  'open'
);

insert into public.sessions (id, team_id, idea_id, created_by_actor_id, primary_agent_id, mode, title)
values (
  '50000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-0000000000a1',
  'solo',
  'Session One'
);

insert into public.session_participants (id, session_id, actor_id, role)
values
  ('70000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner'),
  ('70000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'observer');

insert into public.messages (id, team_id, session_id, sender_actor_id, kind, content)
values (
  '60000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'text',
  'Hello'
);

insert into public.agent_member_access (
  id,
  agent_id,
  member_id,
  permission_level,
  granted_by_member_id
)
values (
  '81000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-0000000000a1',
  '10000000-0000-0000-0000-000000000002',
  'prompt',
  '10000000-0000-0000-0000-000000000003'
);

select ok(
  not has_function_privilege('anon', 'app.current_member_id()', 'EXECUTE'),
  'anon cannot execute current_member_id directly'
);

select ok(
  has_function_privilege('authenticated', 'app.current_member_id()', 'EXECUTE'),
  'authenticated can execute current_member_id directly'
);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';

select lives_ok(
  $sql$
    select public.update_current_actor_profile(
      '10000000-0000-0000-0000-000000000001',
      'Renamed Member',
      'https://example.com/avatar.jpg'
    )
  $sql$,
  'current user can update own actor profile'
);

select is(
  (select display_name from public.actors where id = '10000000-0000-0000-0000-000000000001'),
  'Renamed Member',
  'profile update stores display name'
);

select is(
  (select avatar_url from public.actor_directory where id = '10000000-0000-0000-0000-000000000001'),
  'https://example.com/avatar.jpg',
  'actor_directory exposes updated avatar url'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      select public.update_current_actor_profile(
        '10000000-0000-0000-0000-000000000002',
        'Spoofed Member',
        null
      )
    $sql$,
    '42501'
  ),
  'current user cannot update another actor profile'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      select public.update_current_actor_profile(
        '10000000-0000-0000-0000-000000000001',
        '   ',
        null
      )
    $sql$,
    '23514'
  ),
  'actor profile update rejects blank display names'
);

select is(
  app.current_member_id(),
  '10000000-0000-0000-0000-000000000001'::uuid,
  'active member resolves current_member_id'
);

select is(
  app.current_actor_id(),
  '10000000-0000-0000-0000-000000000001'::uuid,
  'active member resolves current_actor_id'
);

select ok(
  app.is_session_participant('50000000-0000-0000-0000-000000000001'::uuid),
  'active participant is recognized'
);

select is(
  (select count(*) from public.messages),
  1::bigint,
  'active participant can read session messages'
);

set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000002';

select ok(
  app.can_prompt_agent('10000000-0000-0000-0000-0000000000a1'::uuid),
  'explicit grant allows active team member to prompt agent'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      insert into public.session_participants (
        id,
        session_id,
        actor_id,
        role
      )
      values (
        '70000000-0000-0000-0000-000000000003',
        '50000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000002',
        'observer'
      )
    $sql$,
    '42501'
  ),
  'non-participant team member cannot self-enroll into a session'
);

select is(
  (select count(*) from public.messages),
  0::bigint,
  'failed self-enrollment does not grant session message visibility'
);

set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000003';

select ok(
  lives_ok(
    $sql$
      insert into public.session_participants (
        id,
        session_id,
        actor_id,
        role
      )
      values (
        '70000000-0000-0000-0000-000000000004',
        '50000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000002',
        'observer'
      )
    $sql$
  ),
  'existing participant can add another actor to the session'
);

delete from public.session_participants
where id = '70000000-0000-0000-0000-000000000004';

set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';

select lives_ok(
  $sql$
    insert into public.session_participants (
      id,
      session_id,
      actor_id,
      role
    )
    values (
      '70000000-0000-0000-0000-000000000009',
      '50000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000002',
      'observer'
    )
  $sql$,
  'session creator can bootstrap additional participants'
);

delete from public.session_participants
where id = '70000000-0000-0000-0000-000000000009';

set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000002';

select is(
  (select count(*) from public.messages),
  0::bigint,
  'failed participant-managed add does not expand session message visibility'
);

reset role;

delete from public.team_members
where id = '20000000-0000-0000-0000-000000000002';

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000002';

select ok(
  not app.can_prompt_agent('10000000-0000-0000-0000-0000000000a1'::uuid),
  'explicit grant no longer authorizes removed team member'
);

reset role;

insert into public.team_members (id, team_id, member_id, role)
values (
  '20000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'member'
);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';

reset role;

delete from public.team_members
where id = '20000000-0000-0000-0000-000000000001';

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';

select ok(
  not app.is_team_member('00000000-0000-0000-0000-000000000001'::uuid),
  'team membership removal revokes team membership'
);

select ok(
  not app.is_session_participant('50000000-0000-0000-0000-000000000001'::uuid),
  'team membership removal revokes session participation'
);

select is(
  (select count(*) from public.messages),
  0::bigint,
  'team membership removal revokes session message visibility'
);

reset role;

insert into public.team_members (id, team_id, member_id, role)
values (
  '20000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'member'
);

reset role;

delete from public.session_participants
where id = '70000000-0000-0000-0000-000000000001';

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';

select ok(
  not app.is_session_participant('50000000-0000-0000-0000-000000000001'::uuid),
  'participant removal revokes session participation'
);

select is(
  (select count(*) from public.messages),
  0::bigint,
  'participant removal revokes session message visibility'
);

reset role;

insert into public.session_participants (id, session_id, actor_id, role)
values (
  '70000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'owner'
);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000003';

select ok(
  not app.can_prompt_agent('10000000-0000-0000-0000-0000000000a1'::uuid),
  'active team admin without grant cannot prompt team agent'
);

reset role;

update public.members
set status = 'disabled'
where id = '10000000-0000-0000-0000-000000000003';

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000003';

select is(
  app.current_member_id(),
  null::uuid,
  'disabled member no longer resolves current_member_id'
);

select ok(
  not app.can_prompt_agent('10000000-0000-0000-0000-0000000000a1'::uuid),
  'disabled team admin cannot prompt agent'
);

select ok(
  not app.is_session_participant('50000000-0000-0000-0000-000000000001'::uuid),
  'disabled participant loses session participation'
);

select is(
  (select count(*) from public.messages),
  0::bigint,
  'disabled participant cannot read session messages'
);

set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      insert into public.messages (
        id,
        team_id,
        session_id,
        sender_actor_id,
        kind,
        content
      )
      values (
        '60000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        '50000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000002',
        'text',
        'spoofed'
      )
    $sql$,
    '42501'
  ),
  'message sender spoofing is rejected'
);

select lives_ok(
$$
  insert into public.messages (
    id,
    team_id,
    session_id,
    sender_actor_id,
    kind,
    content
  )
  values (
    '60000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'text',
    'allowed'
  );
$$,
'caller can insert a message as their own actor'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      insert into public.workspaces (
        id,
        team_id,
        created_by_member_id,
        name
      )
      values (
        '30000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000002',
        'Spoofed Workspace'
      )
    $sql$,
    '42501'
  ),
  'workspace creator spoofing is rejected'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      update public.ideas
      set created_by_actor_id = '10000000-0000-0000-0000-000000000002'
      where id = '40000000-0000-0000-0000-000000000001'
    $sql$,
    '42501'
  ),
  'idea creator spoofing on update is rejected'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      insert into public.sessions (
        id,
        team_id,
        idea_id,
        created_by_actor_id,
        mode,
        title
      )
      values (
        '50000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        '40000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000002',
        'solo',
        'Spoofed Session'
      )
    $sql$,
    '42501'
  ),
  'session creator spoofing is rejected'
);

select ok(
  pg_temp.raises_sqlstate(
    $sql$
      insert into public.idea_external_refs (
        id,
        idea_id,
        provider,
        external_id,
        external_url,
        linked_by_actor_id
      )
      values (
        '80000000-0000-0000-0000-000000000001',
        '40000000-0000-0000-0000-000000000001',
        'github',
        'issue-1',
        'https://example.com/issues/1',
        '10000000-0000-0000-0000-000000000002'
      )
    $sql$,
    '42501'
  ),
  'external ref linker spoofing is rejected'
);

select * from finish();
rollback;

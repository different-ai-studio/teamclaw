begin;

select plan(5);

insert into auth.users (id, email, aud, role, instance_id)
values ('00000000-0000-0000-0014-000000000001', 'gateway-daemon@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

insert into amux.teams (id, slug, name)
values ('00000000-0000-0000-0014-000000000010', 'gw-message-rls', 'Gateway Message RLS');

insert into amux.actors (id, team_id, actor_type, user_id, source, source_id, display_name)
values
  ('00000000-0000-0000-0014-000000000020', '00000000-0000-0000-0014-000000000010', 'agent', '00000000-0000-0000-0014-000000000001', null, null, 'Gateway Agent'),
  ('00000000-0000-0000-0014-000000000030', '00000000-0000-0000-0014-000000000010', 'external', null, 'wecom', 'LiangLiang', 'LiangLiang'),
  ('00000000-0000-0000-0014-000000000040', '00000000-0000-0000-0014-000000000010', 'external', null, 'wecom', 'OtherUser', 'Other User'),
  ('00000000-0000-0000-0014-000000000050', '00000000-0000-0000-0014-000000000010', 'member', null, null, null, 'Owner Member');

insert into amux.members (id, status) values ('00000000-0000-0000-0014-000000000050', 'active');

-- agents.owner_member_id is NOT NULL and references members, so an owning
-- member has to exist first.
insert into amux.agents (id, owner_member_id, status)
values ('00000000-0000-0000-0014-000000000020', '00000000-0000-0000-0014-000000000050', 'active');

insert into amux.sessions (
  id,
  team_id,
  idea_id,
  created_by_actor_id,
  primary_agent_id,
  mode,
  title,
  binding,
  acp_session_id
)
values (
  '00000000-0000-0000-0014-000000000100',
  '00000000-0000-0000-0014-000000000010',
  null,
  '00000000-0000-0000-0014-000000000020',
  '00000000-0000-0000-0014-000000000020',
  'collab',
  'WeCom - LiangLiang',
  'wecom://aibot/test/single/LiangLiang',
  'acp-gateway-rls-test'
);

insert into amux.session_participants (session_id, actor_id)
values
  ('00000000-0000-0000-0014-000000000100', '00000000-0000-0000-0014-000000000020'),
  ('00000000-0000-0000-0014-000000000100', '00000000-0000-0000-0014-000000000030');

select ok(
  has_function_privilege('authenticated', 'amux.daemon_can_write_gateway_message(uuid, uuid, uuid)', 'EXECUTE'),
  'authenticated can execute gateway message helper'
);

select ok(
  not has_function_privilege('anon', 'amux.daemon_can_write_gateway_message(uuid, uuid, uuid)', 'EXECUTE'),
  'anon cannot execute gateway message helper'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0014-000000000001',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'kind', 'daemon',
      'team_id', '00000000-0000-0000-0014-000000000010',
      'actor_id', '00000000-0000-0000-0014-000000000020'
    )
  )::text,
  true
);
set local role authenticated;

select lives_ok($$
  insert into amux.messages (
    team_id,
    session_id,
    sender_actor_id,
    kind,
    content,
    external_id
  )
  values (
    '00000000-0000-0000-0014-000000000010',
    '00000000-0000-0000-0014-000000000100',
    '00000000-0000-0000-0014-000000000030',
    'text',
    'ni shi shui',
    'c6503412764961b1b583557018de8a26'
  )
$$, 'daemon can record message from external session participant');

select throws_ok($$
  insert into amux.messages (
    team_id,
    session_id,
    sender_actor_id,
    kind,
    content,
    external_id
  )
  values (
    '00000000-0000-0000-0014-000000000010',
    '00000000-0000-0000-0014-000000000100',
    '00000000-0000-0000-0014-000000000040',
    'text',
    'spoof',
    'not-a-participant'
  )
$$, '42501', null, 'daemon cannot record message from non-participant external actor');

-- The team boundary is enforced on the row, not on the JWT.
--
-- Neither write policy reads app_metadata.team_id: messages_agent_write pairs
-- is_current_agent(sender) (which matches the agent actor by auth.uid()) with
-- `team_id = the sender actor's team`, and daemon_can_write_gateway_message
-- re-derives team, session and participation from the tables. A daemon
-- presenting a stale or mismatched team claim therefore gains nothing and loses
-- nothing -- it can still write as itself, exactly as it could with the right
-- claim. This test used to assert that a mismatched claim was rejected, which
-- no policy has ever promised.
--
-- What actually holds the line is the row's own team_id, so that is what gets
-- asserted: writing a message stamped with another team is refused even though
-- the sender, session and JWT are all legitimate.
insert into amux.teams (id, slug, name)
values ('00000000-0000-0000-0014-000000009999', 'gw-message-rls-other', 'Other Team');

select throws_ok($$
  insert into amux.messages (
    team_id,
    session_id,
    sender_actor_id,
    kind,
    content,
    external_id
  )
  values (
    '00000000-0000-0000-0014-000000009999',
    '00000000-0000-0000-0014-000000000100',
    '00000000-0000-0000-0014-000000000020',
    'text',
    'wrong team',
    'wrong-team'
  )
$$, '23514', null, 'message stamped with another team is refused');

select * from finish();
rollback;

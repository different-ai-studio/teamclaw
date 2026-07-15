begin;

select plan(5);

insert into auth.users (id, email, aud, role, instance_id)
values ('00000000-0000-0000-0014-000000000001', 'gateway-daemon@teamclaw.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

insert into public.teams (id, slug, name)
values ('00000000-0000-0000-0014-000000000010', 'gw-message-rls', 'Gateway Message RLS');

insert into public.actors (id, team_id, actor_type, user_id, source, source_id, display_name)
values
  ('00000000-0000-0000-0014-000000000020', '00000000-0000-0000-0014-000000000010', 'agent', '00000000-0000-0000-0014-000000000001', null, null, 'Gateway Agent'),
  ('00000000-0000-0000-0014-000000000030', '00000000-0000-0000-0014-000000000010', 'external', null, 'wecom', 'LiangLiang', 'LiangLiang'),
  ('00000000-0000-0000-0014-000000000040', '00000000-0000-0000-0014-000000000010', 'external', null, 'wecom', 'OtherUser', 'Other User');

insert into public.agents (id, agent_kind, status)
values ('00000000-0000-0000-0014-000000000020', 'gateway', 'active');

insert into public.sessions (
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

insert into public.session_participants (session_id, actor_id)
values
  ('00000000-0000-0000-0014-000000000100', '00000000-0000-0000-0014-000000000020'),
  ('00000000-0000-0000-0014-000000000100', '00000000-0000-0000-0014-000000000030');

select ok(
  has_function_privilege('authenticated', 'app.daemon_can_write_gateway_message(uuid, uuid, uuid)', 'EXECUTE'),
  'authenticated can execute gateway message helper'
);

select ok(
  not has_function_privilege('anon', 'app.daemon_can_write_gateway_message(uuid, uuid, uuid)', 'EXECUTE'),
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
  insert into public.messages (
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
  insert into public.messages (
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

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0014-000000000001',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'kind', 'daemon',
      'team_id', '00000000-0000-0000-0014-000000009999',
      'actor_id', '00000000-0000-0000-0014-000000000020'
    )
  )::text,
  true
);

select throws_ok($$
  insert into public.messages (
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
    '00000000-0000-0000-0014-000000000020',
    'text',
    'wrong team',
    'wrong-team'
  )
$$, '42501', null, 'daemon cannot record message when jwt team does not match');

select * from finish();
rollback;

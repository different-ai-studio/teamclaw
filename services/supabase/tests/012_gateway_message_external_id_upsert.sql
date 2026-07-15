begin;

select plan(5);

insert into public.teams (id, slug, name)
values ('00000000-0000-0000-0012-000000000001', 'gw-message-team', 'Gateway Message Team');

insert into public.actors (id, team_id, actor_type, display_name)
values
  ('00000000-0000-0000-0012-000000000010', '00000000-0000-0000-0012-000000000001', 'agent', 'Gateway Agent'),
  ('00000000-0000-0000-0012-000000000020', '00000000-0000-0000-0012-000000000001', 'external', 'LiangLiang');

insert into public.agents (id, agent_kind, capabilities, status)
values ('00000000-0000-0000-0012-000000000010', 'gateway', '{}'::jsonb, 'active');

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
  '00000000-0000-0000-0012-000000000100',
  '00000000-0000-0000-0012-000000000001',
  null,
  '00000000-0000-0000-0012-000000000010',
  '00000000-0000-0000-0012-000000000010',
  'collab',
  'WeCom - LiangLiang',
  'wecom://aibot/aibfzYpdwyoj_3z9s4ZpVEFAv2IqAwVjNZH/single/LiangLiang',
  'acp-gateway-message-test'
);

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
    '00000000-0000-0000-0012-000000000001',
    '00000000-0000-0000-0012-000000000100',
    '00000000-0000-0000-0012-000000000020',
    'text',
    'hi',
    '632043bcec41613ed54589d5a781cb7e'
  )
  on conflict (session_id, external_id)
  do update set content = excluded.content
$$, 'gateway message upsert conflict target matches a unique index');

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
    '00000000-0000-0000-0012-000000000001',
    '00000000-0000-0000-0012-000000000100',
    '00000000-0000-0000-0012-000000000020',
    'text',
    'hi again',
    '632043bcec41613ed54589d5a781cb7e'
  )
  on conflict (session_id, external_id)
  do update set content = excluded.content
$$, 'gateway duplicate provider message upserts instead of inserting');

select is(
  (
    select count(*)
      from public.messages
     where session_id = '00000000-0000-0000-0012-000000000100'
       and external_id = '632043bcec41613ed54589d5a781cb7e'
  ),
  1::bigint,
  'duplicate external_id keeps one message row'
);

select is(
  (
    select content
      from public.messages
     where session_id = '00000000-0000-0000-0012-000000000100'
       and external_id = '632043bcec41613ed54589d5a781cb7e'
  ),
  'hi again',
  'duplicate external_id updates the existing row'
);

select lives_ok($$
  insert into public.messages (
    team_id,
    session_id,
    sender_actor_id,
    kind,
    content,
    external_id
  )
  values
    (
      '00000000-0000-0000-0012-000000000001',
      '00000000-0000-0000-0012-000000000100',
      '00000000-0000-0000-0012-000000000020',
      'text',
      'local one',
      null
    ),
    (
      '00000000-0000-0000-0012-000000000001',
      '00000000-0000-0000-0012-000000000100',
      '00000000-0000-0000-0012-000000000020',
      'text',
      'local two',
      null
    )
$$, 'messages without external_id can still repeat within a session');

select * from finish();
rollback;

begin;

select plan(5);

insert into amux.teams (id, slug, name)
values ('00000000-0000-0000-0012-000000000001', 'gw-message-team', 'Gateway Message Team');

-- actors_external_has_source: (actor_type = 'external') has to match
-- (source is not null and source_id is not null), in both directions. The
-- external actor therefore needs its gateway coordinates, and they line up with
-- the session binding below (wecom://…/single/LiangLiang).
insert into amux.actors (id, team_id, actor_type, display_name, source, source_id)
values
  ('00000000-0000-0000-0012-000000000010', '00000000-0000-0000-0012-000000000001', 'agent', 'Gateway Agent', null, null),
  ('00000000-0000-0000-0012-000000000020', '00000000-0000-0000-0012-000000000001', 'external', 'LiangLiang', 'wecom', 'wecom-user:aibfzYpdwyoj:LiangLiang');

-- agents.owner_member_id is NOT NULL and references members, so the agent needs
-- an owning member actor to exist first.
insert into amux.actors (id, team_id, actor_type, display_name)
values ('00000000-0000-0000-0012-000000000030', '00000000-0000-0000-0012-000000000001', 'member', 'Owner Member');

insert into amux.members (id, status)
values ('00000000-0000-0000-0012-000000000030', 'active');

insert into amux.agents (id, owner_member_id, capabilities, status)
values ('00000000-0000-0000-0012-000000000010', '00000000-0000-0000-0012-000000000030', '{}'::jsonb, 'active');

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
  insert into amux.messages (
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
  insert into amux.messages (
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
      from amux.messages
     where session_id = '00000000-0000-0000-0012-000000000100'
       and external_id = '632043bcec41613ed54589d5a781cb7e'
  ),
  1::bigint,
  'duplicate external_id keeps one message row'
);

select is(
  (
    select content
      from amux.messages
     where session_id = '00000000-0000-0000-0012-000000000100'
       and external_id = '632043bcec41613ed54589d5a781cb7e'
  ),
  'hi again',
  'duplicate external_id updates the existing row'
);

select lives_ok($$
  insert into amux.messages (
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

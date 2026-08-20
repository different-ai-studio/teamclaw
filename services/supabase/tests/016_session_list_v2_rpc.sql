begin;

select plan(11);

-- The three-argument forms are deliberate. pgTAP overloads these on
-- (schema, object) AND (object, description), and two untyped literals resolve
-- to the LATTER — so `has_table('amux','session_read_markers')` silently asserts
-- "a table named amux exists", which is false. Passing a description picks the
-- schema-qualified overload and makes the failure message readable.
select has_table('amux', 'session_read_markers', 'session_read_markers exists');
select has_index('amux', 'session_read_markers', 'session_read_markers_actor_session_idx',
                 'read markers are indexed by (actor, session)');
select has_index('amux', 'sessions', 'sessions_team_last_message_idx',
                 'sessions are indexed for the team-scoped list');
-- p_team_id leads the signature as of 20260804020000 (a team is what resolves
-- the caller's actor), and p_idea_id was appended by 20260802000000.
select has_function(
  'amux',
  'list_current_actor_sessions',
  array['uuid', 'integer', 'timestamp with time zone', 'timestamp with time zone', 'uuid', 'uuid', 'text']
);
select has_function('amux', 'mark_current_actor_session_viewed', array['uuid', 'uuid']);

insert into auth.users (id, email)
values
  ('91000000-0000-0000-0000-000000000001', 'reader@example.com'),
  ('91000000-0000-0000-0000-000000000002', 'other@example.com');

insert into amux.teams (id, slug, name)
values ('01000000-0000-0000-0000-000000000001', 'read-marker-team', 'Read Marker Team');

-- user_id lives on actors now: identity is per-team, so the link to auth.users
-- belongs on the per-team row rather than on members.
insert into amux.actors (id, team_id, actor_type, display_name, user_id)
values
  ('11000000-0000-0000-0000-000000000001', '01000000-0000-0000-0000-000000000001', 'member', 'Reader', '91000000-0000-0000-0000-000000000001'),
  ('11000000-0000-0000-0000-000000000002', '01000000-0000-0000-0000-000000000001', 'member', 'Other',  '91000000-0000-0000-0000-000000000002');

insert into amux.members (id, status)
values
  ('11000000-0000-0000-0000-000000000001', 'active'),
  ('11000000-0000-0000-0000-000000000002', 'active');

insert into amux.team_members (id, team_id, member_id, role)
values
  ('21000000-0000-0000-0000-000000000001', '01000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'member'),
  ('21000000-0000-0000-0000-000000000002', '01000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000002', 'member');

insert into amux.workspaces (id, team_id, created_by_member_id, name)
values (
  '31000000-0000-0000-0000-000000000001',
  '01000000-0000-0000-0000-000000000001',
  '11000000-0000-0000-0000-000000000001',
  'Workspace'
);

insert into amux.ideas (id, team_id, workspace_id, created_by_actor_id, title, status)
values (
  '41000000-0000-0000-0000-000000000001',
  '01000000-0000-0000-0000-000000000001',
  '31000000-0000-0000-0000-000000000001',
  '11000000-0000-0000-0000-000000000001',
  'Idea',
  'open'
);

insert into amux.sessions (
  id,
  team_id,
  idea_id,
  created_by_actor_id,
  mode,
  title,
  last_message_at,
  last_message_preview,
  created_at
)
values
  (
    '51000000-0000-0000-0000-000000000003',
    '01000000-0000-0000-0000-000000000001',
    '41000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000002',
    'collab',
    'Newest',
    '2026-05-17 10:00:00+00',
    'newest',
    '2026-05-17 09:59:03+00'
  ),
  (
    '51000000-0000-0000-0000-000000000002',
    '01000000-0000-0000-0000-000000000001',
    '41000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000002',
    'collab',
    'Same Timestamp Older Id',
    '2026-05-17 09:00:00+00',
    'older id',
    '2026-05-17 08:59:02+00'
  ),
  (
    '51000000-0000-0000-0000-000000000001',
    '01000000-0000-0000-0000-000000000001',
    '41000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000002',
    'collab',
    'Same Timestamp Newer Id',
    '2026-05-17 09:00:00+00',
    'newer id',
    '2026-05-17 08:59:01+00'
  ),
  (
    '51000000-0000-0000-0000-000000000004',
    '01000000-0000-0000-0000-000000000001',
    '41000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000002',
    'collab',
    'Not Participating',
    '2026-05-17 11:00:00+00',
    'hidden',
    '2026-05-17 10:59:00+00'
  );

insert into amux.session_participants (session_id, actor_id, role)
values
  ('51000000-0000-0000-0000-000000000003', '11000000-0000-0000-0000-000000000001', 'member'),
  ('51000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', 'member'),
  ('51000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'member'),
  ('51000000-0000-0000-0000-000000000004', '11000000-0000-0000-0000-000000000002', 'member');

update amux.sessions
set source = 'cron', cron_job_id = 'fixture-cron'
where id = '51000000-0000-0000-0000-000000000003';

-- team_id became NOT NULL on this table in 20260804020000 so its policies can
-- resolve the caller per team.
insert into amux.session_read_markers (
  session_id,
  actor_id,
  team_id,
  last_read_at
)
values (
  '51000000-0000-0000-0000-000000000003',
  '11000000-0000-0000-0000-000000000001',
  '01000000-0000-0000-0000-000000000001',
  '2026-05-17 09:00:00+00'
);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000001';

select is(
  (select count(*)::int from amux.list_current_actor_sessions('01000000-0000-0000-0000-000000000001', 50, null, null, null)),
  3,
  'list_current_actor_sessions returns only current actor participant sessions'
);

select is(
  (select count(*)::int from amux.list_current_actor_sessions(
    p_team_id => '01000000-0000-0000-0000-000000000001',
    p_kind => 'regular'
  )),
  2,
  'regular sessions are filtered before pagination'
);

select is(
  (select count(*)::int from amux.list_current_actor_sessions(
    p_team_id => '01000000-0000-0000-0000-000000000001',
    p_kind => 'cron'
  )),
  1,
  'cron sessions have an independent page'
);

select ok(
  (select has_unread from amux.list_current_actor_sessions('01000000-0000-0000-0000-000000000001', 50, null, null, null) where id = '51000000-0000-0000-0000-000000000003'),
  'has_unread is true when last_message_at is newer than marker'
);

select is(
  (
    with first_page as (
      select * from amux.list_current_actor_sessions('01000000-0000-0000-0000-000000000001', 2, null, null, null)
    ),
    cursor_row as (
      select *
      from first_page
      order by last_message_at asc nulls last, created_at asc, id asc
      limit 1
    )
    select count(*)::int
    from amux.list_current_actor_sessions(
      '01000000-0000-0000-0000-000000000001',
      50,
      (select last_message_at from cursor_row),
      (select created_at from cursor_row),
      (select id from cursor_row)
    )
  ),
  1,
  'composite cursor returns the remaining older row without duplicating the cursor'
);

select amux.mark_current_actor_session_viewed(
  '51000000-0000-0000-0000-000000000003',
  null
);

select is(
  (select has_unread from amux.list_current_actor_sessions('01000000-0000-0000-0000-000000000001', 50, null, null, null) where id = '51000000-0000-0000-0000-000000000003'),
  false,
  'mark_current_actor_session_viewed clears has_unread'
);

select * from finish();
rollback;

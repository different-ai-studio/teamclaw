-- Regression cover for 20260804020000_per_team_actor_scope.sql.
--
-- The bug it fixes only shows up for a user who belongs to MORE THAN ONE team:
-- amux.current_actor_id() returned the oldest of their actor rows, so every
-- visibility check ran as their first team's identity. A single-team fixture
-- cannot reproduce it, which is why nothing caught it.
--
-- Not wired to CI (nothing runs the files in this directory today, and the
-- pgTAP ones still reference the pre-amux `app` schema). Run it by hand against
-- a scratch database that has the baseline plus every migration applied:
--
--   psql "$SCRATCH_DB" -v ON_ERROR_STOP=1 -f services/supabase/tests/per_team_actor_scope.sql
--
-- It seeds, asserts, and rolls back — nothing is left behind.

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'multi@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'outsider@example.test');

insert into amux.teams (id, slug, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'scope-team-a', 'Team A'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'scope-team-b', 'Team B');

-- The team-A actor is deliberately the older row: it is the one the dropped
-- amux.current_actor_id() would have resolved to for every team.
insert into amux.actors (id, team_id, actor_type, display_name, user_id, created_at) values
  ('a0000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'member', 'Me in A', '11111111-1111-1111-1111-111111111111', now() - interval '10 days'),
  ('b0000000-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000002', 'member', 'Me in B', '11111111-1111-1111-1111-111111111111', now()),
  ('c0000000-0000-0000-0000-0000000000c1', 'bbbbbbbb-0000-0000-0000-000000000002', 'member', 'Outsider in B', '22222222-2222-2222-2222-222222222222', now());
insert into amux.members (id, status) values
  ('a0000000-0000-0000-0000-0000000000a1', 'active'),
  ('b0000000-0000-0000-0000-0000000000b1', 'active'),
  ('c0000000-0000-0000-0000-0000000000c1', 'active');
insert into amux.team_members (team_id, member_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000a1', 'owner'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-0000000000b1', 'member'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-0000000000c1', 'owner');

insert into amux.sessions (id, team_id, mode, title, created_by_actor_id, last_message_at) values
  ('50000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'collab', 'A session', 'a0000000-0000-0000-0000-0000000000a1', now() - interval '1 hour'),
  ('50000000-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000002', 'collab', 'B session', 'b0000000-0000-0000-0000-0000000000b1', now()),
  ('50000000-0000-0000-0000-0000000000b2', 'bbbbbbbb-0000-0000-0000-000000000002', 'collab', 'B session not mine', 'c0000000-0000-0000-0000-0000000000c1', now());

insert into amux.session_participants (session_id, actor_id) values
  ('50000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-0000000000a1'),
  ('50000000-0000-0000-0000-0000000000b1', 'b0000000-0000-0000-0000-0000000000b1'),
  ('50000000-0000-0000-0000-0000000000b2', 'c0000000-0000-0000-0000-0000000000c1');

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare
  v_titles text[];
  v_unread boolean;
begin
  -- The first team still works.
  select array_agg(title order by title)
    into v_titles
  from amux.list_current_actor_sessions(p_team_id => 'aaaaaaaa-0000-0000-0000-000000000001');
  if v_titles is distinct from array['A session'] then
    raise exception 'team A list: expected [A session], got %', v_titles;
  end if;

  -- And so does the second one, which used to come back empty.
  select array_agg(title order by title)
    into v_titles
  from amux.list_current_actor_sessions(p_team_id => 'bbbbbbbb-0000-0000-0000-000000000002');
  if v_titles is distinct from array['B session'] then
    raise exception 'team B list: expected [B session], got %', v_titles;
  end if;

  -- has_unread rides on session_read_markers, whose SELECT policy was subject
  -- to the same mis-resolution: the caller's own marker was invisible, so every
  -- session in the other team read as permanently unread.
  select has_unread into v_unread
  from amux.list_current_actor_sessions(p_team_id => 'bbbbbbbb-0000-0000-0000-000000000002');
  if v_unread is not true then
    raise exception 'team B session should start unread, got %', v_unread;
  end if;

  perform amux.mark_current_actor_session_viewed('50000000-0000-0000-0000-0000000000b1');

  select has_unread into v_unread
  from amux.list_current_actor_sessions(p_team_id => 'bbbbbbbb-0000-0000-0000-000000000002');
  if v_unread is not false then
    raise exception 'team B session should be read after mark-viewed, got %', v_unread;
  end if;

  -- The marker is stamped with the session's team, which is what its policies
  -- now key on.
  if not exists (
    select 1 from amux.session_read_markers
    where session_id = '50000000-0000-0000-0000-0000000000b1'
      and team_id = 'bbbbbbbb-0000-0000-0000-000000000002'
      and actor_id = 'b0000000-0000-0000-0000-0000000000b1'
  ) then
    raise exception 'read marker missing or not stamped with the session team';
  end if;
end
$$;

-- Sending in the second team: messages_insert_if_session_participant compares
-- sender_actor_id against the caller's actor, so this INSERT used to be denied
-- outright for any team but the first.
insert into amux.messages (id, team_id, session_id, sender_actor_id, kind, content)
values (
  gen_random_uuid(),
  'bbbbbbbb-0000-0000-0000-000000000002',
  '50000000-0000-0000-0000-0000000000b1',
  'b0000000-0000-0000-0000-0000000000b1',
  'text',
  'hello from team B'
);

-- Forging a marker for someone else's session by pairing it with an actor from
-- a team I do belong to. team_id is a policy input now, so this has to fail.
do $$
begin
  begin
    insert into amux.session_read_markers (session_id, team_id, actor_id)
    values (
      '50000000-0000-0000-0000-0000000000b2',
      'aaaaaaaa-0000-0000-0000-000000000001',
      'a0000000-0000-0000-0000-0000000000a1'
    );
    raise exception 'forged read marker was accepted';
  exception
    when insufficient_privilege then null;  -- RLS rejected it, as intended
  end;
end
$$;

-- Nothing above widened anyone else's view: the outsider sees only the session
-- they participate in, and none of my read markers.
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

do $$
declare
  v_titles text[];
  v_markers bigint;
begin
  select array_agg(title order by title)
    into v_titles
  from amux.list_current_actor_sessions(p_team_id => 'bbbbbbbb-0000-0000-0000-000000000002');
  if v_titles is distinct from array['B session not mine'] then
    raise exception 'outsider list: expected [B session not mine], got %', v_titles;
  end if;

  select count(*) into v_markers from amux.session_read_markers;
  if v_markers <> 0 then
    raise exception 'outsider can see % read marker(s)', v_markers;
  end if;
end
$$;

reset role;
rollback;

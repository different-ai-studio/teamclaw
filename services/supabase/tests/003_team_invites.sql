begin;

-- Temp tables are owned by the session role; the tests then `set role` to
-- anon/authenticated, which cannot read them without an explicit grant.

-- `like` here is PostgreSQL's built-in operator function, not an assertion —
-- pgTAP's pattern matcher is alike()/matches(). The three-argument call never
-- resolved, which is why this file could not even parse.

select plan(16);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- Fixture users: alice (team A owner), bob (stranger), carol (to be invited)
-- Use .test TLD to avoid collision with seed users (alice@example.com etc.)
insert into auth.users (id, email, aud, role, instance_id)
values
  ('11111111-1111-1111-1111-111111111111', 'alice-pgtest@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('22222222-2222-2222-2222-222222222222', 'bob-pgtest@amux.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('33333333-3333-3333-3333-333333333333', 'carol-pgtest@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select * from amux.create_team('Team A', p_oid => null);

create temp table ctx as
  select
    (select id from amux.teams where slug = 'team-a') as team_a,
    (select id from amux.actors
      where user_id = '11111111-1111-1111-1111-111111111111' limit 1) as alice_actor;

grant select on ctx to anon, authenticated;

-- 1. Non-member is rejected by create_team_invite
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  format($$ select amux.create_team_invite(%L::uuid, 'member', 'X', 'member') $$,
         (select team_a from ctx)),
  '42501', 'create_team_invite requires team membership',
  'non-member rejected'
);

-- 2. kind=member without team_role raises 22023
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(
  format($$ select amux.create_team_invite(%L::uuid, 'member', 'X') $$,
         (select team_a from ctx)),
  '22023', null, 'member kind without team_role raises'
);

-- 3. kind=agent without agent_kind raises 22023
select throws_ok(
  format($$ select amux.create_team_invite(%L::uuid, 'agent', 'X') $$,
         (select team_a from ctx)),
  '22023', null, 'agent kind without agent_kind raises'
);

-- 4. Happy path member invite
create temp table mi as
  select * from amux.create_team_invite(
    (select team_a from ctx), 'member', 'Carol', p_team_role => 'member');
grant select on mi to anon, authenticated;

select ok((select count(*) = 1 from mi), 'member invite created');
select alike((select deeplink from mi), 'amux://invite?token=%',
            'deeplink format is amux://invite?token=...');
-- The deeplink is the token and nothing else. It used to carry broker host,
-- username and a shared password; MQTT now authenticates with the Supabase
-- access_token as the password (wss://mqtt.…/mqtt), so static credentials in a
-- link that gets pasted into chat would be a leak that buys nothing.
select unalike((select deeplink from mi), '%password=%',
            'deeplink carries no static broker credentials');

-- 5. Carol (different auth user) claims → new actor + members + team_members
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
create temp table mc as select * from amux.claim_team_invite((select token from mi));
grant select on mc to anon, authenticated;

select is((select actor_type from mc), 'member',
         'member claim returns actor_type=member');
select ok((select count(*) = 1 from amux.team_members
            where team_id = (select team_a from ctx)
              and member_id = (select actor_id from mc)
              and role = 'member'),
         'team_members row with role=member');

-- 6. Replay same token → 23514
select throws_ok(
  format($$ select amux.claim_team_invite(%L) $$, (select token from mi)),
  '23514', 'invite already consumed', 'replay rejected'
);

-- 7. Agent invite (back as alice)
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table ai as
  select * from amux.create_team_invite(
    (select team_a from ctx), 'agent', 'M1 Studio', p_agent_kind => 'daemon');
grant select on ai to anon, authenticated;

select ok((select count(*) = 1 from ai), 'agent invite created');

-- 8. Anonymous daemon claim → new actor + agents + refresh_token non-null
-- `perform` is plpgsql-only; at the top level of a script it must be `select`.
select set_config('request.jwt.claims', '{}', true);
select set_config('role', 'anon', true);
create temp table ac as select * from amux.claim_team_invite((select token from ai));
grant select on ac to anon, authenticated;

select is((select actor_type from ac), 'agent', 'agent claim returns actor_type=agent');
-- 12 hex characters: substring(encode(gen_random_bytes(6),'hex'), 1, 12).
select ok((select refresh_token is not null and length(refresh_token) >= 12 from ac),
         'agent claim returns a refresh_token');

-- 9. agent_member_access row was materialized for inviter.
-- Read it back as alice: the daemon claim above left the session on `anon`, and
-- agent_member_access is not readable by anon, so this counted zero rows for a
-- reason that had nothing to do with the materialization it was checking.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select ok((select count(*) = 1 from amux.agent_member_access ama
            join amux.actors a on a.id = ama.member_id
            where ama.agent_id = (select actor_id from ac)
              and a.user_id = '11111111-1111-1111-1111-111111111111'
              and ama.permission_level = 'admin'),
         'agent_member_access row materialized for inviter as admin');

-- 10. Expired invite rejected
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table ei as
  select * from amux.create_team_invite(
    (select team_a from ctx), 'member', 'Expires', p_team_role => 'member',
    p_ttl_seconds => 60);
grant select on ei to anon, authenticated;

-- Backdate the expiry as the session role. team_invites has no UPDATE policy
-- for authenticated, so this statement matched zero rows while alice was still
-- current, left the invite live, and the claim below then succeeded -- which the
-- old assertion read as "no exception, wanted 23514".
reset role;
update amux.team_invites set expires_at = now() - interval '1 minute'
  where token = (select token from ei);
-- Claim as bob, not carol. Carol joined the team back in step 5, so her claim
-- fails on the membership guard (23505 "already a member of this team") before
-- the expiry check is ever reached -- the test passed a stale token and got the
-- wrong rejection.
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  format($$ select amux.claim_team_invite(%L) $$, (select token from ei)),
  '23514', 'invite expired', 'expired invite rejected'
);

-- Back to carol for the heartbeat assertions below.
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');

-- 11. Heartbeat bumps last_active_at
select lives_ok('select amux.update_actor_last_active();',
                'heartbeat RPC runs without error');
select ok((select last_active_at > now() - interval '30 seconds'
            from amux.actors where user_id = '33333333-3333-3333-3333-333333333333' limit 1),
         'last_active_at moved forward');

select * from finish();
rollback;

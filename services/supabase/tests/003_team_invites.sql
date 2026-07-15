begin;

select plan(17);

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
select * from public.create_team('Team A');

create temp table ctx as
  select
    (select id from public.teams where slug = 'team-a') as team_a,
    (select id from public.actors
      where user_id = '11111111-1111-1111-1111-111111111111' limit 1) as alice_actor;

-- 1. Non-member is rejected by create_team_invite
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  format($$ select public.create_team_invite(%L::uuid, 'member', 'X', 'member') $$,
         (select team_a from ctx)),
  '42501', 'create_team_invite requires team membership',
  'non-member rejected'
);

-- 2. kind=member without team_role raises 22023
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(
  format($$ select public.create_team_invite(%L::uuid, 'member', 'X') $$,
         (select team_a from ctx)),
  '22023', null, 'member kind without team_role raises'
);

-- 3. kind=agent without agent_kind raises 22023
select throws_ok(
  format($$ select public.create_team_invite(%L::uuid, 'agent', 'X') $$,
         (select team_a from ctx)),
  '22023', null, 'agent kind without agent_kind raises'
);

-- 4. Happy path member invite
create temp table mi as
  select * from public.create_team_invite(
    (select team_a from ctx), 'member', 'Carol', p_team_role => 'member');
select ok((select count(*) = 1 from mi), 'member invite created');
select like((select deeplink from mi), 'amux://invite?token=%',
            'deeplink format is amux://invite?token=...');
select like((select deeplink from mi), '%&broker=mqtts://ai.ucar.cc:8883%',
            'deeplink includes mqtt broker');
select like((select deeplink from mi), '%&username=teamclaw%',
            'deeplink includes mqtt username');
select like((select deeplink from mi), '%&password=teamclaw2026%',
            'deeplink includes mqtt password');

-- 5. Carol (different auth user) claims → new actor + members + team_members
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
create temp table mc as select * from public.claim_team_invite((select token from mi));
select is((select actor_type from mc), 'member',
         'member claim returns actor_type=member');
select ok((select count(*) = 1 from public.team_members
            where team_id = (select team_a from ctx)
              and member_id = (select actor_id from mc)
              and role = 'member'),
         'team_members row with role=member');

-- 6. Replay same token → 23514
select throws_ok(
  format($$ select public.claim_team_invite(%L) $$, (select token from mi)),
  '23514', 'invite already consumed', 'replay rejected'
);

-- 7. Agent invite (back as alice)
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table ai as
  select * from public.create_team_invite(
    (select team_a from ctx), 'agent', 'M1 Studio', p_agent_kind => 'daemon');
select ok((select count(*) = 1 from ai), 'agent invite created');

-- 8. Anonymous daemon claim → new actor + agents + refresh_token non-null
perform set_config('request.jwt.claims', '{}', true);
perform set_config('role', 'anon', true);
create temp table ac as select * from public.claim_team_invite((select token from ai));
select is((select actor_type from ac), 'agent', 'agent claim returns actor_type=agent');
select ok((select refresh_token is not null and length(refresh_token) >= 20 from ac),
         'agent claim returns a refresh_token');

-- 9. agent_member_access row was materialized for inviter
select ok((select count(*) = 1 from public.agent_member_access ama
            join public.actors a on a.id = ama.member_id
            where ama.agent_id = (select actor_id from ac)
              and a.user_id = '11111111-1111-1111-1111-111111111111'
              and ama.permission_level = 'admin'),
         'agent_member_access row materialized for inviter as admin');

-- 10. Expired invite rejected
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table ei as
  select * from public.create_team_invite(
    (select team_a from ctx), 'member', 'Expires', p_team_role => 'member',
    p_ttl_seconds => 60);
update public.team_invites set expires_at = now() - interval '1 minute'
  where token = (select token from ei);
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select throws_ok(
  format($$ select public.claim_team_invite(%L) $$, (select token from ei)),
  '23514', 'invite expired', 'expired invite rejected'
);

-- 11. Heartbeat bumps last_active_at
select lives_ok('select public.update_actor_last_active();',
                'heartbeat RPC runs without error');
select ok((select last_active_at > now() - interval '30 seconds'
            from public.actors where user_id = '33333333-3333-3333-3333-333333333333' limit 1),
         'last_active_at moved forward');

select * from finish();
rollback;

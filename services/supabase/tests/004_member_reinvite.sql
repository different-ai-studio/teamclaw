-- services/supabase/tests/004_member_reinvite.sql
--
-- Member re-invite is removed (20260811110000). This file is what keeps it
-- removed, and pins the two things that must survive alongside it.
--
-- Why it went: create_team_invite only accepted a member target whose auth user
-- was anonymous; the claim branch then kept the actor on that anonymous user and
-- minted a refresh token FOR IT (device recovery); but claim_team_invite's
-- wrapper refuses anonymous and bearerless callers for every member invite, and
-- the person on the new device is exactly that caller. The only caller who could
-- redeem the link was someone already signed into a real account, who would be
-- handed credentials for the anonymous one.
--
-- What must keep working: p_target_actor_id for AGENT invites (daemon credential
-- rotation), and ordinary member invites.
begin;

select plan(6);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

insert into auth.users (id, email, aud, role, instance_id, is_anonymous)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'alice-pgtest-r@amux.test', 'authenticated', 'authenticated',
   '00000000-0000-0000-0000-000000000000', false),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'bob-pgtest-r@amux.test',   'authenticated', 'authenticated',
   '00000000-0000-0000-0000-000000000000', false),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc',
   null, 'authenticated', 'authenticated',
   '00000000-0000-0000-0000-000000000000', true)
on conflict do nothing;

select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select * from amux.create_team('Team R', p_oid => null);

create temp table ctx as
  select
    (select id from amux.teams where slug = 'team-r') as team_r,
    (select id from amux.actors
      where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' limit 1) as alice_actor,
    '11111111-2222-3333-4444-555555555555'::uuid as anon_actor,
    '11111111-2222-3333-4444-666666666666'::uuid as agent_actor;
grant select on ctx to anon, authenticated;

-- A legacy anonymous-bound member: the shape re-invite used to target. Nothing
-- mints these any more, so it has to be seeded directly.
reset role;

insert into amux.actors (id, team_id, actor_type, user_id, display_name)
select anon_actor, team_r, 'member', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'AnonUser' from ctx;
insert into amux.members (id, status) select anon_actor, 'active' from ctx;
insert into amux.team_members (team_id, member_id, role)
select team_r, anon_actor, 'member' from ctx;

-- An agent to prove the parameter still has a job.
insert into amux.actors (id, team_id, actor_type, display_name)
select agent_actor, team_r, 'agent', 'Daemon' from ctx;
insert into amux.agents (id, owner_member_id, visibility, status)
select agent_actor, alice_actor, 'team', 'active' from ctx;

-- 1. A member invite may no longer name a target, however eligible it looks.
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select throws_ok(
  format($$ select amux.create_team_invite(%L::uuid, 'member', 'AnonUser',
              p_team_role => 'member', p_target_actor_id => %L::uuid) $$,
         (select team_r from ctx), (select anon_actor from ctx)),
  '22023', 'member invites cannot target an existing actor',
  'member invite rejects p_target_actor_id');

-- 2. Including one aimed at a member with a real account, which used to fail
--    with a different message ('cannot re-invite member with bound auth
--    identity'). One rejection now covers every member target.
select throws_ok(
  format($$ select amux.create_team_invite(%L::uuid, 'member', 'Alice',
              p_team_role => 'member', p_target_actor_id => %L::uuid) $$,
         (select team_r from ctx), (select alice_actor from ctx)),
  '22023', 'member invites cannot target an existing actor',
  'the rejection does not depend on the target being anonymous');

-- 3. Agent re-invite still works: this is daemon credential rotation.
select lives_ok(
  format($$ select amux.create_team_invite(%L::uuid, 'agent', 'Daemon',
              p_agent_kind => 'daemon', p_target_actor_id => %L::uuid) $$,
         (select team_r from ctx), (select agent_actor from ctx)),
  'agent invite still accepts p_target_actor_id');

-- 4. A token minted before the removal is refused rather than degraded into a
--    self-join. Seeded straight into the table, since the RPC will not make one.
reset role;
insert into amux.team_invites (team_id, kind, token, display_name, team_role,
                               invited_by_actor_id, target_actor_id, expires_at, status)
select team_r, 'member', 'legacy-reinvite-token', 'AnonUser', 'member',
       alice_actor, anon_actor, now() + interval '1 day', 'pending'
from ctx;

select pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
select throws_ok(
  $$ select amux.claim_team_invite('legacy-reinvite-token') $$,
  '22023', 'member re-invite is no longer supported',
  'a pre-existing member re-invite token is refused, not honoured');

-- 5-6. The ordinary member invite is untouched.
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
create temp table mi as
  select * from amux.create_team_invite(
    (select team_r from ctx), 'member', 'Bob', p_team_role => 'member');
grant select on mi to anon, authenticated;

select pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
create temp table mc as select * from amux.claim_team_invite((select token from mi));
grant select on mc to anon, authenticated;

select is((select actor_type from mc), 'member',
          'an ordinary member invite still claims');

reset role;
select is(
  (select user_id from amux.actors where id = (select actor_id from mc)),
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
  'and binds the new actor to the claiming account');

select * from finish();
rollback;

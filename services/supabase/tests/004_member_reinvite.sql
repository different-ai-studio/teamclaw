-- services/supabase/tests/004_member_reinvite.sql
--
-- Member re-invite: two guards that were added independently and now disagree.
--
--   * create_team_invite(p_target_actor_id => …) refuses a target whose auth
--     user is NOT anonymous ('cannot re-invite member with bound auth
--     identity'), so a re-invite only ever points at an anonymous-bound member.
--   * claim_team_invite's member branch keeps the actor on its original
--     anonymous user and mints a fresh session + refresh token for THAT user --
--     device recovery: the person walks to a new device and gets their
--     anonymous member identity back.
--   * but claim_team_invite's outer wrapper (20260801010000) rejects anonymous
--     and bearerless callers before that branch runs, and the person on the new
--     device is exactly such a caller.
--
-- The wrapper was written for the ordinary member invite ("anonymous users
-- cannot self-join a team") and catches the re-invite path as collateral. The
-- assertions below describe what the database actually enforces today, which is
-- the wrapper's version. The original file asserted the branch's version, and
-- neither the file nor the schema was updated when the other moved.
--
-- Not resolved here, because it is a product call rather than a test repair:
-- see QUARANTINE.md, "Member re-invite is unreachable by its intended caller".
begin;

select plan(10);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'anon', true);
end;
$$;

-- Fixture users:
--   alice: team owner, real account
--   bob  : a second real account, the one that redeems the re-invite
--   anon : an anonymous-flagged Supabase user holding a member actor
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
    '11111111-2222-3333-4444-555555555555'::uuid as anon_actor;
grant select on ctx to anon, authenticated;

-- Seed the anonymous member directly. Nothing in the product mints one any
-- more: claim_team_invite and join_public_team both refuse anonymous callers,
-- so an anonymous-bound member actor is a legacy row -- and legacy rows are
-- precisely what re-invite exists to rescue.
reset role;

insert into amux.actors (id, team_id, actor_type, user_id, display_name)
select anon_actor, team_r, 'member', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'AnonUser' from ctx;

insert into amux.members (id, status)
select anon_actor, 'active' from ctx;

insert into amux.team_members (team_id, member_id, role)
select team_r, anon_actor, 'member' from ctx;

-- 1. Alice can mint a re-invite aimed at that actor.
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
create temp table ri as
  select * from amux.create_team_invite(
    (select team_r from ctx), 'member', 'AnonUser',
    p_team_role => 'member',
    p_target_actor_id => (select anon_actor from ctx));
grant select on ri to anon, authenticated;
select ok((select count(*) = 1 from ri),
          'create_team_invite accepts target_actor_id for member kind');

-- 2. A bearerless caller cannot redeem it.
select pg_temp.as_anon();
select throws_ok(
  format($$ select amux.claim_team_invite(%L) $$, (select token from ri)),
  '42501', 'member claim requires a non-anonymous account',
  'anonymous caller cannot claim a member re-invite');

-- 3. An anonymous *account* cannot either -- being signed in is not enough,
--    the account has to be a real one.
select pg_temp.as_user('cccccccc-cccc-cccc-cccc-cccccccccccc');
select throws_ok(
  format($$ select amux.claim_team_invite(%L) $$, (select token from ri)),
  '42501', 'member claim requires a non-anonymous account',
  'anonymous account cannot claim a member re-invite');

-- 4-5. Bob (real account) redeems it and takes over the existing actor rather
--      than getting a fresh one.
select pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
create temp table rc as
  select * from amux.claim_team_invite((select token from ri));
grant select on rc to anon, authenticated;

select is((select actor_type from rc), 'member',
         'member-reinvite claim returns actor_type=member');
select is((select actor_id from rc), (select anon_actor from ctx),
          'reinvite reuses the target actor_id instead of minting one');

-- 6. The actor stays bound to the anonymous account, and the claim hands back a
--    refresh token *for that account* -- the redeemer is meant to end up signed
--    in as the anonymous member, on a new device.
--
--    KNOWN CONTRADICTION, left asserted as-is rather than papered over: the
--    branch below is device recovery, so its natural caller is someone with no
--    account yet -- but claim_team_invite's outer guard (20260801010000) refuses
--    anonymous and bearerless callers before that branch is reached. The only
--    caller who can get through is someone already signed into a real account,
--    who is then handed credentials for the anonymous one. Whichever half is
--    wrong, they cannot both be right; see QUARANTINE.md.
select ok((select refresh_token is not null and length(refresh_token) >= 12 from rc),
          'reinvite claim returns a refresh token');

reset role;
select is(
  (select user_id from amux.actors where id = (select anon_actor from ctx)),
  'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid,
  'reinvite leaves the actor bound to the anonymous account');

-- 7. Replay rejected.
select pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
select throws_ok(
  format($$ select amux.claim_team_invite(%L) $$, (select token from ri)),
  '23514', 'invite already consumed', 'reinvite replay rejected');

-- 9. A member holding a real account cannot be re-invited at all: alice is the
--    owner, signed in with a real identity, so pointing a re-invite at her own
--    actor is refused. This is the guard that confines re-invite to anonymous
--    members.
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select throws_ok(
  format($$ select amux.create_team_invite(%L::uuid, 'member', 'Alice',
              p_team_role => 'member', p_target_actor_id => %L::uuid) $$,
         (select team_r from ctx), (select alice_actor from ctx)),
  '22023', 'cannot re-invite member with bound auth identity',
  'reject re-invite for a member with a bound identity');

-- 10. And a target that does not exist is refused before any of that.
select throws_ok(
  format($$ select amux.create_team_invite(%L::uuid, 'member', 'Stranger',
              p_team_role => 'member', p_target_actor_id => %L::uuid) $$,
         (select team_r from ctx), '00000000-0000-0000-0000-000000000000'),
  '23503', 'target actor not found',
  'reject re-invite with a bogus target_actor_id');

select * from finish();
rollback;

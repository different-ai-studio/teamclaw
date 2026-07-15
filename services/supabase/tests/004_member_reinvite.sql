-- services/supabase/tests/004_member_reinvite.sql
begin;

select plan(8);

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
--   admin: alice (team owner)
--   anon  : an anonymous-flagged Supabase user that joins via member invite
--   named : bob, a non-anonymous user (e.g. signed in via Apple)
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

-- Alice creates Team R and seeds anonymous user as member.
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select * from public.create_team('Team R');

create temp table ctx as
  select
    (select id from public.teams where slug = 'team-r') as team_r,
    (select id from public.actors
      where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' limit 1) as alice_actor;

-- Anon user joins normally.
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
create temp table init_invite as
  select * from public.create_team_invite(
    (select team_r from ctx), 'member', 'AnonUser',
    p_team_role => 'member');
select pg_temp.as_user('cccccccc-cccc-cccc-cccc-cccccccccccc');
create temp table init_claim as
  select * from public.claim_team_invite((select token from init_invite));
grant select on init_claim to anon;

-- 1. Re-invite happy path: alice creates a re-invite for the anon member
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
create temp table ri as
  select * from public.create_team_invite(
    (select team_r from ctx), 'member', 'AnonUser',
    p_team_role => 'member',
    p_target_actor_id => (select actor_id from init_claim));
grant select on ri to anon;
select ok((select count(*) = 1 from ri),
          'create_team_invite accepts target_actor_id for member kind');

-- 2. Anonymous claim of the re-invite returns a refresh_token
select pg_temp.as_anon();
create temp table rc as
  select * from public.claim_team_invite((select token from ri));
grant select on rc to authenticated;
select is((select actor_type from rc), 'member',
         'member-reinvite claim returns actor_type=member');
select ok((select refresh_token is not null and length(refresh_token) >= 12 from rc),
         'member-reinvite claim returns a refresh_token');

-- 3. Reuses the original actor_id (NOT a new row)
select is((select actor_id from rc),
          (select actor_id from init_claim),
          'reinvite reuses target actor_id');

-- 4. The actor is still linked to the SAME user_id (no auth.users swap)
-- Switch to alice (team admin) so RLS lets us read the actor row.
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is(
  (select user_id from public.actors where id = (select actor_id from rc)),
  'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid,
  'reinvite preserves actor.user_id');

-- 5. Replay rejected with 23514
select throws_ok(
  format($$ select public.claim_team_invite(%L) $$, (select token from ri)),
  '23514', 'invite already consumed', 'reinvite replay rejected');

-- 6. Reject create_team_invite when target is non-anonymous (bob is named)
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
create temp table bob_invite as
  select * from public.create_team_invite(
    (select team_r from ctx), 'member', 'Bob',
    p_team_role => 'member');
select pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
create temp table bob_claim as
  select * from public.claim_team_invite((select token from bob_invite));
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select throws_ok(
  format($$ select public.create_team_invite(%L::uuid, 'member', 'Bob',
              p_team_role => 'member', p_target_actor_id => %L::uuid) $$,
         (select team_r from ctx), (select actor_id from bob_claim)),
  '22023', 'cannot re-invite member with bound auth identity',
  'reject re-invite for non-anonymous member');

-- 7. Reject create when target_actor_id points at bogus actor
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select throws_ok(
  format($$ select public.create_team_invite(%L::uuid, 'member', 'Stranger',
              p_team_role => 'member', p_target_actor_id => %L::uuid) $$,
         (select team_r from ctx),
         '00000000-0000-0000-0000-000000000000'),
  '23503', 'target actor not found',
  'reject re-invite with bogus target_actor_id');

select * from finish();
rollback;

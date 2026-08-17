-- 031_org_gc_keeps_public_orgs.sql
--
-- amux.claim_team_invite_legacy moves a member onto the invite team's org
-- (strict single-org) and then collects what the org they left behind still
-- holds. 20260817000000_org_gc_keeps_public_orgs.sql narrowed that collection to
-- our own amux.teams: public.orgs is a saas-mono-owned mirror, and on a merged
-- instance deleting a row there cascades into another product's tables.
--
-- This file pins both halves at once, because the failure modes point in
-- opposite directions: dropping the orgs delete is only safe if the teams delete
-- still happens, and re-adding the orgs delete is exactly the regression worth
-- catching.
--
-- Fixture shape: alice is the SOLE user of the old org, so switching her org
-- empties it and the GC condition is genuinely met — a test where the old org
-- keeps a user would pass no matter what the GC does.

begin;

select plan(5);

create or replace function pg_temp.as_user(p_user uuid, p_org uuid default null)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_org is null then
      json_build_object('sub', p_user::text, 'role', 'authenticated')::text
    else
      json_build_object('sub', p_user::text, 'role', 'authenticated',
                        'app_metadata', json_build_object('org_id', p_org::text))::text
    end,
    true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- Two orgs; alice alone in the old one, bob alone in the new one.
insert into public.orgs (id, name) values
  ('9c000000-0000-4000-8000-000000000001', 'GC Vacated Org'),
  ('9c000000-0000-4000-8000-000000000002', 'GC Destination Org');

insert into auth.users (id, email, aud, role, instance_id) values
  ('9c000000-0000-4000-8000-0000000000a1', 'alice-orggc@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('9c000000-0000-4000-8000-0000000000b1', 'bob-orggc@amux.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

-- Keyed on `id`, not `auth_user_id`: claim_team_invite_legacy resolves the
-- claimer with `where id = auth.uid()`, so a row keyed the other way would leave
-- v_old_org null and skip the GC branch entirely.
insert into public.users (id, org_id, mobile) values
  ('9c000000-0000-4000-8000-0000000000a1', '9c000000-0000-4000-8000-000000000001', ''),
  ('9c000000-0000-4000-8000-0000000000b1', '9c000000-0000-4000-8000-000000000002', '');

-- Alice's team under the org she is about to vacate.
insert into amux.teams (id, name, slug, oid) values
  ('9c000000-0000-4000-8000-0000000000e1', 'GC Vacated Team', 'gc-vacated-team',
   '9c000000-0000-4000-8000-000000000001');

-- Bob owns a team in the destination org and invites alice into it.
select pg_temp.as_user('9c000000-0000-4000-8000-0000000000b1',
                       '9c000000-0000-4000-8000-000000000002');
create temp table dest as
  select team_id from amux.create_team('GC Destination Team',
    p_oid => '9c000000-0000-4000-8000-000000000002');
grant select on dest to anon, authenticated;

create temp table inv as
  select * from amux.create_team_invite(
    (select team_id from dest), 'member', 'Alice', p_team_role => 'member');
grant select on inv to anon, authenticated;

-- ── Act: alice claims, vacating her org ─────────────────────────────────────
select pg_temp.as_user('9c000000-0000-4000-8000-0000000000a1',
                       '9c000000-0000-4000-8000-000000000001');
create temp table claimed as
  select * from amux.claim_team_invite((select token from inv));
grant select on claimed to anon, authenticated;

-- public.orgs and public.users are not readable as `authenticated` here; these
-- are observations about what the claim did, not RLS scenarios.
reset role;

-- ── Assert ──────────────────────────────────────────────────────────────────
select is((select actor_type from claimed), 'member',
          'alice claimed the member invite');

select is((select org_id from public.users
            where id = '9c000000-0000-4000-8000-0000000000a1'),
          '9c000000-0000-4000-8000-000000000002'::uuid,
          'claimer is moved onto the invite team org');

select ok(not exists (select 1 from public.users
                       where org_id = '9c000000-0000-4000-8000-000000000001'),
          'the old org really is empty, so the GC branch was reached');

-- The regression this file exists for.
select ok(exists (select 1 from public.orgs
                   where id = '9c000000-0000-4000-8000-000000000001'),
          'the vacated org row survives — public.orgs is saas-mono-owned');

-- ...and the half that must keep working.
select is((select count(*) from amux.teams
            where oid = '9c000000-0000-4000-8000-000000000001'),
          0::bigint,
          'amux.teams under the vacated org are still collected');

select * from finish();
rollback;

-- 032_picker_disambiguation_fields.sql
--
-- 20260817010000_picker_disambiguation_fields.sql widened
-- amux.list_teams_for_picker with created_at / member_count / owner_name, so a
-- client can tell apart the same-named teams an org accumulates (every team is
-- named after its org, and create_team uniquifies only the slug).
--
-- The fixture builds exactly that shape: one org, two teams with the SAME name,
-- different owners and different sizes. A test with distinct names would pass
-- against the old function too.

begin;

select plan(8);

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
insert into public.orgs (id, name) values
  ('9d000000-0000-4000-8000-000000000001', 'Dup Name Org');

insert into auth.users (id, email, aud, role, instance_id) values
  ('9d000000-0000-4000-8000-0000000000a1', 'ann-dup@amux.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('9d000000-0000-4000-8000-0000000000b1', 'bo-dup@amux.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('9d000000-0000-4000-8000-0000000000c1', 'cy-dup@amux.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('9d000000-0000-4000-8000-0000000000d1', 'dee-dup@amux.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

insert into public.users (id, org_id, mobile) values
  ('9d000000-0000-4000-8000-0000000000a1', '9d000000-0000-4000-8000-000000000001', ''),
  ('9d000000-0000-4000-8000-0000000000b1', '9d000000-0000-4000-8000-000000000001', ''),
  ('9d000000-0000-4000-8000-0000000000c1', '9d000000-0000-4000-8000-000000000001', '');

-- Ann's team, then Bo's team — both named after the org, exactly what bootstrap
-- produces for two people onboarding into one org.
select pg_temp.as_user('9d000000-0000-4000-8000-0000000000a1',
                       '9d000000-0000-4000-8000-000000000001');
create temp table ann as
  select team_id from amux.create_team('Dup Name Org',
    p_oid => '9d000000-0000-4000-8000-000000000001', p_display_name => 'Ann');
grant select on ann to anon, authenticated;

select pg_temp.as_user('9d000000-0000-4000-8000-0000000000b1',
                       '9d000000-0000-4000-8000-000000000001');
create temp table bo as
  select team_id from amux.create_team('Dup Name Org',
    p_oid => '9d000000-0000-4000-8000-000000000001', p_display_name => 'Bo');
grant select on bo to anon, authenticated;

-- Give Ann's team a second member so the two rows differ in size, and so
-- member_count is proven to count more than the owner.
reset role;
insert into amux.actors (team_id, actor_type, user_id, display_name)
values ((select team_id from ann), 'member', '9d000000-0000-4000-8000-0000000000c1', 'Cy');
-- An agent in the same team: member_count must not count it.
insert into amux.actors (team_id, actor_type, display_name)
values ((select team_id from ann), 'agent', 'Some Daemon');

-- ── Act: Ann opens the picker ───────────────────────────────────────────────
select pg_temp.as_user('9d000000-0000-4000-8000-0000000000a1',
                       '9d000000-0000-4000-8000-000000000001');
create temp table picked as
  select * from amux.list_teams_for_picker(null, false);
reset role;
grant select on picked to anon, authenticated;

-- ── Assert ──────────────────────────────────────────────────────────────────
select is((select count(*) from picked where item_type = 'team'), 1::bigint,
          'Ann sees only her own team (Bo''s is private and not hers)');

select is((select count(distinct team_name) from picked where item_type = 'team'), 1::bigint,
          'the fixture really did produce same-named teams');

select is((select member_count from picked where team_id = (select team_id from ann)),
          2,
          'member_count counts members (owner + Cy) and excludes the agent');

select is((select owner_name from picked where team_id = (select team_id from ann)),
          'Ann',
          'owner_name is the team owner''s display name');

select ok((select created_at from picked where team_id = (select team_id from ann)) is not null,
          'created_at is populated');

-- Bo's team is invisible to Ann above, so widen to a caller who is in both:
-- the point is that the two rows carry DIFFERENT disambiguation values.
-- Dee joins Ann's team in the same breath, so the two rows end up 3 vs 2.
-- Without this both land on 2 and the assertion below cannot fail for the right
-- reason.
reset role;
insert into amux.actors (team_id, actor_type, user_id, display_name)
values ((select team_id from bo), 'member', '9d000000-0000-4000-8000-0000000000a1', 'Ann'),
       ((select team_id from ann), 'member', '9d000000-0000-4000-8000-0000000000d1', 'Dee');

select pg_temp.as_user('9d000000-0000-4000-8000-0000000000a1',
                       '9d000000-0000-4000-8000-000000000001');
-- `both` is a reserved word (trim(both …)), hence the suffix.
create temp table both_teams as
  select * from amux.list_teams_for_picker(null, false);
reset role;
grant select on both_teams to anon, authenticated;

select is((select count(*) from both_teams where item_type = 'team'), 2::bigint,
          'Ann now sees both same-named teams');

select is((select count(distinct owner_name) from both_teams where item_type = 'team'), 2::bigint,
          'the two same-named rows carry different owners');

select isnt((select member_count from both_teams where team_id = (select team_id from ann)),
            (select member_count from both_teams where team_id = (select team_id from bo)),
            'the two same-named rows carry different member counts');

select * from finish();
rollback;

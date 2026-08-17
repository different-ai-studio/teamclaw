begin;

select plan(8);

-- bootstrap_login_team is the single login entry point. What it must do:
--   * a caller with a real org enters that org's PUBLIC default team, created
--     on first use and named after the org
--   * the SECOND caller in the same org JOINS that team instead of minting a
--     duplicate — the failure this whole redesign exists to stop
--   * a caller with no org mints one named after them, unless the deployment
--     turned self-registration off
--   * the shared partner tenant stays on the old path (own private team), or
--     belayo's phone users would all be funnelled into one team

create temporary table login_bootstrap (
  what text not null,
  got text
);
grant select on login_bootstrap to anon, authenticated;

create or replace function pg_temp.act_as(p_uid uuid, p_org uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_uid, 'role', 'authenticated',
    'app_metadata', case when p_org is null then '{}'::json
                         else json_build_object('org_id', p_org) end
  )::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

do $$
declare
  v_org      uuid := gen_random_uuid();
  v_shared   uuid := gen_random_uuid();
  v_first    uuid := gen_random_uuid();
  v_second   uuid := gen_random_uuid();
  v_partner  uuid := gen_random_uuid();
  v_orphan   uuid := gen_random_uuid();
  v_team_a   uuid;
  v_team_b   uuid;
  v_role_b   text;
  v_team_p   uuid;
  v_team_o   uuid;
begin
  insert into auth.users (id, aud, role, created_at, updated_at, instance_id, raw_user_meta_data)
  values
    (v_first,   'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000', '{}'::jsonb),
    (v_second,  'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000', '{}'::jsonb),
    (v_partner, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000', '{}'::jsonb),
    (v_orphan,  'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000',
     '{"full_name": "Orphan Otter"}'::jsonb);
  insert into public.orgs (id, name) values (v_org, 'Acme Ltd'), (v_shared, 'Shared Tenant');

  -- 1) first caller in a real org
  perform pg_temp.act_as(v_first, v_org);
  select team_id into v_team_a from amux.bootstrap_login_team(true, v_shared, 'First');
  execute 'reset role';
  insert into login_bootstrap values
    ('first_team_name', (select name from amux.teams where id = v_team_a)),
    ('first_team_visibility', (select visibility from amux.teams where id = v_team_a));

  -- 2) second caller, same org
  perform pg_temp.act_as(v_second, v_org);
  select team_id, role into v_team_b, v_role_b from amux.bootstrap_login_team(true, v_shared, 'Second');
  execute 'reset role';
  insert into login_bootstrap values
    ('second_team_same', case when v_team_b = v_team_a then 'same' else 'different' end),
    ('second_role', v_role_b),
    ('teams_in_org', (select count(*)::text from amux.teams where oid = v_org));

  -- 3) the shared tenant keeps the old behaviour: own team, org stays clean of
  --    a public default team.
  perform pg_temp.act_as(v_partner, v_shared);
  select team_id into v_team_p from amux.bootstrap_login_team(true, v_shared, 'Partner');
  execute 'reset role';
  insert into login_bootstrap values
    ('shared_visibility', (select visibility from amux.teams where id = v_team_p));

  -- 4) no org at all, self-registration allowed: mint an org named after them
  perform pg_temp.act_as(v_orphan, null);
  select team_id into v_team_o from amux.bootstrap_login_team(true, v_shared, 'ignored-for-org-name');
  execute 'reset role';
  insert into login_bootstrap values
    ('orphan_org_name', (select o.name from public.orgs o
                          join amux.teams t on t.oid = o.id where t.id = v_team_o)),
    ('orphan_team_name', (select name from amux.teams where id = v_team_o));
end $$;

select is((select got from login_bootstrap where what = 'first_team_name'), 'Acme Ltd',
  'the org default team is named after the org');
select is((select got from login_bootstrap where what = 'first_team_visibility'), 'public',
  'the org default team is public so the next member can find and join it');
select is((select got from login_bootstrap where what = 'second_team_same'), 'same',
  'the second member of an org JOINS the default team instead of minting a duplicate');
select is((select got from login_bootstrap where what = 'second_role'), 'member',
  'the joining member is not made an owner');
select is((select got from login_bootstrap where what = 'teams_in_org'), '1',
  'two people onboarding into one org produce exactly one team');
select is((select got from login_bootstrap where what = 'shared_visibility'), 'private',
  'the shared partner tenant keeps minting private per-user teams');
select is((select got from login_bootstrap where what = 'orphan_org_name'), 'Orphan Otter',
  'an org-less caller gets an org named from their OAuth full name');
select is((select got from login_bootstrap where what = 'orphan_team_name'), 'Orphan Otter',
  'and the team is named after that org');

select * from finish();
rollback;

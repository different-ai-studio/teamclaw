begin;

select plan(3);

create temporary table empty_org_bootstrap_fixture (
  team_id uuid not null,
  expected_org_name text not null
);

do $$
declare
  v_user uuid := gen_random_uuid();
  v_org uuid := gen_random_uuid();
  v_team uuid;
begin
  insert into auth.users (id, aud, role, created_at, updated_at, instance_id)
  values (v_user, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
  insert into public.orgs (id, name) values (v_org, 'Empty Phone Org');
  insert into public.users (id, auth_user_id, org_id, mobile)
  values (v_user, v_user, v_org, '13800009993');
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select team_id into v_team from amux.bootstrap_selected_org_team(v_org, 'Owner');
  insert into empty_org_bootstrap_fixture values (v_team, 'Empty Phone Org');
end $$;

select is(
  (select t.name from amux.teams t join empty_org_bootstrap_fixture f on f.team_id = t.id),
  expected_org_name,
  'empty org bootstrap names the team after its org'
) from empty_org_bootstrap_fixture;
select is(
  (select t.visibility from amux.teams t join empty_org_bootstrap_fixture f on f.team_id = t.id),
  'public',
  'empty org bootstrap creates a public team'
);
select ok(
  exists(
    select 1
      from amux.actors a
      join empty_org_bootstrap_fixture f on f.team_id = a.team_id
  ),
  'empty org bootstrap adds the selecting user as a member'
);

select * from finish();
rollback;

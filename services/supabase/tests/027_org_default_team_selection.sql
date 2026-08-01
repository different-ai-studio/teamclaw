begin;

select plan(2);

create temporary table onboarding_selection (
  case_name text primary key,
  joined_team_id uuid not null,
  expected_team_id uuid not null
);

do $$
declare
  v_uid uuid := gen_random_uuid();
  v_org uuid := gen_random_uuid();
  v_oldest_team uuid := gen_random_uuid();
  v_named_team uuid := gen_random_uuid();
  v_joined_team uuid;
begin
  insert into auth.users (id, aud, role, created_at, updated_at, instance_id)
  values (v_uid, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
  insert into public.orgs (id, name) values (v_org, 'Preferred Org');
  insert into public.users (auth_user_id, org_id) values (v_uid, v_org);
  insert into amux.teams (id, name, slug, oid, created_at) values
    (v_oldest_team, 'Legacy Team', 'legacy-' || substr(v_oldest_team::text, 1, 8), v_org, now() - interval '1 day'),
    (v_named_team, 'Preferred Org', 'preferred-' || substr(v_named_team::text, 1, 8), v_org, now());

  perform set_config('request.jwt.claims', json_build_object(
    'sub', v_uid, 'role', 'authenticated', 'app_metadata', json_build_object('org_id', v_org)
  )::text, true);
  perform set_config('role', 'authenticated', true);
  select team_id into v_joined_team from amux.join_or_create_org_team(null, null, null, null, null, null, null);
  insert into onboarding_selection values ('named-team', v_joined_team, v_named_team);
end $$;

do $$
declare
  v_uid uuid := gen_random_uuid();
  v_org uuid := gen_random_uuid();
  v_oldest_team uuid := gen_random_uuid();
  v_later_team uuid := gen_random_uuid();
  v_joined_team uuid;
begin
  insert into auth.users (id, aud, role, created_at, updated_at, instance_id)
  values (v_uid, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
  insert into public.orgs (id, name) values (v_org, 'No Match Org');
  insert into public.users (auth_user_id, org_id) values (v_uid, v_org);
  insert into amux.teams (id, name, slug, oid, created_at) values
    (v_oldest_team, 'First Team', 'first-' || substr(v_oldest_team::text, 1, 8), v_org, now() - interval '1 day'),
    (v_later_team, 'Later Team', 'later-' || substr(v_later_team::text, 1, 8), v_org, now());

  perform set_config('request.jwt.claims', json_build_object(
    'sub', v_uid, 'role', 'authenticated', 'app_metadata', json_build_object('org_id', v_org)
  )::text, true);
  perform set_config('role', 'authenticated', true);
  select team_id into v_joined_team from amux.join_or_create_org_team(null, null, null, null, null, null, null);
  insert into onboarding_selection values ('oldest-fallback', v_joined_team, v_oldest_team);
end $$;

select is(joined_team_id, expected_team_id, 'prefers the team named after the org')
from onboarding_selection where case_name = 'named-team';
select is(joined_team_id, expected_team_id, 'falls back to the oldest team when no name matches')
from onboarding_selection where case_name = 'oldest-fallback';

select * from finish();
rollback;

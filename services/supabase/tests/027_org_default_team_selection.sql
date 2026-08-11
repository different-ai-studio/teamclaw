begin;

select plan(3);

create temporary table bootstrap_selection (
  created_team_id uuid not null,
  existing_team_id uuid not null,
  expected_name text not null,
  actor_user_id uuid not null
);

-- The fixture is read back while impersonating anon/authenticated, and a
-- temp table belongs to the session role: without this grant the first read
-- under `set role` fails with "permission denied for table bootstrap_selection".
grant select on bootstrap_selection to anon, authenticated;

do $$
declare
  v_uid uuid := gen_random_uuid();
  v_org uuid := gen_random_uuid();
  v_existing_team uuid := gen_random_uuid();
  v_created_team uuid;
  v_actor uuid;
begin
  insert into auth.users (id, aud, role, created_at, updated_at, instance_id)
  values (v_uid, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
  insert into public.orgs (id, name) values (v_org, 'Bootstrap Org');
  insert into public.users (auth_user_id, org_id) values (v_uid, v_org);
  insert into amux.teams (id, name, slug, oid)
  values (v_existing_team, 'Existing private team', 'existing-' || substr(v_existing_team::text, 1, 8), v_org);

  perform set_config('request.jwt.claims', json_build_object(
    'sub', v_uid, 'role', 'authenticated', 'app_metadata', json_build_object('org_id', v_org)
  )::text, true);
  perform set_config('role', 'authenticated', true);
  select team_id, member_id into v_created_team, v_actor
    from amux.bootstrap_current_org_team(null, 'Owner');
  -- Drop the impersonation before writing the fixture row: the temp table
  -- belongs to the session role, and a write as `authenticated` fails with
  -- "permission denied for table bootstrap_selection".
  execute 'reset role';
  insert into bootstrap_selection values (
    v_created_team, v_existing_team, 'Bootstrap Org',
    (select user_id from amux.actors where id = v_actor)
  );
end $$;

select isnt(created_team_id, existing_team_id, 'bootstrap does not silently join an existing org team')
from bootstrap_selection;
select is(
  (select t.name from amux.teams t join bootstrap_selection s on s.created_team_id = t.id),
  expected_name,
  'bootstrap creates the team with the current org name'
) from bootstrap_selection;
select is(actor_user_id, (select (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid),
  'bootstrap creates the owner actor for the authenticated user')
from bootstrap_selection;

select * from finish();
rollback;

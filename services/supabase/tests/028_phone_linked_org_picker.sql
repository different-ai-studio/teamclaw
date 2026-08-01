begin;

select plan(6);

create temporary table phone_picker_fixture (
  caller_id uuid not null,
  linked_id uuid not null,
  org_a uuid not null,
  org_b uuid not null,
  linked_private_team uuid not null
);

do $$
declare
  v_caller uuid := gen_random_uuid();
  v_linked uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_org_a uuid := gen_random_uuid();
  v_org_b uuid := gen_random_uuid();
  v_org_other uuid := gen_random_uuid();
  v_team_linked uuid := gen_random_uuid();
begin
  insert into auth.users (id, aud, role, created_at, updated_at, instance_id)
  values
    (v_caller, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (v_linked, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (v_other, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
  insert into public.orgs (id, name)
  values (v_org_a, 'Phone Org A'), (v_org_b, 'Phone Org B'), (v_org_other, 'Other Org');
  insert into public.users (id, auth_user_id, org_id, mobile)
  values
    (v_caller, v_caller, v_org_a, '13800009991'),
    (v_linked, v_linked, v_org_b, '13800009991'),
    (v_other, v_other, v_org_other, '13800009992');
  insert into amux.teams (id, name, slug, oid, visibility)
  values
    (gen_random_uuid(), 'Caller private', 'phone-caller-private', v_org_a, 'private'),
    (v_team_linked, 'Linked private', 'phone-linked-private', v_org_b, 'private'),
    (gen_random_uuid(), 'A public', 'phone-a-public', v_org_a, 'public'),
    (gen_random_uuid(), 'B public', 'phone-b-public', v_org_b, 'public'),
    (gen_random_uuid(), 'Hidden private', 'phone-hidden-private', v_org_b, 'private'),
    (gen_random_uuid(), 'Other public', 'phone-other-public', v_org_other, 'public');
  insert into amux.actors (id, team_id, actor_type, user_id, display_name)
  select gen_random_uuid(), t.id, 'member', v_caller, 'Caller'
    from amux.teams t where t.slug = 'phone-caller-private';
  insert into amux.actors (id, team_id, actor_type, user_id, display_name)
  values (gen_random_uuid(), v_team_linked, 'member', v_linked, 'Linked');
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_caller, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  insert into phone_picker_fixture values (v_caller, v_linked, v_org_a, v_org_b, v_team_linked);
end $$;

select is(
  (select count(*)::int from amux.list_teams_for_picker(null, true)),
  4,
  'picker returns only member and public teams in phone-linked orgs'
);
select ok(
  exists(select 1 from amux.list_teams_for_picker(null, true) where team_slug = 'phone-linked-private' and is_member),
  'picker includes a private team joined by a same-phone identity'
);
select ok(
  exists(select 1 from amux.list_teams_for_picker(null, true) where team_slug = 'phone-b-public' and not is_member),
  'picker includes public teams in every phone-linked org'
);
select ok(
  not exists(select 1 from amux.list_teams_for_picker(null, true) where team_slug = 'phone-hidden-private'),
  'picker excludes private teams with no phone-linked membership'
);
select ok(
  not exists(select 1 from amux.list_teams_for_picker(null, true) where team_slug = 'phone-other-public'),
  'picker excludes teams outside phone-linked orgs'
);
select ok(
  (select refresh_token is not null from amux.switch_active_team(linked_private_team) limit 1),
  'switching a linked private team mints the linked identity session'
) from phone_picker_fixture;

select * from finish();
rollback;

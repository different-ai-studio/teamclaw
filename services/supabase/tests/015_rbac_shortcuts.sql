-- services/supabase/tests/015_rbac_shortcuts.sql
begin;

select plan(22);

-- ── Fixture setup ────────────────────────────────────────────────────────
-- One team. owner is the team owner; m1 and m2 are plain members.
-- Custom role 'sales' is held by m1 only.

create temp table fx(
  team_id uuid,
  owner_member uuid, owner_user uuid,
  m1_member uuid, m1_user uuid,
  m2_member uuid, m2_user uuid,
  role_sales uuid
) on commit drop;

create or replace function pg_temp.mk_member(p_team uuid, p_name text, p_role text)
returns table(member_id uuid, user_id uuid)
language plpgsql as $$
declare v_actor uuid := gen_random_uuid(); v_user uuid := gen_random_uuid();
begin
  insert into auth.users(id, email) values (v_user, p_name || '@test.local');
  insert into public.actors(id, team_id, actor_type, display_name)
    values (v_actor, p_team, 'member', p_name);
  insert into public.members(id, user_id, status)
    values (v_actor, v_user, 'active');
  insert into public.team_members(team_id, member_id, role)
    values (p_team, v_actor, p_role);
  return query select v_actor, v_user;
end $$;

create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('role', 'service_role', true);
end $$;

-- Seed
insert into fx(team_id) values (gen_random_uuid());
insert into public.teams(id, slug, name)
  select team_id, 'team-' || team_id::text, 'T' from fx;

update fx set (owner_member, owner_user) =
  (select member_id, user_id from pg_temp.mk_member((select team_id from fx), 'owner', 'owner'));
update fx set (m1_member, m1_user) =
  (select member_id, user_id from pg_temp.mk_member((select team_id from fx), 'm1', 'member'));
update fx set (m2_member, m2_user) =
  (select member_id, user_id from pg_temp.mk_member((select team_id from fx), 'm2', 'member'));

-- Owner creates the 'sales' role and assigns it to m1.
select pg_temp.as_user((select owner_user from fx));

insert into public.team_roles(team_id, code, name)
  select team_id, 'sales', 'Sales' from fx;
update fx set role_sales = (
  select id from public.team_roles
  where team_id = fx.team_id and code = 'sales'
);

insert into public.team_member_roles(team_id, member_id, role_id)
  select team_id, m1_member, role_sales from fx;

-- ── 1) Schema-level ─────────────────────────────────────────────────────
select has_table('public','team_roles',         'team_roles exists');
select has_table('public','team_member_roles',  'team_member_roles exists');
select has_table('public','permissions',        'permissions exists');
select has_table('public','permission_roles',   'permission_roles exists');
select has_table('public','shortcuts',          'shortcuts exists');

-- 2) XOR constraint: personal with no owner_member_id is rejected
select pg_temp.as_service();
select throws_ok(
  $$ insert into public.shortcuts(scope, label, node_type) values ('personal','x','link') $$,
  '23514',
  null,
  'XOR rejects personal shortcut with no owner_member_id'
);

-- 3) XOR constraint: team with both owner_member_id and team_id is rejected
select throws_ok(
  $$ insert into public.shortcuts(scope, owner_member_id, team_id, label, node_type)
     values ('team', gen_random_uuid(), gen_random_uuid(), 'x', 'link') $$,
  '23514',
  null,
  'XOR rejects team shortcut with owner_member_id set'
);

-- ── Helpers exist ───────────────────────────────────────────────────────
-- 4-6
select lives_ok(
  $$ select app.is_team_admin_or_owner(gen_random_uuid()) $$,
  'helper: is_team_admin_or_owner'
);
select lives_ok(
  $$ select app.member_can_access_permission(gen_random_uuid()) $$,
  'helper: member_can_access_permission'
);
select lives_ok(
  $$ select app.member_can_see_shortcut(gen_random_uuid()) $$,
  'helper: member_can_see_shortcut'
);

-- ── RPC: shortcut_create personal ───────────────────────────────────────
select pg_temp.as_user((select m1_user from fx));

select lives_ok(
  $$ select public.shortcut_create('personal', 'My Link', 'link', null, null, null, 0, 'https://example.com') $$,
  'rpc: shortcut_create personal succeeds for any member'
);  -- 7

-- ── RPC: shortcut_create team forbidden for non-admin ───────────────────
select throws_ok(
  $$ select public.shortcut_create('team', 'Team Link', 'link',
       (select team_id from fx), null, null, 0, 'https://example.com') $$,
  null,
  'forbidden',
  'rpc: shortcut_create team rejects non-admin'
);  -- 8

-- ── RPC: shortcut_create team succeeds for owner; also creates permission row
select pg_temp.as_user((select owner_user from fx));

select lives_ok(
  $$ select public.shortcut_create('team', 'Team Link', 'link',
       (select team_id from fx), null, null, 0, 'https://example.com') $$,
  'rpc: shortcut_create team succeeds for owner'
);  -- 9

select pg_temp.as_service();
select is(
  (select count(*)::int from public.permissions
    where team_id = (select team_id from fx) and resource_type = 'shortcut'),
  1,
  'permissions row inserted for team shortcut'
);  -- 10

-- ── RLS: personal isolation ─────────────────────────────────────────────
select pg_temp.as_user((select m2_user from fx));

select is(
  (select count(*)::int from public.shortcuts
    where scope = 'personal'),
  0,
  'm2 cannot see m1''s personal shortcut'
);  -- 11

select pg_temp.as_user((select m1_user from fx));
select is(
  (select count(*)::int from public.shortcuts where scope = 'personal'),
  1,
  'm1 sees own personal shortcut'
);  -- 12

-- ── RLS: team open default (no permission_roles bindings) ───────────────
select pg_temp.as_user((select m2_user from fx));
select is(
  (select count(*)::int from public.shortcuts where scope = 'team'),
  1,
  'm2 (no roles) sees team shortcut under open default'
);  -- 13

-- ── RPC: shortcut_set_visible_roles binds 'sales' to the team shortcut ──
select pg_temp.as_user((select owner_user from fx));

select lives_ok(
  $$ select public.shortcut_set_visible_roles(
       (select id from public.shortcuts where scope='team' limit 1),
       array[(select role_sales from fx)]
     ) $$,
  'rpc: shortcut_set_visible_roles binds sales role'
);  -- 14

-- ── RLS: team restricted — m2 (no sales) cannot see; m1 (sales) can ─────
select pg_temp.as_user((select m2_user from fx));
select is(
  (select count(*)::int from public.shortcuts where scope = 'team'),
  0,
  'm2 cannot see team shortcut after sales-only binding'
);  -- 15

select pg_temp.as_user((select m1_user from fx));
select is(
  (select count(*)::int from public.shortcuts where scope = 'team'),
  1,
  'm1 (holds sales) can see team shortcut after binding'
);  -- 16

-- ── RPC: shortcut_set_visible_roles swap-in (replace bindings) ──────────
select pg_temp.as_user((select owner_user from fx));

select lives_ok(
  $$ select public.shortcut_set_visible_roles(
       (select id from public.shortcuts where scope='team' limit 1),
       array[]::uuid[]
     ) $$,
  'rpc: shortcut_set_visible_roles can clear bindings (back to open default)'
);  -- 17

select pg_temp.as_service();
select is(
  (select count(*)::int from public.permission_roles
    where permission_id = (
      select id from public.permissions
      where resource_type = 'shortcut'
        and resource_id = (select id from public.shortcuts where scope='team' limit 1)
    )),
  0,
  'permission_roles cleared after swap-in with empty array'
);  -- 18

-- ── Trigger: deleting a team shortcut cleans up its permissions row ─────
select pg_temp.as_user((select owner_user from fx));
delete from public.shortcuts
  where scope = 'team' and team_id = (select team_id from fx);

select pg_temp.as_service();
select is(
  (select count(*)::int from public.permissions
    where team_id = (select team_id from fx) and resource_type = 'shortcut'),
  0,
  'cleanup trigger removes permissions row after team shortcut delete'
);  -- 19

-- ── RPC: team_member_set_roles swap-in ──────────────────────────────────
select pg_temp.as_user((select owner_user from fx));

select lives_ok(
  $$ select public.team_member_set_roles(
       (select team_id from fx),
       (select m2_member from fx),
       array[(select role_sales from fx)]
     ) $$,
  'rpc: team_member_set_roles assigns sales to m2'
);  -- 20

select pg_temp.as_service();
select is(
  (select count(*)::int from public.team_member_roles
    where member_id = (select m2_member from fx)),
  1,
  'm2 now has one role binding'
);  -- 21

-- Swap-in to empty
select pg_temp.as_user((select owner_user from fx));
select public.team_member_set_roles(
  (select team_id from fx),
  (select m2_member from fx),
  array[]::uuid[]
);

select pg_temp.as_service();
select is(
  (select count(*)::int from public.team_member_roles
    where member_id = (select m2_member from fx)),
  0,
  'team_member_set_roles with empty array clears all bindings'
);  -- 22

select * from finish();
rollback;

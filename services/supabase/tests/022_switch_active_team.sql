begin;

-- Local helper: assert a statement raises a specific SQLSTATE (copied from
-- 001_schema_shape.sql so this file is self-contained).
create or replace function pg_temp.raises_sqlstate(p_sql text, p_expected_sqlstate text)
returns boolean
language plpgsql
as $$
declare
  v_sqlstate text;
begin
  execute p_sql;
  return false;
exception
  when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    return v_sqlstate = p_expected_sqlstate;
end;
$$;

select plan(7);

-- ---------------------------------------------------------------------------
-- Task 2: list_all_my_teams returns teams across ALL orgs the caller belongs to.
-- Fixture: one user with an actor in org A's team AND org B's team; active org = A.
-- ---------------------------------------------------------------------------
do $$
declare
  v_uid   uuid := gen_random_uuid();
  v_orgA  uuid := gen_random_uuid();
  v_orgB  uuid := gen_random_uuid();
  v_teamA uuid := gen_random_uuid();
  v_teamB uuid := gen_random_uuid();
begin
  insert into auth.users (id, aud, role, created_at, updated_at, instance_id)
    values (v_uid, 'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
  insert into public.orgs (id, name) values (v_orgA, 'Org A'), (v_orgB, 'Org B');
  insert into public.users (auth_user_id, org_id) values (v_uid, v_orgA);
  insert into amux.teams (id, name, slug, oid) values
    (v_teamA, 'Team A', 'team-a', v_orgA),
    (v_teamB, 'Team B', 'team-b', v_orgB);
  insert into amux.actors (id, team_id, actor_type, user_id, display_name)
    values (gen_random_uuid(), v_teamA, 'member', v_uid, 'Me A'),
           (gen_random_uuid(), v_teamB, 'member', v_uid, 'Me B');
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated',
      'app_metadata', json_build_object('org_id', v_orgA))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- 即使活跃 org=A，list_all_my_teams 也要返回 A、B 两个 team（跨 org）。
select is(
  (select count(*)::int from amux.list_all_my_teams()),
  2,
  'list_all_my_teams returns teams across all orgs');
select ok(
  exists(select 1 from amux.list_all_my_teams() where team_slug = 'team-b'),
  'includes a team from the non-active org');
select ok(
  (select org_name from amux.list_all_my_teams() where team_slug = 'team-a') = 'Org A',
  'annotates org name');
select ok(
  (select org_id from amux.list_all_my_teams() where team_slug = 'team-b') is not null,
  'annotates org id');

-- ---------------------------------------------------------------------------
-- Task 3: switch_active_team — switching to a member team flips active org to that
-- team's oid and returns a refresh token; switching to a non-member team raises 42501.
-- ---------------------------------------------------------------------------
do $$
declare
  v_uid   uuid;
  v_teamB uuid;
  v_orgB  uuid;
  v_rt    text;
begin
  select id, oid into v_teamB, v_orgB from amux.teams where slug = 'team-b';
  -- 复用上面的 fixture 用户：经 team-b 的 actor 确定地定位它（不依赖未过滤表上的 limit 1）。
  select a.user_id into v_uid from amux.actors a where a.team_id = v_teamB;
  select refresh_token into v_rt from amux.switch_active_team(v_teamB);
  perform ok(v_rt is not null, 'switch returns a refresh token');
  perform is(
    (select org_id from public.users where auth_user_id = v_uid),
    v_orgB,
    'switch updates active org to target team org');
end $$;

-- 非成员的 team 调用被拒（42501）。
-- 注：'…00ff' 是一个故意不存在的 team id —— actor-membership 查询先查不到 actor，
-- 因而在换 org 前就抛 42501（非成员），覆盖到拒绝路径。
select ok(
  pg_temp.raises_sqlstate(
    'select amux.switch_active_team(''00000000-0000-0000-0000-0000000000ff''::uuid)',
    '42501'),
  'switch rejects a team the caller is not a member of');

select * from finish();
rollback;

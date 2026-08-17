-- CS-2: org 的 public 默认团队 + 登录 bootstrap 编排入口。
--
-- 目标行为：
--   无 org            → 允许注册就自建 org（CS-1 已让它以本人命名）+ 同名 public 默认团队
--   org 是共享租户     → 走今天的老路（belayo 冻结，见 CS-3）
--   其他真实 org      → 确保该 org 有一个 public 默认团队，加入它
--
-- 三件事在这里落地：
--
-- 1) create_team 的 insert 块抽成 amux.create_team_row。原函数的 first-team-only
--    守卫挡住了「已有团队的人为一个还没有团队的 org 建默认团队」这个场景，而那正是
--    规则 4 要做的事。抽出来共用，而不是复制粘贴一份会漂移的副本。
--    create_team 自身语义完全不变（守卫仍在它那一层）。
--
-- 2) ensure_org_public_team 按 org 上咨询锁。amux.teams 在 (oid, name) 上没有
--    任何约束（只有 teams_slug_key），同 org 两人并发登录会造出两个默认团队。
--    幂等键刻意用「该 org 下是否已有 public 团队」而不是同名：名字键改名即失联，
--    slug 因去重后缀 + 全中文归一成 'team-N' 同样不可用。
--
-- 3) bootstrap_login_team 是唯一的编排入口，整个决策在一个事务里完成。让 FC 先
--    读一次 org 再决定调哪个 RPC 会引入一次多余往返和一个竞态窗口。
--
-- 注册开关以参数形式传入（p_allow_new_org），即 FC 层强制 —— 直连 PostgREST 的
-- 调用方可以自己传 true。这是明知并接受的取舍：开关是产品形态开关，不是安全边界。
-- 详见 docs/plans/2026-08-17-login-org-team-redesign.md。

-- ---------------------------------------------------------------------------
-- 1) 建团的实际写入，不带 first-team-only 守卫，可指定 visibility
-- ---------------------------------------------------------------------------
create or replace function amux.create_team_row(
  p_name text default null,
  p_slug text default null,
  p_litellm_team_id text default null,
  p_ai_gateway_endpoint text default null,
  p_display_name text default null,
  p_oid uuid default null,
  p_visibility text default 'private'
)
returns table(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_user_id      uuid := auth.uid();
  v_member_id    uuid;
  v_team_id      uuid := gen_random_uuid();
  v_workspace_id uuid;
  v_slug_base    text;
  v_slug         text;
  v_suffix       integer := 1;
  v_team_name    text;
  v_display_name text;
  v_nickname     text;
begin
  if v_user_id is null then
    raise exception 'create_team_row requires an authenticated user' using errcode = '42501';
  end if;
  if p_visibility not in ('public', 'private') then
    raise exception 'visibility must be public or private' using errcode = '23514';
  end if;

  select nickname into v_nickname from public.users where id = v_user_id limit 1;

  v_team_name := coalesce(
    nullif(btrim(p_name), ''),
    amux.resolve_caller_display_name(v_team_id)
  );

  v_slug_base := lower(regexp_replace(coalesce(nullif(btrim(p_slug), ''), v_team_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug_base := trim(both '-' from v_slug_base);
  if v_slug_base = '' then v_slug_base := 'team'; end if;
  v_slug := v_slug_base;
  while exists (select 1 from amux.teams t where t.slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := format('%s-%s', v_slug_base, v_suffix);
  end loop;

  insert into amux.teams (id, name, slug, oid, visibility)
  values (v_team_id, v_team_name, v_slug, p_oid, p_visibility);

  v_member_id := gen_random_uuid();
  v_display_name := coalesce(
    nullif(btrim(v_nickname), ''),
    nullif(btrim(p_display_name), ''),
    amux.resolve_caller_display_name(v_member_id)
  );

  insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
  values (v_member_id, v_team_id, 'member', v_user_id, v_display_name, now());
  insert into amux.members (id, status) values (v_member_id, 'active');
  insert into amux.team_members (team_id, member_id, role) values (v_team_id, v_member_id, 'owner');
  insert into amux.workspaces (team_id, created_by_member_id, name, path)
  values (v_team_id, v_member_id, 'General', null)
  returning id into v_workspace_id;
  insert into amux.team_workspace_config (team_id, litellm_team_id, ai_gateway_endpoint)
  values (v_team_id, p_litellm_team_id, p_ai_gateway_endpoint);

  return query
  select v_team_id, v_team_name, v_slug, v_member_id, 'owner'::text, v_workspace_id, 'General'::text;
end;
$function$;

grant execute on function amux.create_team_row(text, text, text, text, text, uuid, text) to authenticated, service_role;

-- create_team 保持原语义（含 first-team-only 守卫），实际写入委托给上面那个。
create or replace function amux.create_team(
  p_name text default null::text,
  p_slug text default null::text,
  p_litellm_team_id text default null::text,
  p_ai_gateway_endpoint text default null::text,
  p_display_name text default null::text,
  p_oid uuid default null::uuid
)
returns table(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'create_team requires an authenticated user' using errcode = '42501';
  end if;
  if exists (select 1 from amux.actors where user_id = v_user_id) then
    raise exception 'create_team currently supports first-team onboarding only'
      using errcode = '23514', detail = 'Existing actors already have a team-scoped identity.';
  end if;

  return query
    select c.team_id, c.team_name, c.team_slug, c.member_id, c.role, c.workspace_id, c.workspace_name
      from amux.create_team_row(
        p_name => p_name,
        p_slug => p_slug,
        p_litellm_team_id => p_litellm_team_id,
        p_ai_gateway_endpoint => p_ai_gateway_endpoint,
        p_display_name => p_display_name,
        p_oid => p_oid,
        p_visibility => 'private'
      ) c;
end;
$function$;

grant execute on function amux.create_team(text, text, text, text, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) org 的 public 默认团队：已有就加入，没有就建
--
-- 名字刻意不叫 ensure_org_default_team —— baseline 里已经有一个同名函数
-- (uuid, text) -> uuid，是 app.* schema 时代的遗留（只插一行 teams，不建 actor
-- 也不建 workspace），全仓库没有任何调用点。同名会因返回类型不同直接建不出来，
-- 而 DROP 掉一个自己不需要的遗留函数属于另一件事，不在本次范围内。
-- ---------------------------------------------------------------------------
create or replace function amux.ensure_org_public_team(
  p_org_id uuid,
  p_display_name text default null
)
returns table(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_user_id  uuid := auth.uid();
  v_org_name text;
  v_team     amux.teams%rowtype;
  v_member_id uuid;
  v_nickname text;
  v_display_name text;
  v_workspace_id uuid;
  v_workspace_name text;
begin
  if v_user_id is null then
    raise exception 'ensure_org_public_team requires an authenticated user' using errcode = '42501';
  end if;
  if p_org_id is null then
    raise exception 'ensure_org_public_team requires an organization' using errcode = '23514';
  end if;

  -- 按 org 串行，不是按 user：同 org 两人同时首次登录正是这里要收敛的情况。
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));

  -- 已经在这个 org 的某个团队里了：原样返回，不再造第二个。
  select t.* into v_team
    from amux.teams t
    join amux.actors a on a.team_id = t.id
   where t.oid = p_org_id and a.user_id = v_user_id
   order by t.created_at asc, t.id asc
   limit 1;

  if not found then
    -- 该 org 已有 public 团队 → 加入它（幂等键：public 存在性，不是同名）。
    select t.* into v_team
      from amux.teams t
     where t.oid = p_org_id and t.visibility = 'public'
     order by t.created_at asc, t.id asc
     limit 1;
  end if;

  if not found then
    select name into v_org_name from public.orgs where id = p_org_id;
    if nullif(btrim(v_org_name), '') is null then
      raise exception 'organization has no name' using errcode = '23514';
    end if;
    return query
      select c.team_id, c.team_name, c.team_slug, c.member_id, c.role, c.workspace_id, c.workspace_name
        from amux.create_team_row(
          p_name => v_org_name,
          p_display_name => p_display_name,
          p_oid => p_org_id,
          p_visibility => 'public'
        ) c;
    return;
  end if;

  -- 落到这里说明命中了一个已存在的团队：确保调用者在里面有 actor。
  select a.id into v_member_id
    from amux.actors a
   where a.user_id = v_user_id and a.team_id = v_team.id
   limit 1;

  if v_member_id is null then
    select nickname into v_nickname from public.users where id = v_user_id limit 1;
    v_member_id := gen_random_uuid();
    v_display_name := coalesce(
      nullif(btrim(v_nickname), ''),
      nullif(btrim(p_display_name), ''),
      amux.resolve_caller_display_name(v_member_id)
    );
    insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
      values (v_member_id, v_team.id, 'member', v_user_id, v_display_name, now());
    insert into amux.members (id, status) values (v_member_id, 'active');
    insert into amux.team_members (team_id, member_id, role) values (v_team.id, v_member_id, 'member');
  end if;

  select w.id, w.name into v_workspace_id, v_workspace_name
    from amux.workspaces w
   where w.team_id = v_team.id
   order by w.created_at asc, w.id asc
   limit 1;

  return query select v_team.id, v_team.name, v_team.slug, v_member_id,
    case when exists (
      select 1 from amux.team_members tm
       where tm.team_id = v_team.id and tm.member_id = v_member_id and tm.role = 'owner'
    ) then 'owner' else 'member' end,
    v_workspace_id, v_workspace_name;
end;
$function$;

grant execute on function amux.ensure_org_public_team(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) 登录 bootstrap 的唯一编排入口
-- ---------------------------------------------------------------------------
create or replace function amux.bootstrap_login_team(
  p_allow_new_org boolean default true,
  p_shared_org uuid default null,
  p_display_name text default null
)
returns table(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_org_id  uuid;
begin
  if v_user_id is null then
    raise exception 'bootstrap_login_team requires an authenticated user' using errcode = '42501';
  end if;

  v_org_id := amux.current_org_id();

  if v_org_id is null then
    if not coalesce(p_allow_new_org, true) then
      raise exception 'self-registration is disabled on this deployment' using errcode = '42501';
    end if;
    v_org_id := amux.ensure_personal_org();
  end if;

  if v_org_id is null then
    raise exception 'current organization is required for team bootstrap' using errcode = '23514';
  end if;

  -- 共享租户（partner）留在老路上：各自建私有团队，不给它建 public 默认团队。
  -- 没有这条排除，belayo 的手机号用户会被规则 4 收敛进同一个团队。
  if p_shared_org is not null and v_org_id = p_shared_org then
    return query
      select c.team_id, c.team_name, c.team_slug, c.member_id, c.role, c.workspace_id, c.workspace_name
        from amux.bootstrap_current_org_team(v_org_id, p_display_name) c;
    return;
  end if;

  return query
    select c.team_id, c.team_name, c.team_slug, c.member_id, c.role, c.workspace_id, c.workspace_name
      from amux.ensure_org_public_team(v_org_id, p_display_name) c;
end;
$function$;

grant execute on function amux.bootstrap_login_team(boolean, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) 选择器：related_orgs 补上 JWT 里的活跃 org
-- ---------------------------------------------------------------------------
-- 规则 4.1（有 org、有 public team → 列出来让用户选）依赖 public_teams 这个
-- CTE，而它过去只认 public.users.org_id。一个只带 JWT app_metadata.org_id、
-- 还没有 users 行的账号因此看不到自己 org 里的 public 团队，会被 bootstrap
-- 当成「无可选项」。加上 current_org_id() 补齐这个口子。
-- 函数签名与返回类型不变，CREATE OR REPLACE 即可，grant 自动保留。
create or replace function amux.list_teams_for_picker(
  p_default_org_id uuid default null,
  p_include_empty_orgs boolean default false
)
returns table(team_id uuid, team_name text, team_slug text, org_id uuid, org_name text,
              visibility text, is_member boolean, item_type text,
              created_at timestamptz, member_count integer, owner_name text)
language sql
stable security definer
set search_path to 'amux', 'public', 'auth'
as $function$
  with current_identity as (
    select u.id, nullif(btrim(u.mobile), '') as mobile
      from public.users u
     where u.id = auth.uid()
     limit 1
  ), related_users as (
    select auth.uid() as id
     where auth.uid() is not null
    union
    select u.id
      from public.users u
      join current_identity c on c.mobile is not null and u.mobile = c.mobile
  ), related_orgs as (
    select distinct u.org_id
      from public.users u
      join related_users ru on ru.id = u.id
     where u.org_id is not null
    union
    select amux.current_org_id()
     where amux.current_org_id() is not null
  ), member_teams as (
    select t.id, t.name, t.slug, t.oid, t.visibility, true as is_member, 'team'::text as item_type,
           t.created_at
      from amux.teams t
     where exists (
         select 1
           from amux.actors a
           join related_users ru on ru.id = a.user_id
          where a.team_id = t.id
       )
  ), public_teams as (
    select t.id, t.name, t.slug, t.oid, t.visibility, false as is_member, 'team'::text as item_type,
           t.created_at
      from amux.teams t
     where t.oid in (select org_id from related_orgs)
       and t.visibility = 'public'
       and not exists (
         select 1
           from amux.actors a
           join related_users ru on ru.id = a.user_id
          where a.team_id = t.id
       )
  ), empty_orgs as (
    select null::uuid as id, null::text as name, null::text as slug, o.id as oid,
           'private'::text as visibility, true as is_member, 'org'::text as item_type,
           null::timestamptz as created_at
      from public.orgs o
      join related_orgs ro on ro.org_id = o.id
     where p_include_empty_orgs
       and not exists (select 1 from amux.teams t where t.oid = o.id)
  )
  select * from (
    select t.id as team_id, t.name as team_name, t.slug as team_slug, t.oid as org_id,
           o.name as org_name, t.visibility, t.is_member, t.item_type,
           t.created_at,
           (select count(*)::int
              from amux.actors a
             where a.team_id = t.id and a.actor_type = 'member') as member_count,
           (select a.display_name
              from amux.team_members tm
              join amux.actors a on a.id = tm.member_id
             where tm.team_id = t.id and tm.role = 'owner'
             order by a.created_at asc, a.id asc
             limit 1) as owner_name
      from (
        select * from member_teams
        union all
        select * from public_teams
      ) t
      join public.orgs o on o.id = t.oid
    union all
    select e.id, e.name, e.slug, e.oid, o.name, e.visibility, e.is_member, e.item_type,
           e.created_at, null::int, null::text
      from empty_orgs e
      join public.orgs o on o.id = e.oid
  ) picker_items
  order by org_name nulls last, item_type, team_name, created_at nulls last, team_id;
$function$;

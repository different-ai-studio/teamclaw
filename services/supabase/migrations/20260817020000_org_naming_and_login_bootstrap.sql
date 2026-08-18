-- CS-1: org 命名 + 团队命名 + 去掉匿名分支。
--
-- 病灶：ensure_personal_org 把每个自建 org 都叫 'Personal'（baseline），而
-- bootstrap_current_org_team 用 org 名当团队名 —— 于是所有自助注册用户的团队
-- 都会重名。线上今天更糟：FC 传 DEFAULT_ORG_ID 当兜底，Google 用户根本不自建
-- org，全部落进名为 "TeamClaw Public" 的共享 org，团队也就都叫这个名字。
--
-- 改法：org 名取自本人（nickname → OAuth full_name/name → 邮箱前缀 →
-- Adjective Animal 兜底），团队继续与 org 同名。团队命名规则本身**不变**，
-- 变的是「落到哪个 org」—— 那部分在 FC 侧（DEFAULT_ORG_ID 退出解析链）。
--
-- 兜底那一环不能省：bootstrap_current_org_team 对空 org 名直接 raise 23514，
-- 一个既无 nickname、无 OAuth 元数据、又无邮箱的账号会在注册最后一步炸掉。
--
-- 同时删掉匿名分支：匿名 / 快捷试用整个功能已下线，v_is_anonymous 那条随机名
-- 支路没有调用者了。守卫（join_public_team / claim_team_invite 里的匿名拒绝）
-- 刻意保留，零成本的纵深防御。

-- 调用者的人类可读名。nickname 优先，OAuth 元数据其次，邮箱前缀再次，
-- 最后才是确定性的 Adjective Animal（由 seed 推导，同一 seed 稳定）。
--
-- 刻意不接受客户端传入的 display name 作为来源：客户端的
-- resolveDefaultDisplayName 是「操作系统账户名优先」，统一装机的机器上会拿到
-- IT 管理员名。那个值继续只用于 owner actor 的显示名。
create or replace function amux.resolve_caller_display_name(p_seed uuid default null)
returns text
language plpgsql
stable
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_user       uuid := auth.uid();
  v_name       text;
  v_meta       jsonb;
  v_email      text;
  v_seed       uuid;
  v_adjectives text[] := array['Curious','Brave','Calm','Eager','Lively','Mellow','Nimble','Quick','Quiet','Sunny','Witty','Zesty','Bright','Daring','Gentle','Jolly','Keen','Plucky','Spry','Sparkling'];
  v_animals    text[] := array['Otter','Panda','Falcon','Fox','Heron','Lynx','Owl','Puffin','Quokka','Raven','Seal','Tapir','Viper','Walrus','Yak','Zebra','Badger','Cougar','Dolphin','Hare'];
begin
  if v_user is null then
    return null;
  end if;

  select nullif(btrim(u.nickname), '') into v_name
    from public.users u
   where u.id = v_user
   limit 1;
  if v_name is not null then
    return v_name;
  end if;

  select au.raw_user_meta_data, au.email into v_meta, v_email
    from auth.users au
   where au.id = v_user;

  v_name := nullif(btrim(coalesce(v_meta ->> 'full_name', v_meta ->> 'name')), '');
  if v_name is not null then
    return v_name;
  end if;

  v_name := nullif(btrim(split_part(coalesce(v_email, ''), '@', 1)), '');
  if v_name is not null then
    return v_name;
  end if;

  v_seed := coalesce(p_seed, v_user);
  return v_adjectives[((hashtextextended(v_seed::text, 11) % 20) + 20) % 20 + 1] || ' ' ||
         v_animals[((hashtextextended(v_seed::text, 29) % 20) + 20) % 20 + 1];
end;
$function$;

grant execute on function amux.resolve_caller_display_name(uuid) to authenticated, service_role;

-- org 名从硬编码 'Personal' 改成解析出来的本人名字。
-- 其余行为（含丢掉并发竞争时删掉自己刚建的 org、复用赢家的）原样保留。
create or replace function amux.ensure_personal_org()
returns uuid
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_user uuid := auth.uid();
  v_org  uuid;
  v_name text;
begin
  if v_user is null then
    raise exception 'ensure_personal_org requires an authenticated user' using errcode = '42501';
  end if;

  select org_id into v_org from public.users where id = v_user limit 1;
  if v_org is not null then
    return v_org;
  end if;

  v_name := coalesce(nullif(btrim(amux.resolve_caller_display_name()), ''), 'Personal');

  insert into public.orgs (name) values (v_name) returning id into v_org;
  begin
    insert into public.users (id, org_id, mobile) values (v_user, v_org, '');
  exception when unique_violation then
    -- lost a concurrent race: drop our org, reuse the winner's
    delete from public.orgs where id = v_org;
    select org_id into v_org from public.users where id = v_user limit 1;
  end;

  return v_org;
end;
$function$;

grant execute on function amux.ensure_personal_org() to authenticated, service_role;

-- 去掉匿名分支。团队名恒等于 org 名 —— 自助注册的人现在有了自己的、以本人
-- 命名的 org，所以这条规则产出的就是「evan chow」而不是共享租户名。
create or replace function amux.bootstrap_current_org_team(
  p_fallback_org uuid default null,
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
  v_org_name text;
begin
  if v_user_id is null then
    raise exception 'bootstrap_current_org_team requires an authenticated user' using errcode = '42501';
  end if;

  -- Serialize bootstrap per user; create_team itself checks first-team-only.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  if exists (select 1 from amux.actors where user_id = v_user_id) then
    raise exception 'bootstrap_current_org_team currently supports first-team onboarding only'
      using errcode = '23514';
  end if;

  v_org_id := coalesce(amux.current_org_id(), p_fallback_org);
  if v_org_id is null then
    raise exception 'current organization is required for team bootstrap' using errcode = '23514';
  end if;

  select name into v_org_name from public.orgs where id = v_org_id;
  if nullif(btrim(v_org_name), '') is null then
    raise exception 'current organization has no name' using errcode = '23514';
  end if;

  return query
    select c.team_id, c.team_name, c.team_slug, c.member_id, c.role, c.workspace_id, c.workspace_name
      from amux.create_team(
        p_name => v_org_name,
        p_display_name => p_display_name,
        p_oid => v_org_id
      ) c;
end;
$function$;

grant execute on function amux.bootstrap_current_org_team(uuid, text) to authenticated, service_role;

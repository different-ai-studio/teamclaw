-- CS-4: join_public_team 只允许加入自己 org 内的 public 团队。
--
-- 今天它只校验 visibility='public' 和非匿名，**不校验 org** —— "public" 实际
-- 等于「全网可加入」。这在过去无关紧要（全库只有一个 public 团队），但 CS-2
-- 之后每个 org 的默认团队都是 public，等于任何持有 team id 的账号都能加进
-- 别人 org 的默认团队。
--
-- 展示层（list_teams_for_picker 的 public_teams CTE）本来就按 org 过滤，接口层
-- 没有 —— 这里把两者对齐。
--
-- 顺带把新成员的显示名从写死的 'Member' 换成 resolve_caller_display_name：
-- 同一个人从 bootstrap 进来叫真名、从这条路进来叫 "Member" 是没有道理的。
--
-- 匿名守卫保留：匿名功能已下线，但这道守卫零成本，留作纵深防御。
-- p_default_org_id 参数保留在签名里（函数体从来没用过它），避免连带改动所有
-- 调用点；FC 侧已停止传值（CS-3）。
create or replace function amux.join_public_team(
  p_team_id uuid,
  p_default_org_id uuid default null
)
returns table(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_team amux.teams%rowtype;
  v_member_id uuid;
  v_workspace_id uuid;
  v_workspace_name text;
  v_nickname text;
  v_display_name text;
  v_is_anonymous boolean;
  v_caller_org uuid;
begin
  if v_user_id is null then
    raise exception 'join_public_team requires an authenticated user' using errcode = '42501';
  end if;
  select coalesce(is_anonymous, false) into v_is_anonymous from auth.users where id = v_user_id;
  if coalesce(v_is_anonymous, false) then
    raise exception 'anonymous users cannot join a team' using errcode = '42501';
  end if;
  select * into v_team from amux.teams where id = p_team_id;
  if not found then raise exception 'team not found' using errcode = 'P0002'; end if;
  if v_team.visibility is distinct from 'public' then
    raise exception 'team is not a joinable public team' using errcode = '42501';
  end if;

  -- 已经是成员就放行（幂等），否则必须同 org。
  select a.id into v_member_id from amux.actors a where a.user_id = v_user_id and a.team_id = p_team_id limit 1;
  if v_member_id is null then
    v_caller_org := amux.current_org_id();
    if v_team.oid is null or v_caller_org is null or v_team.oid is distinct from v_caller_org then
      raise exception 'team belongs to another organization' using errcode = '42501';
    end if;

    select nickname into v_nickname from public.users where id = v_user_id limit 1;
    v_member_id := gen_random_uuid();
    v_display_name := coalesce(
      nullif(btrim(v_nickname), ''),
      amux.resolve_caller_display_name(v_member_id)
    );
    insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
      values (v_member_id, p_team_id, 'member', v_user_id, v_display_name, now());
    insert into amux.members (id, status) values (v_member_id, 'active');
    insert into amux.team_members (team_id, member_id, role) values (p_team_id, v_member_id, 'member');
  end if;

  select w.id, w.name into v_workspace_id, v_workspace_name from amux.workspaces w
    where w.team_id = p_team_id order by w.created_at asc, w.id asc limit 1;
  return query select v_team.id, v_team.name, v_team.slug, v_member_id,
    case when exists (select 1 from amux.team_members tm where tm.team_id = p_team_id and tm.member_id = v_member_id and tm.role = 'owner') then 'owner' else 'member' end,
    v_workspace_id, v_workspace_name;
end;
$function$;

grant execute on function amux.join_public_team(uuid, uuid) to authenticated, service_role;

-- ============================================================================
-- 登录后多团队（跨 org）选择页：列出跨 org 的全部 team + 切换活跃 team。
-- 复用 claim_team_invite 的「换 org + 铸新 session」机制（见
-- 20260608060000_claim_team_invite_org_switch.sql:43-47, 65-84）。
-- ============================================================================

-- (1) 铸一个新的 GoTrue session + refresh_token（与 claim 的内联逻辑等价，抽出复用）。
--     返回 refresh_token；调用方负责拿它走 /auth/v1/token?grant_type=refresh_token
--     换新 access token —— 那次 refresh 时 amux_access_token_hook 会重新读
--     public.users.org_id 写入新 org_id（新 session 没有在途 org_id claim 可优先）。
create or replace function auth._mint_session(p_user_id uuid)
returns text
language plpgsql security definer
set search_path to 'auth', 'public', 'extensions'
as $function$
declare
  v_session uuid := gen_random_uuid();
  v_rt      text := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);
begin
  insert into auth.sessions (id, user_id, aal, created_at, updated_at)
    values (v_session, p_user_id, 'aal1', now(), now());
  insert into auth.refresh_tokens (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
    values (v_rt, p_user_id::text, v_session, false, '00000000-0000-0000-0000-000000000000', now(), now());
  return v_rt;
end;
$function$;

-- (2) 列出当前用户在「所有 org」下的 team —— security definer 绕过 teams_org_guard。
create or replace function amux.list_all_my_teams()
returns table(team_id uuid, team_name text, team_slug text, org_id uuid, org_name text)
language sql stable security definer
set search_path to 'amux', 'public', 'auth'
as $function$
  select t.id, t.name, t.slug, t.oid, o.name
    from amux.teams t
    left join public.orgs o on o.id = t.oid
   where exists (
     select 1 from amux.actors a
      where a.user_id = auth.uid() and a.team_id = t.id
   )
   order by o.name nulls last, t.created_at;
$function$;

-- (3) 切换活跃 team：校验成员 → 改 public.users.org_id 为该 team 的 oid → 铸新 session。
--     不做 personal-org GC（切换场景两个 org 都要保留，区别于 claim）。
create or replace function amux.switch_active_team(p_team_id uuid)
returns table(actor_id uuid, team_id uuid, refresh_token text)
language plpgsql security definer
set search_path to 'amux', 'public', 'auth', 'app'
as $function$
declare
  v_user_id  uuid := auth.uid();
  v_actor    uuid;
  v_team_org uuid;
  v_rt       text;
begin
  if v_user_id is null then
    raise exception 'switch requires authentication' using errcode = '42501';
  end if;

  -- 成员校验：当前用户在目标 team 必须有 actor，否则拒绝（非成员）。
  select a.id into v_actor
    from amux.actors a
   where a.user_id = v_user_id and a.team_id = p_team_id
   limit 1;
  if v_actor is null then
    raise exception 'not a member of this team' using errcode = '42501';
  end if;

  -- 换 org：把用户的活跃 org 设为该 team 的 org。
  select oid into v_team_org from amux.teams where id = p_team_id;
  if v_team_org is not null then
    -- 幂等 upsert（race-safe）：仲裁器须带 uq_users_auth_user_id 的 partial 谓词。
    insert into public.users (auth_user_id, org_id)
    values (v_user_id, v_team_org)
    on conflict (auth_user_id) where auth_user_id is not null do update
      set org_id = excluded.org_id, updated_at = now();
  end if;

  v_rt := auth._mint_session(v_user_id);
  update amux.actors set last_active_at = now(), updated_at = now() where id = v_actor;

  return query select v_actor, p_team_id, v_rt;
end;
$function$;

grant execute on function amux.list_all_my_teams() to authenticated;
grant execute on function amux.switch_active_team(uuid) to authenticated;

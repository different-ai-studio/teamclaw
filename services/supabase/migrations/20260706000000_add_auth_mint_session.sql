-- ============================================================================
-- 修复：amux.switch_active_team()（baseline:3202）调用 auth._mint_session(uuid)，
-- 但该函数定义在 squash 到 20260601000000_baseline.sql 时被丢掉（只剩在
-- _archive/squashed-20260624/20260611120000_login_multi_team_picker.sql）。
-- 结果：从 baseline 重建的库（beta/live）上加入/切换团队时报
-- 「function auth._mint_session(uuid) does not exist」。
-- 这里把定义前向补回（verbatim 自归档文件）。
-- ============================================================================

-- 铸一个新的 GoTrue session + refresh_token（与 claim 的内联逻辑等价，抽出复用）。
-- 返回 refresh_token；调用方负责拿它走 /auth/v1/token?grant_type=refresh_token
-- 换新 access token —— 那次 refresh 时 amux_access_token_hook 会重新读
-- public.users.org_id 写入新 org_id（新 session 没有在途 org_id claim 可优先）。
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

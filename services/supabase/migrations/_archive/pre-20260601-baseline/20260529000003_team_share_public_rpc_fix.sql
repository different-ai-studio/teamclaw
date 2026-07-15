-- 20260529000003_team_share_public_rpc_fix.sql
--
-- 20260528000002_team_share_mode.sql created enable_team_share and
-- update_team_litellm in the `app` schema. But the FC repository layer calls
-- them via PostgREST in the PUBLIC schema:
--   services/fc/lib/supabase-repo.mjs
--     supabase.rpc("enable_team_share", ...)
--     supabase.rpc("update_team_litellm", ...)
-- PostgREST RPC (no .schema()) only resolves functions in the exposed (public)
-- schema, so every call failed with PGRST202 "Could not find the function
-- public.enable_team_share(...) in the schema cache" -> opaque 500. This
-- mirrors public.set_team_sync_mode, which is (correctly) in public and uses
-- the same app.allow_sync_mode_switch GUC bypass.
--
-- Recreate both RPCs in public (identical bodies) and drop the unreachable
-- app-schema versions. The app.team_share_mode enum (param type) and the
-- `grant usage on type app.team_share_mode to service_role` from
-- 20260528000002 stay as-is.

begin;

create or replace function public.enable_team_share(
  p_team_id            uuid,
  p_mode               app.team_share_mode,
  p_git_remote_url     text default null,
  p_git_auth_kind      text default null,
  p_git_credential_ref text default null
) returns public.teams
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_team public.teams;
  v_sync_mode text;
begin
  if p_git_auth_kind is not null
     and p_git_auth_kind not in ('ssh_key', 'https_token') then
    raise exception 'git_auth_kind must be ssh_key or https_token'
      using errcode = '22023';
  end if;

  update public.teams
     set share_mode         = p_mode,
         share_enabled_at   = now(),
         git_remote_url     = p_git_remote_url,
         git_auth_kind      = p_git_auth_kind,
         git_credential_ref = p_git_credential_ref
   where id = p_team_id
     and share_mode is null
  returning * into v_team;

  if v_team.id is null then
    raise exception 'team % does not exist or share_mode is already locked', p_team_id
      using errcode = '23514';
  end if;

  v_sync_mode := case p_mode when 'oss' then 'oss' else 'git' end;

  perform set_config('app.allow_sync_mode_switch', 'on', true);

  insert into public.team_workspace_config (team_id, sync_mode)
       values (p_team_id, v_sync_mode)
  on conflict (team_id) do update
       set sync_mode = excluded.sync_mode;

  perform set_config('app.allow_sync_mode_switch', 'off', true);

  return v_team;
end
$$;

revoke all on function public.enable_team_share(uuid, app.team_share_mode, text, text, text) from public;
grant execute on function public.enable_team_share(uuid, app.team_share_mode, text, text, text) to service_role;

create or replace function public.update_team_litellm(
  p_team_id             uuid,
  p_litellm_team_id     text,
  p_ai_gateway_endpoint text
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform set_config('app.allow_sync_mode_switch', 'on', true);

  insert into public.team_workspace_config (team_id, litellm_team_id, ai_gateway_endpoint)
       values (p_team_id, p_litellm_team_id, p_ai_gateway_endpoint)
  on conflict (team_id) do update
       set litellm_team_id     = excluded.litellm_team_id,
           ai_gateway_endpoint = excluded.ai_gateway_endpoint;

  perform set_config('app.allow_sync_mode_switch', 'off', true);
end
$$;

revoke all on function public.update_team_litellm(uuid, text, text) from public;
grant execute on function public.update_team_litellm(uuid, text, text) to service_role;

-- Remove the unreachable app-schema versions created by 20260528000002.
drop function if exists app.enable_team_share(uuid, app.team_share_mode, text, text, text);
drop function if exists app.update_team_litellm(uuid, text, text);

commit;

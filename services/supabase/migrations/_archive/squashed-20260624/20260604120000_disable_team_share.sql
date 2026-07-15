-- Mutable team share mode: owner-controlled switch/clear via FC (no once-only lock).
-- Disconnect uses public.disable_team_share; re-enable uses public.enable_team_share.

begin;

drop trigger if exists guard_team_share_mode on public.teams;

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
  v_git_remote_url text;
  v_git_auth_kind text;
  v_git_credential_ref text;
begin
  if p_git_auth_kind is not null
     and p_git_auth_kind not in ('ssh_key', 'https_token') then
    raise exception 'git_auth_kind must be ssh_key or https_token'
      using errcode = '22023';
  end if;

  if p_mode = 'oss'::app.team_share_mode then
    v_git_remote_url := null;
    v_git_auth_kind := null;
    v_git_credential_ref := null;
  else
    v_git_remote_url := p_git_remote_url;
    v_git_auth_kind := p_git_auth_kind;
    v_git_credential_ref := p_git_credential_ref;
  end if;

  update public.teams
     set share_mode         = p_mode,
         share_enabled_at   = now(),
         git_remote_url     = v_git_remote_url,
         git_auth_kind      = v_git_auth_kind,
         git_credential_ref = v_git_credential_ref
   where id = p_team_id
  returning * into v_team;

  if v_team.id is null then
    raise exception 'team % does not exist', p_team_id
      using errcode = '23503';
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

create or replace function public.disable_team_share(p_team_id uuid)
returns public.teams
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_team public.teams;
begin
  update public.teams
     set share_mode         = null,
         share_enabled_at   = null,
         git_remote_url     = null,
         git_auth_kind      = null,
         git_credential_ref = null
   where id = p_team_id
  returning * into v_team;

  if v_team.id is null then
    select * into v_team from public.teams where id = p_team_id;
    if v_team.id is null then
      raise exception 'team % does not exist', p_team_id
        using errcode = '23503';
    end if;
  end if;

  perform set_config('app.allow_sync_mode_switch', 'on', true);

  update public.team_workspace_config
     set sync_mode = null
   where team_id = p_team_id;

  perform set_config('app.allow_sync_mode_switch', 'off', true);

  return v_team;
end
$$;

revoke all on function public.enable_team_share(uuid, app.team_share_mode, text, text, text) from public, anon, authenticated;
grant execute on function public.enable_team_share(uuid, app.team_share_mode, text, text, text) to service_role;

revoke all on function public.disable_team_share(uuid) from public, anon, authenticated;
grant execute on function public.disable_team_share(uuid) to service_role;

commit;

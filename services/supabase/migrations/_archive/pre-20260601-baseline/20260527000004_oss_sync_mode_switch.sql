-- 20260527000004_oss_sync_mode_switch.sql
--
-- Allow team owners to hard-switch sync_mode after team creation.
-- Spec §2.6 originally treated sync_mode as immutable; user overrode this:
-- switching does NOT migrate data (existing blobs/files are abandoned in place).
-- The guard trigger in 20260527000002_oss_sync_schema.sql still blocks raw
-- authenticated writes; this RPC is the sole allowed mutation path.
--
-- Strategy: rather than trying to detect SECURITY DEFINER via session_user
-- (which is 'postgres' in both local dev and CI), the set_team_sync_mode RPC
-- sets a LOCAL GUC flag before performing the UPDATE. The trigger reads this
-- flag to allow the write. SET LOCAL resets automatically at sub-transaction
-- boundary so the flag cannot leak between calls.

begin;

-- ===========================================================================
-- 1. Re-create the guard trigger — adds custom GUC bypass
-- ===========================================================================
create or replace function app.guard_team_workspace_sync_fields()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  -- Service-role callers (direct DB writes, migrations, FC) are always allowed.
  if current_setting('role', true) = 'service_role' then
    return new;
  end if;

  -- Allow when the owner-only RPC (set_team_sync_mode) signals it's running.
  -- The RPC sets this LOCAL GUC after performing its own ownership check.
  if current_setting('app.allow_sync_mode_switch', true) = 'on' then
    return new;
  end if;

  if new.sync_mode is distinct from old.sync_mode then
    raise exception 'team_workspace_config.sync_mode is service-role only (use public.set_team_sync_mode)'
      using errcode = '42501';
  end if;
  if new.oss_change_seq is distinct from old.oss_change_seq then
    raise exception 'team_workspace_config.oss_change_seq is service-role only'
      using errcode = '42501';
  end if;
  if new.litellm_team_id is distinct from old.litellm_team_id then
    raise exception 'team_workspace_config.litellm_team_id is service-role only'
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- ===========================================================================
-- 2. Owner-only sync_mode switch RPC
-- ===========================================================================
create or replace function public.set_team_sync_mode(
  p_team_id uuid,
  p_mode text
) returns text
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_actor_id uuid;
  v_role text;
begin
  if p_mode not in ('git', 'oss') then
    raise exception 'invalid sync_mode: %', p_mode using errcode = '22023';
  end if;

  v_actor_id := app.current_actor_id_for_team(p_team_id);
  if v_actor_id is null then
    raise exception 'caller is not a member of team %', p_team_id
      using errcode = '42501';
  end if;

  select tm.role into v_role
    from public.team_members tm
   where tm.team_id = p_team_id and tm.member_id = v_actor_id;

  if v_role <> 'owner' then
    raise exception 'only team owners may switch sync_mode (caller role=%)', coalesce(v_role, 'null')
      using errcode = '42501';
  end if;

  -- Signal the guard trigger that this update is coming from the owner-only RPC.
  -- SET LOCAL auto-reverts after this sub-transaction / function call.
  perform set_config('app.allow_sync_mode_switch', 'on', true);

  update public.team_workspace_config
     set sync_mode = p_mode
   where team_id = p_team_id;

  -- Clear the flag immediately after the update (belt-and-suspenders).
  perform set_config('app.allow_sync_mode_switch', 'off', true);

  return p_mode;
end;
$$;

revoke all on function public.set_team_sync_mode(uuid, text) from public;
grant execute on function public.set_team_sync_mode(uuid, text) to authenticated;

-- ===========================================================================
-- 3. Read helper for join auto-detect
-- ===========================================================================
-- Avoids exposing the whole team_workspace_config row to authenticated callers.
-- Performs no ownership/membership check beyond the caller holding a valid JWT.
create or replace function public.get_team_sync_mode(p_team_id uuid)
returns text
language sql security definer set search_path = public, auth
stable as $$
  select sync_mode from public.team_workspace_config where team_id = p_team_id
$$;

revoke all on function public.get_team_sync_mode(uuid) from public;
grant execute on function public.get_team_sync_mode(uuid) to authenticated;

commit;

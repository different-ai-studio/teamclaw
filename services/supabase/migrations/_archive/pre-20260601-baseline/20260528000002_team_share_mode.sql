-- 20260528000002_team_share_mode.sql
--
-- Split "create team" from "enable team share". After this migration:
--   * Creating a team (public.create_team — see PR #212 migration
--     20260528000001_create_team_with_workspace_config.sql) only writes a
--     teams row and a bare team_workspace_config row. sync_mode is NULL until
--     the owner explicitly opens team-share via app.enable_team_share().
--   * public.teams gains share_mode + share_enabled_at + custom-git fields.
--   * share_mode is once-only: NULL -> value is allowed, value -> different
--     value (or NULL) is blocked by the app.guard_team_share_mode trigger.
--   * app.enable_team_share is the sole intended writer of share_mode; it
--     also mirrors the choice into team_workspace_config.sync_mode.
--
-- See docs/superpowers/plans/2026-05-28-team-share-onboarding-refactor.md
-- (Task 1) for the broader plan.

begin;

-- ===========================================================================
-- 1. share_mode enum (idempotent)
-- ===========================================================================
do $$ begin
  create type app.team_share_mode as enum ('oss', 'managed_git', 'custom_git');
exception when duplicate_object then null; end $$;

-- ===========================================================================
-- 2. Add columns to public.teams
-- ===========================================================================
alter table public.teams
  add column if not exists share_mode         app.team_share_mode,
  add column if not exists share_enabled_at   timestamptz,
  add column if not exists git_remote_url     text,
  add column if not exists git_auth_kind      text,
  add column if not exists git_credential_ref text;

-- Constrain git_auth_kind values (NULL still allowed) — separate from
-- add column so re-runs don't try to create the same constraint twice.
do $$ begin
  alter table public.teams
    add constraint teams_git_auth_kind_check
    check (git_auth_kind is null or git_auth_kind in ('ssh_key', 'https_token'));
exception when duplicate_object then null; end $$;

-- ===========================================================================
-- 3. Once-only lock trigger for share_mode
-- ===========================================================================
-- Reject any UPDATE that changes share_mode away from a non-null value.
-- INSERTs are unaffected (no OLD row). The trigger guards both direct table
-- writes and authenticated UPDATEs; app.enable_team_share works fine because
-- it only updates rows WHERE share_mode IS NULL (so OLD.share_mode IS NULL
-- and the guard short-circuits).
create or replace function app.guard_team_share_mode()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if old.share_mode is not null
     and new.share_mode is distinct from old.share_mode then
    raise exception 'teams.share_mode is locked once enabled (was %, attempted %)',
      old.share_mode, new.share_mode
      using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists guard_team_share_mode on public.teams;
create trigger guard_team_share_mode
  before update on public.teams
  for each row execute function app.guard_team_share_mode();

-- ===========================================================================
-- 4. team_workspace_config.sync_mode: drop DEFAULT, drop NOT NULL
-- ===========================================================================
-- Originally added by 20260527000002 as `not null default 'git'`, later
-- 20260527000005 flipped the default to 'oss'. Both PR #212's create_team
-- and the AuthGate auto-create path implicitly seeded sync_mode. After this
-- migration, sync_mode starts NULL ("share not opened yet") and is only set
-- when app.enable_team_share runs. The CHECK constraint (sync_mode in
-- ('git','oss')) is unaffected; CHECK constraints are satisfied by NULL.
alter table public.team_workspace_config
  alter column sync_mode drop default;

alter table public.team_workspace_config
  alter column sync_mode drop not null;

-- ===========================================================================
-- 5. Rewrite public.create_team (introduced in PR #212) to NOT seed sync_mode
-- ===========================================================================
-- Same signature as 20260528000001 so /v1/teams handler and FC callers do not
-- need to change. The only behaviour delta is the INSERT into
-- team_workspace_config: we omit sync_mode so it stays NULL until
-- app.enable_team_share fills it in.
create or replace function public.create_team(
  p_name text,
  p_slug text default null,
  p_litellm_team_id text default null,
  p_ai_gateway_endpoint text default null
)
returns table (team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_user_id     uuid := auth.uid();
  v_member_id   uuid;
  v_team_id     uuid;
  v_workspace_id uuid;
  v_slug_base   text;
  v_slug        text;
  v_suffix      integer := 1;
begin
  if v_user_id is null then
    raise exception 'create_team requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'team name is required'
      using errcode = '22023';
  end if;

  if exists (select 1 from public.actors where user_id = v_user_id) then
    raise exception 'create_team currently supports first-team onboarding only'
      using errcode = '23514',
            detail = 'Existing actors already have a team-scoped identity.';
  end if;

  v_slug_base := lower(
    regexp_replace(
      coalesce(nullif(btrim(p_slug), ''), btrim(p_name)),
      '[^a-zA-Z0-9]+', '-', 'g'
    )
  );
  v_slug_base := trim(both '-' from v_slug_base);
  if v_slug_base = '' then v_slug_base := 'team'; end if;

  v_slug := v_slug_base;
  while exists (select 1 from public.teams t where t.slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := format('%s-%s', v_slug_base, v_suffix);
  end loop;

  insert into public.teams (name, slug)
  values (btrim(p_name), v_slug)
  returning id into v_team_id;

  v_member_id := gen_random_uuid();

  insert into public.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
  values (v_member_id, v_team_id, 'member', v_user_id, 'You', now());

  insert into public.members (id, status)
  values (v_member_id, 'active');

  insert into public.team_members (team_id, member_id, role)
  values (v_team_id, v_member_id, 'owner');

  insert into public.workspaces (team_id, created_by_member_id, name, path)
  values (v_team_id, v_member_id, 'General', null)
  returning id into v_workspace_id;

  -- Seed team_workspace_config WITHOUT sync_mode. sync_mode starts NULL and
  -- transitions to 'oss' or 'git' when the owner calls app.enable_team_share.
  -- litellm_team_id / ai_gateway_endpoint can still be set here (PR #212).
  insert into public.team_workspace_config (team_id, litellm_team_id, ai_gateway_endpoint)
  values (v_team_id, p_litellm_team_id, p_ai_gateway_endpoint);

  return query
  select v_team_id, btrim(p_name), v_slug,
         v_member_id, 'owner'::text,
         v_workspace_id, 'General'::text;
end;
$$;

revoke all on function public.create_team(text, text, text, text) from public;
grant execute on function public.create_team(text, text, text, text) to authenticated;

-- ===========================================================================
-- 6. app.enable_team_share — atomic, idempotent-at-the-NULL-edge writer
-- ===========================================================================
-- Atomically asserts share_mode IS NULL and writes the chosen mode + custom-
-- git fields. Mirrors the choice into team_workspace_config.sync_mode so the
-- sync engine (oss / git) keeps reading from team_workspace_config as today.
-- Returns the updated public.teams row. Raises if the team does not exist or
-- already has share_mode set (locked).
create or replace function app.enable_team_share(
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

  -- Mirror sync_mode into team_workspace_config. The 20260527000004 guard on
  -- team_workspace_config blocks sync_mode changes unless current role is
  -- service_role or the app.allow_sync_mode_switch GUC is on. Since this RPC
  -- is SECURITY DEFINER but `current_setting('role', true)` reflects the
  -- caller's role (e.g. 'authenticated'), we flip the GUC explicitly to
  -- authorise the update, exactly like public.set_team_sync_mode does.
  perform set_config('app.allow_sync_mode_switch', 'on', true);

  insert into public.team_workspace_config (team_id, sync_mode)
       values (p_team_id, v_sync_mode)
  on conflict (team_id) do update
       set sync_mode = excluded.sync_mode;

  perform set_config('app.allow_sync_mode_switch', 'off', true);

  return v_team;
end
$$;

-- service_role needs USAGE on the app schema to resolve the function name and
-- the enum type. The app schema is currently postgres-only; grant the minimum
-- needed for this RPC + enum type lookup.
grant usage on schema app to service_role;
grant usage on type app.team_share_mode to service_role;

revoke all on function app.enable_team_share(uuid, app.team_share_mode, text, text, text) from public;
grant execute on function app.enable_team_share(uuid, app.team_share_mode, text, text, text) to service_role;

-- ===========================================================================
-- 7. app.update_team_litellm — owner-only LiteLLM credential writeback
-- ===========================================================================
-- team_workspace_config.litellm_team_id is guarded by
-- app.guard_team_workspace_sync_fields() (see 20260527000004) which blocks
-- direct UPDATEs from authenticated callers. The FC `setupLiteLlm(teamId)`
-- repo method needs to persist the LiteLLM team id + AI gateway endpoint after
-- calling out to LiteLLM. Reuse the same `app.allow_sync_mode_switch` GUC
-- bypass that public.set_team_sync_mode uses, since the guard accepts that
-- flag for all sync-related field updates.
--
-- We do NOT re-check ownership here because the FC layer is already trusted
-- (caller's bearer is forwarded to PostgREST and the route handler validates
-- the caller is a team owner before invoking this). If/when the RPC is
-- exposed to authenticated callers directly, add an ownership check.
create or replace function app.update_team_litellm(
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

revoke all on function app.update_team_litellm(uuid, text, text) from public;
grant execute on function app.update_team_litellm(uuid, text, text) to service_role;

commit;

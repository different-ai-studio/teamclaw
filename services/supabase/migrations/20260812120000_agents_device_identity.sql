-- Device-scoped agent identity: one agent actor per (team, device).
--
-- The desktop no longer asks the user to create an agent, bind an existing one,
-- or reset a machine bound to another team. It calls ensure_agent_for_device,
-- which returns the agent this machine already has in this team, or creates one.
-- Three parts:
--
--   1. agents.team_id + a partial unique index, so "one agent per (team,
--      device)" is a database fact rather than a client convention. The client
--      path that used to serialize this — a human clicking through a wizard —
--      is gone, so two cold starts can now race.
--
--   2. ensure_agent_for_device(): advisory-locked lookup-or-create. It creates
--      the actor + agents row itself (so the unique index is enforced while the
--      lock is held) and delegates the one-shot invite to create_team_invite,
--      whose owner check we deliberately keep depending on.
--
--   3. claim_team_invite_legacy(): stop forcing visibility='team' when
--      re-binding a device-scoped agent, or every credential rotation would
--      silently publish a personal machine to the whole team.
--
-- Nothing here backfills or migrates existing rows. device_id has never been
-- written by any live code path (the column dates from the MQTT-routing era and
-- claim_team_invite's INSERT never listed it), so every existing agent has
-- device_id IS NULL and the partial index simply does not cover it.

-- ── 1. Schema ────────────────────────────────────────────────────────────────

alter table amux.agents
  add column if not exists team_id uuid references amux.teams(id) on delete cascade;

comment on column amux.agents.team_id is
  'Denormalized from actors.team_id, written only for device-scoped agents so that (team_id, device_id) can carry a unique index (agents_team_device_uk). An actor never changes team, so this never needs updating. NULL on every agent created before device-scoped binding.';

comment on column amux.agents.device_id is
  'The machine this agent runs on: the daemon''s ~/.amuxd/device-id. At most one active agent per (team_id, device_id). Originally the MQTT device identifier for iOS publish routing; nothing wrote it between the iroh/MQTT removal and device-scoped binding.';

create unique index if not exists agents_team_device_uk
  on amux.agents (team_id, device_id)
  where device_id is not null;

-- ── 2a. find_agent_for_device (lookup, no side effects) ──────────────────────
--
-- The client asks this first: a machine that already has an agent here is bound
-- silently, and only a machine that does not gets to interrupt the user for a
-- name. Owner-scoped like the ensure path, so one member cannot probe whether
-- another member's machine is in the team.

create or replace function amux.find_agent_for_device(
  p_team_id uuid,
  p_device_id text
) returns table(agent_id uuid, display_name text)
  language sql
  stable
  security definer
  set search_path to 'amux', 'public', 'auth'
as $function$
  select ag.id, a.display_name
    from amux.agents ag
    join amux.actors a on a.id = ag.id
   where a.team_id = p_team_id
     and ag.device_id = nullif(btrim(p_device_id), '')
     and ag.owner_member_id = amux.current_actor_id_for_team(p_team_id)
     and ag.status = 'active'
   limit 1
$function$;

comment on function amux.find_agent_for_device(uuid, text) is
  'This machine''s agent in this team, if the caller already owns one. Read-only companion to ensure_agent_for_device: the client uses it to decide whether to ask the user to name a new agent.';

grant execute on function amux.find_agent_for_device(uuid, text)
  to authenticated, service_role;

-- ── 2b. ensure_agent_for_device ──────────────────────────────────────────────

create or replace function amux.ensure_agent_for_device(
  p_team_id uuid,
  p_device_id text,
  p_display_name text
) returns table(agent_id uuid, token text, expires_at timestamp with time zone, created boolean)
  language plpgsql
  security definer
  set search_path to 'amux', 'public', 'auth', 'app'
as $function$
declare
  v_caller  uuid := amux.current_actor_id_for_team(p_team_id);
  v_device  text := nullif(btrim(p_device_id), '');
  v_name    text := nullif(btrim(p_display_name), '');
  v_agent   uuid;
  v_created boolean := false;
  v_invite  record;
begin
  if v_caller is null then
    raise exception 'ensure_agent_for_device requires team membership'
      using errcode = '42501';
  end if;
  if v_device is null then
    raise exception 'p_device_id is required' using errcode = '22023';
  end if;
  if v_name is null then
    raise exception 'p_display_name is required' using errcode = '22023';
  end if;

  -- Serialize concurrent callers for the same machine. Two cold starts (or two
  -- windows of the same app) would otherwise both find nothing and both create
  -- an agent; the unique index would reject the loser, but only after it had
  -- minted an invite and rotated the daemon's credentials onto it.
  perform pg_advisory_xact_lock(hashtext(p_team_id::text || ':' || v_device)::bigint);

  -- An agent for this device owned by somebody else counts as absent: a machine
  -- two accounts share gets one agent each, and neither silently takes over the
  -- other's. create_team_invite would refuse the re-invite anyway (owner check),
  -- so treating it as absent turns a hard 42501 into a second agent.
  select ag.id into v_agent
    from amux.agents ag
    join amux.actors a on a.id = ag.id
   where a.team_id = p_team_id
     and ag.device_id = v_device
     and ag.owner_member_id = v_caller
     and ag.status = 'active';

  if v_agent is null then
    insert into amux.actors (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
    values (p_team_id, 'agent', null, v_caller, v_name, null)
    returning id into v_agent;

    -- visibility is deliberately not passed: the column default ('personal') is
    -- the wanted default now that nothing asks the user. Publishing the machine
    -- to the team is an explicit later action (PATCH /v1/agents/{id}).
    insert into amux.agents (id, owner_member_id, status, device_id, team_id)
    values (v_agent, v_caller, 'active', v_device, p_team_id);

    insert into amux.agent_member_access (agent_id, member_id, permission_level, granted_by_member_id)
    values (v_agent, v_caller, 'admin', v_caller)
    on conflict (agent_id, member_id) do update
      set permission_level = 'admin', updated_at = now();

    v_created := true;
  end if;
  -- p_display_name is create-only on purpose. The client passes a name the user
  -- typed when the machine was first bound; re-applying it on every rebind would
  -- overwrite any later rename (and the client's fallback is the hostname, so a
  -- renamed robot would silently revert on the next launch).

  select * into v_invite from amux.create_team_invite(
    p_team_id         => p_team_id,
    p_kind            => 'agent',
    p_display_name    => v_name,
    p_team_role       => null,
    p_agent_kind      => 'claude',
    -- Claimed immediately by `amuxd init`; a tight window avoids leaving live
    -- agent invites behind when init fails.
    p_ttl_seconds     => 600,
    p_target_actor_id => v_agent
  );

  return query select v_agent, v_invite.token, v_invite.expires_at, v_created;
end;
$function$;

comment on function amux.ensure_agent_for_device(uuid, text, text) is
  'Idempotent per (team, device): returns this machine''s agent in this team, creating it (visibility personal) if absent, plus a one-shot invite for the daemon to claim. An agent owned by another account counts as absent.';

grant execute on function amux.ensure_agent_for_device(uuid, text, text)
  to authenticated, service_role;

-- ── 3. claim_team_invite_legacy: preserve a device agent's visibility ────────
--
-- Reproduced from its live definition (20260811110000_remove_member_reinvite)
-- with exactly one line changed, marked below.

CREATE OR REPLACE FUNCTION amux.claim_team_invite_legacy(p_token text)
 RETURNS TABLE(actor_id uuid, team_id uuid, actor_type text, display_name text, refresh_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'amux', 'public', 'auth', 'extensions'
AS $function$
declare
  v_invite      amux.team_invites%rowtype;
  v_user_id     uuid;
  v_actor       uuid;
  v_email       text;
  v_session     uuid;
  v_rt          text := null;
  v_old_user    uuid;
  v_target_anon boolean;
  v_team_org    uuid;   -- invite team's org (S3-FC.3)
  v_old_org     uuid;   -- claimer's previous org (member path)
begin
  select * into v_invite from amux.team_invites where token = p_token for update;
  if not found then raise exception 'invite not found' using errcode = '23503'; end if;
  if v_invite.consumed_at is not null then raise exception 'invite already consumed' using errcode = '23514'; end if;
  if v_invite.status = 'declined' then raise exception 'invite was declined' using errcode = '23514'; end if;
  if v_invite.status = 'expired' then raise exception 'invite superseded' using errcode = '23514'; end if;
  if v_invite.expires_at < now() then raise exception 'invite expired' using errcode = '23514'; end if;

  -- Resolved once for both branches: members get public.users.org_id switched,
  -- agents get the claim baked into raw_app_meta_data.
  select oid into v_team_org from amux.teams where id = v_invite.team_id;

  if v_invite.kind = 'member' then
    if v_invite.target_actor_id is not null then
      -- Unconsumed tokens minted before the removal still carry a target. They
      -- are refused rather than degraded into a self-join: the token was issued
      -- to hand back somebody else's credentials, not to add the caller.
      raise exception 'member re-invite is no longer supported' using errcode = '22023';
    else
      v_user_id := auth.uid();
      if v_user_id is null then raise exception 'member claim requires authentication' using errcode = '42501'; end if;
      if exists (select 1 from amux.actors act where act.team_id = v_invite.team_id and act.user_id = v_user_id) then
        raise exception 'already a member of this team' using errcode = '23505';
      end if;

      insert into amux.actors (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values (v_invite.team_id, 'member', v_user_id, v_invite.invited_by_actor_id, v_invite.display_name, now())
      returning id into v_actor;
      insert into amux.members (id, status) values (v_actor, 'active');
      insert into amux.team_members (team_id, member_id, role) values (v_invite.team_id, v_actor, v_invite.team_role);
    end if;

    -- S3-FC.3: strict single-org — claimer's org becomes the invite team's org.
    if v_team_org is not null and v_user_id is not null then
      select org_id into v_old_org from public.users where id = v_user_id;
      if v_old_org is null then
        insert into public.users (id, org_id, mobile) values (v_user_id, v_team_org, '');
      else
        update public.users set org_id = v_team_org, updated_at = now() where id = v_user_id;
      end if;
      -- best-effort GC of an abandoned one-person (personal) old org; never fail the claim
      begin
        if v_old_org is not null and v_old_org <> v_team_org
           and not exists (select 1 from public.users where org_id = v_old_org) then
          delete from amux.teams where oid = v_old_org;   -- cascades actors/members/sessions/...
          delete from public.orgs where id = v_old_org;
        end if;
      exception when others then
        null;  -- leave the orphan; reassignment already succeeded
      end;
    end if;
  else
    v_user_id := gen_random_uuid();
    v_email   := format('daemon.%s@amuxd.run', v_user_id);
    v_session := gen_random_uuid();
    v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);
    -- Stamp the team's org into app_metadata so daemon access tokens pass
    -- teams_org_guard (current_org_id() reads the JWT claim first; daemon
    -- users have no public.users fallback row).
    insert into auth.users (id, email, email_confirmed_at, encrypted_password, confirmation_token, recovery_token,
      email_change_token_new, email_change, raw_app_meta_data, aud, role, created_at, updated_at, instance_id)
    values (v_user_id, v_email, now(), '', '', '', '', '',
      case when v_team_org is not null then jsonb_build_object('org_id', v_team_org) else '{}'::jsonb end,
      'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
    insert into auth.sessions (id, user_id, aal, created_at, updated_at) values (v_session, v_user_id, 'aal1', now(), now());
    insert into auth.refresh_tokens (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
      values (v_rt, v_user_id::text, v_session, false, '00000000-0000-0000-0000-000000000000', now(), now());

    -- Also give the daemon account a public.users fallback row with the team's
    -- org, so org resolvers that query public.users by id directly (without the
    -- JWT app_metadata.org_id claim) can resolve org_id instead of erroring.
    if v_team_org is not null then
      insert into public.users (id, org_id, mobile) values (v_user_id, v_team_org, '')
      on conflict (id) do update set org_id = excluded.org_id, updated_at = now();
    end if;

    if v_invite.target_actor_id is not null then
      select user_id into v_old_user from amux.actors where id = v_invite.target_actor_id;
      update amux.actors set user_id = v_user_id, invited_by_actor_id = v_invite.invited_by_actor_id,
             last_active_at = null, updated_at = now() where id = v_invite.target_actor_id;
      v_actor := v_invite.target_actor_id;
      -- CHANGED: a device-scoped agent keeps whatever visibility it has. Every
      -- credential rotation (team switch, expired refresh token) lands here, and
      -- forcing 'team' turned each one into a silent publish of the machine.
      -- Agents with no device_id keep the historical behaviour.
      update amux.agents
         set owner_member_id = v_invite.invited_by_actor_id,
             visibility = case when device_id is not null then visibility else 'team' end,
             updated_at = now()
       where id = v_actor;
      if v_old_user is not null then delete from auth.users where id = v_old_user; end if;
    else
      insert into amux.actors (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values (v_invite.team_id, 'agent', v_user_id, v_invite.invited_by_actor_id, v_invite.display_name, null)
      returning id into v_actor;
      insert into amux.agents (id, owner_member_id, visibility, status) values (v_actor, v_invite.invited_by_actor_id, 'team', 'active');
    end if;

    insert into amux.agent_member_access (agent_id, member_id, permission_level, granted_by_member_id)
    values (v_actor, v_invite.invited_by_actor_id, 'admin', v_invite.invited_by_actor_id)
    on conflict (agent_id, member_id) do update
      set permission_level = 'admin', granted_by_member_id = excluded.granted_by_member_id, updated_at = now();
  end if;

  update amux.team_invites set consumed_at = now(), consumed_by_actor_id = v_actor,
         status = 'accepted', updated_at = now() where id = v_invite.id;

  return query select v_actor, v_invite.team_id, v_invite.kind::text, v_invite.display_name, v_rt;
end;
$function$;

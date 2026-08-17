-- Stop the invite-claim path from deleting rows in public.orgs.
--
-- amux.claim_team_invite_legacy implements "strict single-org" (S3-FC.3): when a
-- member claims an invite, their public.users.org_id is switched to the invite
-- team's org. It then garbage-collects the org they left, if that org has no
-- users remaining:
--
--     delete from amux.teams where oid = v_old_org;   -- ours
--     delete from public.orgs  where id = v_old_org;  -- NOT ours
--
-- The second statement is the problem. Both public tables are explicitly
-- foreign, per their own baseline comments:
--
--   public.orgs  — 'Mirror of saas-mono public.orgs (canonical tenant).
--                   saas-mono-owned on the merged instance.'
--   public.users — 'SUBSET mirror of saas-mono public.users … saas-mono-owned
--                   on merge'
--
-- On a merged instance that ownership is not theoretical. There, public.orgs is
-- the other product's tenant table, and 185 foreign keys point at it — 31 of
-- them ON DELETE CASCADE (routes, route_plans, route_setters, staffs, roles,
-- permissions, roles_users, org_units, store_areas, tasks/task_comments/
-- task_attachments, marketing_*, wechat_accounts, certification_definitions, …).
-- Accepting a team invite is not an operation that should be able to reach any
-- of that. "The last user left this tenant" is a judgement only the product that
-- owns the tenant table can make; we cannot see the rest of its data and have no
-- business inferring abandonment from the one column we mirror.
--
-- Note what this does NOT change: the amux.teams deletion stays. Collecting our
-- own teams for an org nobody is left in is squarely ours to do, and on a
-- TeamClu-only instance (where public.orgs has just two referents, amux.teams
-- and public.users) that was always the substantive half of the GC.
--
-- Two consequences worth stating plainly:
--
--   1. A TeamClu-only instance now accumulates user-less rows in public.orgs
--      instead of clearing them. That is inert: every reader reaches orgs
--      through the caller's own public.users row (list_teams_for_picker's
--      related_orgs, bootstrap_current_org_team), so an org with no users is
--      reachable by nobody and never appears in a picker.
--
--   2. On a merged instance the amux.teams deletion begins to take effect where
--      it previously did not. The pair ran inside one BEGIN…EXCEPTION
--      subtransaction, and there the orgs delete always raised — every org
--      carries audit_logs rows behind a NOT DEFERRABLE no-action FK, and the
--      orgs audit trigger writes one more on the way out — so the swallowed
--      exception rolled the amux.teams delete back along with it. Removing the
--      statement that always failed is what lets the statement that should
--      always have run actually commit.
--
-- Carried forward from 20260812120000_agents_device_identity.sql. One statement
-- is gone; the only other edits are two comments (this GC block's, and a stale
-- "CHANGED:" prefix that was written relative to that migration's own diff).

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
      -- best-effort GC of OUR teams under the abandoned old org; never fail the
      -- claim. public.orgs is deliberately left alone — see the header: that row
      -- belongs to saas-mono, and on a merged instance deleting it cascades into
      -- another product's data.
      begin
        if v_old_org is not null and v_old_org <> v_team_org
           and not exists (select 1 from public.users where org_id = v_old_org) then
          delete from amux.teams where oid = v_old_org;   -- cascades actors/members/sessions/...
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
      -- A device-scoped agent keeps whatever visibility it has. Every credential
      -- rotation (team switch, expired refresh token) lands here, and forcing
      -- 'team' turned each one into a silent publish of the machine. Agents with
      -- no device_id keep the historical behaviour.
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

comment on function amux.claim_team_invite_legacy(text) is
  'Consumes an invite token. Member claims move the claimer onto the invite team''s org (strict single-org) and collect any amux.teams left under the org they vacated. public.orgs and its rows are never deleted here — that table is saas-mono-owned.';

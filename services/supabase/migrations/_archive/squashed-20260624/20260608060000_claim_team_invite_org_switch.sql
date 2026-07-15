-- ============================================================================
-- Stage 3-FC.3: claim_team_invite switches the claimer's org (strict single-org)
-- (spec: docs/specs/2026-06-08-teamclaw-saas-mono-integration.md §8)
--
-- ⚠️ APPLY WITH / AFTER Stage 2 (references amux). Supersedes the S2-rewritten
--    claim_team_invite, adding an org-switch block to the member paths:
--   - reassign the claimer's public.users.org_id to the invite team's oid
--     (so teams_org_guard passes for the newly joined team), and
--   - best-effort GC of an abandoned one-person (personal) old org. The GC
--     never fails the claim (reassignment is the only hard requirement).
-- Daemon/agent path (kind <> 'member') is unchanged — those mint their own
-- in-db user and have no personal org.
-- ============================================================================
create or replace function public.claim_team_invite(p_token text)
returns table(actor_id uuid, team_id uuid, actor_type text, display_name text, refresh_token text)
language plpgsql security definer
set search_path to 'amux', 'public', 'auth', 'app'
as $function$
declare
  v_invite      amux.team_invites%rowtype;
  v_user_id     uuid;
  v_actor       uuid;
  v_email       text;
  v_session     uuid;
  v_rt          text := null;
  v_old_user    uuid;
  v_target_anon boolean;
  v_team_org    uuid;   -- S3-FC.3: invite team's org
  v_old_org     uuid;   -- S3-FC.3: claimer's previous org
begin
  select * into v_invite from amux.team_invites where token = p_token for update;
  if not found then raise exception 'invite not found' using errcode = '23503'; end if;
  if v_invite.consumed_at is not null then raise exception 'invite already consumed' using errcode = '23514'; end if;
  if v_invite.expires_at < now() then raise exception 'invite expired' using errcode = '23514'; end if;

  if v_invite.kind = 'member' then
    if v_invite.target_actor_id is not null then
      select user_id into v_user_id from amux.actors where id = v_invite.target_actor_id;
      if v_user_id is null then raise exception 'target member has no auth user' using errcode = '23503'; end if;
      select coalesce(is_anonymous, false) into v_target_anon from auth.users where id = v_user_id;
      if not v_target_anon then raise exception 'target member is no longer anonymous' using errcode = '23514'; end if;

      v_session := gen_random_uuid();
      v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);
      insert into auth.sessions (id, user_id, aal, created_at, updated_at) values (v_session, v_user_id, 'aal1', now(), now());
      insert into auth.refresh_tokens (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
        values (v_rt, v_user_id::text, v_session, false, '00000000-0000-0000-0000-000000000000', now(), now());

      v_actor := v_invite.target_actor_id;
      update amux.actors set last_active_at = now(), updated_at = now() where id = v_actor;
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
    select oid into v_team_org from amux.teams where id = v_invite.team_id;
    if v_team_org is not null and v_user_id is not null then
      select org_id into v_old_org from public.users where auth_user_id = v_user_id;
      if v_old_org is null then
        insert into public.users (auth_user_id, org_id) values (v_user_id, v_team_org);
      else
        update public.users set org_id = v_team_org, updated_at = now() where auth_user_id = v_user_id;
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
    insert into auth.users (id, email, email_confirmed_at, encrypted_password, confirmation_token, recovery_token,
      email_change_token_new, email_change, raw_app_meta_data, aud, role, created_at, updated_at, instance_id)
    values (v_user_id, v_email, now(), '', '', '', '', '', '{}'::jsonb, 'authenticated', 'authenticated',
      now(), now(), '00000000-0000-0000-0000-000000000000');
    insert into auth.sessions (id, user_id, aal, created_at, updated_at) values (v_session, v_user_id, 'aal1', now(), now());
    insert into auth.refresh_tokens (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
      values (v_rt, v_user_id::text, v_session, false, '00000000-0000-0000-0000-000000000000', now(), now());

    if v_invite.target_actor_id is not null then
      select user_id into v_old_user from amux.actors where id = v_invite.target_actor_id;
      update amux.actors set user_id = v_user_id, invited_by_actor_id = v_invite.invited_by_actor_id,
             last_active_at = null, updated_at = now() where id = v_invite.target_actor_id;
      v_actor := v_invite.target_actor_id;
      update amux.agents set owner_member_id = v_invite.invited_by_actor_id, visibility = 'team', updated_at = now() where id = v_actor;
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

  update amux.team_invites set consumed_at = now(), consumed_by_actor_id = v_actor, updated_at = now() where id = v_invite.id;

  return query select v_actor, v_invite.team_id, v_invite.kind::text, v_invite.display_name, v_rt;
end;
$function$;

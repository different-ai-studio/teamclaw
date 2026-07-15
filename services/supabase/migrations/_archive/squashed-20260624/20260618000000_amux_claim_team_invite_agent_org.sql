-- ============================================================================
-- Fix: amux.claim_team_invite must stamp org_id for daemon (agent) users
--
-- Regression: 20260611000000 fixed public.claim_team_invite, but FC now calls
-- amux.claim_team_invite (20260617000000_users_id_linkage_amux). The amux
-- agent branch still inserted raw_app_meta_data = '{}', so daemon JWTs failed
-- teams_org_guard and getShareMode returned mode=null → team_share_not_enabled_for_daemon.
-- Rebind could never fix it because every re-claim minted the same gap.
--
-- Fix:
--   1. Resolve v_team_org once up front; stamp it into new daemon users.
--   2. amux_access_token_hook: fallback org_id from the agent actor's team oid
--      when public.users has no row (belt-and-suspenders on token refresh).
--   3. Backfill existing daemon auth users (idempotent).
-- ============================================================================

create or replace function amux.claim_team_invite(p_token text)
returns table(actor_id uuid, team_id uuid, actor_type text, display_name text, refresh_token text)
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
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
  v_team_org    uuid;   -- invite team's org (S3-FC.3)
  v_old_org     uuid;   -- claimer's previous org (member path)
begin
  select * into v_invite from amux.team_invites where token = p_token for update;
  if not found then raise exception 'invite not found' using errcode = '23503'; end if;
  if v_invite.consumed_at is not null then raise exception 'invite already consumed' using errcode = '23514'; end if;
  if v_invite.expires_at < now() then raise exception 'invite expired' using errcode = '23514'; end if;

  -- Resolved once for both branches: members get public.users.org_id switched,
  -- agents get the claim baked into raw_app_meta_data.
  select oid into v_team_org from amux.teams where id = v_invite.team_id;

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

create or replace function amux.amux_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_user_id     uuid;
  v_claims      jsonb;
  v_memberships jsonb;
  v_acl         jsonb;
  v_org         uuid;
begin
  v_user_id := nullif(event->>'user_id','')::uuid;
  if v_user_id is null then
    return event;
  end if;
  v_claims := coalesce(event->'claims', '{}'::jsonb);

  select coalesce(
    jsonb_agg(jsonb_build_object(
      'team_id', a.team_id::text, 'actor_id', a.id::text, 'actor_type', a.actor_type
    ) order by a.team_id, a.id),
    '[]'::jsonb)
    into v_memberships
    from amux.actors a where a.user_id = v_user_id;

  with expanded as (
    select jsonb_build_object('permission','allow','action',r.action,'topic',r.topic) as rule
      from amux.actors a,
           lateral amux.amux_acl_rules_for(a.team_id, a.id, a.actor_type) r
     where a.user_id = v_user_id
  )
  select coalesce(jsonb_agg(rule), '[]'::jsonb)
         || jsonb_build_array(jsonb_build_object('permission','deny','action','all','topic','#'))
    into v_acl from expanded;

  -- org_id: existing claim > public.users > agent actor's team oid (daemon users)
  v_org := coalesce(
    nullif(v_claims->'app_metadata'->>'org_id','')::uuid,
    (select u.org_id from public.users u where u.id = v_user_id limit 1),
    (select t.oid
       from amux.actors a
       join amux.teams t on t.id = a.team_id
      where a.user_id = v_user_id
        and a.actor_type = 'agent'
        and t.oid is not null
      limit 1)
  );

  v_claims := v_claims
    || jsonb_build_object('acl', v_acl)
    || jsonb_build_object('app_metadata',
         coalesce(v_claims->'app_metadata', '{}'::jsonb)
         || jsonb_build_object('memberships', v_memberships)
         || case when v_org is not null then jsonb_build_object('org_id', v_org::text) else '{}'::jsonb end
       );

  return jsonb_build_object('claims', v_claims);
exception when others then
  return event;
end;
$function$;

-- Backfill: existing daemon users of agent actors in org-stamped teams.
update auth.users u
set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb)
                        || jsonb_build_object('org_id', t.oid),
    updated_at = now()
from amux.actors a
join amux.teams t on t.id = a.team_id
where a.actor_type = 'agent'
  and a.user_id = u.id
  and t.oid is not null
  and coalesce(u.raw_app_meta_data ->> 'org_id', '') <> t.oid::text;

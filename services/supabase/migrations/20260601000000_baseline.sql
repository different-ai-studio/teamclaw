-- TeamClaw consolidated baseline (squashed from migrations, generated 2026-06-24).
-- FRESH DATABASES ONLY. This baseline replaces the pre-2026-06-24 migration chain
-- (archived under _archive/squashed-20260624/). Do NOT apply it to an already-deployed
-- database (e.g. belayo / dev) that ran the old migrations — those carry their own
-- applied history; this file is the starting point for brand-new deployments.
-- All teamclaw tables + functions live in amux; public holds only orgs/plans/users.
-- Generated via: pg_dump --schema=amux --schema=public  +  appended storage policies.

create extension if not exists pgcrypto;
create extension if not exists pgtap;
create extension if not exists pg_net;

--
-- PostgreSQL database dump
--

-- Dumped from database version 15.1 (Ubuntu 15.1-1.pgdg20.04+1)
-- Dumped by pg_dump version 15.7 (Ubuntu 15.7-1.pgdg20.04+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: amux; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS amux;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: team_share_mode; Type: TYPE; Schema: amux; Owner: -
--

CREATE TYPE amux.team_share_mode AS ENUM (
    'oss',
    'managed_git',
    'custom_git'
);


--
-- Name: actor_has_app_access(uuid, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.actor_has_app_access(p_app_id uuid, p_actor_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'amux', 'public'
    AS $$
  select exists (
    select 1
      from amux.app_member_access ama
     where ama.app_id = p_app_id
       and ama.member_id = p_actor_id
  );
$$;


--
-- Name: actor_id_for_user_in_team(uuid, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.actor_id_for_user_in_team(p_user_id uuid, p_team_id uuid) RETURNS uuid
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select id
    from amux.actors
   where user_id  = p_user_id
     and team_id  = p_team_id
   limit 1;
$$;


--
-- Name: FUNCTION actor_id_for_user_in_team(p_user_id uuid, p_team_id uuid); Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON FUNCTION amux.actor_id_for_user_in_team(p_user_id uuid, p_team_id uuid) IS 'Resolves actor.id for a (user_id, team_id) pair. Used by FC /sync/* auth middleware (service_role) where auth.uid() is not available. Returns NULL if the user is not a member of the team.';


--
-- Name: actor_team_id(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.actor_team_id(p_actor_id uuid) RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select team_id
  from amux.actors
  where id = p_actor_id
$$;


--
-- Name: actor_user_contact(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.actor_user_contact(p_user_id uuid) RETURNS TABLE(email text, phone text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select u.email::text, nullif(u.phone, '')::text
  from auth.users u
  where u.id = p_user_id
    and exists (
      -- caller shares at least one team with the target user
      select 1
      from amux.actors them
      join amux.actors me on me.team_id = them.team_id
      where them.user_id = p_user_id
        and me.user_id = auth.uid()
    )
$$;


--
-- Name: FUNCTION actor_user_contact(p_user_id uuid); Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON FUNCTION amux.actor_user_contact(p_user_id uuid) IS 'Returns (email, phone) from auth.users for p_user_id, but only when the caller (auth.uid()) shares a team with that user. SECURITY DEFINER so it can read auth.users; the team-sharing guard prevents arbitrary contact harvesting via direct calls. Used by the actor_directory view.';


--
-- Name: add_gateway_session_participant(uuid, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.add_gateway_session_participant(p_session_id uuid, p_actor_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_primary_agent uuid;
  v_team          uuid;
begin
  select s.primary_agent_id, s.team_id
    into v_primary_agent, v_team
    from amux.sessions as s
   where s.id = p_session_id;

  if v_primary_agent is null then
    raise exception 'add_gateway_session_participant: session % not found',
      p_session_id
      using errcode = 'P0002';
  end if;

  -- Authorization: the caller's JWT must own the session's primary-agent
  -- actor. This matches how the daemon authenticates (it spawns Supabase
  -- requests using the agent's user_id).
  if not exists (
    select 1
      from amux.actors a
     where a.id = v_primary_agent
       and a.user_id = auth.uid()
  ) then
    raise exception
      'add_gateway_session_participant: caller is not the session primary agent'
      using errcode = '42501';
  end if;

  -- The target actor must be in the same team as the session. Mirrors the
  -- `enforce_session_participants_same_team` trigger (202604220002) so we
  -- fail fast with a clear error rather than tripping the trigger.
  if not exists (
    select 1
      from amux.actors a
     where a.id = p_actor_id
       and a.team_id = v_team
  ) then
    raise exception
      'add_gateway_session_participant: actor % not in session team %',
      p_actor_id, v_team
      using errcode = '23514';
  end if;

  insert into amux.session_participants (session_id, actor_id)
    values (p_session_id, p_actor_id)
  on conflict on constraint session_participants_session_id_actor_id_key
  do nothing;
end;
$$;


--
-- Name: amux_access_token_hook(jsonb); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.amux_access_token_hook(event jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth', 'extensions'
    AS $$
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
$$;


--
-- Name: amux_acl_rules_for(uuid, uuid, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.amux_acl_rules_for(p_team uuid, p_actor uuid, p_type text) RETURNS TABLE(action text, topic text)
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'amux', 'public'
    AS $$
  select action, topic from amux.amux_acl_rules_for(p_team, p_actor, p_type)
$$;


--
-- Name: amuxc_complete_delete(uuid, text, integer, uuid, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.amuxc_complete_delete(p_team_id uuid, p_path text, p_parent_version integer, p_actor_id uuid, p_node_id text DEFAULT NULL::text) RETURNS TABLE(version integer, change_seq bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_file    amux.amuxc_files%rowtype;
  v_seq     bigint;
  v_new_ver int;
begin
  -- WATERLINE INVARIANT (§2.6): push seq FIRST.
  update amux.team_workspace_config
     set oss_change_seq = oss_change_seq + 1
   where team_id = p_team_id
  returning oss_change_seq into v_seq;

  if not found then
    raise exception 'team_workspace_config row missing for team %', p_team_id;
  end if;

  -- Lock file row
  select * into v_file
    from amux.amuxc_files
   where team_id = p_team_id
     and path    = p_path
   for update;

  if not found then
    raise exception 'file not found: %', p_path using errcode = 'P0404';
  end if;

  -- CAS check
  if v_file.current_version <> p_parent_version then
    raise exception 'cas-mismatch'
      using errcode = 'P0409',
            hint    = json_build_object(
                        'remote_version', v_file.current_version,
                        'remote_hash',    v_file.content_hash
                      )::text;
  end if;

  v_new_ver := v_file.current_version + 1;

  -- Append tombstone version record
  insert into amux.amuxc_file_versions
    (file_id, version, parent_version, content_hash, size, deleted,
     created_by, created_by_node_id)
  values
    (v_file.id, v_new_ver, p_parent_version, null, 0, true, p_actor_id, p_node_id);

  -- Mark file as deleted and advance pointer
  update amux.amuxc_files
     set current_version = v_new_ver,
         content_hash    = null,
         size            = 0,
         deleted         = true,
         change_seq      = v_seq,
         updated_by      = p_actor_id,
         updated_at      = now()
   where id = v_file.id;

  return query select v_new_ver, v_seq;
end;
$$;


--
-- Name: FUNCTION amuxc_complete_delete(p_team_id uuid, p_path text, p_parent_version integer, p_actor_id uuid, p_node_id text); Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON FUNCTION amux.amuxc_complete_delete(p_team_id uuid, p_path text, p_parent_version integer, p_actor_id uuid, p_node_id text) IS 'Atomic delete tombstone per spec §3.5. Same waterline invariant as amuxc_complete_upload. Raises P0409 on CAS conflict, P0404 if file not found.';


--
-- Name: amuxc_complete_upload(uuid, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.amuxc_complete_upload(p_session_id uuid, p_actor_id uuid) RETURNS TABLE(version integer, content_hash text, change_seq bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_session   amux.amuxc_upload_sessions%rowtype;
  v_file      amux.amuxc_files%rowtype;
  v_seq       bigint;
  v_new_ver   int;
begin
  -- Lock and read session
  select * into v_session
    from amux.amuxc_upload_sessions
   where id = p_session_id
   for update;

  if not found then
    raise exception 'session not found' using errcode = 'P0404';
  end if;
  if v_session.actor_id <> p_actor_id then
    raise exception 'session does not belong to caller' using errcode = 'P0403';
  end if;
  if v_session.status <> 'pending' then
    raise exception 'session is %', v_session.status using errcode = 'P0410';
  end if;
  if v_session.expires_at < now() then
    raise exception 'session has expired' using errcode = 'P0410';
  end if;

  -- WATERLINE INVARIANT (§2.6): push seq FIRST, before any amuxc_files write.
  -- Any snapshot that can see oss_change_seq=N is guaranteed to also see
  -- all amuxc_files rows with change_seq<=N because they are committed in
  -- the same atomic transaction.
  update amux.team_workspace_config
     set oss_change_seq = oss_change_seq + 1
   where team_id = v_session.team_id
  returning oss_change_seq into v_seq;

  if not found then
    raise exception 'team_workspace_config row missing for team %', v_session.team_id;
  end if;

  -- Ensure file row exists (upsert the pointer row)
  insert into amux.amuxc_files (team_id, path, updated_by)
    values (v_session.team_id, v_session.path, p_actor_id)
  on conflict (team_id, path) do nothing;

  -- Lock file row
  select * into v_file
    from amux.amuxc_files
   where team_id = v_session.team_id
     and path    = v_session.path
   for update;

  -- CAS check
  if v_file.current_version <> v_session.parent_version then
    raise exception 'cas-mismatch'
      using errcode = 'P0409',
            hint    = json_build_object(
                        'remote_version', v_file.current_version,
                        'remote_hash',    v_file.content_hash
                      )::text;
  end if;

  v_new_ver := v_file.current_version + 1;

  -- Mark blob verified (table-qualify to avoid PL/pgSQL ambiguity with local var)
  update amux.amuxc_blobs b
     set verified = true
   where b.team_id      = v_session.team_id
     and b.content_hash = v_session.content_hash;

  -- Append version record
  insert into amux.amuxc_file_versions
    (file_id, version, parent_version, content_hash, size, deleted,
     created_by, created_by_node_id)
  values
    (v_file.id, v_new_ver, v_session.parent_version, v_session.content_hash,
     v_session.size, false, p_actor_id, v_session.node_id);

  -- Advance file pointer
  update amux.amuxc_files
     set current_version = v_new_ver,
         content_hash    = v_session.content_hash,
         size            = v_session.size,
         deleted         = false,
         change_seq      = v_seq,
         updated_by      = p_actor_id,
         updated_at      = now()
   where id = v_file.id;

  -- Mark session completed
  update amux.amuxc_upload_sessions
     set status = 'completed'
   where id = p_session_id;

  return query select v_new_ver, v_session.content_hash, v_seq;
end;
$$;


--
-- Name: FUNCTION amuxc_complete_upload(p_session_id uuid, p_actor_id uuid); Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON FUNCTION amux.amuxc_complete_upload(p_session_id uuid, p_actor_id uuid) IS 'Atomic CAS upload-complete per spec §3.3. Waterline invariant: team_workspace_config.oss_change_seq is incremented BEFORE any amuxc_files write. Raises P0409 on CAS conflict, P0403 on ownership mismatch, P0410 on expired/non-pending session.';


--
-- Name: archive_idea(uuid, boolean); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.archive_idea(p_idea_id uuid, p_archived boolean DEFAULT true) RETURNS TABLE(id uuid, team_id uuid, workspace_id uuid, created_by_actor_id uuid, title text, description text, status text, archived boolean, sort_order integer, created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_idea_team_id uuid;
begin
  if amux.current_actor_id() is null then
    raise exception 'archive_idea requires an authenticated member'
      using errcode = '42501';
  end if;

  if p_idea_id is null then
    raise exception 'idea id is required'
      using errcode = '22023';
  end if;

  select t.team_id
  into v_idea_team_id
  from amux.ideas t
  where t.id = p_idea_id;

  if v_idea_team_id is null then
    raise exception 'idea not found'
      using errcode = '23503';
  end if;

  if not amux.is_team_member(v_idea_team_id) then
    raise exception 'archive_idea requires team membership'
      using errcode = '42501';
  end if;

  return query
  update amux.ideas
  set archived = coalesce(p_archived, true)
  where ideas.id = p_idea_id
  returning
    ideas.id,
    ideas.team_id,
    ideas.workspace_id,
    ideas.created_by_actor_id,
    ideas.title,
    ideas.description,
    ideas.status,
    ideas.archived,
    ideas.sort_order,
    ideas.created_at,
    ideas.updated_at;
end;
$$;


--
-- Name: bind_phone_to_account(text, text, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.bind_phone_to_account(p_phone text, p_code text, p_default_org_id uuid) RETURNS TABLE(user_id uuid, bound boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_user_id uuid := auth.uid();
  v_code_id uuid;
  v_other   uuid;
  v_nick    text;
begin
  if v_user_id is null then
    raise exception 'phone bind requires an authenticated user' using errcode = '42501';
  end if;
  if p_default_org_id is null then
    raise exception 'default org is required' using errcode = '23514';
  end if;

  -- Verify the code (our own auth_verify_code, same table phone login uses).
  select id into v_code_id
  from public.auth_verify_code
  where phone = p_phone and code = p_code and used = false and expires_at > now()
  order by created_at desc
  limit 1;
  if v_code_id is null then
    raise exception 'verification code is invalid or expired' using errcode = '23514';
  end if;

  -- The phone must not already belong to a DIFFERENT account in the default org.
  select id into v_other
  from public.users
  where org_id = p_default_org_id
    and mobile = p_phone
    and deleted_at is null
    and auth_user_id is distinct from v_user_id
  limit 1;
  if v_other is not null then
    raise exception 'phone already in use by another account' using errcode = '23505';
  end if;

  -- Upsert the current account's public.users row (mirror the partner's shape).
  v_nick := 'user_' || substr(md5(v_user_id::text || p_phone), 1, 4) || '_' || right(p_phone, 4);
  insert into public.users (id, org_id, auth_user_id, mobile, nickname)
  values (v_user_id, p_default_org_id, v_user_id, p_phone, v_nick)
  on conflict (id) do update
    set mobile = excluded.mobile,
        org_id = coalesce(public.users.org_id, excluded.org_id);

  -- Flip the auth user to a real (non-anonymous) phone identity.
  update auth.users set phone = p_phone, is_anonymous = false where id = v_user_id;

  -- Consume the code.
  update public.auth_verify_code set used = true, used_at = now() where id = v_code_id;

  return query select v_user_id, true;
end;
$$;


--
-- Name: bump_session_last_message(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.bump_session_last_message() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE amux.sessions
  SET last_message_preview = LEFT(COALESCE(NEW.content, ''), 140),
      last_message_at = NEW.created_at
  WHERE id = NEW.session_id
    AND (last_message_at IS NULL OR last_message_at <= NEW.created_at);
  RETURN NEW;
END;
$$;


--
-- Name: bump_updated_at(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.bump_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: can_prompt_agent(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.can_prompt_agent(target_agent_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select exists (
    select 1
      from amux.agent_member_access ama
      join amux.agents ag on ag.id = ama.agent_id
      join amux.actors act on act.id = ag.id
     where ama.agent_id = target_agent_id
       and ama.member_id = amux.current_actor_id_for_team(act.team_id)
       and ama.permission_level in ('prompt', 'admin')
       and amux.is_team_member(act.team_id)
       and (
         ag.visibility = 'team'
         or ag.owner_member_id = amux.current_actor_id_for_team(act.team_id)
       )
  )
$$;


--
-- Name: check_agent_permission(uuid, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.check_agent_permission(p_agent_id uuid, p_actor_id uuid) RETURNS text
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select ama.permission_level
    from amux.agent_member_access ama
    join amux.agents ag on ag.id = ama.agent_id
   where ama.agent_id = p_agent_id
     and ama.member_id = p_actor_id
     and (
       ag.visibility = 'team'
       or ag.owner_member_id = p_actor_id
     )
   limit 1;
$$;


--
-- Name: claim_team_invite(text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.claim_team_invite(p_token text) RETURNS TABLE(actor_id uuid, team_id uuid, actor_type text, display_name text, refresh_token text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth', 'extensions'
    AS $$
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
$$;


--
-- Name: cleanup_shortcut_permission(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.cleanup_shortcut_permission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $$
begin
  if old.scope = 'team' then
    delete from amux.permissions
      where team_id = old.team_id
        and resource_type = 'shortcut'
        and resource_id = old.id;
  end if;
  return old;
end $$;


--
-- Name: create_idea(uuid, text, uuid, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.create_idea(p_team_id uuid, p_title text, p_workspace_id uuid DEFAULT NULL::uuid, p_description text DEFAULT ''::text) RETURNS TABLE(id uuid, team_id uuid, workspace_id uuid, created_by_actor_id uuid, title text, description text, status text, archived boolean, sort_order integer, created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_actor_id uuid := amux.current_actor_id();
  v_workspace_team_id uuid;
  v_sort_order integer;
begin
  if v_actor_id is null then
    raise exception 'create_idea requires an authenticated member'
      using errcode = '42501';
  end if;

  if p_team_id is null or not amux.is_team_member(p_team_id) then
    raise exception 'create_idea requires team membership'
      using errcode = '42501';
  end if;

  if p_title is null or btrim(p_title) = '' then
    raise exception 'title is required'
      using errcode = '22023';
  end if;

  if p_workspace_id is not null then
    select w.team_id
    into v_workspace_team_id
    from amux.workspaces w
    where w.id = p_workspace_id
      and w.archived = false;

    if v_workspace_team_id is null then
      raise exception 'workspace not found'
        using errcode = '23503';
    end if;

    if v_workspace_team_id <> p_team_id then
      raise exception 'workspace does not belong to the requested team'
        using errcode = '23514';
    end if;
  end if;

  perform 1
  from amux.teams
  where teams.id = p_team_id
  for update;

  select coalesce(min(i.sort_order), 1000) - 1000
  into v_sort_order
  from amux.ideas i
  where i.team_id = p_team_id
    and i.archived = false;

  return query
  insert into amux.ideas (
    team_id,
    workspace_id,
    created_by_actor_id,
    title,
    description,
    status,
    archived,
    sort_order
  )
  values (
    p_team_id,
    p_workspace_id,
    v_actor_id,
    btrim(p_title),
    coalesce(p_description, ''),
    'open',
    false,
    v_sort_order
  )
  returning
    ideas.id,
    ideas.team_id,
    ideas.workspace_id,
    ideas.created_by_actor_id,
    ideas.title,
    ideas.description,
    ideas.status,
    ideas.archived,
    ideas.sort_order,
    ideas.created_at,
    ideas.updated_at;
end;
$$;


--
-- Name: create_idea_activity(uuid, text, text, jsonb, text[]); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.create_idea_activity(p_idea_id uuid, p_activity_type text, p_content text DEFAULT ''::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_attachment_urls text[] DEFAULT '{}'::text[]) RETURNS TABLE(id uuid, team_id uuid, idea_id uuid, actor_id uuid, activity_type text, content text, metadata jsonb, attachment_urls text[], created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_actor_id uuid := amux.current_actor_id();
  v_team_id uuid;
begin
  if v_actor_id is null then
    raise exception 'create_idea_activity requires an authenticated member'
      using errcode = '42501';
  end if;

  if p_idea_id is null then
    raise exception 'idea id is required'
      using errcode = '22023';
  end if;

  if p_activity_type not in ('progress', 'status_change', 'reorder') then
    raise exception 'invalid idea activity type'
      using errcode = '22023';
  end if;

  select i.team_id
  into v_team_id
  from amux.ideas i
  where i.id = p_idea_id;

  if v_team_id is null then
    raise exception 'idea not found'
      using errcode = '23503';
  end if;

  if not amux.is_team_member(v_team_id) then
    raise exception 'create_idea_activity requires team membership'
      using errcode = '42501';
  end if;

  return query
  insert into amux.idea_activities (
    team_id,
    idea_id,
    actor_id,
    activity_type,
    content,
    metadata,
    attachment_urls
  )
  values (
    v_team_id,
    p_idea_id,
    v_actor_id,
    p_activity_type,
    coalesce(p_content, ''),
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_attachment_urls, '{}'::text[])
  )
  returning
    idea_activities.id,
    idea_activities.team_id,
    idea_activities.idea_id,
    idea_activities.actor_id,
    idea_activities.activity_type,
    idea_activities.content,
    idea_activities.metadata,
    idea_activities.attachment_urls,
    idea_activities.created_at,
    idea_activities.updated_at;
end;
$$;


--
-- Name: create_session(uuid, uuid, text, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.create_session(p_primary_agent_id uuid, p_idea_id uuid, p_mode text, p_title text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'app'
    AS $$
declare
  v_caller_member uuid := amux.current_member_id();
  v_team uuid;
  v_session uuid;
begin
  if v_caller_member is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idea_id is not null then
    select team_id into v_team from amux.ideas where id = p_idea_id;
    if v_team is null then
      raise exception 'idea not found' using errcode = 'P0001';
    end if;
  else
    v_team := amux.actor_team_id(p_primary_agent_id);
  end if;

  if v_team is null then
    raise exception 'agent not in team' using errcode = '42501';
  end if;

  if not exists (
    select 1 from amux.team_members
    where team_id = v_team and member_id = v_caller_member
  ) then
    raise exception 'caller not in team' using errcode = '42501';
  end if;

  if amux.actor_team_id(p_primary_agent_id) <> v_team then
    raise exception 'agent not in team' using errcode = '42501';
  end if;

  insert into amux.sessions
    (team_id, idea_id, created_by_actor_id, primary_agent_id, mode, title)
    values (v_team, p_idea_id, v_caller_member, p_primary_agent_id, p_mode, p_title)
    returning id into v_session;

  insert into amux.session_participants (session_id, actor_id) values
    (v_session, v_caller_member),
    (v_session, p_primary_agent_id)
  on conflict (session_id, actor_id) do nothing;

  return v_session;
end;
$$;


--
-- Name: create_team(text, text, text, text, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.create_team(p_name text DEFAULT NULL::text, p_slug text DEFAULT NULL::text, p_litellm_team_id text DEFAULT NULL::text, p_ai_gateway_endpoint text DEFAULT NULL::text, p_display_name text DEFAULT NULL::text) RETURNS TABLE(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_user_id      uuid := auth.uid();
  v_member_id    uuid;
  v_team_id      uuid := gen_random_uuid();
  v_workspace_id uuid;
  v_slug_base    text;
  v_slug         text;
  v_suffix       integer := 1;
  v_team_name    text;
  v_display_name text;
  v_org_name     text;
  v_nickname     text;
  v_adjectives   text[] := array['Curious','Brave','Calm','Eager','Lively','Mellow','Nimble','Quick','Quiet','Sunny','Witty','Zesty','Bright','Daring','Gentle','Jolly','Keen','Plucky','Spry','Sparkling'];
  v_animals      text[] := array['Otter','Panda','Falcon','Fox','Heron','Lynx','Owl','Puffin','Quokka','Raven','Seal','Tapir','Viper','Walrus','Yak','Zebra','Badger','Cougar','Dolphin','Hare'];
begin
  if v_user_id is null then
    raise exception 'create_team requires an authenticated user' using errcode = '42501';
  end if;
  if exists (select 1 from amux.actors where user_id = v_user_id) then
    raise exception 'create_team currently supports first-team onboarding only'
      using errcode = '23514', detail = 'Existing actors already have a team-scoped identity.';
  end if;

  -- Resolve the caller's org name (for the default team name). Prefer the org
  -- stamped by FC (p_oid); fall back to the org linked in public.users.
  if v_org_name is null then
    select o.name into v_org_name
    from public.users u
    join public.orgs o on o.id = u.org_id
    where u.id = v_user_id
    limit 1;
  end if;

  -- Resolve the caller's nickname (for the default owner display name).
  select nickname into v_nickname
  from public.users
  where id = v_user_id
  limit 1;

  -- Team name: explicit > org name > deterministic Adjective Animal.
  v_team_name := coalesce(
    nullif(btrim(p_name), ''),
    nullif(btrim(v_org_name), ''),
    v_adjectives[((hashtextextended(v_team_id::text, 11) % 20) + 20) % 20 + 1] || ' ' ||
    v_animals[((hashtextextended(v_team_id::text, 29) % 20) + 20) % 20 + 1]
  );

  v_slug_base := lower(regexp_replace(coalesce(nullif(btrim(p_slug), ''), v_team_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug_base := trim(both '-' from v_slug_base);
  if v_slug_base = '' then v_slug_base := 'team'; end if;
  v_slug := v_slug_base;
  while exists (select 1 from amux.teams t where t.slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := format('%s-%s', v_slug_base, v_suffix);
  end loop;

  -- Stamp the caller's org onto the team.
  insert into amux.teams (id, name, slug, oid)
  values (v_team_id, v_team_name, v_slug, null::uuid);

  v_member_id := gen_random_uuid();
  -- Display name: saas-mono nickname > client-sent best effort > Adjective Animal.
  v_display_name := coalesce(
    nullif(btrim(v_nickname), ''),
    nullif(btrim(p_display_name), ''),
    v_adjectives[((hashtextextended(v_member_id::text, 11) % 20) + 20) % 20 + 1] || ' ' ||
    v_animals[((hashtextextended(v_member_id::text, 29) % 20) + 20) % 20 + 1]
  );

  insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
  values (v_member_id, v_team_id, 'member', v_user_id, v_display_name, now());
  insert into amux.members (id, status) values (v_member_id, 'active');
  insert into amux.team_members (team_id, member_id, role) values (v_team_id, v_member_id, 'owner');
  insert into amux.workspaces (team_id, created_by_member_id, name, path)
  values (v_team_id, v_member_id, 'General', null)
  returning id into v_workspace_id;
  insert into amux.team_workspace_config (team_id, litellm_team_id, ai_gateway_endpoint)
  values (v_team_id, p_litellm_team_id, p_ai_gateway_endpoint);

  return query
  select v_team_id, v_team_name, v_slug, v_member_id, 'owner'::text, v_workspace_id, 'General'::text;
end;
$$;


--
-- Name: create_team(text, text, text, text, text, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.create_team(p_name text DEFAULT NULL::text, p_slug text DEFAULT NULL::text, p_litellm_team_id text DEFAULT NULL::text, p_ai_gateway_endpoint text DEFAULT NULL::text, p_display_name text DEFAULT NULL::text, p_oid uuid DEFAULT NULL::uuid) RETURNS TABLE(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_user_id      uuid := auth.uid();
  v_member_id    uuid;
  v_team_id      uuid := gen_random_uuid();
  v_workspace_id uuid;
  v_slug_base    text;
  v_slug         text;
  v_suffix       integer := 1;
  v_team_name    text;
  v_display_name text;
  v_nickname     text;
  v_adjectives   text[] := array['Curious','Brave','Calm','Eager','Lively','Mellow','Nimble','Quick','Quiet','Sunny','Witty','Zesty','Bright','Daring','Gentle','Jolly','Keen','Plucky','Spry','Sparkling'];
  v_animals      text[] := array['Otter','Panda','Falcon','Fox','Heron','Lynx','Owl','Puffin','Quokka','Raven','Seal','Tapir','Viper','Walrus','Yak','Zebra','Badger','Cougar','Dolphin','Hare'];
begin
  if v_user_id is null then
    raise exception 'create_team requires an authenticated user' using errcode = '42501';
  end if;
  if exists (select 1 from amux.actors where user_id = v_user_id) then
    raise exception 'create_team currently supports first-team onboarding only'
      using errcode = '23514', detail = 'Existing actors already have a team-scoped identity.';
  end if;

  -- Owner display name still seeds from the caller's saas-mono nickname.
  select nickname into v_nickname
  from public.users
  where id = v_user_id
  limit 1;

  -- Team name: explicit > deterministic Adjective Animal. NOT the org name —
  -- every personal team shares the default org, so the org name is meaningless
  -- as a team name. A real org name arrives later via account upgrade (rename).
  v_team_name := coalesce(
    nullif(btrim(p_name), ''),
    v_adjectives[((hashtextextended(v_team_id::text, 11) % 20) + 20) % 20 + 1] || ' ' ||
    v_animals[((hashtextextended(v_team_id::text, 29) % 20) + 20) % 20 + 1]
  );

  v_slug_base := lower(regexp_replace(coalesce(nullif(btrim(p_slug), ''), v_team_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug_base := trim(both '-' from v_slug_base);
  if v_slug_base = '' then v_slug_base := 'team'; end if;
  v_slug := v_slug_base;
  while exists (select 1 from amux.teams t where t.slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := format('%s-%s', v_slug_base, v_suffix);
  end loop;

  -- Stamp the team with the default org (p_oid = DEFAULT_ORG_ID from FC).
  insert into amux.teams (id, name, slug, oid)
  values (v_team_id, v_team_name, v_slug, p_oid);

  v_member_id := gen_random_uuid();
  v_display_name := coalesce(
    nullif(btrim(v_nickname), ''),
    nullif(btrim(p_display_name), ''),
    v_adjectives[((hashtextextended(v_member_id::text, 11) % 20) + 20) % 20 + 1] || ' ' ||
    v_animals[((hashtextextended(v_member_id::text, 29) % 20) + 20) % 20 + 1]
  );

  insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
  values (v_member_id, v_team_id, 'member', v_user_id, v_display_name, now());
  insert into amux.members (id, status) values (v_member_id, 'active');
  insert into amux.team_members (team_id, member_id, role) values (v_team_id, v_member_id, 'owner');
  insert into amux.workspaces (team_id, created_by_member_id, name, path)
  values (v_team_id, v_member_id, 'General', null)
  returning id into v_workspace_id;
  insert into amux.team_workspace_config (team_id, litellm_team_id, ai_gateway_endpoint)
  values (v_team_id, p_litellm_team_id, p_ai_gateway_endpoint);

  return query
  select v_team_id, v_team_name, v_slug, v_member_id, 'owner'::text, v_workspace_id, 'General'::text;
end;
$$;


--
-- Name: create_team_invite(uuid, text, text, text, text, integer, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.create_team_invite(p_team_id uuid, p_kind text, p_display_name text, p_team_role text DEFAULT NULL::text, p_agent_kind text DEFAULT NULL::text, p_ttl_seconds integer DEFAULT 604800, p_target_actor_id uuid DEFAULT NULL::uuid) RETURNS TABLE(token text, expires_at timestamp with time zone, deeplink text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth', 'app'
    AS $$
declare
  v_caller uuid := amux.current_actor_id_for_team(p_team_id);
  v_token  text := translate(
                     encode(extensions.gen_random_bytes(24), 'base64'),
                     '+/=', '-_0'
                   );
  v_expires timestamptz := now() + make_interval(secs => greatest(60, p_ttl_seconds));
  v_kind    text;
  v_role    text;
  v_target  amux.actors%rowtype;
  v_target_anon boolean;
begin
  if v_caller is null then
    raise exception 'create_team_invite requires team membership'
      using errcode = '42501';
  end if;

  v_kind := lower(coalesce(p_kind, ''));
  if v_kind not in ('member','agent') then
    raise exception 'p_kind must be member or agent' using errcode = '22023';
  end if;

  if v_kind = 'member' then
    if p_team_role is null or btrim(p_team_role) = '' then
      raise exception 'member invites require p_team_role' using errcode = '22023';
    end if;
    v_role := lower(p_team_role);
    if v_role not in ('owner','admin','member') then
      raise exception 'team_role must be owner/admin/member' using errcode = '22023';
    end if;

    if p_target_actor_id is not null then
      select * into v_target from amux.actors where id = p_target_actor_id;
      if not found then
        raise exception 'target actor not found' using errcode = '23503';
      end if;
      if v_target.team_id <> p_team_id then
        raise exception 'target actor belongs to a different team'
          using errcode = '23514';
      end if;
      if v_target.actor_type <> 'member' then
        raise exception 'target actor must be a member' using errcode = '22023';
      end if;
      if v_target.user_id is null then
        raise exception 'target member has no auth user'
          using errcode = '23503';
      end if;
      select coalesce(is_anonymous, false) into v_target_anon
        from auth.users where id = v_target.user_id;
      if not v_target_anon then
        raise exception 'cannot re-invite member with bound auth identity'
          using errcode = '22023';
      end if;
    end if;
  else
    if p_agent_kind is null or btrim(p_agent_kind) = '' then
      raise exception 'agent invites require p_agent_kind' using errcode = '22023';
    end if;
    if p_target_actor_id is not null then
      select * into v_target from amux.actors where id = p_target_actor_id;
      if not found then
        raise exception 'target actor not found' using errcode = '23503';
      end if;
      if v_target.team_id <> p_team_id then
        raise exception 'target actor belongs to a different team'
          using errcode = '23514';
      end if;
      if v_target.actor_type <> 'agent' then
        raise exception 'target actor must be an agent' using errcode = '22023';
      end if;
      if not exists (
        select 1 from amux.agents
        where id = p_target_actor_id
          and owner_member_id = v_caller
      ) then
        raise exception 'only the agent owner can re-invite this agent'
          using errcode = '42501';
      end if;
    end if;
  end if;

  insert into amux.team_invites (
    team_id, kind, display_name, team_role, agent_kind,
    invited_by_actor_id, token, expires_at, target_actor_id
  )
  values (
    p_team_id, v_kind, btrim(p_display_name), v_role, p_agent_kind,
    v_caller, v_token, v_expires, p_target_actor_id
  );

  return query
  select v_token,
         v_expires,
         format('amux://invite?token=%s', v_token);
end;
$$;


--
-- Name: current_actor_for_agent(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.current_actor_for_agent(p_agent_id uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select amux.current_actor_id_for_team(a.team_id)
    from amux.actors a
   where a.id = p_agent_id
$$;


--
-- Name: current_actor_id(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.current_actor_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select id from amux.actors where user_id = auth.uid()
   order by created_at limit 1
$$;


--
-- Name: current_actor_id_for_team(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.current_actor_id_for_team(p_team_id uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select id from amux.actors
   where user_id = auth.uid() and team_id = p_team_id
$$;


--
-- Name: current_jwt_actor_id(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.current_jwt_actor_id() RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select nullif(
    (current_setting('request.jwt.claims', true)::jsonb)->'app_metadata'->>'actor_id',
    ''
  )::uuid;
$$;


--
-- Name: current_jwt_kind(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.current_jwt_kind() RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb)->'app_metadata'->>'kind',
    ''
  );
$$;


--
-- Name: current_jwt_team_id(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.current_jwt_team_id() RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select nullif(
    (current_setting('request.jwt.claims', true)::jsonb)->'app_metadata'->>'team_id',
    ''
  )::uuid;
$$;


--
-- Name: current_member_id(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.current_member_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select a.id
    from amux.actors a
    join amux.members m on m.id = a.id
   where a.user_id = auth.uid() and m.status = 'active'
   order by a.created_at limit 1
$$;


--
-- Name: current_org_id(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.current_org_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth', 'extensions'
    AS $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'org_id', '')::uuid,
    (select u.org_id from public.users u where u.id = auth.uid() limit 1)
  );
$$;


--
-- Name: current_team_role(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.current_team_role(target_team_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select tm.role
  from amux.team_members tm
  where tm.team_id = target_team_id
    and tm.member_id = amux.current_member_id()
  limit 1
$$;


--
-- Name: daemon_can_write_gateway_message(uuid, uuid, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.daemon_can_write_gateway_message(p_team_id uuid, p_session_id uuid, p_sender_actor_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $$
  select
    -- the caller owns an agent that participates in this session+team
    exists (
      select 1
        from amux.actors as agent
        join amux.session_participants as sp
          on sp.actor_id = agent.id
       where agent.user_id = auth.uid()
         and agent.actor_type = 'agent'
         and agent.team_id = p_team_id
         and sp.session_id = p_session_id
    )
    -- the sender is a participant of the session
    and exists (
      select 1
        from amux.session_participants as sp
       where sp.session_id = p_session_id
         and sp.actor_id = p_sender_actor_id
    )
    -- the session belongs to the team
    and exists (
      select 1
        from amux.sessions as s
       where s.id = p_session_id
         and s.team_id = p_team_id
    )
    -- the sender actor belongs to the team
    and exists (
      select 1
        from amux.actors as a
       where a.id = p_sender_actor_id
         and a.team_id = p_team_id
    );
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: teams; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.teams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    share_mode amux.team_share_mode,
    share_enabled_at timestamp with time zone,
    git_remote_url text,
    git_auth_kind text,
    git_credential_ref text,
    oid uuid,
    CONSTRAINT teams_git_auth_kind_check CHECK (((git_auth_kind IS NULL) OR (git_auth_kind = ANY (ARRAY['ssh_key'::text, 'https_token'::text]))))
);


--
-- Name: disable_team_share(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.disable_team_share(p_team_id uuid) RETURNS amux.teams
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
declare
  v_team amux.teams;
begin
  update amux.teams
     set share_mode         = null,
         share_enabled_at   = null,
         git_remote_url     = null,
         git_auth_kind      = null,
         git_credential_ref = null
   where id = p_team_id
  returning * into v_team;

  if v_team.id is null then
    select * into v_team from amux.teams where id = p_team_id;
    if v_team.id is null then
      raise exception 'team % does not exist', p_team_id
        using errcode = '23503';
    end if;
  end if;

  perform set_config('amux.allow_sync_mode_switch', 'on', true);

  update amux.team_workspace_config
     set sync_mode = null
   where team_id = p_team_id;

  perform set_config('amux.allow_sync_mode_switch', 'off', true);

  return v_team;
end
$$;


--
-- Name: enable_team_share(uuid, amux.team_share_mode, text, text, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.enable_team_share(p_team_id uuid, p_mode amux.team_share_mode, p_git_remote_url text DEFAULT NULL::text, p_git_auth_kind text DEFAULT NULL::text, p_git_credential_ref text DEFAULT NULL::text) RETURNS amux.teams
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
declare
  v_team amux.teams;
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

  if p_mode = 'oss'::amux.team_share_mode then
    v_git_remote_url := null;
    v_git_auth_kind := null;
    v_git_credential_ref := null;
  else
    v_git_remote_url := p_git_remote_url;
    v_git_auth_kind := p_git_auth_kind;
    v_git_credential_ref := p_git_credential_ref;
  end if;

  update amux.teams
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

  perform set_config('amux.allow_sync_mode_switch', 'on', true);

  insert into amux.team_workspace_config (team_id, sync_mode)
       values (p_team_id, v_sync_mode)
  on conflict (team_id) do update
       set sync_mode = excluded.sync_mode;

  perform set_config('amux.allow_sync_mode_switch', 'off', true);

  return v_team;
end
$$;


--
-- Name: enforce_actor_subtype(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.enforce_actor_subtype() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if tg_table_name = 'members' then
    perform amux.require_actor_type(new.id, 'member', 'members.id');
  elsif tg_table_name = 'agents' then
    perform amux.require_actor_type(new.id, 'agent', 'agents.id');
  else
    raise exception 'amux.enforce_actor_subtype is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$$;


--
-- Name: enforce_core_team_integrity(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.enforce_core_team_integrity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_table_name = 'team_members' then
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.member_id),
      'team_members.member_id'
    );
  elsif tg_table_name = 'workspaces' then
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.created_by_member_id),
      'workspaces.created_by_member_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.agent_id),
      'workspaces.agent_id'
    );
  elsif tg_table_name = 'agents' then
    -- created_by_member_id was dropped in migration 0015; only workspace check remains.
    perform amux.require_same_team(
      amux.actor_team_id(new.id),
      amux.table_team_id('amux.workspaces'::regclass, new.default_workspace_id),
      'agents.default_workspace_id'
    );
  elsif tg_table_name = 'agent_member_access' then
    perform amux.require_same_team(
      amux.actor_team_id(new.agent_id),
      amux.actor_team_id(new.member_id),
      'agent_member_access.member_id'
    );
    perform amux.require_same_team(
      amux.actor_team_id(new.agent_id),
      amux.actor_team_id(new.granted_by_member_id),
      'agent_member_access.granted_by_member_id'
    );
  elsif tg_table_name = 'ideas' then
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.workspaces'::regclass, new.workspace_id),
      'ideas.workspace_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.ideas'::regclass, new.parent_idea_id),
      'ideas.parent_idea_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.created_by_actor_id),
      'ideas.created_by_actor_id'
    );
  elsif tg_table_name = 'idea_external_refs' then
    perform amux.require_same_team(
      amux.table_team_id('amux.ideas'::regclass, new.idea_id),
      amux.actor_team_id(new.linked_by_actor_id),
      'idea_external_refs.linked_by_actor_id'
    );
  elsif tg_table_name = 'sessions' then
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.ideas'::regclass, new.idea_id),
      'sessions.idea_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.created_by_actor_id),
      'sessions.created_by_actor_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.primary_agent_id),
      'sessions.primary_agent_id'
    );
  elsif tg_table_name = 'session_participants' then
    perform amux.require_same_team(
      amux.table_team_id('amux.sessions'::regclass, new.session_id),
      amux.actor_team_id(new.actor_id),
      'session_participants.actor_id'
    );
  elsif tg_table_name = 'messages' then
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.sessions'::regclass, new.session_id),
      'messages.session_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.sender_actor_id),
      'messages.sender_actor_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.messages'::regclass, new.reply_to_message_id),
      'messages.reply_to_message_id'
    );
  elsif tg_table_name = 'agent_runtimes' then
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.agent_id),
      'agent_runtimes.agent_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.sessions'::regclass, new.session_id),
      'agent_runtimes.session_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.workspaces'::regclass, new.workspace_id),
      'agent_runtimes.workspace_id'
    );
  else
    raise exception 'amux.enforce_core_team_integrity is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$$;


--
-- Name: enforce_parent_integrity(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.enforce_parent_integrity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_table_name = 'actors' then
    if new.actor_type is distinct from old.actor_type then
      if exists (select 1 from amux.members where id = new.id) and new.actor_type <> 'member' then
        raise exception 'actors.actor_type cannot diverge from members.id'
          using errcode = '23514';
      end if;

      if exists (select 1 from amux.agents where id = new.id) and new.actor_type <> 'agent' then
        raise exception 'actors.actor_type cannot diverge from agents.id'
          using errcode = '23514';
      end if;
    end if;

    if new.team_id is distinct from old.team_id then
      if exists (select 1 from amux.members where id = new.id)
        or exists (select 1 from amux.agents where id = new.id)
        or exists (select 1 from amux.team_members where member_id = new.id)
        or exists (select 1 from amux.workspaces where created_by_member_id = new.id or agent_id = new.id)
        or exists (select 1 from amux.agent_member_access where member_id = new.id or granted_by_member_id = new.id or agent_id = new.id)
        or exists (select 1 from amux.ideas where created_by_actor_id = new.id)
        or exists (select 1 from amux.idea_external_refs where linked_by_actor_id = new.id)
        or exists (select 1 from amux.sessions where created_by_actor_id = new.id or primary_agent_id = new.id)
        or exists (select 1 from amux.session_participants where actor_id = new.id)
        or exists (select 1 from amux.messages where sender_actor_id = new.id)
        or exists (select 1 from amux.agent_runtimes where agent_id = new.id) then
        perform amux.reject_team_reassignment('actors.team_id');
      end if;
    end if;
  elsif tg_table_name = 'workspaces' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from amux.agents where default_workspace_id = new.id)
        or old.agent_id is not null
        or exists (select 1 from amux.ideas where workspace_id = new.id)
        or exists (select 1 from amux.agent_runtimes where workspace_id = new.id)
      ) then
      perform amux.reject_team_reassignment('workspaces.team_id');
    end if;
  elsif tg_table_name = 'ideas' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from amux.ideas where parent_idea_id = new.id)
        or exists (select 1 from amux.idea_external_refs where idea_id = new.id)
        or exists (select 1 from amux.sessions where idea_id = new.id)
      ) then
      perform amux.reject_team_reassignment('ideas.team_id');
    end if;
  elsif tg_table_name = 'sessions' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from amux.session_participants where session_id = new.id)
        or exists (select 1 from amux.messages where session_id = new.id)
        or exists (select 1 from amux.agent_runtimes where session_id = new.id)
      ) then
      perform amux.reject_team_reassignment('sessions.team_id');
    end if;
  else
    raise exception 'amux.enforce_parent_integrity is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$$;


--
-- Name: ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.ensure_gateway_session(p_team_id uuid, p_binding text, p_title text, p_primary_agent_actor_id uuid, p_owner_member_actor_ids uuid[], p_participant_actor_ids uuid[]) RETURNS TABLE(session_id uuid, acp_session_id text, created boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'extensions'
    AS $$
declare
  v_session uuid;
  v_acp     text;
  v_created boolean := false;
begin
  select s.id, s.acp_session_id
    into v_session, v_acp
    from amux.sessions as s
   where s.team_id = p_team_id
     and s.binding = p_binding;

  if v_session is null then
    insert into amux.sessions
      (team_id, idea_id, created_by_actor_id, primary_agent_id,
       mode, title, binding, acp_session_id)
    values
      (p_team_id,
       null,
       p_primary_agent_actor_id,
       p_primary_agent_actor_id,
       'collab',
       p_title,
       p_binding,
       encode(extensions.gen_random_bytes(16), 'hex'))
    returning amux.sessions.id, amux.sessions.acp_session_id
      into v_session, v_acp;
    v_created := true;

    insert into amux.session_participants (session_id, actor_id)
      select v_session, participant_actor_id
        from unnest(
          array[p_primary_agent_actor_id]
            || coalesce(p_owner_member_actor_ids, '{}'::uuid[])
            || coalesce(p_participant_actor_ids,  '{}'::uuid[])
        ) as participant_actor_id
    on conflict on constraint session_participants_session_id_actor_id_key
    do nothing;
  end if;

  return query select v_session, v_acp, v_created;
end;
$$;


--
-- Name: ensure_org_default_team(uuid, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.ensure_org_default_team(p_org_id uuid, p_name text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_team uuid;
begin
  select id into v_team from amux.teams where oid = p_org_id order by created_at limit 1;
  if v_team is not null then
    return v_team;
  end if;
  insert into amux.teams (slug, name, oid)
  values ('org-' || replace(p_org_id::text, '-', ''), coalesce(p_name, 'Default'), p_org_id)
  returning id into v_team;
  return v_team;
end;
$$;


--
-- Name: ensure_personal_org(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.ensure_personal_org() RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth', 'extensions'
    AS $$
declare
  v_user uuid := auth.uid();
  v_org  uuid;
begin
  if v_user is null then
    raise exception 'ensure_personal_org requires an authenticated user' using errcode = '42501';
  end if;

  select org_id into v_org from public.users where id = v_user limit 1;
  if v_org is not null then
    return v_org;
  end if;

  insert into public.orgs (name) values ('Personal') returning id into v_org;
  begin
    insert into public.users (id, org_id, mobile) values (v_user, v_org, '');
  exception when unique_violation then
    -- lost a concurrent race: drop our org, reuse the winner's
    delete from public.orgs where id = v_org;
    select org_id into v_org from public.users where id = v_user limit 1;
  end;

  return v_org;
end;
$$;


--
-- Name: get_member_default_agent(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.get_member_default_agent(p_team_id uuid) RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_caller uuid := amux.current_actor_id_for_team(p_team_id);
  v_default uuid;
begin
  if v_caller is null then
    raise exception 'caller is not a member of this team'
      using errcode = '42501';
  end if;

  select m.default_agent_id into v_default
    from amux.members m
   where m.id = v_caller;

  return v_default;
end;
$$;


--
-- Name: get_team_sync_mode(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.get_team_sync_mode(p_team_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select sync_mode from amux.team_workspace_config where team_id = p_team_id
$$;


--
-- Name: guard_team_share_mode(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.guard_team_share_mode() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
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


--
-- Name: guard_team_workspace_sync_fields(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.guard_team_workspace_sync_fields() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
begin
  -- Service-role callers (direct DB writes, migrations, FC) are always allowed.
  if current_setting('role', true) = 'service_role' then
    return new;
  end if;

  -- Allow when the owner-only RPC (set_team_sync_mode) signals it's running.
  -- The RPC sets this LOCAL GUC after performing its own ownership check.
  if current_setting('amux.allow_sync_mode_switch', true) = 'on' then
    return new;
  end if;

  if new.sync_mode is distinct from old.sync_mode then
    raise exception 'team_workspace_config.sync_mode is service-role only (use amux.set_team_sync_mode)'
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


--
-- Name: FUNCTION guard_team_workspace_sync_fields(); Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON FUNCTION amux.guard_team_workspace_sync_fields() IS 'Enforces the §2.6 waterline invariant: sync_mode / oss_change_seq / litellm_team_id are mutable only by service_role (FC). Authenticated team members can update other columns.';


--
-- Name: is_current_agent(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.is_current_agent(p_agent_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select exists (
    select 1 from amux.actors a
     where a.id = p_agent_id
       and a.actor_type = 'agent'
       and a.user_id = auth.uid()
  )
$$;


--
-- Name: is_daemon(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.is_daemon() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select amux.current_jwt_kind() = 'daemon';
$$;


--
-- Name: is_session_participant(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.is_session_participant(target_session_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select amux.current_actor_id() is not null
    and exists (
      select 1
      from amux.sessions s
      where s.id = target_session_id
        and amux.is_team_member(s.team_id)
        and exists (
          select 1
          from amux.session_participants sp
          where sp.session_id = s.id
            and sp.actor_id = amux.current_actor_id()
        )
    )
$$;


--
-- Name: is_team_admin_or_owner(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.is_team_admin_or_owner(target_team_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $$
  select amux.current_team_role(target_team_id) in ('owner','admin')
$$;


--
-- Name: is_team_member(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.is_team_member(target_team_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select exists (
    select 1 from amux.actors
     where user_id = auth.uid() and team_id = target_team_id
  )
$$;


--
-- Name: join_session(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.join_session(p_session_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth', 'extensions'
    AS $$
declare
  v_team_id uuid;
  v_actor_id uuid;
begin
  select team_id into v_team_id from amux.sessions where id = p_session_id;
  if v_team_id is null then
    raise exception 'session not found' using errcode = 'no_data_found'; -- P0002
  end if;

  v_actor_id := amux.current_actor_id_for_team(v_team_id);
  if v_actor_id is null then
    raise exception 'not a member of this session''s team'
      using errcode = 'insufficient_privilege'; -- 42501
  end if;

  insert into amux.session_participants (session_id, actor_id, role)
  values (p_session_id, v_actor_id, 'member')
  on conflict (session_id, actor_id) do nothing;
end;
$$;


--
-- Name: jwt_memberships(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.jwt_memberships() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb)
      -> 'app_metadata' -> 'memberships',
    '[]'::jsonb
  );
$$;


--
-- Name: list_agent_admin_member_actor_ids(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.list_agent_admin_member_actor_ids(p_agent_actor_id uuid) RETURNS TABLE(member_actor_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $$
  select ama.member_id
    from amux.agent_member_access as ama
    join amux.agents as ag on ag.id = ama.agent_id
   where ama.agent_id = p_agent_actor_id
     and ama.permission_level = 'admin'
     and (
       p_agent_actor_id = amux.current_actor_id()
       or ag.owner_member_id = amux.current_actor_for_agent(p_agent_actor_id)
     )
   order by ama.created_at;
$$;


--
-- Name: list_all_my_teams(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.list_all_my_teams() RETURNS TABLE(team_id uuid, team_name text, team_slug text, org_id uuid, org_name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
  select t.id, t.name, t.slug, t.oid, o.name
    from amux.teams t
    left join public.orgs o on o.id = t.oid
   where exists (
     select 1 from amux.actors a
      where a.user_id = auth.uid() and a.team_id = t.id
   )
   order by o.name nulls last, t.created_at;
$$;


--
-- Name: list_connected_agents(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.list_connected_agents(p_team_id uuid) RETURNS TABLE(agent_id uuid, display_name text, agent_types jsonb, default_agent_type text, permission_level text, visibility text, is_owner boolean, device_id text, last_active_at timestamp with time zone)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select
    ag.id as agent_id,
    a.display_name,
    ag.agent_types,
    ag.default_agent_type,
    coalesce(ama.permission_level, case when amux.is_team_member(p_team_id) then 'view' end) as permission_level,
    ag.visibility,
    ag.owner_member_id = amux.current_actor_id_for_team(p_team_id) as is_owner,
    ag.device_id,
    a.last_active_at
  from amux.agents ag
  join amux.actors a on a.id = ag.id
  left join amux.agent_member_access ama
    on ama.agent_id = ag.id
   and ama.member_id = amux.current_actor_id_for_team(p_team_id)
  where a.team_id = p_team_id
    and ag.status = 'active'
    and (
      ag.visibility = 'team'
      or ag.owner_member_id = amux.current_actor_id_for_team(p_team_id)
      or ama.member_id is not null
    )
$$;


--
-- Name: list_current_actor_sessions(integer, timestamp with time zone, timestamp with time zone, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.list_current_actor_sessions(p_limit integer DEFAULT 50, p_before_last_message_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid) RETURNS TABLE(id uuid, title text, team_id uuid, mode text, idea_id uuid, last_message_at timestamp with time zone, last_message_preview text, created_at timestamp with time zone, updated_at timestamp with time zone, has_unread boolean)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'app'
    AS $$
  with current_actor as (
    select amux.current_actor_id() as actor_id
  )
  select
    s.id,
    s.title,
    s.team_id,
    s.mode,
    s.idea_id,
    s.last_message_at,
    s.last_message_preview,
    s.created_at,
    s.updated_at,
    (
      s.last_message_at is not null
      and s.last_message_at > coalesce(srm.last_read_at, '-infinity'::timestamptz)
    ) as has_unread
  from amux.sessions s
  cross join current_actor ca
  left join amux.session_read_markers srm
    on srm.session_id = s.id
   and srm.actor_id = ca.actor_id
  where amux.is_session_participant(s.id)
    and s.archived_at is null
    and (
      p_before_id is null
      or (
        case
          when p_before_last_message_at is null then
            s.last_message_at is not null
            or (
              s.last_message_at is null
              and (
                s.created_at < p_before_created_at
                or (s.created_at = p_before_created_at and s.id < p_before_id)
              )
            )
          when s.last_message_at is null then false
          when s.last_message_at < p_before_last_message_at then true
          when s.last_message_at = p_before_last_message_at then
            s.created_at < p_before_created_at
            or (s.created_at = p_before_created_at and s.id < p_before_id)
          else false
        end
      )
    )
  order by
    s.last_message_at desc nulls first,
    s.created_at desc,
    s.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;


--
-- Name: list_my_teams_current_org(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.list_my_teams_current_org() RETURNS TABLE(id uuid, name text, slug text, created_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth', 'extensions'
    AS $$
  select t.id, t.name, t.slug, t.created_at
    from amux.teams t
   where t.oid is not distinct from amux.current_org_id()
     and exists (
       select 1 from amux.actors a
        where a.user_id = auth.uid()
          and a.team_id = t.id
     )
   order by t.created_at;
$$;


--
-- Name: list_session_push_targets(uuid, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.list_session_push_targets(p_session_id uuid, p_exclude_actor_id uuid) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with sender as (
    select coalesce(display_name, 'Someone') as display_name
      from amux.actors where id = p_exclude_actor_id
  ),
  recipients as (
    select
      a.user_id,
      coalesce(
        (select jsonb_agg(jsonb_build_object(
            'provider', dpt.provider,
            'token',    dpt.token,
            'device_id', dpt.device_id))
           from amux.device_push_tokens dpt
          where dpt.user_id = a.user_id
            and dpt.revoked_at is null),
        '[]'::jsonb
      ) as tokens,
      coalesce(
        (select to_jsonb(np)
           from amux.notification_prefs np
          where np.user_id = a.user_id),
        jsonb_build_object('enabled', true)
      ) as prefs,
      coalesce(
        (select jsonb_agg(jsonb_build_object(
            'device_id',        cp.device_id,
            'foreground_until', cp.foreground_until))
           from amux.client_presence cp
          where cp.user_id = a.user_id
            and cp.foreground_until > now()),
        '[]'::jsonb
      ) as presence,
      exists(
        select 1 from amux.session_mutes sm
         where sm.user_id = a.user_id
           and sm.session_id = p_session_id
      ) as muted
    from amux.session_participants sp
    join amux.actors a on a.id = sp.actor_id
    where sp.session_id = p_session_id
      and sp.actor_id <> p_exclude_actor_id
      and a.user_id is not null
      and a.actor_type = 'member'
  )
  select jsonb_build_object(
    'sender_display_name', (select display_name from sender),
    'recipients', coalesce(
       (select jsonb_agg(to_jsonb(r)) from recipients r),
       '[]'::jsonb)
  );
$$;


--
-- Name: make_agent_personal(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.make_agent_personal(p_agent_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth', 'app'
    AS $$
declare
  v_owner uuid;
begin
  select owner_member_id into v_owner
    from amux.agents
   where id = p_agent_id;

  if v_owner is null or v_owner <> amux.current_actor_for_agent(p_agent_id) then
    raise exception 'only agent owner can make agent personal'
      using errcode = '42501';
  end if;

  update amux.agents
     set visibility = 'personal',
         updated_at = now()
   where id = p_agent_id;

  delete from amux.agent_member_access
   where agent_id = p_agent_id
     and member_id <> v_owner;

  insert into amux.agent_member_access (
    agent_id,
    member_id,
    permission_level,
    granted_by_member_id
  )
  values (p_agent_id, v_owner, 'admin', v_owner)
  on conflict (agent_id, member_id) do update
    set permission_level = 'admin',
        granted_by_member_id = excluded.granted_by_member_id,
        updated_at = now();
end;
$$;


--
-- Name: mark_current_actor_session_viewed(uuid, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.mark_current_actor_session_viewed(p_session_id uuid, p_last_read_message_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'amux', 'public', 'app'
    AS $$
declare
  v_actor_id uuid := amux.current_actor_id();
begin
  if v_actor_id is null then
    raise exception 'no current actor' using errcode = '42501';
  end if;

  if not amux.is_session_participant(p_session_id) then
    raise exception 'not a session participant' using errcode = '42501';
  end if;

  insert into amux.session_read_markers (
    session_id,
    actor_id,
    last_read_at,
    last_read_message_id
  )
  values (
    p_session_id,
    v_actor_id,
    now(),
    p_last_read_message_id
  )
  on conflict (session_id, actor_id)
  do update set
    last_read_at = excluded.last_read_at,
    last_read_message_id = excluded.last_read_message_id;
end;
$$;


--
-- Name: member_can_access_permission(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.member_can_access_permission(target_permission_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $$
  select case
    when not exists (
      select 1 from amux.permission_roles where permission_id = target_permission_id
    ) then true
    else exists (
      select 1
      from amux.permission_roles pr
      join amux.team_member_roles tmr on tmr.role_id = pr.role_id
      where pr.permission_id = target_permission_id
        and tmr.member_id = amux.current_member_id()
    )
  end
$$;


--
-- Name: member_can_see_shortcut(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.member_can_see_shortcut(target_shortcut_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $$
  with sc as (
    select scope, owner_member_id, team_id from amux.shortcuts where id = target_shortcut_id
  )
  select case
    when (select scope from sc) = 'personal'
      then (select owner_member_id from sc) = amux.current_member_id()
    when (select scope from sc) = 'team'
      then amux.is_team_member((select team_id from sc))
       and amux.member_can_access_permission((
         select id from amux.permissions
         where team_id = (select team_id from sc)
           and resource_type = 'shortcut'
           and resource_id = target_shortcut_id
       ))
  end
$$;


--
-- Name: notify_push_dispatch(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.notify_push_dispatch() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'push_webhook_secret'
   limit 1;

  -- Silently skip if secret not configured yet
  if v_secret is null then
    return new;
  end if;

  perform net.http_post(
    url     := 'https://cloud.ucar.cc/push/dispatch',
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'x-webhook-secret', v_secret
    ),
    body    := jsonb_build_object(
      'type',   'INSERT',
      'table',  'messages',
      'record', row_to_json(new)
    )
  );

  return new;
end;
$$;


--
-- Name: oss_sync_abandon_expired_sessions(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.oss_sync_abandon_expired_sessions() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
begin
  update amux.amuxc_upload_sessions
     set status = 'abandoned'
   where status = 'pending'
     and expires_at < now();

  delete from amux.amuxc_upload_sessions
   where status = 'abandoned'
     and expires_at < now() - interval '24 hours';
end;
$$;


--
-- Name: oss_sync_gc_orphan_blobs(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.oss_sync_gc_orphan_blobs() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_deleted int;
begin
  with orphan as (
    select b.team_id, b.content_hash
      from amux.amuxc_blobs b
     where b.created_at < now() - interval '7 days'
       and not exists (
         select 1 from amux.amuxc_file_versions v
          join amux.amuxc_files f on f.id = v.file_id
          where f.team_id = b.team_id
            and v.content_hash = b.content_hash
       )
  )
  delete from amux.amuxc_blobs b
   using orphan
   where b.team_id = orphan.team_id
     and b.content_hash = orphan.content_hash;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;


--
-- Name: push_idempotency_claim(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.push_idempotency_claim(p_message_id uuid) RETURNS TABLE(claimed boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into amux.push_idempotency(message_id) values (p_message_id)
  on conflict do nothing;
  return query select found;
end;
$$;


--
-- Name: reject_team_reassignment(text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.reject_team_reassignment(p_context text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  raise exception '% cannot change team_id while dependent rows exist', p_context
    using errcode = '23514';
end;
$$;


--
-- Name: remove_team_actor(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.remove_team_actor(p_actor_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth', 'app'
    AS $$
declare
  v_team_id uuid;
  v_actor_type text;
  v_caller_actor uuid := amux.current_actor_id();
  v_owned_agent_id uuid;
begin
  if v_caller_actor is null then
    raise exception 'remove_team_actor requires authentication'
      using errcode = '42501';
  end if;

  select team_id, actor_type
    into v_team_id, v_actor_type
  from public.actors
  where id = p_actor_id;

  if v_team_id is null then
    raise exception 'actor not found'
      using errcode = '23503';
  end if;

  if v_caller_actor = p_actor_id then
    raise exception 'cannot remove your own actor'
      using errcode = '42501';
  end if;

  if amux.current_team_role(v_team_id) not in ('owner', 'admin') then
    raise exception 'remove_team_actor requires owner or admin'
      using errcode = '42501';
  end if;

  if v_actor_type = 'member' and exists (
    select 1 from public.team_members
     where team_id = v_team_id and member_id = p_actor_id and role = 'owner'
  ) then
    if (select count(*) from public.team_members
          where team_id = v_team_id and role = 'owner') <= 1 then
      raise exception 'cannot remove the last owner'
        using errcode = '23514';
    end if;
  end if;

  -- Member removal: cascade-delete agents they own before dropping the member row.
  if v_actor_type = 'member' then
    delete from public.daemon_invites
     where created_by_member_id = p_actor_id;

    for v_owned_agent_id in
      select id from public.agents where owner_member_id = p_actor_id
    loop
      delete from public.agent_member_access
       where agent_id = v_owned_agent_id or member_id = v_owned_agent_id;

      delete from public.team_members
       where member_id = v_owned_agent_id;

      -- actors delete cascades to agents (agents.id -> actors.id).
      delete from public.actors where id = v_owned_agent_id;
    end loop;
  end if;

  delete from public.agent_member_access
   where agent_id = p_actor_id or member_id = p_actor_id;

  delete from public.team_members where member_id = p_actor_id;

  if v_actor_type = 'member' then
    delete from public.members where id = p_actor_id;
  else
    delete from public.agents where id = p_actor_id;
  end if;

  delete from public.actors where id = p_actor_id;
end;
$$;


--
-- Name: rename_team(uuid, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.rename_team(p_team_id uuid, p_name text) RETURNS TABLE(team_id uuid, team_name text, team_slug text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_new_name text;
begin
  if v_user_id is null then
    raise exception 'rename_team requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_team_id is null then
    raise exception 'team id is required'
      using errcode = '22023';
  end if;

  v_new_name := btrim(coalesce(p_name, ''));
  if v_new_name = '' then
    raise exception 'team name is required'
      using errcode = '22023';
  end if;

  if length(v_new_name) > 80 then
    raise exception 'team name too long (max 80 characters)'
      using errcode = '22001';
  end if;

  -- Caller must be an active owner or admin of the team.
  select tm.role
  into v_role
  from amux.team_members tm
  join amux.members m on m.id = tm.member_id
  where tm.team_id = p_team_id
    and m.user_id = v_user_id
    and m.status = 'active'
  limit 1;

  if v_role is null then
    raise exception 'not a member of this team'
      using errcode = '42501';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'only team owners or admins can rename the team'
      using errcode = '42501';
  end if;

  update amux.teams
  set name = v_new_name
  where id = p_team_id;

  return query
  select
    t.id,
    t.name,
    t.slug
  from amux.teams t
  where t.id = p_team_id;
end;
$$;


--
-- Name: reorder_ideas(uuid, uuid[]); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.reorder_ideas(p_team_id uuid, p_idea_ids uuid[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
begin
  if p_team_id is null or not amux.is_team_member(p_team_id) then
    raise exception 'reorder_ideas requires team membership'
      using errcode = '42501';
  end if;

  if p_idea_ids is null then
    return;
  end if;

  if exists (
    select 1
    from unnest(p_idea_ids) as ordered(id)
    left join amux.ideas i
      on i.id = ordered.id
     and i.team_id = p_team_id
     and i.archived = false
    where i.id is null
  ) then
    raise exception 'reorder_ideas contains an invalid idea'
      using errcode = '23503';
  end if;

  update amux.ideas i
  set sort_order = ordered.ordinality::integer * 1000
  from unnest(p_idea_ids) with ordinality as ordered(id, ordinality)
  where i.id = ordered.id
    and i.team_id = p_team_id
    and i.archived = false;
end;
$$;


--
-- Name: report_client_version(uuid, text, text, text, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.report_client_version(p_team_id uuid, p_client_type text, p_version text, p_device_id text, p_build text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_caller uuid := amux.current_actor_id_for_team(p_team_id);
begin
  if v_caller is null then
    raise exception 'caller is not a member of this team' using errcode = '42501';
  end if;
  if p_client_type not in ('tauri','ios','expo','daemon') then
    raise exception 'invalid client_type' using errcode = '23514';
  end if;

  insert into amux.actor_client_versions
    (actor_id, team_id, client_type, device_id, version, build, last_reported_at)
  values
    (v_caller, p_team_id, p_client_type, p_device_id, p_version, p_build, now())
  on conflict (actor_id, client_type, device_id) do update
    set version = excluded.version,
        build = excluded.build,
        last_reported_at = now();
end;
$$;


--
-- Name: require_actor_type(uuid, text, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.require_actor_type(p_actor_id uuid, p_expected_type text, p_context text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'amux', 'public'
    AS $$
declare
  v_actor_type text;
begin
  if p_actor_id is null then
    return;
  end if;

  select actor_type
  into v_actor_type
  from amux.actors
  where id = p_actor_id;

  if v_actor_type is null then
    return;
  end if;

  if v_actor_type <> p_expected_type then
    raise exception '% requires actor_type = %', p_context, p_expected_type
      using errcode = '23514',
            detail = format(
              'Actor %s has actor_type %s',
              p_actor_id,
              v_actor_type
            );
  end if;
end;
$$;


--
-- Name: require_same_team(uuid, uuid, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.require_same_team(p_expected_team_id uuid, p_actual_team_id uuid, p_context text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if p_expected_team_id is null or p_actual_team_id is null then
    return;
  end if;

  if p_expected_team_id is distinct from p_actual_team_id then
    raise exception '% violates team scoping', p_context
      using errcode = '23514',
            detail = format(
              'Expected team %s but found team %s',
              p_expected_team_id,
              p_actual_team_id
            );
  end if;
end;
$$;


--
-- Name: set_member_default_agent(uuid, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.set_member_default_agent(p_team_id uuid, p_agent_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_caller     uuid := amux.current_actor_id_for_team(p_team_id);
  v_agent_team uuid;
  v_actor_type text;
  v_status     text;
  v_visibility text;
  v_owner      uuid;
begin
  if v_caller is null then
    raise exception 'caller is not a member of this team'
      using errcode = '42501';
  end if;

  if p_agent_id is not null then
    select a.team_id, a.actor_type, ag.status, ag.visibility, ag.owner_member_id
      into v_agent_team, v_actor_type, v_status, v_visibility, v_owner
      from amux.actors a
      join amux.agents ag on ag.id = a.id
     where a.id = p_agent_id;

    if v_agent_team is null or v_actor_type <> 'agent' or v_agent_team <> p_team_id then
      raise exception 'agent is not in this team' using errcode = '23514';
    end if;

    if v_status <> 'active' then
      raise exception 'agent is not active' using errcode = '23514';
    end if;

    -- Visibility gate: team-visible agents are fine; personal agents only when
    -- the caller owns them.
    if v_visibility <> 'team' and v_owner is distinct from v_caller then
      raise exception 'agent is not visible to caller' using errcode = '42501';
    end if;
  end if;

  update amux.members m
     set default_agent_id = p_agent_id,
         updated_at = now()
   where m.id = v_caller;

  if not found then
    raise exception 'member not found' using errcode = '23503';
  end if;

  return p_agent_id;
end;
$$;


--
-- Name: set_team_sync_mode(uuid, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.set_team_sync_mode(p_team_id uuid, p_mode text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_actor_id uuid;
  v_role text;
begin
  if p_mode not in ('git', 'oss') then
    raise exception 'invalid sync_mode: %', p_mode using errcode = '22023';
  end if;

  v_actor_id := amux.current_actor_id_for_team(p_team_id);
  if v_actor_id is null then
    raise exception 'caller is not a member of team %', p_team_id
      using errcode = '42501';
  end if;

  select tm.role into v_role
    from amux.team_members tm
   where tm.team_id = p_team_id and tm.member_id = v_actor_id;

  if v_role <> 'owner' then
    raise exception 'only team owners may switch sync_mode (caller role=%)', coalesce(v_role, 'null')
      using errcode = '42501';
  end if;

  -- Signal the guard trigger that this update is coming from the owner-only RPC.
  -- SET LOCAL auto-reverts after this sub-transaction / function call.
  perform set_config('amux.allow_sync_mode_switch', 'on', true);

  update amux.team_workspace_config
     set sync_mode = p_mode
   where team_id = p_team_id;

  -- Clear the flag immediately after the update (belt-and-suspenders).
  perform set_config('amux.allow_sync_mode_switch', 'off', true);

  return p_mode;
end;
$$;


--
-- Name: share_agent_to_team(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.share_agent_to_team(p_agent_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth', 'app'
    AS $$
begin
  if not exists (
    select 1
      from amux.agents ag
     where ag.id = p_agent_id
       and ag.owner_member_id = amux.current_actor_for_agent(p_agent_id)
  ) then
    raise exception 'only agent owner can share agent to team'
      using errcode = '42501';
  end if;

  update amux.agents
     set visibility = 'team',
         updated_at = now()
   where id = p_agent_id;
end;
$$;


--
-- Name: shortcut_batch_move(jsonb); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.shortcut_batch_move(p_moves jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'app'
    AS $$
declare v_count int;
begin
  update amux.shortcuts s set
    parent_id  = nullif(m->>'parent_id','')::uuid,
    "order"    = (m->>'order')::int,
    updated_at = now()
  from jsonb_array_elements(p_moves) m
  where s.id = (m->>'id')::uuid
    and (
      (s.scope = 'personal' and s.owner_member_id = amux.current_member_id())
      or (s.scope = 'team'  and amux.is_team_admin_or_owner(s.team_id))
    );
  get diagnostics v_count = row_count;
  return v_count;
end $$;


--
-- Name: shortcut_create(text, text, text, uuid, uuid, text, integer, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.shortcut_create(p_scope text, p_label text, p_node_type text, p_team_id uuid DEFAULT NULL::uuid, p_parent_id uuid DEFAULT NULL::uuid, p_icon text DEFAULT NULL::text, p_order integer DEFAULT 0, p_target text DEFAULT ''::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'app'
    AS $$
declare
  v_id uuid;
  v_member uuid := amux.current_member_id();
begin
  if v_member is null then
    raise exception 'not authenticated';
  end if;

  if p_scope = 'personal' then
    insert into amux.shortcuts (scope, owner_member_id, parent_id, label, icon, "order", node_type, target)
    values ('personal', v_member, p_parent_id, p_label, p_icon, p_order, p_node_type, p_target)
    returning id into v_id;
  elsif p_scope = 'team' then
    if p_team_id is null then
      raise exception 'team_id required for team scope';
    end if;
    if not amux.is_team_admin_or_owner(p_team_id) then
      raise exception 'forbidden';
    end if;
    insert into amux.shortcuts (scope, team_id, parent_id, label, icon, "order", node_type, target)
    values ('team', p_team_id, p_parent_id, p_label, p_icon, p_order, p_node_type, p_target)
    returning id into v_id;
    insert into amux.permissions (team_id, resource_type, resource_id, code)
    values (p_team_id, 'shortcut', v_id, 'shortcut:' || v_id::text);
  else
    raise exception 'invalid scope: %', p_scope;
  end if;

  return v_id;
end $$;


--
-- Name: shortcut_set_visible_roles(uuid, uuid[]); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.shortcut_set_visible_roles(p_shortcut_id uuid, p_role_ids uuid[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'app'
    AS $$
declare v_team uuid; v_perm uuid;
begin
  select team_id into v_team from amux.shortcuts
    where id = p_shortcut_id and scope = 'team';
  if v_team is null then
    raise exception 'shortcut not found or not team-scoped';
  end if;
  if not amux.is_team_admin_or_owner(v_team) then
    raise exception 'forbidden';
  end if;
  select id into v_perm from amux.permissions
    where team_id = v_team and resource_type = 'shortcut' and resource_id = p_shortcut_id;
  if v_perm is null then
    raise exception 'permission row missing for shortcut %', p_shortcut_id;
  end if;
  delete from amux.permission_roles where permission_id = v_perm;
  if array_length(p_role_ids, 1) is not null then
    insert into amux.permission_roles (permission_id, role_id)
      select v_perm, unnest(p_role_ids);
  end if;
end $$;


--
-- Name: switch_active_team(uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.switch_active_team(p_team_id uuid) RETURNS TABLE(actor_id uuid, team_id uuid, refresh_token text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth', 'app'
    AS $$
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
    -- 幂等 upsert（race-safe）：仲裁器须带 uq_users_id 的 partial 谓词。
    insert into public.users (id, org_id, mobile) values (v_user_id, v_team_org, '')
    on conflict (id) do update
      set org_id = excluded.org_id, updated_at = now();
  end if;

  v_rt := auth._mint_session(v_user_id);
  update amux.actors set last_active_at = now(), updated_at = now() where id = v_actor;

  return query select v_actor, p_team_id, v_rt;
end;
$$;


--
-- Name: table_team_id(regclass, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.table_team_id(p_table regclass, p_id uuid) RETURNS uuid
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $_$
declare
  v_team_id uuid;
begin
  if p_id is null then
    return null;
  end if;

  execute format('select team_id from %s where id = $1', p_table)
    into v_team_id
    using p_id;

  return v_team_id;
end;
$_$;


--
-- Name: team_leaderboard(uuid, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.team_leaderboard(p_team_id uuid, p_period text DEFAULT 'week'::text) RETURNS TABLE(team_id uuid, actor_id uuid, display_name text, period text, tokens_used bigint, cost_usd numeric, positive_feedback bigint, negative_feedback bigint, session_count bigint, skill_usage jsonb, score numeric)
    LANGUAGE sql STABLE
    AS $$
  with bounds as (
    select case p_period
      when 'day'   then now() - interval '1 day'
      when 'week'  then now() - interval '7 days'
      when 'month' then now() - interval '30 days'
      else              now() - interval '7 days'
    end as since
  ),
  reports as (
    select r.actor_id,
           sum(r.tokens_used)::bigint   as tokens_used,
           sum(r.cost_usd)::numeric     as cost_usd,
           count(*)::bigint             as session_count
    from amux.actor_session_report r, bounds b
    where r.team_id = p_team_id and r.created_at >= b.since
    group by r.actor_id
  ),
  fb as (
    select f.actor_id,
           sum((f.kind = 'positive')::int)::bigint as positive_feedback,
           sum((f.kind = 'negative')::int)::bigint as negative_feedback
    from amux.actor_message_feedback f, bounds b
    where f.team_id = p_team_id and f.created_at >= b.since
    group by f.actor_id
  ),
  skills as (
    select s.actor_id,
           jsonb_object_agg(s.skill, s.cnt) as skill_usage
    from (
      select su.actor_id, su.skill, sum(su.count)::bigint as cnt
      from amux.actor_skill_usage su, bounds b
      where su.team_id = p_team_id and su.created_at >= b.since
      group by su.actor_id, su.skill
    ) s
    group by s.actor_id
  )
  select
    a.team_id,
    a.id                                          as actor_id,
    a.display_name,
    p_period                                      as period,
    coalesce(reports.tokens_used, 0)              as tokens_used,
    coalesce(reports.cost_usd, 0)                 as cost_usd,
    coalesce(fb.positive_feedback, 0)             as positive_feedback,
    coalesce(fb.negative_feedback, 0)             as negative_feedback,
    coalesce(reports.session_count, 0)            as session_count,
    coalesce(skills.skill_usage, '{}'::jsonb)     as skill_usage,
    -- score = tokens_used (placeholder ranking key; cost-weighted formula TBD)
    coalesce(reports.tokens_used, 0)::numeric     as score
  from amux.actors a
  left join reports on reports.actor_id = a.id
  left join fb      on fb.actor_id      = a.id
  left join skills  on skills.actor_id  = a.id
  where a.team_id = p_team_id;
$$;


--
-- Name: team_member_set_roles(uuid, uuid, uuid[]); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.team_member_set_roles(p_team_id uuid, p_member_id uuid, p_role_ids uuid[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'app'
    AS $$
begin
  if not amux.is_team_admin_or_owner(p_team_id) then
    raise exception 'forbidden';
  end if;
  delete from amux.team_member_roles
    where team_id = p_team_id and member_id = p_member_id;
  if array_length(p_role_ids, 1) is not null then
    insert into amux.team_member_roles (team_id, member_id, role_id)
      select p_team_id, p_member_id, unnest(p_role_ids);
  end if;
end $$;


--
-- Name: update_actor_last_active(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.update_actor_last_active() RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  update amux.actors
     set last_active_at = now(), updated_at = now()
   where user_id = auth.uid();
$$;


--
-- Name: update_agent_defaults(uuid, uuid, text, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.update_agent_defaults(p_agent_id uuid, p_default_workspace_id uuid DEFAULT NULL::uuid, p_agent_kind text DEFAULT NULL::text, p_default_agent_type text DEFAULT NULL::text) RETURNS TABLE(agent_id uuid, default_workspace_id uuid, agent_types jsonb, default_agent_type text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_team_id          uuid;
  v_caller           uuid := auth.uid();
  v_new_backend      text := nullif(btrim(coalesce(p_default_agent_type, '')), '');
begin
  if v_caller is null then
    raise exception 'update_agent_defaults requires authentication'
      using errcode = '42501';
  end if;

  select a.team_id into v_team_id
    from amux.actors a
   where a.id = p_agent_id and a.actor_type = 'agent';

  if v_team_id is null then
    raise exception 'agent not found' using errcode = '23503';
  end if;

  if not amux.is_team_member(v_team_id) then
    raise exception 'caller is not a member of the agent team'
      using errcode = '42501';
  end if;

  if p_default_workspace_id is not null then
    if not exists (
      select 1 from amux.workspaces w
       where w.id = p_default_workspace_id and w.team_id = v_team_id
    ) then
      raise exception 'workspace is not in the agent team'
        using errcode = '23514';
    end if;
  end if;

  if v_new_backend in ('claude_code', 'claude-code') then
    v_new_backend := 'claude';
  end if;

  if v_new_backend is not null
     and v_new_backend not in ('opencode', 'codex', 'claude', 'pi') then
    raise exception 'invalid default_agent_type: must be opencode, codex, claude, or pi'
      using errcode = '23514';
  end if;

  if v_new_backend is not null and not exists (
    select 1 from amux.agents ag, jsonb_array_elements_text(ag.agent_types) t(value)
     where ag.id = p_agent_id and t.value = v_new_backend
  ) then
    raise exception 'default_agent_type must be one of agent_types'
      using errcode = '23514';
  end if;

  update amux.agents ag
     set default_workspace_id = coalesce(p_default_workspace_id, ag.default_workspace_id),
         default_agent_type   = coalesce(v_new_backend, ag.default_agent_type),
         updated_at           = now()
   where ag.id = p_agent_id;

  if not found then
    raise exception 'agent row missing' using errcode = '23503';
  end if;

  return query
  select ag.id, ag.default_workspace_id, ag.agent_types, ag.default_agent_type
    from amux.agents ag
   where ag.id = p_agent_id;
end;
$$;


--
-- Name: update_audit_columns(); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.update_audit_columns() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at := current_timestamp;
  begin
    new.updated_by := auth.uid();
  exception when others then
    -- auth.uid() may be unavailable outside a request context; leave as-is
    null;
  end;
  return new;
end;
$$;


--
-- Name: update_current_actor_profile(uuid, text, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.update_current_actor_profile(p_actor_id uuid, p_display_name text, p_avatar_url text DEFAULT NULL::text) RETURNS TABLE(id uuid, team_id uuid, actor_type text, user_id uuid, invited_by_actor_id uuid, display_name text, avatar_url text, last_active_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone, member_status text, team_role text, agent_types jsonb, default_agent_type text, agent_status text, default_workspace_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_display_name text := nullif(btrim(p_display_name), '');
  v_avatar_url text := nullif(btrim(coalesce(p_avatar_url, '')), '');
begin
  if v_display_name is null then
    raise exception 'display name is required'
      using errcode = '23514';
  end if;

  update amux.actors a
     set display_name = v_display_name,
         avatar_url = v_avatar_url,
         updated_at = now()
   where a.id = p_actor_id
     and a.actor_type = 'member'
     and a.user_id = auth.uid();

  if not found then
    raise exception 'actor profile update is not allowed'
      using errcode = '42501';
  end if;

  return query
  select
    ad.id, ad.team_id, ad.actor_type, ad.user_id, ad.invited_by_actor_id,
    ad.display_name, ad.avatar_url, ad.last_active_at, ad.created_at, ad.updated_at,
    ad.member_status, ad.team_role, ad.agent_types, ad.default_agent_type,
    ad.agent_status, ad.default_workspace_id
  from amux.actor_directory ad
  where ad.id = p_actor_id;
end;
$$;


--
-- Name: update_idea(uuid, text, uuid, text, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.update_idea(p_idea_id uuid, p_title text, p_workspace_id uuid DEFAULT NULL::uuid, p_description text DEFAULT ''::text, p_status text DEFAULT 'open'::text) RETURNS TABLE(id uuid, team_id uuid, workspace_id uuid, created_by_actor_id uuid, title text, description text, status text, archived boolean, sort_order integer, created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_idea_team_id uuid;
  v_workspace_team_id uuid;
begin
  if amux.current_actor_id() is null then
    raise exception 'update_idea requires an authenticated member'
      using errcode = '42501';
  end if;

  if p_idea_id is null then
    raise exception 'idea id is required'
      using errcode = '22023';
  end if;

  if p_title is null or btrim(p_title) = '' then
    raise exception 'title is required'
      using errcode = '22023';
  end if;

  select t.team_id
  into v_idea_team_id
  from amux.ideas t
  where t.id = p_idea_id;

  if v_idea_team_id is null then
    raise exception 'idea not found'
      using errcode = '23503';
  end if;

  if not amux.is_team_member(v_idea_team_id) then
    raise exception 'update_idea requires team membership'
      using errcode = '42501';
  end if;

  if p_workspace_id is not null then
    select w.team_id
    into v_workspace_team_id
    from amux.workspaces w
    where w.id = p_workspace_id
      and w.archived = false;

    if v_workspace_team_id is null then
      raise exception 'workspace not found'
        using errcode = '23503';
    end if;

    if v_workspace_team_id <> v_idea_team_id then
      raise exception 'workspace does not belong to the idea team'
        using errcode = '23514';
    end if;
  end if;

  return query
  update amux.ideas
  set
    workspace_id = p_workspace_id,
    title = btrim(p_title),
    description = coalesce(p_description, ''),
    status = p_status
  where ideas.id = p_idea_id
  returning
    ideas.id,
    ideas.team_id,
    ideas.workspace_id,
    ideas.created_by_actor_id,
    ideas.title,
    ideas.description,
    ideas.status,
    ideas.archived,
    ideas.sort_order,
    ideas.created_at,
    ideas.updated_at;
end;
$$;


--
-- Name: update_owned_agent_profile(uuid, text, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.update_owned_agent_profile(p_agent_id uuid, p_display_name text, p_visibility text DEFAULT NULL::text) RETURNS TABLE(agent_id uuid, display_name text, visibility text, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth', 'app'
    AS $$
declare
  v_display_name text := nullif(btrim(p_display_name), '');
  v_visibility text := nullif(btrim(coalesce(p_visibility, '')), '');
begin
  if v_display_name is null then
    raise exception 'display name is required'
      using errcode = '23514';
  end if;

  if v_visibility is not null and v_visibility not in ('personal', 'team') then
    raise exception 'visibility must be personal or team'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
      from amux.agents ag
     where ag.id = p_agent_id
       and ag.owner_member_id = amux.current_actor_for_agent(p_agent_id)
  ) then
    raise exception 'only agent owner can update agent profile'
      using errcode = '42501';
  end if;

  update amux.actors a
     set display_name = v_display_name,
         updated_at = now()
   where a.id = p_agent_id
     and a.actor_type = 'agent';

  update amux.agents ag
     set visibility = coalesce(v_visibility, ag.visibility),
         updated_at = now()
   where ag.id = p_agent_id;

  return query
  select ag.id, a.display_name, ag.visibility, greatest(a.updated_at, ag.updated_at)
    from amux.agents ag
    join amux.actors a on a.id = ag.id
   where ag.id = p_agent_id;
end;
$$;


--
-- Name: update_team_litellm(uuid, text, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.update_team_litellm(p_team_id uuid, p_litellm_team_id text, p_ai_gateway_endpoint text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
begin
  perform set_config('amux.allow_sync_mode_switch', 'on', true);

  insert into amux.team_workspace_config (team_id, litellm_team_id, ai_gateway_endpoint)
       values (p_team_id, p_litellm_team_id, p_ai_gateway_endpoint)
  on conflict (team_id) do update
       set litellm_team_id     = excluded.litellm_team_id,
           ai_gateway_endpoint = excluded.ai_gateway_endpoint;

  perform set_config('amux.allow_sync_mode_switch', 'off', true);
end
$$;


--
-- Name: upgrade_account_to_org(uuid, text, text, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.upgrade_account_to_org(p_team_id uuid, p_org_name text, p_contact text DEFAULT NULL::text, p_default_org_id uuid DEFAULT NULL::uuid) RETURNS TABLE(org_id uuid, team_id uuid, team_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_user_id   uuid := auth.uid();
  v_member_id uuid;
  v_org_id    uuid := gen_random_uuid();
  v_team_oid  uuid;
  v_mobile    text;
  v_name      text := btrim(p_org_name);
begin
  if v_user_id is null then
    raise exception 'upgrade requires an authenticated user' using errcode = '42501';
  end if;
  if v_name is null or v_name = '' then
    raise exception 'org name is required' using errcode = '23514';
  end if;

  -- Caller must be the OWNER of the team being upgraded.
  select tm.member_id into v_member_id
  from amux.team_members tm
  join amux.actors a on a.id = tm.member_id
  where tm.team_id = p_team_id and a.user_id = v_user_id and tm.role = 'owner'
  limit 1;
  if v_member_id is null then
    raise exception 'only the team owner can upgrade' using errcode = '42501';
  end if;

  -- The team must currently live in the default org (idempotency / re-upgrade guard).
  select oid into v_team_oid from amux.teams where id = p_team_id;
  if p_default_org_id is not null and v_team_oid is distinct from p_default_org_id then
    raise exception 'team already belongs to its own org' using errcode = '23514';
  end if;

  select mobile into v_mobile from public.users where id = v_user_id limit 1;

  -- 1. New org.
  insert into public.orgs (id, name, contact, phone)
  values (v_org_id, v_name, nullif(btrim(p_contact), ''), v_mobile);

  -- 2. Point the user's profile at the new org.
  update public.users set org_id = v_org_id where id = v_user_id;

  -- 3. Stamp the JWT org claim source so daemon / team-share resolve the new org.
  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('org_id', v_org_id::text)
  where id = v_user_id;

  -- 4. Reparent + rename the team.
  update amux.teams set oid = v_org_id, name = v_name where id = p_team_id;

  return query select v_org_id, p_team_id, v_name;
end;
$$;


--
-- Name: upsert_external_actor(uuid, text, text, text); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.upsert_external_actor(p_team_id uuid, p_source text, p_source_id text, p_display_name text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_actor uuid;
begin
  -- Try update first (cheap path: most calls are re-deliveries).
  update amux.actors
     set display_name   = p_display_name,
         last_active_at = now(),
         updated_at     = now()
   where team_id   = p_team_id
     and source    = p_source
     and source_id = p_source_id
  returning id into v_actor;

  if v_actor is not null then
    return v_actor;
  end if;

  insert into amux.actors
    (team_id, actor_type, source, source_id, display_name, last_active_at)
  values
    (p_team_id, 'external', p_source, p_source_id, p_display_name, now())
  returning id into v_actor;

  return v_actor;
exception when unique_violation then
  -- Race with a concurrent insert on the same (team_id, source, source_id).
  -- The other inserter won; pick up its row.
  select id into v_actor
    from amux.actors
   where team_id   = p_team_id
     and source    = p_source
     and source_id = p_source_id;
  return v_actor;
end;
$$;


--
-- Name: uuid_column_matches_existing(regclass, uuid, text, uuid); Type: FUNCTION; Schema: amux; Owner: -
--

CREATE FUNCTION amux.uuid_column_matches_existing(target_table regclass, target_id uuid, target_column text, target_value uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $_$
declare
  existing_value uuid;
begin
  if target_id is null then
    return false;
  end if;

  execute format('select %I from %s where id = $1', target_column, target_table)
    into existing_value
    using target_id;

  return target_value is not distinct from existing_value;
end;
$_$;


--
-- Name: actor_client_versions; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.actor_client_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid NOT NULL,
    team_id uuid NOT NULL,
    client_type text NOT NULL,
    device_id text NOT NULL,
    version text NOT NULL,
    build text,
    last_reported_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: actors; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.actors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    actor_type text NOT NULL,
    display_name text NOT NULL,
    last_active_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid,
    invited_by_actor_id uuid,
    source text,
    source_id text,
    avatar_url text,
    CONSTRAINT actors_actor_type_check CHECK ((actor_type = ANY (ARRAY['member'::text, 'agent'::text, 'external'::text]))),
    CONSTRAINT actors_external_has_source CHECK (((actor_type = 'external'::text) = ((source IS NOT NULL) AND (source_id IS NOT NULL))))
);


--
-- Name: agents; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.agents (
    id uuid NOT NULL,
    default_workspace_id uuid,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    device_id text,
    visibility text DEFAULT 'personal'::text NOT NULL,
    owner_member_id uuid NOT NULL,
    default_agent_type text,
    agent_types jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT agents_agent_types_array_check CHECK ((jsonb_typeof(agent_types) = 'array'::text)),
    CONSTRAINT agents_default_agent_type_check CHECK (((default_agent_type IS NULL) OR (default_agent_type = ANY (ARRAY['claude'::text, 'opencode'::text, 'codex'::text, 'pi'::text])))),
    CONSTRAINT agents_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'archived'::text]))),
    CONSTRAINT agents_visibility_check CHECK ((visibility = ANY (ARRAY['personal'::text, 'team'::text])))
);


--
-- Name: COLUMN agents.capabilities; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON COLUMN amux.agents.capabilities IS 'Reserved for future use: extensible JSONB config, e.g. a list of supported_backends the agent advertises, feature flags, or per-backend overrides. Not used for backend selection today — use default_agent_type instead.';


--
-- Name: COLUMN agents.default_agent_type; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON COLUMN amux.agents.default_agent_type IS 'Preferred runtime backend type when no explicit agent type is requested. Canonical values match agent_runtimes.backend_type: claude, opencode, codex.';


--
-- Name: COLUMN agents.agent_types; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON COLUMN amux.agents.agent_types IS 'Supported runtime backend types for this agent as a JSON array, e.g. ["claude","opencode","codex"]. Empty means the daemon has not advertised support yet.';


--
-- Name: members; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.members (
    id uuid NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    default_agent_id uuid,
    CONSTRAINT members_status_check CHECK ((status = ANY (ARRAY['invited'::text, 'active'::text, 'disabled'::text])))
);


--
-- Name: team_members; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.team_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    member_id uuid NOT NULL,
    role text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);


--
-- Name: actor_directory; Type: VIEW; Schema: amux; Owner: -
--

CREATE VIEW amux.actor_directory WITH (security_invoker='true') AS
 SELECT a.id,
    a.team_id,
    a.actor_type,
    a.user_id,
    a.invited_by_actor_id,
    a.display_name,
    a.avatar_url,
    a.last_active_at,
    a.created_at,
    a.updated_at,
    m.status AS member_status,
    tm.role AS team_role,
    ag.agent_types,
    ag.default_agent_type,
    ag.default_workspace_id,
    ag.visibility AS agent_visibility,
    ag.status AS agent_status,
    c.email AS user_email,
    c.phone AS user_phone
   FROM ((((amux.actors a
     LEFT JOIN amux.members m ON ((m.id = a.id)))
     LEFT JOIN amux.team_members tm ON ((tm.member_id = a.id)))
     LEFT JOIN amux.agents ag ON ((ag.id = a.id)))
     LEFT JOIN LATERAL amux.actor_user_contact(a.user_id) c(email, phone) ON (((a.actor_type <> 'agent'::text) AND (a.user_id IS NOT NULL))))
  WHERE ((a.actor_type <> 'agent'::text) OR (ag.visibility = 'team'::text) OR (ag.owner_member_id = amux.current_actor_id_for_team(a.team_id)));


--
-- Name: actor_message_feedback; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.actor_message_feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid NOT NULL,
    team_id uuid NOT NULL,
    session_id uuid,
    message_id uuid,
    kind text NOT NULL,
    star_rating smallint,
    skill text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT actor_message_feedback_kind_check CHECK ((kind = ANY (ARRAY['positive'::text, 'negative'::text]))),
    CONSTRAINT actor_message_feedback_star_rating_check CHECK (((star_rating >= 1) AND (star_rating <= 5)))
);


--
-- Name: actor_session_report; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.actor_session_report (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid NOT NULL,
    team_id uuid NOT NULL,
    session_id uuid,
    tokens_used bigint DEFAULT 0 NOT NULL,
    cost_usd numeric(12,4) DEFAULT 0 NOT NULL,
    model text,
    agent_kind text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone
);


--
-- Name: actor_skill_usage; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.actor_skill_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid NOT NULL,
    team_id uuid NOT NULL,
    session_id uuid,
    skill text NOT NULL,
    count integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT actor_skill_usage_count_check CHECK ((count > 0))
);


--
-- Name: agent_member_access; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.agent_member_access (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_id uuid NOT NULL,
    member_id uuid NOT NULL,
    permission_level text NOT NULL,
    granted_by_member_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_member_access_permission_level_check CHECK ((permission_level = ANY (ARRAY['view'::text, 'prompt'::text, 'admin'::text])))
);


--
-- Name: agent_runtimes; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.agent_runtimes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    session_id uuid,
    workspace_id uuid,
    backend_type text NOT NULL,
    backend_session_id text,
    status text NOT NULL,
    current_model text,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    runtime_id text,
    last_processed_message_id uuid,
    CONSTRAINT agent_runtimes_backend_type_check CHECK ((backend_type = ANY (ARRAY['claude'::text, 'codex'::text, 'opencode'::text]))),
    CONSTRAINT agent_runtimes_status_check CHECK ((status = ANY (ARRAY['starting'::text, 'running'::text, 'idle'::text, 'stopped'::text, 'failed'::text])))
);


--
-- Name: COLUMN agent_runtimes.runtime_id; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON COLUMN amux.agent_runtimes.runtime_id IS 'Daemon-side 8-char runtime id used as the segment in MQTT topic amux/{team}/device/{device}/runtime/{runtime_id}/state. iOS bridges Supabase agent_runtimes to the live MQTT Runtime row by this column.';


--
-- Name: amuxc_blobs; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.amuxc_blobs (
    team_id uuid NOT NULL,
    content_hash text NOT NULL,
    oss_key text NOT NULL,
    size bigint NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT amuxc_blobs_size_check CHECK ((size >= 0))
);

ALTER TABLE ONLY amux.amuxc_blobs FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE amuxc_blobs; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON TABLE amux.amuxc_blobs IS 'OSS blob registry. (team_id, content_hash) PK acts as a per-team dedup key. verified=false means prepare-stage placeholder, flipped true by /sync/upload/complete.';


--
-- Name: amuxc_file_versions; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.amuxc_file_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_id uuid NOT NULL,
    version integer NOT NULL,
    parent_version integer NOT NULL,
    content_hash text,
    size bigint DEFAULT 0 NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    created_by uuid NOT NULL,
    created_by_node_id text,
    message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT amuxc_file_versions_size_check CHECK ((size >= 0))
);

ALTER TABLE ONLY amux.amuxc_file_versions FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE amuxc_file_versions; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON TABLE amux.amuxc_file_versions IS 'Append-only version chain. parent_version=current_version at time of complete, so cas conflicts surface as a 409 before this row is written.';


--
-- Name: amuxc_files; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.amuxc_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    path text NOT NULL,
    current_version integer DEFAULT 0 NOT NULL,
    content_hash text,
    size bigint DEFAULT 0 NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    change_seq bigint DEFAULT 0 NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT amuxc_files_size_check CHECK ((size >= 0))
);

ALTER TABLE ONLY amux.amuxc_files FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE amuxc_files; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON TABLE amux.amuxc_files IS 'Current pointer per (team, path). Soft-delete keeps the same row (deleted=true) so revival increments current_version on the existing row and preserves the immutable version chain in amuxc_file_versions.';


--
-- Name: COLUMN amuxc_files.content_hash; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON COLUMN amux.amuxc_files.content_hash IS 'Ciphertext sha256 (see design §3.-1). Null iff deleted=true.';


--
-- Name: COLUMN amuxc_files.change_seq; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON COLUMN amux.amuxc_files.change_seq IS 'Per-team manifest sequence, assigned by /sync/upload/complete. See team_workspace_config.oss_change_seq.';


--
-- Name: amuxc_upload_sessions; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.amuxc_upload_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    node_id text,
    path text NOT NULL,
    parent_version integer NOT NULL,
    content_hash text NOT NULL,
    size bigint NOT NULL,
    oss_key text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT amuxc_upload_sessions_size_check CHECK ((size >= 0)),
    CONSTRAINT amuxc_upload_sessions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'abandoned'::text])))
);

ALTER TABLE ONLY amux.amuxc_upload_sessions FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE amuxc_upload_sessions; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON TABLE amux.amuxc_upload_sessions IS 'Tracks in-flight uploads between /prepare and /complete. actor_id is the creator; /complete must verify caller.actor_id == session.actor_id.';


--
-- Name: app_member_access; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.app_member_access (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id uuid NOT NULL,
    member_id uuid NOT NULL,
    permission_level text NOT NULL,
    granted_by_member_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_member_access_permission_level_check CHECK ((permission_level = ANY (ARRAY['view'::text, 'prompt'::text, 'admin'::text])))
);


--
-- Name: apps; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.apps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    created_by_actor_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    type text NOT NULL,
    visibility text DEFAULT 'personal'::text NOT NULL,
    workspace_id uuid,
    git_remote_url text,
    git_auth_kind text,
    provision_status text DEFAULT 'pending'::text NOT NULL,
    provision_error text,
    fc_function_name text,
    fc_region text,
    fc_endpoint text,
    fc_status text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT apps_provision_status_check CHECK ((provision_status = ANY (ARRAY['pending'::text, 'repo_created'::text, 'seeding'::text, 'ready'::text, 'error'::text]))),
    CONSTRAINT apps_visibility_check CHECK ((visibility = ANY (ARRAY['personal'::text, 'team'::text])))
);


--
-- Name: client_presence; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.client_presence (
    user_id uuid NOT NULL,
    device_id text NOT NULL,
    foreground_until timestamp with time zone NOT NULL
);


--
-- Name: device_push_tokens; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.device_push_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    device_id text NOT NULL,
    platform text NOT NULL,
    provider text NOT NULL,
    token text NOT NULL,
    app_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT device_push_tokens_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'desktop'::text]))),
    CONSTRAINT device_push_tokens_provider_check CHECK ((provider = ANY (ARRAY['apns'::text, 'jpush'::text, 'tauri'::text])))
);


--
-- Name: idea_activities; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.idea_activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    idea_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    activity_type text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    attachment_urls text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT idea_activities_activity_type_check CHECK ((activity_type = ANY (ARRAY['progress'::text, 'status_change'::text, 'reorder'::text])))
);


--
-- Name: idea_external_refs; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.idea_external_refs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idea_id uuid NOT NULL,
    provider text NOT NULL,
    external_id text NOT NULL,
    external_key text,
    external_url text NOT NULL,
    linked_by_actor_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT idea_external_refs_provider_check CHECK ((provider = ANY (ARRAY['github'::text, 'linear'::text, 'jira'::text])))
);


--
-- Name: ideas; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.ideas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    workspace_id uuid,
    parent_idea_id uuid,
    created_by_actor_id uuid,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    status text NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    CONSTRAINT ideas_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'done'::text])))
);


--
-- Name: messages; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    session_id uuid NOT NULL,
    sender_actor_id uuid,
    reply_to_message_id uuid,
    kind text NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    model text,
    turn_id text,
    external_id text,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    sequence bigint DEFAULT 0 NOT NULL,
    CONSTRAINT messages_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'system'::text, 'idea_event'::text, 'agent_reply'::text])))
);


--
-- Name: COLUMN messages.model; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON COLUMN amux.messages.model IS 'Model identifier (e.g. claude-haiku-4-5) the agent used to produce this message. NULL for non-agent messages and rows older than the column.';


--
-- Name: COLUMN messages.turn_id; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON COLUMN amux.messages.turn_id IS 'Daemon-assigned correlation id stamped on every emit within one ACP turn (Idle→Active→…→Idle). Clients merge consecutive same-turn_id AgentReply rows into a single bubble. NULL for rows older than this column.';


--
-- Name: notification_prefs; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.notification_prefs (
    user_id uuid NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    dnd_start_min smallint,
    dnd_end_min smallint,
    dnd_tz text DEFAULT 'Asia/Shanghai'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_prefs_dnd_end_min_check CHECK (((dnd_end_min >= 0) AND (dnd_end_min <= 1439))),
    CONSTRAINT notification_prefs_dnd_start_min_check CHECK (((dnd_start_min >= 0) AND (dnd_start_min <= 1439)))
);


--
-- Name: permission_roles; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.permission_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    permission_id uuid NOT NULL,
    role_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: permissions; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: push_idempotency; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.push_idempotency (
    message_id uuid NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: session_mutes; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.session_mutes (
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    muted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: session_participants; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.session_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    role text,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: session_read_markers; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.session_read_markers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    last_read_at timestamp with time zone DEFAULT now() NOT NULL,
    last_read_message_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    idea_id uuid,
    created_by_actor_id uuid,
    primary_agent_id uuid,
    mode text NOT NULL,
    title text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    last_message_preview text,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    binding text,
    acp_session_id text,
    archived_at timestamp with time zone,
    app_id uuid,
    CONSTRAINT sessions_mode_check CHECK ((mode = ANY (ARRAY['solo'::text, 'collab'::text, 'control'::text])))
);


--
-- Name: shortcuts; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.shortcuts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope text NOT NULL,
    owner_member_id uuid,
    team_id uuid,
    parent_id uuid,
    label text NOT NULL,
    icon text,
    "order" integer DEFAULT 0 NOT NULL,
    node_type text NOT NULL,
    target text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shortcuts_node_type_check CHECK ((node_type = ANY (ARRAY['native'::text, 'link'::text, 'folder'::text]))),
    CONSTRAINT shortcuts_scope_check CHECK ((scope = ANY (ARRAY['personal'::text, 'team'::text]))),
    CONSTRAINT shortcuts_scope_owner_xor CHECK ((((scope = 'personal'::text) AND (owner_member_id IS NOT NULL) AND (team_id IS NULL)) OR ((scope = 'team'::text) AND (team_id IS NOT NULL) AND (owner_member_id IS NULL))))
);


--
-- Name: team_invites; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.team_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    token text NOT NULL,
    kind text NOT NULL,
    team_role text,
    agent_kind text,
    display_name text NOT NULL,
    invited_by_actor_id uuid,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    consumed_by_actor_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    target_actor_id uuid,
    CONSTRAINT team_invites_kind_check CHECK ((kind = ANY (ARRAY['member'::text, 'agent'::text]))),
    CONSTRAINT team_invites_kind_fields_check CHECK ((((kind = 'member'::text) AND (team_role IS NOT NULL) AND (agent_kind IS NULL)) OR ((kind = 'agent'::text) AND (team_role IS NULL) AND (agent_kind IS NOT NULL)))),
    CONSTRAINT team_invites_team_role_check CHECK ((team_role = ANY (ARRAY['member'::text, 'admin'::text])))
);


--
-- Name: team_member_roles; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.team_member_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    member_id uuid NOT NULL,
    role_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_roles; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.team_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_workspace_config; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.team_workspace_config (
    team_id uuid NOT NULL,
    git_url text,
    git_branch text,
    git_token text,
    ai_gateway_endpoint text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sync_mode text,
    oss_change_seq bigint DEFAULT 0 NOT NULL,
    litellm_team_id text,
    CONSTRAINT team_workspace_config_sync_mode_check CHECK ((sync_mode = ANY (ARRAY['git'::text, 'oss'::text])))
);


--
-- Name: COLUMN team_workspace_config.sync_mode; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON COLUMN amux.team_workspace_config.sync_mode IS 'Sync backend for this team. Set at team creation; immutable thereafter (enforced by trg_team_workspace_config_guard).';


--
-- Name: COLUMN team_workspace_config.oss_change_seq; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON COLUMN amux.team_workspace_config.oss_change_seq IS 'Per-team monotonic sequence written by /sync/upload/complete inside the same tx as amuxc_files.change_seq. Manifest high-water mark.';


--
-- Name: COLUMN team_workspace_config.litellm_team_id; Type: COMMENT; Schema: amux; Owner: -
--

COMMENT ON COLUMN amux.team_workspace_config.litellm_team_id IS 'LiteLLM team id provisioned for this team during /sync/create-team.';


--
-- Name: workspaces; Type: TABLE; Schema: amux; Owner: -
--

CREATE TABLE amux.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    created_by_member_id uuid,
    name text NOT NULL,
    path text,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    agent_id uuid
);


--
-- Name: orgs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orgs (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    code character varying(50),
    logo text,
    address text,
    contact character varying(50),
    phone character varying(20),
    email character varying(100),
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    description text,
    created_by uuid DEFAULT auth.uid(),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_by uuid DEFAULT auth.uid(),
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_note text,
    domain text,
    onboarding_status text DEFAULT 'pending'::text NOT NULL,
    onboarding_completed_at timestamp with time zone,
    plan_id uuid,
    business_stage text DEFAULT 'operating'::text NOT NULL,
    CONSTRAINT orgs_business_stage_check CHECK ((business_stage = ANY (ARRAY['operating'::text, 'preparing'::text, 'both'::text]))),
    CONSTRAINT orgs_onboarding_status_check CHECK ((onboarding_status = ANY (ARRAY['pending'::text, 'completed'::text])))
);


--
-- Name: TABLE orgs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.orgs IS 'Mirror of saas-mono public.orgs (canonical tenant). saas-mono-owned on the merged instance. See docs/specs/2026-06-08-teamclaw-saas-mono-integration.md';


--
-- Name: plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plans (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: TABLE plans; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.plans IS 'STUB mirror of saas-mono public.plans for local integration dev. Replace with real DDL before merge. See docs/specs/2026-06-08-teamclaw-saas-mono-integration.md';


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    auth_user_id uuid,
    org_id uuid NOT NULL,
    admin_type smallint DEFAULT 1 NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    mobile text DEFAULT ''::text NOT NULL,
    nickname text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: TABLE users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.users IS 'SUBSET mirror of saas-mono public.users (user↔org). saas-mono-owned on merge; reconcile full shape before merge.';


--
-- Name: actor_client_versions actor_client_versions_actor_id_client_type_device_id_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_client_versions
    ADD CONSTRAINT actor_client_versions_actor_id_client_type_device_id_key UNIQUE (actor_id, client_type, device_id);


--
-- Name: actor_client_versions actor_client_versions_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_client_versions
    ADD CONSTRAINT actor_client_versions_pkey PRIMARY KEY (id);


--
-- Name: actor_message_feedback actor_message_feedback_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_message_feedback
    ADD CONSTRAINT actor_message_feedback_pkey PRIMARY KEY (id);


--
-- Name: actor_session_report actor_session_report_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_session_report
    ADD CONSTRAINT actor_session_report_pkey PRIMARY KEY (id);


--
-- Name: actor_skill_usage actor_skill_usage_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_skill_usage
    ADD CONSTRAINT actor_skill_usage_pkey PRIMARY KEY (id);


--
-- Name: actors actors_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actors
    ADD CONSTRAINT actors_pkey PRIMARY KEY (id);


--
-- Name: agent_member_access agent_member_access_agent_id_member_id_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agent_member_access
    ADD CONSTRAINT agent_member_access_agent_id_member_id_key UNIQUE (agent_id, member_id);


--
-- Name: agent_member_access agent_member_access_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agent_member_access
    ADD CONSTRAINT agent_member_access_pkey PRIMARY KEY (id);


--
-- Name: agent_runtimes agent_runtimes_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agent_runtimes
    ADD CONSTRAINT agent_runtimes_pkey PRIMARY KEY (id);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: amuxc_blobs amuxc_blobs_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.amuxc_blobs
    ADD CONSTRAINT amuxc_blobs_pkey PRIMARY KEY (team_id, content_hash);


--
-- Name: amuxc_file_versions amuxc_file_versions_file_id_version_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.amuxc_file_versions
    ADD CONSTRAINT amuxc_file_versions_file_id_version_key UNIQUE (file_id, version);


--
-- Name: amuxc_file_versions amuxc_file_versions_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.amuxc_file_versions
    ADD CONSTRAINT amuxc_file_versions_pkey PRIMARY KEY (id);


--
-- Name: amuxc_files amuxc_files_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.amuxc_files
    ADD CONSTRAINT amuxc_files_pkey PRIMARY KEY (id);


--
-- Name: amuxc_upload_sessions amuxc_upload_sessions_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.amuxc_upload_sessions
    ADD CONSTRAINT amuxc_upload_sessions_pkey PRIMARY KEY (id);


--
-- Name: app_member_access app_member_access_app_member_uniq; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.app_member_access
    ADD CONSTRAINT app_member_access_app_member_uniq UNIQUE (app_id, member_id);


--
-- Name: app_member_access app_member_access_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.app_member_access
    ADD CONSTRAINT app_member_access_pkey PRIMARY KEY (id);


--
-- Name: apps apps_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.apps
    ADD CONSTRAINT apps_pkey PRIMARY KEY (id);


--
-- Name: apps apps_team_slug_uniq; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.apps
    ADD CONSTRAINT apps_team_slug_uniq UNIQUE (team_id, slug);


--
-- Name: apps apps_workspace_uniq; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.apps
    ADD CONSTRAINT apps_workspace_uniq UNIQUE (workspace_id);


--
-- Name: client_presence client_presence_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.client_presence
    ADD CONSTRAINT client_presence_pkey PRIMARY KEY (user_id, device_id);


--
-- Name: device_push_tokens device_push_tokens_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.device_push_tokens
    ADD CONSTRAINT device_push_tokens_pkey PRIMARY KEY (id);


--
-- Name: device_push_tokens device_push_tokens_user_id_device_id_provider_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.device_push_tokens
    ADD CONSTRAINT device_push_tokens_user_id_device_id_provider_key UNIQUE (user_id, device_id, provider);


--
-- Name: idea_activities idea_activities_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.idea_activities
    ADD CONSTRAINT idea_activities_pkey PRIMARY KEY (id);


--
-- Name: idea_external_refs idea_external_refs_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.idea_external_refs
    ADD CONSTRAINT idea_external_refs_pkey PRIMARY KEY (id);


--
-- Name: idea_external_refs idea_external_refs_provider_external_id_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.idea_external_refs
    ADD CONSTRAINT idea_external_refs_provider_external_id_key UNIQUE (provider, external_id);


--
-- Name: ideas ideas_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.ideas
    ADD CONSTRAINT ideas_pkey PRIMARY KEY (id);


--
-- Name: members members_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: notification_prefs notification_prefs_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.notification_prefs
    ADD CONSTRAINT notification_prefs_pkey PRIMARY KEY (user_id);


--
-- Name: permission_roles permission_roles_permission_id_role_id_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.permission_roles
    ADD CONSTRAINT permission_roles_permission_id_role_id_key UNIQUE (permission_id, role_id);


--
-- Name: permission_roles permission_roles_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.permission_roles
    ADD CONSTRAINT permission_roles_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_team_id_code_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.permissions
    ADD CONSTRAINT permissions_team_id_code_key UNIQUE (team_id, code);


--
-- Name: permissions permissions_team_id_resource_type_resource_id_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.permissions
    ADD CONSTRAINT permissions_team_id_resource_type_resource_id_key UNIQUE (team_id, resource_type, resource_id);


--
-- Name: push_idempotency push_idempotency_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.push_idempotency
    ADD CONSTRAINT push_idempotency_pkey PRIMARY KEY (message_id);


--
-- Name: session_mutes session_mutes_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.session_mutes
    ADD CONSTRAINT session_mutes_pkey PRIMARY KEY (user_id, session_id);


--
-- Name: session_participants session_participants_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.session_participants
    ADD CONSTRAINT session_participants_pkey PRIMARY KEY (id);


--
-- Name: session_participants session_participants_session_id_actor_id_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.session_participants
    ADD CONSTRAINT session_participants_session_id_actor_id_key UNIQUE (session_id, actor_id);


--
-- Name: session_read_markers session_read_markers_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.session_read_markers
    ADD CONSTRAINT session_read_markers_pkey PRIMARY KEY (id);


--
-- Name: session_read_markers session_read_markers_session_id_actor_id_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.session_read_markers
    ADD CONSTRAINT session_read_markers_session_id_actor_id_key UNIQUE (session_id, actor_id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: shortcuts shortcuts_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.shortcuts
    ADD CONSTRAINT shortcuts_pkey PRIMARY KEY (id);


--
-- Name: team_invites team_invites_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_invites
    ADD CONSTRAINT team_invites_pkey PRIMARY KEY (id);


--
-- Name: team_invites team_invites_token_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_invites
    ADD CONSTRAINT team_invites_token_key UNIQUE (token);


--
-- Name: team_member_roles team_member_roles_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_member_roles
    ADD CONSTRAINT team_member_roles_pkey PRIMARY KEY (id);


--
-- Name: team_member_roles team_member_roles_team_id_member_id_role_id_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_member_roles
    ADD CONSTRAINT team_member_roles_team_id_member_id_role_id_key UNIQUE (team_id, member_id, role_id);


--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);


--
-- Name: team_members team_members_team_id_member_id_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_members
    ADD CONSTRAINT team_members_team_id_member_id_key UNIQUE (team_id, member_id);


--
-- Name: team_roles team_roles_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_roles
    ADD CONSTRAINT team_roles_pkey PRIMARY KEY (id);


--
-- Name: team_roles team_roles_team_id_code_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_roles
    ADD CONSTRAINT team_roles_team_id_code_key UNIQUE (team_id, code);


--
-- Name: team_workspace_config team_workspace_config_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_workspace_config
    ADD CONSTRAINT team_workspace_config_pkey PRIMARY KEY (team_id);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: teams teams_slug_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.teams
    ADD CONSTRAINT teams_slug_key UNIQUE (slug);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_team_id_agent_id_name_key; Type: CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.workspaces
    ADD CONSTRAINT workspaces_team_id_agent_id_name_key UNIQUE (team_id, agent_id, name);


--
-- Name: orgs orgs_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_code_key UNIQUE (code);


--
-- Name: orgs orgs_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_domain_key UNIQUE (domain);


--
-- Name: orgs orgs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_pkey PRIMARY KEY (id);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: actor_message_feedback_actor_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX actor_message_feedback_actor_idx ON amux.actor_message_feedback USING btree (actor_id, created_at DESC);


--
-- Name: actor_message_feedback_actor_message_uidx; Type: INDEX; Schema: amux; Owner: -
--

CREATE UNIQUE INDEX actor_message_feedback_actor_message_uidx ON amux.actor_message_feedback USING btree (actor_id, message_id);


--
-- Name: actor_message_feedback_team_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX actor_message_feedback_team_idx ON amux.actor_message_feedback USING btree (team_id, created_at DESC);


--
-- Name: actor_session_report_actor_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX actor_session_report_actor_idx ON amux.actor_session_report USING btree (actor_id, created_at DESC);


--
-- Name: actor_session_report_team_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX actor_session_report_team_idx ON amux.actor_session_report USING btree (team_id, created_at DESC);


--
-- Name: actor_skill_usage_actor_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX actor_skill_usage_actor_idx ON amux.actor_skill_usage USING btree (actor_id, created_at DESC);


--
-- Name: actor_skill_usage_team_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX actor_skill_usage_team_idx ON amux.actor_skill_usage USING btree (team_id, created_at DESC);


--
-- Name: actors_team_source_id_uq; Type: INDEX; Schema: amux; Owner: -
--

CREATE UNIQUE INDEX actors_team_source_id_uq ON amux.actors USING btree (team_id, source, source_id) WHERE (source IS NOT NULL);


--
-- Name: actors_team_user_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE UNIQUE INDEX actors_team_user_idx ON amux.actors USING btree (team_id, user_id) WHERE (user_id IS NOT NULL);


--
-- Name: agent_runtimes_agent_backend_uniq; Type: INDEX; Schema: amux; Owner: -
--

CREATE UNIQUE INDEX agent_runtimes_agent_backend_uniq ON amux.agent_runtimes USING btree (agent_id, backend_session_id) NULLS NOT DISTINCT;


--
-- Name: agent_runtimes_cursor_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX agent_runtimes_cursor_idx ON amux.agent_runtimes USING btree (session_id, last_processed_message_id);


--
-- Name: agent_runtimes_runtime_id_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX agent_runtimes_runtime_id_idx ON amux.agent_runtimes USING btree (runtime_id);


--
-- Name: agents_device_id_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX agents_device_id_idx ON amux.agents USING btree (device_id);


--
-- Name: device_push_tokens_user_active_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX device_push_tokens_user_active_idx ON amux.device_push_tokens USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_actors_team_id; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_actors_team_id ON amux.actors USING btree (team_id);


--
-- Name: idx_actors_user_id; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_actors_user_id ON amux.actors USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_agent_runtimes_agent_id; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_agent_runtimes_agent_id ON amux.agent_runtimes USING btree (agent_id);


--
-- Name: idx_agent_runtimes_session_id; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_agent_runtimes_session_id ON amux.agent_runtimes USING btree (session_id);


--
-- Name: idx_amuxc_blobs_verified_created; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_amuxc_blobs_verified_created ON amux.amuxc_blobs USING btree (created_at) WHERE (verified = false);


--
-- Name: idx_amuxc_file_versions_file; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_amuxc_file_versions_file ON amux.amuxc_file_versions USING btree (file_id, version DESC);


--
-- Name: idx_amuxc_files_team_seq; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_amuxc_files_team_seq ON amux.amuxc_files USING btree (team_id, change_seq);


--
-- Name: idx_amuxc_files_team_updated; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_amuxc_files_team_updated ON amux.amuxc_files USING btree (team_id, updated_at);


--
-- Name: idx_amuxc_sessions_expires; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_amuxc_sessions_expires ON amux.amuxc_upload_sessions USING btree (expires_at);


--
-- Name: idx_amuxc_sessions_team_status; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_amuxc_sessions_team_status ON amux.amuxc_upload_sessions USING btree (team_id, status);


--
-- Name: idx_idea_activities_idea_created_at; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_idea_activities_idea_created_at ON amux.idea_activities USING btree (idea_id, created_at DESC);


--
-- Name: idx_idea_activities_team_created_at; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_idea_activities_team_created_at ON amux.idea_activities USING btree (team_id, created_at DESC);


--
-- Name: idx_ideas_team_id; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_ideas_team_id ON amux.ideas USING btree (team_id);


--
-- Name: idx_ideas_team_sort_order; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_ideas_team_sort_order ON amux.ideas USING btree (team_id, archived, sort_order, updated_at DESC);


--
-- Name: idx_ideas_workspace_id; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_ideas_workspace_id ON amux.ideas USING btree (workspace_id);


--
-- Name: idx_messages_session_created_at; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_messages_session_created_at ON amux.messages USING btree (session_id, created_at DESC);


--
-- Name: idx_messages_team_id; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_messages_team_id ON amux.messages USING btree (team_id);


--
-- Name: idx_session_participants_actor_id; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_session_participants_actor_id ON amux.session_participants USING btree (actor_id);


--
-- Name: idx_sessions_idea_id; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_sessions_idea_id ON amux.sessions USING btree (idea_id);


--
-- Name: idx_sessions_team_id; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_sessions_team_id ON amux.sessions USING btree (team_id);


--
-- Name: idx_team_members_member_id; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_team_members_member_id ON amux.team_members USING btree (member_id);


--
-- Name: idx_workspaces_agent_id; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_workspaces_agent_id ON amux.workspaces USING btree (agent_id);


--
-- Name: idx_workspaces_team_id; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX idx_workspaces_team_id ON amux.workspaces USING btree (team_id);


--
-- Name: messages_session_created_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX messages_session_created_idx ON amux.messages USING btree (session_id, created_at DESC);


--
-- Name: messages_session_external_id_uq; Type: INDEX; Schema: amux; Owner: -
--

CREATE UNIQUE INDEX messages_session_external_id_uq ON amux.messages USING btree (session_id, external_id);


--
-- Name: messages_session_sequence_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX messages_session_sequence_idx ON amux.messages USING btree (session_id, sequence) WHERE (sequence > 0);


--
-- Name: messages_turn_id_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX messages_turn_id_idx ON amux.messages USING btree (session_id, turn_id) WHERE (turn_id IS NOT NULL);


--
-- Name: permission_roles_role_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX permission_roles_role_idx ON amux.permission_roles USING btree (role_id);


--
-- Name: permissions_resource_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX permissions_resource_idx ON amux.permissions USING btree (team_id, resource_type, resource_id);


--
-- Name: push_idempotency_claimed_at_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX push_idempotency_claimed_at_idx ON amux.push_idempotency USING btree (claimed_at);


--
-- Name: session_read_markers_actor_session_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE UNIQUE INDEX session_read_markers_actor_session_idx ON amux.session_read_markers USING btree (actor_id, session_id);


--
-- Name: session_read_markers_session_actor_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX session_read_markers_session_actor_idx ON amux.session_read_markers USING btree (session_id, actor_id);


--
-- Name: sessions_acp_session_id_uq; Type: INDEX; Schema: amux; Owner: -
--

CREATE UNIQUE INDEX sessions_acp_session_id_uq ON amux.sessions USING btree (acp_session_id) WHERE (acp_session_id IS NOT NULL);


--
-- Name: sessions_team_active_last_message_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX sessions_team_active_last_message_idx ON amux.sessions USING btree (team_id, last_message_at DESC, created_at DESC, id DESC) WHERE (archived_at IS NULL);


--
-- Name: sessions_team_binding_uq; Type: INDEX; Schema: amux; Owner: -
--

CREATE UNIQUE INDEX sessions_team_binding_uq ON amux.sessions USING btree (team_id, binding) WHERE (binding IS NOT NULL);


--
-- Name: sessions_team_last_message_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX sessions_team_last_message_idx ON amux.sessions USING btree (team_id, last_message_at DESC, created_at DESC, id DESC);


--
-- Name: shortcuts_parent_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX shortcuts_parent_idx ON amux.shortcuts USING btree (parent_id);


--
-- Name: shortcuts_personal_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX shortcuts_personal_idx ON amux.shortcuts USING btree (owner_member_id) WHERE (scope = 'personal'::text);


--
-- Name: shortcuts_team_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX shortcuts_team_idx ON amux.shortcuts USING btree (team_id) WHERE (scope = 'team'::text);


--
-- Name: team_invites_team_unconsumed_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX team_invites_team_unconsumed_idx ON amux.team_invites USING btree (team_id) WHERE (consumed_at IS NULL);


--
-- Name: team_invites_token_unconsumed_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX team_invites_token_unconsumed_idx ON amux.team_invites USING btree (token) WHERE (consumed_at IS NULL);


--
-- Name: team_member_roles_member_idx; Type: INDEX; Schema: amux; Owner: -
--

CREATE INDEX team_member_roles_member_idx ON amux.team_member_roles USING btree (team_id, member_id);


--
-- Name: uniq_amuxc_path; Type: INDEX; Schema: amux; Owner: -
--

CREATE UNIQUE INDEX uniq_amuxc_path ON amux.amuxc_files USING btree (team_id, path);


--
-- Name: idx_orgs_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orgs_code ON public.orgs USING btree (code);


--
-- Name: idx_orgs_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orgs_domain ON public.orgs USING btree (domain);


--
-- Name: idx_orgs_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orgs_name ON public.orgs USING btree (name);


--
-- Name: idx_orgs_onboarding_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orgs_onboarding_status ON public.orgs USING btree (onboarding_status);


--
-- Name: idx_orgs_plan_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orgs_plan_id ON public.orgs USING btree (plan_id);


--
-- Name: idx_users_auth_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_auth_user_id ON public.users USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);


--
-- Name: idx_users_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_org_id ON public.users USING btree (org_id);


--
-- Name: uq_users_auth_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_users_auth_user_id ON public.users USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);


--
-- Name: messages bump_session_last_message; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER bump_session_last_message AFTER INSERT ON amux.messages FOR EACH ROW EXECUTE FUNCTION amux.bump_session_last_message();


--
-- Name: actors enforce_actors_parent_integrity; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_actors_parent_integrity BEFORE UPDATE ON amux.actors FOR EACH ROW EXECUTE FUNCTION amux.enforce_parent_integrity();


--
-- Name: agent_member_access enforce_agent_member_access_same_team; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_agent_member_access_same_team BEFORE INSERT OR UPDATE ON amux.agent_member_access FOR EACH ROW EXECUTE FUNCTION amux.enforce_core_team_integrity();


--
-- Name: agent_runtimes enforce_agent_runtimes_same_team; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_agent_runtimes_same_team BEFORE INSERT OR UPDATE ON amux.agent_runtimes FOR EACH ROW EXECUTE FUNCTION amux.enforce_core_team_integrity();


--
-- Name: agents enforce_agents_actor_type; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_agents_actor_type BEFORE INSERT OR UPDATE ON amux.agents FOR EACH ROW EXECUTE FUNCTION amux.enforce_actor_subtype();


--
-- Name: agents enforce_agents_same_team; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_agents_same_team BEFORE INSERT OR UPDATE ON amux.agents FOR EACH ROW EXECUTE FUNCTION amux.enforce_core_team_integrity();


--
-- Name: idea_external_refs enforce_idea_external_refs_same_team; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_idea_external_refs_same_team BEFORE INSERT OR UPDATE ON amux.idea_external_refs FOR EACH ROW EXECUTE FUNCTION amux.enforce_core_team_integrity();


--
-- Name: ideas enforce_ideas_parent_integrity; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_ideas_parent_integrity BEFORE UPDATE ON amux.ideas FOR EACH ROW EXECUTE FUNCTION amux.enforce_parent_integrity();


--
-- Name: ideas enforce_ideas_same_team; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_ideas_same_team BEFORE INSERT OR UPDATE ON amux.ideas FOR EACH ROW EXECUTE FUNCTION amux.enforce_core_team_integrity();


--
-- Name: members enforce_members_actor_type; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_members_actor_type BEFORE INSERT OR UPDATE ON amux.members FOR EACH ROW EXECUTE FUNCTION amux.enforce_actor_subtype();


--
-- Name: messages enforce_messages_same_team; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_messages_same_team BEFORE INSERT OR UPDATE ON amux.messages FOR EACH ROW EXECUTE FUNCTION amux.enforce_core_team_integrity();


--
-- Name: session_participants enforce_session_participants_same_team; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_session_participants_same_team BEFORE INSERT OR UPDATE ON amux.session_participants FOR EACH ROW EXECUTE FUNCTION amux.enforce_core_team_integrity();


--
-- Name: sessions enforce_sessions_parent_integrity; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_sessions_parent_integrity BEFORE UPDATE ON amux.sessions FOR EACH ROW EXECUTE FUNCTION amux.enforce_parent_integrity();


--
-- Name: sessions enforce_sessions_same_team; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_sessions_same_team BEFORE INSERT OR UPDATE ON amux.sessions FOR EACH ROW EXECUTE FUNCTION amux.enforce_core_team_integrity();


--
-- Name: team_members enforce_team_members_same_team; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_team_members_same_team BEFORE INSERT OR UPDATE ON amux.team_members FOR EACH ROW EXECUTE FUNCTION amux.enforce_core_team_integrity();


--
-- Name: workspaces enforce_workspaces_parent_integrity; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_workspaces_parent_integrity BEFORE UPDATE ON amux.workspaces FOR EACH ROW EXECUTE FUNCTION amux.enforce_parent_integrity();


--
-- Name: workspaces enforce_workspaces_same_team; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER enforce_workspaces_same_team BEFORE INSERT OR UPDATE ON amux.workspaces FOR EACH ROW EXECUTE FUNCTION amux.enforce_core_team_integrity();


--
-- Name: messages messages_push_dispatch; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER messages_push_dispatch AFTER INSERT ON amux.messages FOR EACH ROW EXECUTE FUNCTION amux.notify_push_dispatch();


--
-- Name: actors set_actors_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_actors_updated_at BEFORE UPDATE ON amux.actors FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: agent_member_access set_agent_member_access_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_agent_member_access_updated_at BEFORE UPDATE ON amux.agent_member_access FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: agent_runtimes set_agent_runtimes_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_agent_runtimes_updated_at BEFORE UPDATE ON amux.agent_runtimes FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: agents set_agents_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_agents_updated_at BEFORE UPDATE ON amux.agents FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: idea_activities set_idea_activities_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_idea_activities_updated_at BEFORE UPDATE ON amux.idea_activities FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: idea_external_refs set_idea_external_refs_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_idea_external_refs_updated_at BEFORE UPDATE ON amux.idea_external_refs FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: ideas set_ideas_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_ideas_updated_at BEFORE UPDATE ON amux.ideas FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: members set_members_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_members_updated_at BEFORE UPDATE ON amux.members FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: messages set_messages_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_messages_updated_at BEFORE UPDATE ON amux.messages FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: session_participants set_session_participants_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_session_participants_updated_at BEFORE UPDATE ON amux.session_participants FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: session_read_markers set_session_read_markers_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_session_read_markers_updated_at BEFORE UPDATE ON amux.session_read_markers FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: sessions set_sessions_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_sessions_updated_at BEFORE UPDATE ON amux.sessions FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: team_invites set_team_invites_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_team_invites_updated_at BEFORE UPDATE ON amux.team_invites FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: team_members set_team_members_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_team_members_updated_at BEFORE UPDATE ON amux.team_members FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: team_workspace_config set_team_workspace_config_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_team_workspace_config_updated_at BEFORE UPDATE ON amux.team_workspace_config FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: teams set_teams_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_teams_updated_at BEFORE UPDATE ON amux.teams FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: workspaces set_workspaces_updated_at; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER set_workspaces_updated_at BEFORE UPDATE ON amux.workspaces FOR EACH ROW EXECUTE FUNCTION amux.bump_updated_at();


--
-- Name: shortcuts shortcuts_cleanup_permission_after_delete; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER shortcuts_cleanup_permission_after_delete AFTER DELETE ON amux.shortcuts FOR EACH ROW EXECUTE FUNCTION amux.cleanup_shortcut_permission();


--
-- Name: team_workspace_config trg_team_workspace_config_guard; Type: TRIGGER; Schema: amux; Owner: -
--

CREATE TRIGGER trg_team_workspace_config_guard BEFORE UPDATE ON amux.team_workspace_config FOR EACH ROW EXECUTE FUNCTION amux.guard_team_workspace_sync_fields();


--
-- Name: orgs trg_orgs_update_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_orgs_update_audit BEFORE UPDATE ON public.orgs FOR EACH ROW EXECUTE FUNCTION amux.update_audit_columns();


--
-- Name: users trg_users_update_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_update_audit BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION amux.update_audit_columns();


--
-- Name: actor_client_versions actor_client_versions_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_client_versions
    ADD CONSTRAINT actor_client_versions_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES amux.actors(id) ON DELETE CASCADE;


--
-- Name: actor_client_versions actor_client_versions_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_client_versions
    ADD CONSTRAINT actor_client_versions_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: actor_message_feedback actor_message_feedback_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_message_feedback
    ADD CONSTRAINT actor_message_feedback_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES amux.actors(id) ON DELETE CASCADE;


--
-- Name: actor_message_feedback actor_message_feedback_session_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_message_feedback
    ADD CONSTRAINT actor_message_feedback_session_id_fkey FOREIGN KEY (session_id) REFERENCES amux.sessions(id) ON DELETE SET NULL;


--
-- Name: actor_message_feedback actor_message_feedback_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_message_feedback
    ADD CONSTRAINT actor_message_feedback_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: actor_session_report actor_session_report_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_session_report
    ADD CONSTRAINT actor_session_report_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES amux.actors(id) ON DELETE CASCADE;


--
-- Name: actor_session_report actor_session_report_session_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_session_report
    ADD CONSTRAINT actor_session_report_session_id_fkey FOREIGN KEY (session_id) REFERENCES amux.sessions(id) ON DELETE SET NULL;


--
-- Name: actor_session_report actor_session_report_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_session_report
    ADD CONSTRAINT actor_session_report_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: actor_skill_usage actor_skill_usage_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_skill_usage
    ADD CONSTRAINT actor_skill_usage_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES amux.actors(id) ON DELETE CASCADE;


--
-- Name: actor_skill_usage actor_skill_usage_session_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_skill_usage
    ADD CONSTRAINT actor_skill_usage_session_id_fkey FOREIGN KEY (session_id) REFERENCES amux.sessions(id) ON DELETE SET NULL;


--
-- Name: actor_skill_usage actor_skill_usage_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actor_skill_usage
    ADD CONSTRAINT actor_skill_usage_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: actors actors_invited_by_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actors
    ADD CONSTRAINT actors_invited_by_actor_id_fkey FOREIGN KEY (invited_by_actor_id) REFERENCES amux.actors(id) ON DELETE SET NULL;


--
-- Name: actors actors_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actors
    ADD CONSTRAINT actors_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: actors actors_user_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.actors
    ADD CONSTRAINT actors_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: agent_member_access agent_member_access_agent_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agent_member_access
    ADD CONSTRAINT agent_member_access_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES amux.agents(id) ON DELETE CASCADE;


--
-- Name: agent_member_access agent_member_access_granted_by_member_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agent_member_access
    ADD CONSTRAINT agent_member_access_granted_by_member_id_fkey FOREIGN KEY (granted_by_member_id) REFERENCES amux.members(id) ON DELETE SET NULL;


--
-- Name: agent_member_access agent_member_access_member_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agent_member_access
    ADD CONSTRAINT agent_member_access_member_id_fkey FOREIGN KEY (member_id) REFERENCES amux.members(id) ON DELETE CASCADE;


--
-- Name: agent_runtimes agent_runtimes_agent_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agent_runtimes
    ADD CONSTRAINT agent_runtimes_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES amux.agents(id) ON DELETE CASCADE;


--
-- Name: agent_runtimes agent_runtimes_last_processed_message_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agent_runtimes
    ADD CONSTRAINT agent_runtimes_last_processed_message_id_fkey FOREIGN KEY (last_processed_message_id) REFERENCES amux.messages(id) ON DELETE SET NULL;


--
-- Name: agent_runtimes agent_runtimes_session_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agent_runtimes
    ADD CONSTRAINT agent_runtimes_session_id_fkey FOREIGN KEY (session_id) REFERENCES amux.sessions(id) ON DELETE CASCADE;


--
-- Name: agent_runtimes agent_runtimes_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agent_runtimes
    ADD CONSTRAINT agent_runtimes_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: agent_runtimes agent_runtimes_workspace_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agent_runtimes
    ADD CONSTRAINT agent_runtimes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES amux.workspaces(id) ON DELETE SET NULL;


--
-- Name: agents agents_default_workspace_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agents
    ADD CONSTRAINT agents_default_workspace_id_fkey FOREIGN KEY (default_workspace_id) REFERENCES amux.workspaces(id) ON DELETE SET NULL;


--
-- Name: agents agents_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agents
    ADD CONSTRAINT agents_id_fkey FOREIGN KEY (id) REFERENCES amux.actors(id) ON DELETE CASCADE;


--
-- Name: agents agents_owner_member_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.agents
    ADD CONSTRAINT agents_owner_member_id_fkey FOREIGN KEY (owner_member_id) REFERENCES amux.members(id) ON DELETE RESTRICT;


--
-- Name: amuxc_blobs amuxc_blobs_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.amuxc_blobs
    ADD CONSTRAINT amuxc_blobs_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: amuxc_file_versions amuxc_file_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.amuxc_file_versions
    ADD CONSTRAINT amuxc_file_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES amux.actors(id) ON DELETE RESTRICT;


--
-- Name: amuxc_file_versions amuxc_file_versions_file_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.amuxc_file_versions
    ADD CONSTRAINT amuxc_file_versions_file_id_fkey FOREIGN KEY (file_id) REFERENCES amux.amuxc_files(id) ON DELETE CASCADE;


--
-- Name: amuxc_files amuxc_files_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.amuxc_files
    ADD CONSTRAINT amuxc_files_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: amuxc_files amuxc_files_updated_by_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.amuxc_files
    ADD CONSTRAINT amuxc_files_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES amux.actors(id) ON DELETE RESTRICT;


--
-- Name: amuxc_upload_sessions amuxc_upload_sessions_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.amuxc_upload_sessions
    ADD CONSTRAINT amuxc_upload_sessions_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES amux.actors(id) ON DELETE CASCADE;


--
-- Name: amuxc_upload_sessions amuxc_upload_sessions_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.amuxc_upload_sessions
    ADD CONSTRAINT amuxc_upload_sessions_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: app_member_access app_member_access_app_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.app_member_access
    ADD CONSTRAINT app_member_access_app_id_fkey FOREIGN KEY (app_id) REFERENCES amux.apps(id) ON DELETE CASCADE;


--
-- Name: app_member_access app_member_access_granted_by_member_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.app_member_access
    ADD CONSTRAINT app_member_access_granted_by_member_id_fkey FOREIGN KEY (granted_by_member_id) REFERENCES amux.members(id) ON DELETE SET NULL;


--
-- Name: app_member_access app_member_access_member_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.app_member_access
    ADD CONSTRAINT app_member_access_member_id_fkey FOREIGN KEY (member_id) REFERENCES amux.members(id) ON DELETE CASCADE;


--
-- Name: apps apps_created_by_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.apps
    ADD CONSTRAINT apps_created_by_actor_id_fkey FOREIGN KEY (created_by_actor_id) REFERENCES amux.actors(id) ON DELETE RESTRICT;


--
-- Name: apps apps_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.apps
    ADD CONSTRAINT apps_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: apps apps_workspace_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.apps
    ADD CONSTRAINT apps_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES amux.workspaces(id) ON DELETE SET NULL;


--
-- Name: client_presence client_presence_user_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.client_presence
    ADD CONSTRAINT client_presence_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: device_push_tokens device_push_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.device_push_tokens
    ADD CONSTRAINT device_push_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: idea_activities idea_activities_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.idea_activities
    ADD CONSTRAINT idea_activities_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES amux.actors(id) ON DELETE RESTRICT;


--
-- Name: idea_activities idea_activities_idea_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.idea_activities
    ADD CONSTRAINT idea_activities_idea_id_fkey FOREIGN KEY (idea_id) REFERENCES amux.ideas(id) ON DELETE CASCADE;


--
-- Name: idea_activities idea_activities_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.idea_activities
    ADD CONSTRAINT idea_activities_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: idea_external_refs idea_external_refs_idea_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.idea_external_refs
    ADD CONSTRAINT idea_external_refs_idea_id_fkey FOREIGN KEY (idea_id) REFERENCES amux.ideas(id) ON DELETE CASCADE;


--
-- Name: idea_external_refs idea_external_refs_linked_by_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.idea_external_refs
    ADD CONSTRAINT idea_external_refs_linked_by_actor_id_fkey FOREIGN KEY (linked_by_actor_id) REFERENCES amux.actors(id) ON DELETE SET NULL;


--
-- Name: ideas ideas_created_by_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.ideas
    ADD CONSTRAINT ideas_created_by_actor_id_fkey FOREIGN KEY (created_by_actor_id) REFERENCES amux.actors(id) ON DELETE SET NULL;


--
-- Name: ideas ideas_parent_idea_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.ideas
    ADD CONSTRAINT ideas_parent_idea_id_fkey FOREIGN KEY (parent_idea_id) REFERENCES amux.ideas(id) ON DELETE SET NULL;


--
-- Name: ideas ideas_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.ideas
    ADD CONSTRAINT ideas_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: ideas ideas_workspace_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.ideas
    ADD CONSTRAINT ideas_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES amux.workspaces(id) ON DELETE SET NULL;


--
-- Name: members members_default_agent_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.members
    ADD CONSTRAINT members_default_agent_id_fkey FOREIGN KEY (default_agent_id) REFERENCES amux.agents(id) ON DELETE SET NULL;


--
-- Name: members members_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.members
    ADD CONSTRAINT members_id_fkey FOREIGN KEY (id) REFERENCES amux.actors(id) ON DELETE CASCADE;


--
-- Name: messages messages_reply_to_message_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.messages
    ADD CONSTRAINT messages_reply_to_message_id_fkey FOREIGN KEY (reply_to_message_id) REFERENCES amux.messages(id) ON DELETE SET NULL;


--
-- Name: messages messages_sender_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.messages
    ADD CONSTRAINT messages_sender_actor_id_fkey FOREIGN KEY (sender_actor_id) REFERENCES amux.actors(id) ON DELETE SET NULL;


--
-- Name: messages messages_session_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.messages
    ADD CONSTRAINT messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES amux.sessions(id) ON DELETE CASCADE;


--
-- Name: messages messages_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.messages
    ADD CONSTRAINT messages_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: notification_prefs notification_prefs_user_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.notification_prefs
    ADD CONSTRAINT notification_prefs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: permission_roles permission_roles_permission_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.permission_roles
    ADD CONSTRAINT permission_roles_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES amux.permissions(id) ON DELETE CASCADE;


--
-- Name: permission_roles permission_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.permission_roles
    ADD CONSTRAINT permission_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES amux.team_roles(id) ON DELETE CASCADE;


--
-- Name: permissions permissions_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.permissions
    ADD CONSTRAINT permissions_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: push_idempotency push_idempotency_message_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.push_idempotency
    ADD CONSTRAINT push_idempotency_message_id_fkey FOREIGN KEY (message_id) REFERENCES amux.messages(id) ON DELETE CASCADE;


--
-- Name: session_mutes session_mutes_session_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.session_mutes
    ADD CONSTRAINT session_mutes_session_id_fkey FOREIGN KEY (session_id) REFERENCES amux.sessions(id) ON DELETE CASCADE;


--
-- Name: session_mutes session_mutes_user_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.session_mutes
    ADD CONSTRAINT session_mutes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: session_participants session_participants_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.session_participants
    ADD CONSTRAINT session_participants_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES amux.actors(id) ON DELETE CASCADE;


--
-- Name: session_participants session_participants_session_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.session_participants
    ADD CONSTRAINT session_participants_session_id_fkey FOREIGN KEY (session_id) REFERENCES amux.sessions(id) ON DELETE CASCADE;


--
-- Name: session_read_markers session_read_markers_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.session_read_markers
    ADD CONSTRAINT session_read_markers_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES amux.actors(id) ON DELETE CASCADE;


--
-- Name: session_read_markers session_read_markers_last_read_message_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.session_read_markers
    ADD CONSTRAINT session_read_markers_last_read_message_id_fkey FOREIGN KEY (last_read_message_id) REFERENCES amux.messages(id) ON DELETE SET NULL;


--
-- Name: session_read_markers session_read_markers_session_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.session_read_markers
    ADD CONSTRAINT session_read_markers_session_id_fkey FOREIGN KEY (session_id) REFERENCES amux.sessions(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_app_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.sessions
    ADD CONSTRAINT sessions_app_id_fkey FOREIGN KEY (app_id) REFERENCES amux.apps(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_created_by_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.sessions
    ADD CONSTRAINT sessions_created_by_actor_id_fkey FOREIGN KEY (created_by_actor_id) REFERENCES amux.actors(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_idea_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.sessions
    ADD CONSTRAINT sessions_idea_id_fkey FOREIGN KEY (idea_id) REFERENCES amux.ideas(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_primary_agent_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.sessions
    ADD CONSTRAINT sessions_primary_agent_id_fkey FOREIGN KEY (primary_agent_id) REFERENCES amux.agents(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.sessions
    ADD CONSTRAINT sessions_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: shortcuts shortcuts_owner_member_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.shortcuts
    ADD CONSTRAINT shortcuts_owner_member_id_fkey FOREIGN KEY (owner_member_id) REFERENCES amux.members(id) ON DELETE CASCADE;


--
-- Name: shortcuts shortcuts_parent_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.shortcuts
    ADD CONSTRAINT shortcuts_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES amux.shortcuts(id) ON DELETE CASCADE;


--
-- Name: shortcuts shortcuts_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.shortcuts
    ADD CONSTRAINT shortcuts_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: team_invites team_invites_consumed_by_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_invites
    ADD CONSTRAINT team_invites_consumed_by_actor_id_fkey FOREIGN KEY (consumed_by_actor_id) REFERENCES amux.actors(id) ON DELETE SET NULL;


--
-- Name: team_invites team_invites_invited_by_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_invites
    ADD CONSTRAINT team_invites_invited_by_actor_id_fkey FOREIGN KEY (invited_by_actor_id) REFERENCES amux.actors(id) ON DELETE SET NULL;


--
-- Name: team_invites team_invites_target_actor_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_invites
    ADD CONSTRAINT team_invites_target_actor_id_fkey FOREIGN KEY (target_actor_id) REFERENCES amux.actors(id) ON DELETE CASCADE;


--
-- Name: team_invites team_invites_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_invites
    ADD CONSTRAINT team_invites_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: team_member_roles team_member_roles_member_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_member_roles
    ADD CONSTRAINT team_member_roles_member_id_fkey FOREIGN KEY (member_id) REFERENCES amux.members(id) ON DELETE CASCADE;


--
-- Name: team_member_roles team_member_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_member_roles
    ADD CONSTRAINT team_member_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES amux.team_roles(id) ON DELETE CASCADE;


--
-- Name: team_member_roles team_member_roles_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_member_roles
    ADD CONSTRAINT team_member_roles_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_member_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_members
    ADD CONSTRAINT team_members_member_id_fkey FOREIGN KEY (member_id) REFERENCES amux.members(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_members
    ADD CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: team_roles team_roles_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_roles
    ADD CONSTRAINT team_roles_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: team_workspace_config team_workspace_config_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.team_workspace_config
    ADD CONSTRAINT team_workspace_config_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: teams teams_oid_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.teams
    ADD CONSTRAINT teams_oid_fkey FOREIGN KEY (oid) REFERENCES public.orgs(id);


--
-- Name: workspaces workspaces_agent_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.workspaces
    ADD CONSTRAINT workspaces_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES amux.agents(id) ON DELETE SET NULL;


--
-- Name: workspaces workspaces_created_by_member_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.workspaces
    ADD CONSTRAINT workspaces_created_by_member_id_fkey FOREIGN KEY (created_by_member_id) REFERENCES amux.members(id) ON DELETE SET NULL;


--
-- Name: workspaces workspaces_team_id_fkey; Type: FK CONSTRAINT; Schema: amux; Owner: -
--

ALTER TABLE ONLY amux.workspaces
    ADD CONSTRAINT workspaces_team_id_fkey FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;


--
-- Name: orgs orgs_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id);


--
-- Name: users users_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id);


--
-- Name: users users_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id);


--
-- Name: actor_client_versions; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.actor_client_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: actor_client_versions actor_client_versions_select; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY actor_client_versions_select ON amux.actor_client_versions FOR SELECT USING ((amux.current_actor_id_for_team(team_id) IS NOT NULL));


--
-- Name: actor_message_feedback; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.actor_message_feedback ENABLE ROW LEVEL SECURITY;

--
-- Name: actor_message_feedback actor_message_feedback_delete_self; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY actor_message_feedback_delete_self ON amux.actor_message_feedback FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM amux.actors a
  WHERE ((a.id = actor_message_feedback.actor_id) AND (a.user_id = auth.uid())))));


--
-- Name: actor_message_feedback actor_message_feedback_insert_self; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY actor_message_feedback_insert_self ON amux.actor_message_feedback FOR INSERT TO authenticated WITH CHECK ((amux.is_team_member(team_id) AND (EXISTS ( SELECT 1
   FROM amux.actors a
  WHERE ((a.id = actor_message_feedback.actor_id) AND (a.user_id = auth.uid()) AND (a.team_id = a.team_id))))));


--
-- Name: actor_message_feedback actor_message_feedback_select_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY actor_message_feedback_select_if_team_member ON amux.actor_message_feedback FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: actor_message_feedback actor_message_feedback_update_self; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY actor_message_feedback_update_self ON amux.actor_message_feedback FOR UPDATE TO authenticated USING ((amux.is_team_member(team_id) AND (EXISTS ( SELECT 1
   FROM amux.actors a
  WHERE ((a.id = actor_message_feedback.actor_id) AND (a.user_id = auth.uid()) AND (a.team_id = a.team_id)))))) WITH CHECK ((amux.is_team_member(team_id) AND (EXISTS ( SELECT 1
   FROM amux.actors a
  WHERE ((a.id = actor_message_feedback.actor_id) AND (a.user_id = auth.uid()) AND (a.team_id = a.team_id))))));


--
-- Name: actor_session_report; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.actor_session_report ENABLE ROW LEVEL SECURITY;

--
-- Name: actor_session_report actor_session_report_insert_self; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY actor_session_report_insert_self ON amux.actor_session_report FOR INSERT TO authenticated WITH CHECK ((amux.is_team_member(team_id) AND (EXISTS ( SELECT 1
   FROM amux.actors a
  WHERE ((a.id = actor_session_report.actor_id) AND (a.user_id = auth.uid()) AND (a.team_id = a.team_id))))));


--
-- Name: actor_session_report actor_session_report_select_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY actor_session_report_select_if_team_member ON amux.actor_session_report FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: actor_skill_usage; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.actor_skill_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: actor_skill_usage actor_skill_usage_insert_self; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY actor_skill_usage_insert_self ON amux.actor_skill_usage FOR INSERT TO authenticated WITH CHECK ((amux.is_team_member(team_id) AND (EXISTS ( SELECT 1
   FROM amux.actors a
  WHERE ((a.id = actor_skill_usage.actor_id) AND (a.user_id = auth.uid()) AND (a.team_id = a.team_id))))));


--
-- Name: actor_skill_usage actor_skill_usage_select_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY actor_skill_usage_select_if_team_member ON amux.actor_skill_usage FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: actors; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.actors ENABLE ROW LEVEL SECURITY;

--
-- Name: actors actors_select_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY actors_select_if_team_member ON amux.actors FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: actors actors_self_heartbeat; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY actors_self_heartbeat ON amux.actors FOR UPDATE TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: agent_member_access; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.agent_member_access ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_member_access agent_member_access_manage_if_agent_owner; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY agent_member_access_manage_if_agent_owner ON amux.agent_member_access TO authenticated USING ((EXISTS ( SELECT 1
   FROM amux.agents ag
  WHERE ((ag.id = agent_member_access.agent_id) AND (ag.owner_member_id = amux.current_actor_for_agent(ag.id)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM amux.agents ag
  WHERE ((ag.id = agent_member_access.agent_id) AND (ag.owner_member_id = amux.current_actor_for_agent(ag.id))))));


--
-- Name: agent_member_access agent_member_access_select_if_agent_owner_or_self; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY agent_member_access_select_if_agent_owner_or_self ON amux.agent_member_access FOR SELECT TO authenticated USING (((member_id = amux.current_actor_for_agent(agent_id)) OR (EXISTS ( SELECT 1
   FROM amux.agents ag
  WHERE ((ag.id = agent_member_access.agent_id) AND (ag.owner_member_id = amux.current_actor_for_agent(ag.id)))))));


--
-- Name: agent_runtimes; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.agent_runtimes ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_runtimes agent_runtimes_agent_update; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY agent_runtimes_agent_update ON amux.agent_runtimes FOR UPDATE TO authenticated USING (amux.is_current_agent(agent_id)) WITH CHECK (amux.is_current_agent(agent_id));


--
-- Name: agent_runtimes agent_runtimes_agent_write; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY agent_runtimes_agent_write ON amux.agent_runtimes FOR INSERT TO authenticated WITH CHECK ((amux.is_current_agent(agent_id) AND (team_id = ( SELECT actors.team_id
   FROM amux.actors
  WHERE (actors.id = agent_runtimes.agent_id)))));


--
-- Name: agent_runtimes agent_runtimes_select_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY agent_runtimes_select_if_team_member ON amux.agent_runtimes FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: agents; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.agents ENABLE ROW LEVEL SECURITY;

--
-- Name: agents agents_select_if_visible; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY agents_select_if_visible ON amux.agents FOR SELECT TO authenticated USING ((amux.is_current_agent(id) OR (EXISTS ( SELECT 1
   FROM amux.actors a
  WHERE ((a.id = agents.id) AND amux.is_team_member(a.team_id) AND ((agents.visibility = 'team'::text) OR (agents.owner_member_id = amux.current_actor_id_for_team(a.team_id))))))));


--
-- Name: agents agents_self_update; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY agents_self_update ON amux.agents FOR UPDATE TO authenticated USING (amux.is_current_agent(id)) WITH CHECK (amux.is_current_agent(id));


--
-- Name: amuxc_blobs; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.amuxc_blobs ENABLE ROW LEVEL SECURITY;

--
-- Name: amuxc_blobs amuxc_blobs_select_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY amuxc_blobs_select_team_member ON amux.amuxc_blobs FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: amuxc_file_versions; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.amuxc_file_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: amuxc_file_versions amuxc_file_versions_select_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY amuxc_file_versions_select_team_member ON amux.amuxc_file_versions FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM amux.amuxc_files f
  WHERE ((f.id = amuxc_file_versions.file_id) AND amux.is_team_member(f.team_id)))));


--
-- Name: amuxc_files; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.amuxc_files ENABLE ROW LEVEL SECURITY;

--
-- Name: amuxc_files amuxc_files_select_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY amuxc_files_select_team_member ON amux.amuxc_files FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: amuxc_upload_sessions; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.amuxc_upload_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: amuxc_upload_sessions amuxc_upload_sessions_select_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY amuxc_upload_sessions_select_team_member ON amux.amuxc_upload_sessions FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: app_member_access; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.app_member_access ENABLE ROW LEVEL SECURITY;

--
-- Name: app_member_access app_member_access_manage; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY app_member_access_manage ON amux.app_member_access TO authenticated USING ((EXISTS ( SELECT 1
   FROM amux.apps a
  WHERE ((a.id = app_member_access.app_id) AND (a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM amux.apps a
  WHERE ((a.id = app_member_access.app_id) AND (a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id))))));


--
-- Name: app_member_access app_member_access_select; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY app_member_access_select ON amux.app_member_access FOR SELECT TO authenticated USING (((member_id = amux.current_member_id()) OR (EXISTS ( SELECT 1
   FROM amux.apps a
  WHERE ((a.id = app_member_access.app_id) AND (a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)))))));


--
-- Name: apps; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.apps ENABLE ROW LEVEL SECURITY;

--
-- Name: apps apps_insert_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY apps_insert_if_team_member ON amux.apps FOR INSERT TO authenticated WITH CHECK ((amux.is_team_member(team_id) AND (created_by_actor_id = amux.current_actor_id_for_team(team_id))));


--
-- Name: apps apps_select_if_visible; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY apps_select_if_visible ON amux.apps FOR SELECT TO authenticated USING ((amux.is_team_member(team_id) AND ((visibility = 'team'::text) OR (created_by_actor_id = amux.current_actor_id_for_team(team_id)) OR amux.actor_has_app_access(id, amux.current_actor_id_for_team(team_id)))));


--
-- Name: apps apps_update_if_creator; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY apps_update_if_creator ON amux.apps FOR UPDATE TO authenticated USING ((created_by_actor_id = amux.current_actor_id_for_team(team_id))) WITH CHECK ((created_by_actor_id = amux.current_actor_id_for_team(team_id)));


--
-- Name: client_presence; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.client_presence ENABLE ROW LEVEL SECURITY;

--
-- Name: client_presence client_presence_owner; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY client_presence_owner ON amux.client_presence TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: device_push_tokens; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.device_push_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: device_push_tokens device_push_tokens_owner; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY device_push_tokens_owner ON amux.device_push_tokens TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: idea_activities; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.idea_activities ENABLE ROW LEVEL SECURITY;

--
-- Name: idea_activities idea_activities_insert_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY idea_activities_insert_if_team_member ON amux.idea_activities FOR INSERT TO authenticated WITH CHECK ((amux.is_team_member(team_id) AND (actor_id = amux.current_actor_id()) AND (EXISTS ( SELECT 1
   FROM amux.ideas i
  WHERE ((i.id = idea_activities.idea_id) AND (i.team_id = idea_activities.team_id))))));


--
-- Name: idea_activities idea_activities_select_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY idea_activities_select_if_team_member ON amux.idea_activities FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: idea_external_refs; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.idea_external_refs ENABLE ROW LEVEL SECURITY;

--
-- Name: idea_external_refs idea_external_refs_insert_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY idea_external_refs_insert_if_team_member ON amux.idea_external_refs FOR INSERT TO authenticated WITH CHECK (((EXISTS ( SELECT 1
   FROM amux.ideas t
  WHERE ((t.id = idea_external_refs.idea_id) AND amux.is_team_member(t.team_id)))) AND (linked_by_actor_id = amux.current_actor_id())));


--
-- Name: idea_external_refs idea_external_refs_select_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY idea_external_refs_select_if_team_member ON amux.idea_external_refs FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM amux.ideas t
  WHERE ((t.id = idea_external_refs.idea_id) AND amux.is_team_member(t.team_id)))));


--
-- Name: ideas; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.ideas ENABLE ROW LEVEL SECURITY;

--
-- Name: ideas ideas_insert_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY ideas_insert_if_team_member ON amux.ideas FOR INSERT TO authenticated WITH CHECK ((amux.is_team_member(team_id) AND (created_by_actor_id = amux.current_actor_id())));


--
-- Name: ideas ideas_select_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY ideas_select_if_team_member ON amux.ideas FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: ideas ideas_update_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY ideas_update_if_team_member ON amux.ideas FOR UPDATE TO authenticated USING (amux.is_team_member(team_id)) WITH CHECK ((amux.is_team_member(team_id) AND amux.uuid_column_matches_existing('amux.ideas'::regclass, id, 'created_by_actor_id'::text, created_by_actor_id)));


--
-- Name: members; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.members ENABLE ROW LEVEL SECURITY;

--
-- Name: members members_select_self_or_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY members_select_self_or_team_member ON amux.members FOR SELECT TO authenticated USING (((id = amux.current_member_id()) OR (EXISTS ( SELECT 1
   FROM amux.actors a
  WHERE ((a.id = members.id) AND amux.is_team_member(a.team_id))))));


--
-- Name: messages; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: messages messages_agent_write; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY messages_agent_write ON amux.messages FOR INSERT TO authenticated WITH CHECK ((amux.is_current_agent(sender_actor_id) AND (team_id = ( SELECT actors.team_id
   FROM amux.actors
  WHERE (actors.id = messages.sender_actor_id)))));


--
-- Name: messages messages_daemon_gateway_participant_write; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY messages_daemon_gateway_participant_write ON amux.messages FOR INSERT TO authenticated WITH CHECK (amux.daemon_can_write_gateway_message(team_id, session_id, sender_actor_id));


--
-- Name: messages messages_insert_if_session_participant; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY messages_insert_if_session_participant ON amux.messages FOR INSERT TO authenticated WITH CHECK ((amux.is_session_participant(session_id) AND (sender_actor_id = amux.current_actor_id())));


--
-- Name: messages messages_select_if_session_participant; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY messages_select_if_session_participant ON amux.messages FOR SELECT TO authenticated USING (amux.is_session_participant(session_id));


--
-- Name: notification_prefs; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.notification_prefs ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_prefs notification_prefs_owner; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY notification_prefs_owner ON amux.notification_prefs TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: permission_roles; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.permission_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: permission_roles permission_roles_select_if_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY permission_roles_select_if_member ON amux.permission_roles FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM amux.permissions p
  WHERE ((p.id = permission_roles.permission_id) AND amux.is_team_member(p.team_id)))));


--
-- Name: permission_roles permission_roles_write_if_admin; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY permission_roles_write_if_admin ON amux.permission_roles TO authenticated USING ((EXISTS ( SELECT 1
   FROM amux.permissions p
  WHERE ((p.id = permission_roles.permission_id) AND amux.is_team_admin_or_owner(p.team_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM amux.permissions p
  WHERE ((p.id = permission_roles.permission_id) AND amux.is_team_admin_or_owner(p.team_id)))));


--
-- Name: permissions; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: permissions permissions_select_if_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY permissions_select_if_member ON amux.permissions FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: permissions permissions_write_if_admin; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY permissions_write_if_admin ON amux.permissions TO authenticated USING (amux.is_team_admin_or_owner(team_id)) WITH CHECK (amux.is_team_admin_or_owner(team_id));


--
-- Name: push_idempotency; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.push_idempotency ENABLE ROW LEVEL SECURITY;

--
-- Name: session_mutes; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.session_mutes ENABLE ROW LEVEL SECURITY;

--
-- Name: session_mutes session_mutes_owner; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY session_mutes_owner ON amux.session_mutes TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: session_participants; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.session_participants ENABLE ROW LEVEL SECURITY;

--
-- Name: session_participants session_participants_insert_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY session_participants_insert_if_team_member ON amux.session_participants FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM amux.sessions s
  WHERE ((s.id = session_participants.session_id) AND amux.is_team_member(s.team_id) AND ((s.created_by_actor_id = amux.current_actor_id_for_team(s.team_id)) OR amux.is_session_participant(session_participants.session_id))))));


--
-- Name: session_participants session_participants_select_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY session_participants_select_if_team_member ON amux.session_participants FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM amux.sessions s
  WHERE ((s.id = session_participants.session_id) AND amux.is_team_member(s.team_id)))));


--
-- Name: session_read_markers; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.session_read_markers ENABLE ROW LEVEL SECURITY;

--
-- Name: session_read_markers session_read_markers_insert_own; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY session_read_markers_insert_own ON amux.session_read_markers FOR INSERT TO authenticated WITH CHECK (((actor_id = amux.current_actor_id()) AND amux.is_session_participant(session_id)));


--
-- Name: session_read_markers session_read_markers_select_own; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY session_read_markers_select_own ON amux.session_read_markers FOR SELECT TO authenticated USING (((actor_id = amux.current_actor_id()) AND amux.is_session_participant(session_id)));


--
-- Name: session_read_markers session_read_markers_update_own; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY session_read_markers_update_own ON amux.session_read_markers FOR UPDATE TO authenticated USING (((actor_id = amux.current_actor_id()) AND amux.is_session_participant(session_id))) WITH CHECK (((actor_id = amux.current_actor_id()) AND amux.is_session_participant(session_id)));


--
-- Name: sessions; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions sessions_insert_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY sessions_insert_if_team_member ON amux.sessions FOR INSERT TO authenticated WITH CHECK ((amux.is_team_member(team_id) AND (created_by_actor_id = amux.current_actor_id_for_team(team_id))));


--
-- Name: sessions sessions_select_if_participant_or_creator; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY sessions_select_if_participant_or_creator ON amux.sessions FOR SELECT TO authenticated USING ((amux.is_team_member(team_id) AND ((created_by_actor_id = amux.current_actor_id()) OR (primary_agent_id = amux.current_actor_id()) OR amux.is_session_participant(id))));


--
-- Name: sessions sessions_update_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY sessions_update_if_team_member ON amux.sessions FOR UPDATE TO authenticated USING (amux.is_team_member(team_id)) WITH CHECK ((amux.is_team_member(team_id) AND amux.uuid_column_matches_existing('amux.sessions'::regclass, id, 'created_by_actor_id'::text, created_by_actor_id)));


--
-- Name: shortcuts; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.shortcuts ENABLE ROW LEVEL SECURITY;

--
-- Name: shortcuts shortcuts_select_personal; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY shortcuts_select_personal ON amux.shortcuts FOR SELECT TO authenticated USING (((scope = 'personal'::text) AND (owner_member_id = amux.current_member_id())));


--
-- Name: shortcuts shortcuts_select_team; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY shortcuts_select_team ON amux.shortcuts FOR SELECT TO authenticated USING (((scope = 'team'::text) AND amux.member_can_see_shortcut(id)));


--
-- Name: shortcuts shortcuts_write_personal; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY shortcuts_write_personal ON amux.shortcuts TO authenticated USING (((scope = 'personal'::text) AND (owner_member_id = amux.current_member_id()))) WITH CHECK (((scope = 'personal'::text) AND (owner_member_id = amux.current_member_id())));


--
-- Name: shortcuts shortcuts_write_team; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY shortcuts_write_team ON amux.shortcuts TO authenticated USING (((scope = 'team'::text) AND amux.is_team_admin_or_owner(team_id))) WITH CHECK (((scope = 'team'::text) AND amux.is_team_admin_or_owner(team_id)));


--
-- Name: team_invites; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.team_invites ENABLE ROW LEVEL SECURITY;

--
-- Name: team_invites team_invites_insert_via_rpc; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY team_invites_insert_via_rpc ON amux.team_invites FOR INSERT TO authenticated WITH CHECK ((amux.is_team_member(team_id) AND (EXISTS ( SELECT 1
   FROM amux.actors a
  WHERE ((a.id = a.invited_by_actor_id) AND (a.user_id = auth.uid()) AND (a.team_id = a.team_id))))));


--
-- Name: team_invites team_invites_select_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY team_invites_select_if_team_member ON amux.team_invites FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: team_member_roles; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.team_member_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: team_member_roles team_member_roles_select_if_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY team_member_roles_select_if_member ON amux.team_member_roles FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: team_member_roles team_member_roles_write_if_admin; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY team_member_roles_write_if_admin ON amux.team_member_roles TO authenticated USING (amux.is_team_admin_or_owner(team_id)) WITH CHECK (amux.is_team_admin_or_owner(team_id));


--
-- Name: team_members; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.team_members ENABLE ROW LEVEL SECURITY;

--
-- Name: team_members team_members_select_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY team_members_select_if_team_member ON amux.team_members FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: team_roles; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.team_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: team_roles team_roles_select_if_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY team_roles_select_if_member ON amux.team_roles FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: team_roles team_roles_write_if_admin; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY team_roles_write_if_admin ON amux.team_roles TO authenticated USING (amux.is_team_admin_or_owner(team_id)) WITH CHECK (amux.is_team_admin_or_owner(team_id));


--
-- Name: team_workspace_config; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.team_workspace_config ENABLE ROW LEVEL SECURITY;

--
-- Name: team_workspace_config team_workspace_config_delete_if_owner; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY team_workspace_config_delete_if_owner ON amux.team_workspace_config FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM (amux.team_members tm
     JOIN amux.actors a ON ((a.id = tm.member_id)))
  WHERE ((tm.team_id = team_workspace_config.team_id) AND (a.user_id = auth.uid()) AND (tm.role = 'owner'::text)))));


--
-- Name: team_workspace_config team_workspace_config_insert_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY team_workspace_config_insert_if_team_member ON amux.team_workspace_config FOR INSERT TO authenticated WITH CHECK (amux.is_team_member(team_id));


--
-- Name: team_workspace_config team_workspace_config_select_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY team_workspace_config_select_if_team_member ON amux.team_workspace_config FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: team_workspace_config team_workspace_config_update_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY team_workspace_config_update_if_team_member ON amux.team_workspace_config FOR UPDATE TO authenticated USING (amux.is_team_member(team_id)) WITH CHECK (amux.is_team_member(team_id));


--
-- Name: teams; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.teams ENABLE ROW LEVEL SECURITY;

--
-- Name: teams teams_org_guard; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY teams_org_guard ON amux.teams USING (((oid IS NULL) OR (oid = ( SELECT amux.current_org_id() AS current_org_id)))) WITH CHECK (((oid IS NULL) OR (oid = ( SELECT amux.current_org_id() AS current_org_id))));


--
-- Name: teams teams_select_if_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY teams_select_if_member ON amux.teams FOR SELECT TO authenticated USING (amux.is_team_member(id));


--
-- Name: workspaces; Type: ROW SECURITY; Schema: amux; Owner: -
--

ALTER TABLE amux.workspaces ENABLE ROW LEVEL SECURITY;

--
-- Name: workspaces workspaces_agent_update; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY workspaces_agent_update ON amux.workspaces FOR UPDATE TO authenticated USING (amux.is_current_agent(agent_id)) WITH CHECK (amux.is_current_agent(agent_id));


--
-- Name: workspaces workspaces_agent_write; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY workspaces_agent_write ON amux.workspaces FOR INSERT TO authenticated WITH CHECK ((amux.is_current_agent(agent_id) AND (team_id = ( SELECT actors.team_id
   FROM amux.actors
  WHERE (actors.id = workspaces.agent_id)))));


--
-- Name: workspaces workspaces_insert_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY workspaces_insert_if_team_member ON amux.workspaces FOR INSERT TO authenticated WITH CHECK ((amux.is_team_member(team_id) AND ((created_by_member_id IS NULL) OR (created_by_member_id = amux.current_member_id()))));


--
-- Name: workspaces workspaces_select_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY workspaces_select_if_team_member ON amux.workspaces FOR SELECT TO authenticated USING (amux.is_team_member(team_id));


--
-- Name: workspaces workspaces_update_if_team_member; Type: POLICY; Schema: amux; Owner: -
--

CREATE POLICY workspaces_update_if_team_member ON amux.workspaces FOR UPDATE TO authenticated USING (amux.is_team_member(team_id)) WITH CHECK ((amux.is_team_member(team_id) AND amux.uuid_column_matches_existing('amux.workspaces'::regclass, id, 'created_by_member_id'::text, created_by_member_id)));


--
-- Name: orgs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.orgs ENABLE ROW LEVEL SECURITY;

--
-- Name: orgs orgs_view_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orgs_view_policy ON public.orgs FOR SELECT USING ((id = ( SELECT amux.current_org_id() AS current_org_id)));


--
-- Name: SCHEMA amux; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA amux TO anon;
GRANT USAGE ON SCHEMA amux TO authenticated;
GRANT USAGE ON SCHEMA amux TO service_role;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: TYPE team_share_mode; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TYPE amux.team_share_mode TO service_role;


--
-- Name: FUNCTION actor_id_for_user_in_team(p_user_id uuid, p_team_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.actor_id_for_user_in_team(p_user_id uuid, p_team_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.actor_id_for_user_in_team(p_user_id uuid, p_team_id uuid) TO service_role;


--
-- Name: FUNCTION actor_user_contact(p_user_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.actor_user_contact(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.actor_user_contact(p_user_id uuid) TO authenticated;


--
-- Name: FUNCTION add_gateway_session_participant(p_session_id uuid, p_actor_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.add_gateway_session_participant(p_session_id uuid, p_actor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.add_gateway_session_participant(p_session_id uuid, p_actor_id uuid) TO service_role;
GRANT ALL ON FUNCTION amux.add_gateway_session_participant(p_session_id uuid, p_actor_id uuid) TO authenticated;


--
-- Name: FUNCTION amux_access_token_hook(event jsonb); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.amux_access_token_hook(event jsonb) TO supabase_auth_admin;
GRANT ALL ON FUNCTION amux.amux_access_token_hook(event jsonb) TO anon;
GRANT ALL ON FUNCTION amux.amux_access_token_hook(event jsonb) TO authenticated;
GRANT ALL ON FUNCTION amux.amux_access_token_hook(event jsonb) TO service_role;


--
-- Name: FUNCTION amux_acl_rules_for(p_team uuid, p_actor uuid, p_type text); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.amux_acl_rules_for(p_team uuid, p_actor uuid, p_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.amux_acl_rules_for(p_team uuid, p_actor uuid, p_type text) TO supabase_auth_admin;


--
-- Name: FUNCTION amuxc_complete_delete(p_team_id uuid, p_path text, p_parent_version integer, p_actor_id uuid, p_node_id text); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.amuxc_complete_delete(p_team_id uuid, p_path text, p_parent_version integer, p_actor_id uuid, p_node_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.amuxc_complete_delete(p_team_id uuid, p_path text, p_parent_version integer, p_actor_id uuid, p_node_id text) TO service_role;


--
-- Name: FUNCTION amuxc_complete_upload(p_session_id uuid, p_actor_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.amuxc_complete_upload(p_session_id uuid, p_actor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.amuxc_complete_upload(p_session_id uuid, p_actor_id uuid) TO service_role;


--
-- Name: FUNCTION archive_idea(p_idea_id uuid, p_archived boolean); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.archive_idea(p_idea_id uuid, p_archived boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.archive_idea(p_idea_id uuid, p_archived boolean) TO anon;
GRANT ALL ON FUNCTION amux.archive_idea(p_idea_id uuid, p_archived boolean) TO authenticated;
GRANT ALL ON FUNCTION amux.archive_idea(p_idea_id uuid, p_archived boolean) TO service_role;


--
-- Name: FUNCTION can_prompt_agent(target_agent_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.can_prompt_agent(target_agent_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.can_prompt_agent(target_agent_id uuid) TO authenticated;


--
-- Name: FUNCTION check_agent_permission(p_agent_id uuid, p_actor_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.check_agent_permission(p_agent_id uuid, p_actor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.check_agent_permission(p_agent_id uuid, p_actor_id uuid) TO anon;
GRANT ALL ON FUNCTION amux.check_agent_permission(p_agent_id uuid, p_actor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION amux.check_agent_permission(p_agent_id uuid, p_actor_id uuid) TO service_role;


--
-- Name: FUNCTION claim_team_invite(p_token text); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.claim_team_invite(p_token text) TO anon;
GRANT ALL ON FUNCTION amux.claim_team_invite(p_token text) TO authenticated;
GRANT ALL ON FUNCTION amux.claim_team_invite(p_token text) TO service_role;


--
-- Name: FUNCTION create_idea(p_team_id uuid, p_title text, p_workspace_id uuid, p_description text); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.create_idea(p_team_id uuid, p_title text, p_workspace_id uuid, p_description text) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.create_idea(p_team_id uuid, p_title text, p_workspace_id uuid, p_description text) TO authenticated;
GRANT ALL ON FUNCTION amux.create_idea(p_team_id uuid, p_title text, p_workspace_id uuid, p_description text) TO service_role;


--
-- Name: FUNCTION create_idea_activity(p_idea_id uuid, p_activity_type text, p_content text, p_metadata jsonb, p_attachment_urls text[]); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.create_idea_activity(p_idea_id uuid, p_activity_type text, p_content text, p_metadata jsonb, p_attachment_urls text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.create_idea_activity(p_idea_id uuid, p_activity_type text, p_content text, p_metadata jsonb, p_attachment_urls text[]) TO authenticated;
GRANT ALL ON FUNCTION amux.create_idea_activity(p_idea_id uuid, p_activity_type text, p_content text, p_metadata jsonb, p_attachment_urls text[]) TO service_role;


--
-- Name: FUNCTION create_session(p_primary_agent_id uuid, p_idea_id uuid, p_mode text, p_title text); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.create_session(p_primary_agent_id uuid, p_idea_id uuid, p_mode text, p_title text) TO anon;
GRANT ALL ON FUNCTION amux.create_session(p_primary_agent_id uuid, p_idea_id uuid, p_mode text, p_title text) TO authenticated;
GRANT ALL ON FUNCTION amux.create_session(p_primary_agent_id uuid, p_idea_id uuid, p_mode text, p_title text) TO service_role;


--
-- Name: FUNCTION create_team(p_name text, p_slug text, p_litellm_team_id text, p_ai_gateway_endpoint text, p_display_name text); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.create_team(p_name text, p_slug text, p_litellm_team_id text, p_ai_gateway_endpoint text, p_display_name text) TO anon;
GRANT ALL ON FUNCTION amux.create_team(p_name text, p_slug text, p_litellm_team_id text, p_ai_gateway_endpoint text, p_display_name text) TO authenticated;
GRANT ALL ON FUNCTION amux.create_team(p_name text, p_slug text, p_litellm_team_id text, p_ai_gateway_endpoint text, p_display_name text) TO service_role;


--
-- Name: FUNCTION create_team(p_name text, p_slug text, p_litellm_team_id text, p_ai_gateway_endpoint text, p_display_name text, p_oid uuid); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.create_team(p_name text, p_slug text, p_litellm_team_id text, p_ai_gateway_endpoint text, p_display_name text, p_oid uuid) TO anon;
GRANT ALL ON FUNCTION amux.create_team(p_name text, p_slug text, p_litellm_team_id text, p_ai_gateway_endpoint text, p_display_name text, p_oid uuid) TO authenticated;
GRANT ALL ON FUNCTION amux.create_team(p_name text, p_slug text, p_litellm_team_id text, p_ai_gateway_endpoint text, p_display_name text, p_oid uuid) TO service_role;


--
-- Name: FUNCTION create_team_invite(p_team_id uuid, p_kind text, p_display_name text, p_team_role text, p_agent_kind text, p_ttl_seconds integer, p_target_actor_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.create_team_invite(p_team_id uuid, p_kind text, p_display_name text, p_team_role text, p_agent_kind text, p_ttl_seconds integer, p_target_actor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.create_team_invite(p_team_id uuid, p_kind text, p_display_name text, p_team_role text, p_agent_kind text, p_ttl_seconds integer, p_target_actor_id uuid) TO anon;
GRANT ALL ON FUNCTION amux.create_team_invite(p_team_id uuid, p_kind text, p_display_name text, p_team_role text, p_agent_kind text, p_ttl_seconds integer, p_target_actor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION amux.create_team_invite(p_team_id uuid, p_kind text, p_display_name text, p_team_role text, p_agent_kind text, p_ttl_seconds integer, p_target_actor_id uuid) TO service_role;


--
-- Name: FUNCTION current_actor_for_agent(p_agent_id uuid); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.current_actor_for_agent(p_agent_id uuid) TO authenticated;


--
-- Name: FUNCTION current_actor_id(); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.current_actor_id() FROM PUBLIC;
GRANT ALL ON FUNCTION amux.current_actor_id() TO authenticated;


--
-- Name: FUNCTION current_actor_id_for_team(p_team_id uuid); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.current_actor_id_for_team(p_team_id uuid) TO authenticated;


--
-- Name: FUNCTION current_jwt_actor_id(); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.current_jwt_actor_id() FROM PUBLIC;
GRANT ALL ON FUNCTION amux.current_jwt_actor_id() TO authenticated;


--
-- Name: FUNCTION current_jwt_kind(); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.current_jwt_kind() FROM PUBLIC;
GRANT ALL ON FUNCTION amux.current_jwt_kind() TO authenticated;


--
-- Name: FUNCTION current_jwt_team_id(); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.current_jwt_team_id() FROM PUBLIC;
GRANT ALL ON FUNCTION amux.current_jwt_team_id() TO authenticated;


--
-- Name: FUNCTION current_member_id(); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.current_member_id() FROM PUBLIC;
GRANT ALL ON FUNCTION amux.current_member_id() TO authenticated;


--
-- Name: FUNCTION current_org_id(); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.current_org_id() TO anon;
GRANT ALL ON FUNCTION amux.current_org_id() TO authenticated;
GRANT ALL ON FUNCTION amux.current_org_id() TO service_role;


--
-- Name: FUNCTION current_team_role(target_team_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.current_team_role(target_team_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.current_team_role(target_team_id uuid) TO authenticated;


--
-- Name: FUNCTION daemon_can_write_gateway_message(p_team_id uuid, p_session_id uuid, p_sender_actor_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.daemon_can_write_gateway_message(p_team_id uuid, p_session_id uuid, p_sender_actor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.daemon_can_write_gateway_message(p_team_id uuid, p_session_id uuid, p_sender_actor_id uuid) TO authenticated;


--
-- Name: TABLE teams; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.teams TO anon;
GRANT ALL ON TABLE amux.teams TO authenticated;
GRANT ALL ON TABLE amux.teams TO service_role;


--
-- Name: FUNCTION disable_team_share(p_team_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.disable_team_share(p_team_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.disable_team_share(p_team_id uuid) TO service_role;


--
-- Name: FUNCTION enable_team_share(p_team_id uuid, p_mode amux.team_share_mode, p_git_remote_url text, p_git_auth_kind text, p_git_credential_ref text); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.enable_team_share(p_team_id uuid, p_mode amux.team_share_mode, p_git_remote_url text, p_git_auth_kind text, p_git_credential_ref text) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.enable_team_share(p_team_id uuid, p_mode amux.team_share_mode, p_git_remote_url text, p_git_auth_kind text, p_git_credential_ref text) TO service_role;


--
-- Name: FUNCTION ensure_gateway_session(p_team_id uuid, p_binding text, p_title text, p_primary_agent_actor_id uuid, p_owner_member_actor_ids uuid[], p_participant_actor_ids uuid[]); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.ensure_gateway_session(p_team_id uuid, p_binding text, p_title text, p_primary_agent_actor_id uuid, p_owner_member_actor_ids uuid[], p_participant_actor_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.ensure_gateway_session(p_team_id uuid, p_binding text, p_title text, p_primary_agent_actor_id uuid, p_owner_member_actor_ids uuid[], p_participant_actor_ids uuid[]) TO service_role;
GRANT ALL ON FUNCTION amux.ensure_gateway_session(p_team_id uuid, p_binding text, p_title text, p_primary_agent_actor_id uuid, p_owner_member_actor_ids uuid[], p_participant_actor_ids uuid[]) TO authenticated;


--
-- Name: FUNCTION ensure_personal_org(); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.ensure_personal_org() TO anon;
GRANT ALL ON FUNCTION amux.ensure_personal_org() TO authenticated;
GRANT ALL ON FUNCTION amux.ensure_personal_org() TO service_role;


--
-- Name: FUNCTION get_member_default_agent(p_team_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.get_member_default_agent(p_team_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.get_member_default_agent(p_team_id uuid) TO anon;
GRANT ALL ON FUNCTION amux.get_member_default_agent(p_team_id uuid) TO authenticated;
GRANT ALL ON FUNCTION amux.get_member_default_agent(p_team_id uuid) TO service_role;


--
-- Name: FUNCTION get_team_sync_mode(p_team_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.get_team_sync_mode(p_team_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.get_team_sync_mode(p_team_id uuid) TO anon;
GRANT ALL ON FUNCTION amux.get_team_sync_mode(p_team_id uuid) TO authenticated;
GRANT ALL ON FUNCTION amux.get_team_sync_mode(p_team_id uuid) TO service_role;


--
-- Name: FUNCTION is_current_agent(p_agent_id uuid); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.is_current_agent(p_agent_id uuid) TO authenticated;


--
-- Name: FUNCTION is_daemon(); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.is_daemon() FROM PUBLIC;
GRANT ALL ON FUNCTION amux.is_daemon() TO authenticated;


--
-- Name: FUNCTION is_session_participant(target_session_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.is_session_participant(target_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.is_session_participant(target_session_id uuid) TO authenticated;


--
-- Name: FUNCTION is_team_admin_or_owner(target_team_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.is_team_admin_or_owner(target_team_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.is_team_admin_or_owner(target_team_id uuid) TO authenticated;


--
-- Name: FUNCTION is_team_member(target_team_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.is_team_member(target_team_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.is_team_member(target_team_id uuid) TO authenticated;


--
-- Name: FUNCTION join_session(p_session_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.join_session(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.join_session(p_session_id uuid) TO authenticated;


--
-- Name: FUNCTION jwt_memberships(); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.jwt_memberships() FROM PUBLIC;
GRANT ALL ON FUNCTION amux.jwt_memberships() TO authenticated;


--
-- Name: FUNCTION list_agent_admin_member_actor_ids(p_agent_actor_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.list_agent_admin_member_actor_ids(p_agent_actor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.list_agent_admin_member_actor_ids(p_agent_actor_id uuid) TO service_role;
GRANT ALL ON FUNCTION amux.list_agent_admin_member_actor_ids(p_agent_actor_id uuid) TO authenticated;


--
-- Name: FUNCTION list_all_my_teams(); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.list_all_my_teams() TO authenticated;


--
-- Name: FUNCTION list_connected_agents(p_team_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.list_connected_agents(p_team_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.list_connected_agents(p_team_id uuid) TO anon;
GRANT ALL ON FUNCTION amux.list_connected_agents(p_team_id uuid) TO authenticated;
GRANT ALL ON FUNCTION amux.list_connected_agents(p_team_id uuid) TO service_role;


--
-- Name: FUNCTION list_current_actor_sessions(p_limit integer, p_before_last_message_at timestamp with time zone, p_before_created_at timestamp with time zone, p_before_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.list_current_actor_sessions(p_limit integer, p_before_last_message_at timestamp with time zone, p_before_created_at timestamp with time zone, p_before_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.list_current_actor_sessions(p_limit integer, p_before_last_message_at timestamp with time zone, p_before_created_at timestamp with time zone, p_before_id uuid) TO anon;
GRANT ALL ON FUNCTION amux.list_current_actor_sessions(p_limit integer, p_before_last_message_at timestamp with time zone, p_before_created_at timestamp with time zone, p_before_id uuid) TO authenticated;
GRANT ALL ON FUNCTION amux.list_current_actor_sessions(p_limit integer, p_before_last_message_at timestamp with time zone, p_before_created_at timestamp with time zone, p_before_id uuid) TO service_role;


--
-- Name: FUNCTION list_my_teams_current_org(); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.list_my_teams_current_org() TO anon;
GRANT ALL ON FUNCTION amux.list_my_teams_current_org() TO authenticated;
GRANT ALL ON FUNCTION amux.list_my_teams_current_org() TO service_role;


--
-- Name: FUNCTION list_session_push_targets(p_session_id uuid, p_exclude_actor_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.list_session_push_targets(p_session_id uuid, p_exclude_actor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.list_session_push_targets(p_session_id uuid, p_exclude_actor_id uuid) TO service_role;


--
-- Name: FUNCTION make_agent_personal(p_agent_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.make_agent_personal(p_agent_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.make_agent_personal(p_agent_id uuid) TO anon;
GRANT ALL ON FUNCTION amux.make_agent_personal(p_agent_id uuid) TO authenticated;
GRANT ALL ON FUNCTION amux.make_agent_personal(p_agent_id uuid) TO service_role;


--
-- Name: FUNCTION mark_current_actor_session_viewed(p_session_id uuid, p_last_read_message_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.mark_current_actor_session_viewed(p_session_id uuid, p_last_read_message_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.mark_current_actor_session_viewed(p_session_id uuid, p_last_read_message_id uuid) TO anon;
GRANT ALL ON FUNCTION amux.mark_current_actor_session_viewed(p_session_id uuid, p_last_read_message_id uuid) TO authenticated;
GRANT ALL ON FUNCTION amux.mark_current_actor_session_viewed(p_session_id uuid, p_last_read_message_id uuid) TO service_role;


--
-- Name: FUNCTION member_can_access_permission(target_permission_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.member_can_access_permission(target_permission_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.member_can_access_permission(target_permission_id uuid) TO authenticated;


--
-- Name: FUNCTION member_can_see_shortcut(target_shortcut_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.member_can_see_shortcut(target_shortcut_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.member_can_see_shortcut(target_shortcut_id uuid) TO authenticated;


--
-- Name: FUNCTION notify_push_dispatch(); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.notify_push_dispatch() FROM PUBLIC;
GRANT ALL ON FUNCTION amux.notify_push_dispatch() TO service_role;


--
-- Name: FUNCTION push_idempotency_claim(p_message_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.push_idempotency_claim(p_message_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.push_idempotency_claim(p_message_id uuid) TO service_role;


--
-- Name: FUNCTION remove_team_actor(p_actor_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.remove_team_actor(p_actor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.remove_team_actor(p_actor_id uuid) TO anon;
GRANT ALL ON FUNCTION amux.remove_team_actor(p_actor_id uuid) TO authenticated;
GRANT ALL ON FUNCTION amux.remove_team_actor(p_actor_id uuid) TO service_role;


--
-- Name: FUNCTION rename_team(p_team_id uuid, p_name text); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.rename_team(p_team_id uuid, p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.rename_team(p_team_id uuid, p_name text) TO anon;
GRANT ALL ON FUNCTION amux.rename_team(p_team_id uuid, p_name text) TO authenticated;
GRANT ALL ON FUNCTION amux.rename_team(p_team_id uuid, p_name text) TO service_role;


--
-- Name: FUNCTION reorder_ideas(p_team_id uuid, p_idea_ids uuid[]); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.reorder_ideas(p_team_id uuid, p_idea_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.reorder_ideas(p_team_id uuid, p_idea_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION amux.reorder_ideas(p_team_id uuid, p_idea_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION amux.reorder_ideas(p_team_id uuid, p_idea_ids uuid[]) TO service_role;


--
-- Name: FUNCTION report_client_version(p_team_id uuid, p_client_type text, p_version text, p_device_id text, p_build text); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.report_client_version(p_team_id uuid, p_client_type text, p_version text, p_device_id text, p_build text) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.report_client_version(p_team_id uuid, p_client_type text, p_version text, p_device_id text, p_build text) TO anon;
GRANT ALL ON FUNCTION amux.report_client_version(p_team_id uuid, p_client_type text, p_version text, p_device_id text, p_build text) TO authenticated;
GRANT ALL ON FUNCTION amux.report_client_version(p_team_id uuid, p_client_type text, p_version text, p_device_id text, p_build text) TO service_role;


--
-- Name: FUNCTION set_member_default_agent(p_team_id uuid, p_agent_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.set_member_default_agent(p_team_id uuid, p_agent_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.set_member_default_agent(p_team_id uuid, p_agent_id uuid) TO anon;
GRANT ALL ON FUNCTION amux.set_member_default_agent(p_team_id uuid, p_agent_id uuid) TO authenticated;
GRANT ALL ON FUNCTION amux.set_member_default_agent(p_team_id uuid, p_agent_id uuid) TO service_role;


--
-- Name: FUNCTION set_team_sync_mode(p_team_id uuid, p_mode text); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.set_team_sync_mode(p_team_id uuid, p_mode text) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.set_team_sync_mode(p_team_id uuid, p_mode text) TO anon;
GRANT ALL ON FUNCTION amux.set_team_sync_mode(p_team_id uuid, p_mode text) TO authenticated;
GRANT ALL ON FUNCTION amux.set_team_sync_mode(p_team_id uuid, p_mode text) TO service_role;


--
-- Name: FUNCTION share_agent_to_team(p_agent_id uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.share_agent_to_team(p_agent_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.share_agent_to_team(p_agent_id uuid) TO anon;
GRANT ALL ON FUNCTION amux.share_agent_to_team(p_agent_id uuid) TO authenticated;
GRANT ALL ON FUNCTION amux.share_agent_to_team(p_agent_id uuid) TO service_role;


--
-- Name: FUNCTION shortcut_batch_move(p_moves jsonb); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.shortcut_batch_move(p_moves jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.shortcut_batch_move(p_moves jsonb) TO anon;
GRANT ALL ON FUNCTION amux.shortcut_batch_move(p_moves jsonb) TO authenticated;
GRANT ALL ON FUNCTION amux.shortcut_batch_move(p_moves jsonb) TO service_role;


--
-- Name: FUNCTION shortcut_create(p_scope text, p_label text, p_node_type text, p_team_id uuid, p_parent_id uuid, p_icon text, p_order integer, p_target text); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.shortcut_create(p_scope text, p_label text, p_node_type text, p_team_id uuid, p_parent_id uuid, p_icon text, p_order integer, p_target text) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.shortcut_create(p_scope text, p_label text, p_node_type text, p_team_id uuid, p_parent_id uuid, p_icon text, p_order integer, p_target text) TO anon;
GRANT ALL ON FUNCTION amux.shortcut_create(p_scope text, p_label text, p_node_type text, p_team_id uuid, p_parent_id uuid, p_icon text, p_order integer, p_target text) TO authenticated;
GRANT ALL ON FUNCTION amux.shortcut_create(p_scope text, p_label text, p_node_type text, p_team_id uuid, p_parent_id uuid, p_icon text, p_order integer, p_target text) TO service_role;


--
-- Name: FUNCTION shortcut_set_visible_roles(p_shortcut_id uuid, p_role_ids uuid[]); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.shortcut_set_visible_roles(p_shortcut_id uuid, p_role_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.shortcut_set_visible_roles(p_shortcut_id uuid, p_role_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION amux.shortcut_set_visible_roles(p_shortcut_id uuid, p_role_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION amux.shortcut_set_visible_roles(p_shortcut_id uuid, p_role_ids uuid[]) TO service_role;


--
-- Name: FUNCTION switch_active_team(p_team_id uuid); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.switch_active_team(p_team_id uuid) TO authenticated;
GRANT ALL ON FUNCTION amux.switch_active_team(p_team_id uuid) TO anon;
GRANT ALL ON FUNCTION amux.switch_active_team(p_team_id uuid) TO service_role;


--
-- Name: FUNCTION team_leaderboard(p_team_id uuid, p_period text); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.team_leaderboard(p_team_id uuid, p_period text) TO anon;
GRANT ALL ON FUNCTION amux.team_leaderboard(p_team_id uuid, p_period text) TO authenticated;
GRANT ALL ON FUNCTION amux.team_leaderboard(p_team_id uuid, p_period text) TO service_role;


--
-- Name: FUNCTION team_member_set_roles(p_team_id uuid, p_member_id uuid, p_role_ids uuid[]); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.team_member_set_roles(p_team_id uuid, p_member_id uuid, p_role_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.team_member_set_roles(p_team_id uuid, p_member_id uuid, p_role_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION amux.team_member_set_roles(p_team_id uuid, p_member_id uuid, p_role_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION amux.team_member_set_roles(p_team_id uuid, p_member_id uuid, p_role_ids uuid[]) TO service_role;


--
-- Name: FUNCTION update_actor_last_active(); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.update_actor_last_active() FROM PUBLIC;
GRANT ALL ON FUNCTION amux.update_actor_last_active() TO anon;
GRANT ALL ON FUNCTION amux.update_actor_last_active() TO authenticated;
GRANT ALL ON FUNCTION amux.update_actor_last_active() TO service_role;


--
-- Name: FUNCTION update_agent_defaults(p_agent_id uuid, p_default_workspace_id uuid, p_agent_kind text, p_default_agent_type text); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.update_agent_defaults(p_agent_id uuid, p_default_workspace_id uuid, p_agent_kind text, p_default_agent_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.update_agent_defaults(p_agent_id uuid, p_default_workspace_id uuid, p_agent_kind text, p_default_agent_type text) TO anon;
GRANT ALL ON FUNCTION amux.update_agent_defaults(p_agent_id uuid, p_default_workspace_id uuid, p_agent_kind text, p_default_agent_type text) TO authenticated;
GRANT ALL ON FUNCTION amux.update_agent_defaults(p_agent_id uuid, p_default_workspace_id uuid, p_agent_kind text, p_default_agent_type text) TO service_role;


--
-- Name: FUNCTION update_audit_columns(); Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON FUNCTION amux.update_audit_columns() TO anon;
GRANT ALL ON FUNCTION amux.update_audit_columns() TO authenticated;
GRANT ALL ON FUNCTION amux.update_audit_columns() TO service_role;


--
-- Name: FUNCTION update_current_actor_profile(p_actor_id uuid, p_display_name text, p_avatar_url text); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.update_current_actor_profile(p_actor_id uuid, p_display_name text, p_avatar_url text) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.update_current_actor_profile(p_actor_id uuid, p_display_name text, p_avatar_url text) TO anon;
GRANT ALL ON FUNCTION amux.update_current_actor_profile(p_actor_id uuid, p_display_name text, p_avatar_url text) TO authenticated;
GRANT ALL ON FUNCTION amux.update_current_actor_profile(p_actor_id uuid, p_display_name text, p_avatar_url text) TO service_role;


--
-- Name: FUNCTION update_idea(p_idea_id uuid, p_title text, p_workspace_id uuid, p_description text, p_status text); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.update_idea(p_idea_id uuid, p_title text, p_workspace_id uuid, p_description text, p_status text) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.update_idea(p_idea_id uuid, p_title text, p_workspace_id uuid, p_description text, p_status text) TO anon;
GRANT ALL ON FUNCTION amux.update_idea(p_idea_id uuid, p_title text, p_workspace_id uuid, p_description text, p_status text) TO authenticated;
GRANT ALL ON FUNCTION amux.update_idea(p_idea_id uuid, p_title text, p_workspace_id uuid, p_description text, p_status text) TO service_role;


--
-- Name: FUNCTION update_owned_agent_profile(p_agent_id uuid, p_display_name text, p_visibility text); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.update_owned_agent_profile(p_agent_id uuid, p_display_name text, p_visibility text) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.update_owned_agent_profile(p_agent_id uuid, p_display_name text, p_visibility text) TO anon;
GRANT ALL ON FUNCTION amux.update_owned_agent_profile(p_agent_id uuid, p_display_name text, p_visibility text) TO authenticated;
GRANT ALL ON FUNCTION amux.update_owned_agent_profile(p_agent_id uuid, p_display_name text, p_visibility text) TO service_role;


--
-- Name: FUNCTION update_team_litellm(p_team_id uuid, p_litellm_team_id text, p_ai_gateway_endpoint text); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.update_team_litellm(p_team_id uuid, p_litellm_team_id text, p_ai_gateway_endpoint text) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.update_team_litellm(p_team_id uuid, p_litellm_team_id text, p_ai_gateway_endpoint text) TO anon;
GRANT ALL ON FUNCTION amux.update_team_litellm(p_team_id uuid, p_litellm_team_id text, p_ai_gateway_endpoint text) TO authenticated;
GRANT ALL ON FUNCTION amux.update_team_litellm(p_team_id uuid, p_litellm_team_id text, p_ai_gateway_endpoint text) TO service_role;


--
-- Name: FUNCTION upsert_external_actor(p_team_id uuid, p_source text, p_source_id text, p_display_name text); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.upsert_external_actor(p_team_id uuid, p_source text, p_source_id text, p_display_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.upsert_external_actor(p_team_id uuid, p_source text, p_source_id text, p_display_name text) TO service_role;
GRANT ALL ON FUNCTION amux.upsert_external_actor(p_team_id uuid, p_source text, p_source_id text, p_display_name text) TO authenticated;


--
-- Name: FUNCTION uuid_column_matches_existing(target_table regclass, target_id uuid, target_column text, target_value uuid); Type: ACL; Schema: amux; Owner: -
--

REVOKE ALL ON FUNCTION amux.uuid_column_matches_existing(target_table regclass, target_id uuid, target_column text, target_value uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.uuid_column_matches_existing(target_table regclass, target_id uuid, target_column text, target_value uuid) TO authenticated;


--
-- Name: TABLE actor_client_versions; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.actor_client_versions TO anon;
GRANT ALL ON TABLE amux.actor_client_versions TO authenticated;
GRANT ALL ON TABLE amux.actor_client_versions TO service_role;


--
-- Name: TABLE actors; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.actors TO anon;
GRANT ALL ON TABLE amux.actors TO authenticated;
GRANT ALL ON TABLE amux.actors TO service_role;


--
-- Name: TABLE agents; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.agents TO anon;
GRANT ALL ON TABLE amux.agents TO authenticated;
GRANT ALL ON TABLE amux.agents TO service_role;


--
-- Name: TABLE members; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.members TO anon;
GRANT ALL ON TABLE amux.members TO authenticated;
GRANT ALL ON TABLE amux.members TO service_role;


--
-- Name: TABLE team_members; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.team_members TO anon;
GRANT ALL ON TABLE amux.team_members TO authenticated;
GRANT ALL ON TABLE amux.team_members TO service_role;


--
-- Name: TABLE actor_directory; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.actor_directory TO anon;
GRANT ALL ON TABLE amux.actor_directory TO authenticated;
GRANT ALL ON TABLE amux.actor_directory TO service_role;


--
-- Name: TABLE actor_message_feedback; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.actor_message_feedback TO anon;
GRANT ALL ON TABLE amux.actor_message_feedback TO authenticated;
GRANT ALL ON TABLE amux.actor_message_feedback TO service_role;


--
-- Name: TABLE actor_session_report; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.actor_session_report TO anon;
GRANT ALL ON TABLE amux.actor_session_report TO authenticated;
GRANT ALL ON TABLE amux.actor_session_report TO service_role;


--
-- Name: TABLE actor_skill_usage; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.actor_skill_usage TO anon;
GRANT ALL ON TABLE amux.actor_skill_usage TO authenticated;
GRANT ALL ON TABLE amux.actor_skill_usage TO service_role;


--
-- Name: TABLE agent_member_access; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.agent_member_access TO anon;
GRANT ALL ON TABLE amux.agent_member_access TO authenticated;
GRANT ALL ON TABLE amux.agent_member_access TO service_role;


--
-- Name: TABLE agent_runtimes; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.agent_runtimes TO anon;
GRANT ALL ON TABLE amux.agent_runtimes TO authenticated;
GRANT ALL ON TABLE amux.agent_runtimes TO service_role;


--
-- Name: TABLE amuxc_blobs; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.amuxc_blobs TO service_role;
GRANT SELECT ON TABLE amux.amuxc_blobs TO authenticated;


--
-- Name: TABLE amuxc_file_versions; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.amuxc_file_versions TO service_role;
GRANT SELECT ON TABLE amux.amuxc_file_versions TO authenticated;


--
-- Name: TABLE amuxc_files; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.amuxc_files TO service_role;
GRANT SELECT ON TABLE amux.amuxc_files TO authenticated;


--
-- Name: TABLE amuxc_upload_sessions; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.amuxc_upload_sessions TO service_role;
GRANT SELECT ON TABLE amux.amuxc_upload_sessions TO authenticated;


--
-- Name: TABLE app_member_access; Type: ACL; Schema: amux; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE amux.app_member_access TO authenticated;
GRANT ALL ON TABLE amux.app_member_access TO service_role;


--
-- Name: TABLE apps; Type: ACL; Schema: amux; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE amux.apps TO authenticated;
GRANT ALL ON TABLE amux.apps TO service_role;


--
-- Name: TABLE client_presence; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.client_presence TO anon;
GRANT ALL ON TABLE amux.client_presence TO authenticated;
GRANT ALL ON TABLE amux.client_presence TO service_role;


--
-- Name: TABLE device_push_tokens; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.device_push_tokens TO anon;
GRANT ALL ON TABLE amux.device_push_tokens TO authenticated;
GRANT ALL ON TABLE amux.device_push_tokens TO service_role;


--
-- Name: TABLE idea_activities; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.idea_activities TO anon;
GRANT ALL ON TABLE amux.idea_activities TO authenticated;
GRANT ALL ON TABLE amux.idea_activities TO service_role;


--
-- Name: TABLE idea_external_refs; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.idea_external_refs TO anon;
GRANT ALL ON TABLE amux.idea_external_refs TO authenticated;
GRANT ALL ON TABLE amux.idea_external_refs TO service_role;


--
-- Name: TABLE ideas; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.ideas TO anon;
GRANT ALL ON TABLE amux.ideas TO authenticated;
GRANT ALL ON TABLE amux.ideas TO service_role;


--
-- Name: TABLE messages; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.messages TO anon;
GRANT ALL ON TABLE amux.messages TO authenticated;
GRANT ALL ON TABLE amux.messages TO service_role;


--
-- Name: TABLE notification_prefs; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.notification_prefs TO anon;
GRANT ALL ON TABLE amux.notification_prefs TO authenticated;
GRANT ALL ON TABLE amux.notification_prefs TO service_role;


--
-- Name: TABLE permission_roles; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.permission_roles TO anon;
GRANT ALL ON TABLE amux.permission_roles TO authenticated;
GRANT ALL ON TABLE amux.permission_roles TO service_role;


--
-- Name: TABLE permissions; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.permissions TO anon;
GRANT ALL ON TABLE amux.permissions TO authenticated;
GRANT ALL ON TABLE amux.permissions TO service_role;


--
-- Name: TABLE push_idempotency; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.push_idempotency TO anon;
GRANT ALL ON TABLE amux.push_idempotency TO authenticated;
GRANT ALL ON TABLE amux.push_idempotency TO service_role;


--
-- Name: TABLE session_mutes; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.session_mutes TO anon;
GRANT ALL ON TABLE amux.session_mutes TO authenticated;
GRANT ALL ON TABLE amux.session_mutes TO service_role;


--
-- Name: TABLE session_participants; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.session_participants TO anon;
GRANT ALL ON TABLE amux.session_participants TO authenticated;
GRANT ALL ON TABLE amux.session_participants TO service_role;


--
-- Name: TABLE session_read_markers; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.session_read_markers TO anon;
GRANT ALL ON TABLE amux.session_read_markers TO authenticated;
GRANT ALL ON TABLE amux.session_read_markers TO service_role;


--
-- Name: TABLE sessions; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.sessions TO anon;
GRANT ALL ON TABLE amux.sessions TO authenticated;
GRANT ALL ON TABLE amux.sessions TO service_role;


--
-- Name: TABLE shortcuts; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.shortcuts TO anon;
GRANT ALL ON TABLE amux.shortcuts TO authenticated;
GRANT ALL ON TABLE amux.shortcuts TO service_role;


--
-- Name: TABLE team_invites; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.team_invites TO anon;
GRANT ALL ON TABLE amux.team_invites TO authenticated;
GRANT ALL ON TABLE amux.team_invites TO service_role;


--
-- Name: TABLE team_member_roles; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.team_member_roles TO anon;
GRANT ALL ON TABLE amux.team_member_roles TO authenticated;
GRANT ALL ON TABLE amux.team_member_roles TO service_role;


--
-- Name: TABLE team_roles; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.team_roles TO anon;
GRANT ALL ON TABLE amux.team_roles TO authenticated;
GRANT ALL ON TABLE amux.team_roles TO service_role;


--
-- Name: TABLE team_workspace_config; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.team_workspace_config TO anon;
GRANT ALL ON TABLE amux.team_workspace_config TO authenticated;
GRANT ALL ON TABLE amux.team_workspace_config TO service_role;


--
-- Name: TABLE workspaces; Type: ACL; Schema: amux; Owner: -
--

GRANT ALL ON TABLE amux.workspaces TO anon;
GRANT ALL ON TABLE amux.workspaces TO authenticated;
GRANT ALL ON TABLE amux.workspaces TO service_role;


--
-- Name: TABLE orgs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.orgs TO anon;
GRANT ALL ON TABLE public.orgs TO authenticated;
GRANT ALL ON TABLE public.orgs TO service_role;


--
-- Name: TABLE plans; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.plans TO anon;
GRANT ALL ON TABLE public.plans TO authenticated;
GRANT ALL ON TABLE public.plans TO service_role;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.users TO anon;
GRANT ALL ON TABLE public.users TO authenticated;
GRANT ALL ON TABLE public.users TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--


-- ============ teamclaw storage buckets ============
-- The RLS policies below reference the 'attachments' and 'avatars' buckets, but
-- the buckets themselves must exist first or every upload fails with
-- "Bucket not found" (surfaced to the client as
-- "Failed to upload attachment — message not sent"). Both are public so the
-- public-object URLs returned by supabase-repo (uploadAttachment) resolve.
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', true),
       ('avatars', 'avatars', true)
on conflict (id) do update set public = excluded.public;

-- ============ teamclaw RLS policies on storage.objects ============
drop policy if exists authenticated_can_upload on storage.objects;
create policy authenticated_can_upload on storage.objects for insert to authenticated with check ((bucket_id = 'attachments'::text));

drop policy if exists no_delete on storage.objects;
create policy no_delete on storage.objects for delete to authenticated using (false);

drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read on storage.objects for select to public using ((bucket_id = 'avatars'::text));

drop policy if exists avatars_owner_insert on storage.objects;
create policy avatars_owner_insert on storage.objects for insert to authenticated with check (((bucket_id = 'avatars'::text) AND (name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'::text) AND (EXISTS ( SELECT 1
   FROM amux.actors a
  WHERE ((a.id = (split_part(objects.name, '/'::text, 1))::uuid) AND (a.actor_type = 'member'::text) AND (a.user_id = auth.uid()))))));

drop policy if exists avatars_owner_update on storage.objects;
create policy avatars_owner_update on storage.objects for update to authenticated using (((bucket_id = 'avatars'::text) AND (name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'::text) AND (EXISTS ( SELECT 1
   FROM amux.actors a
  WHERE ((a.id = (split_part(objects.name, '/'::text, 1))::uuid) AND (a.actor_type = 'member'::text) AND (a.user_id = auth.uid())))))) with check (((bucket_id = 'avatars'::text) AND (name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'::text) AND (EXISTS ( SELECT 1
   FROM amux.actors a
  WHERE ((a.id = (split_part(objects.name, '/'::text, 1))::uuid) AND (a.actor_type = 'member'::text) AND (a.user_id = auth.uid()))))));

drop policy if exists avatars_owner_delete on storage.objects;
create policy avatars_owner_delete on storage.objects for delete to authenticated using (((bucket_id = 'avatars'::text) AND (name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'::text) AND (EXISTS ( SELECT 1
   FROM amux.actors a
  WHERE ((a.id = (split_part(objects.name, '/'::text, 1))::uuid) AND (a.actor_type = 'member'::text) AND (a.user_id = auth.uid()))))));

drop policy if exists team_members_can_download_idea_attachments on storage.objects;
create policy team_members_can_download_idea_attachments on storage.objects for select to authenticated using (((bucket_id = 'attachments'::text) AND (split_part(name, '/'::text, 2) = 'ideas'::text) AND (split_part(name, '/'::text, 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text) AND amux.is_team_member((split_part(name, '/'::text, 1))::uuid)));

drop policy if exists attachments_public_read on storage.objects;
create policy attachments_public_read on storage.objects for select to public using ((bucket_id = 'attachments'::text));

-- ============================================================================
-- Canonical user linkage fix: public.users.id = auth.uid()  (NOT auth_user_id)
--
-- saas-mono sets public.users.id to the GoTrue auth uid at signup
-- (apps/api/.../auth/{email,phone,wechat}.ts create the row with id =
-- authData.user.id; migration 2025-12-19 backfilled auth_user_id = id, treating
-- it as a redundant mirror). saas-mono RLS/code filter by id = auth.uid().
--
-- The teamclaw integration functions previously resolved public.users via
-- `auth_user_id = auth.uid()`, which MISSES the ~275k accounts linked only by
-- id (auth_user_id null/not backfilled) — so onboarding wrongly re-inserted a
-- users row (hitting public.users.mobile NOT NULL: "name/mobile is required")
-- and org/nickname seeding silently failed.
--
-- Fix: resolve by id = auth.uid() everywhere; inserts key on id and pass
-- mobile='' (the saas-mono users table's only NOT-NULL text column lacking a
-- default; all others default ''). Functions consolidated under the `amux`
-- schema (canonical on the integrated dev/test/live databases; the duplicate
-- public.* copies have been dropped). Definitions captured from the corrected
-- production (live) state.
-- ============================================================================

CREATE OR REPLACE FUNCTION amux.ensure_personal_org()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'amux', 'public', 'auth', 'extensions'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION amux.current_org_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'amux', 'public', 'auth', 'extensions'
AS $function$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'org_id', '')::uuid,
    (select u.org_id from public.users u where u.id = auth.uid() limit 1)
  );
$function$;

CREATE OR REPLACE FUNCTION amux.amux_access_token_hook(event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'amux', 'public', 'auth', 'extensions'
AS $function$
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

  -- org_id: keep existing claim if present, else resolve from public.users
  v_org := coalesce(
    nullif(v_claims->'app_metadata'->>'org_id','')::uuid,
    (select u.org_id from public.users u where u.id = v_user_id limit 1)
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

CREATE OR REPLACE FUNCTION amux.switch_active_team(p_team_id uuid)
 RETURNS TABLE(actor_id uuid, team_id uuid, refresh_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'amux', 'public', 'auth', 'app'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION amux.claim_team_invite(p_token text)
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

CREATE OR REPLACE FUNCTION amux.list_my_teams_current_org()
 RETURNS TABLE(id uuid, name text, slug text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'amux', 'public', 'auth', 'extensions'
AS $function$
  select t.id, t.name, t.slug, t.created_at
    from amux.teams t
   where t.oid is not distinct from amux.current_org_id()
     and exists (
       select 1 from amux.actors a
        where a.user_id = auth.uid()
          and a.team_id = t.id
     )
   order by t.created_at;
$function$;

CREATE OR REPLACE FUNCTION amux.create_team(p_name text DEFAULT NULL::text, p_slug text DEFAULT NULL::text, p_litellm_team_id text DEFAULT NULL::text, p_ai_gateway_endpoint text DEFAULT NULL::text, p_display_name text DEFAULT NULL::text)
 RETURNS TABLE(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'amux', 'public', 'auth'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION amux.create_team(p_name text DEFAULT NULL::text, p_slug text DEFAULT NULL::text, p_litellm_team_id text DEFAULT NULL::text, p_ai_gateway_endpoint text DEFAULT NULL::text, p_display_name text DEFAULT NULL::text, p_oid uuid DEFAULT NULL::uuid)
 RETURNS TABLE(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'amux', 'public', 'auth'
AS $function$
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
  if p_oid is not null then
    select name into v_org_name from public.orgs where id = p_oid;
  end if;
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
  values (v_team_id, v_team_name, v_slug, p_oid);

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
$function$;

-- Execute grants (CREATE OR REPLACE preserves existing grants; restated for fresh installs).
grant execute on function amux.ensure_personal_org() to anon, authenticated, service_role;
grant execute on function amux.current_org_id() to anon, authenticated, service_role;
grant execute on function amux.amux_access_token_hook(jsonb) to supabase_auth_admin, anon, authenticated, service_role;
grant execute on function amux.switch_active_team(uuid) to anon, authenticated, service_role;
grant execute on function amux.claim_team_invite(text) to anon, authenticated, service_role;
grant execute on function amux.list_my_teams_current_org() to anon, authenticated, service_role;
grant execute on function amux.create_team(text,text,text,text,text) to anon, authenticated, service_role;
grant execute on function amux.create_team(text,text,text,text,text,uuid) to anon, authenticated, service_role;

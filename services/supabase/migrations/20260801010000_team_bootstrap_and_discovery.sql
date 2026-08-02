-- Login team discovery and first-team bootstrap.
--
-- Supersedes the "join the oldest org team" behavior from
-- join_or_create_org_team: a user with no visible/joinable team now gets an
-- owner team named after their current org, plus its member actor, atomically.

create or replace function amux.list_teams_for_picker(p_default_org_id uuid default null)
  returns table(team_id uuid, team_name text, team_slug text, org_id uuid, org_name text, visibility text, is_member boolean)
  language sql stable security definer
  set search_path to 'amux', 'public', 'auth'
  as $$
  with mine as (
    select t.id, t.name, t.slug, t.oid, t.visibility, true as is_member
      from amux.teams t
     where exists (select 1 from amux.actors a where a.user_id = auth.uid() and a.team_id = t.id)
  ), public_teams as (
    select t.id, t.name, t.slug, t.oid, t.visibility, false as is_member
      from amux.teams t
     where t.visibility = 'public'
       and not exists (select 1 from amux.actors a where a.user_id = auth.uid() and a.team_id = t.id)
  ), combined as (
    select * from mine union all select * from public_teams
  )
  select c.id, c.name, c.slug, c.oid, o.name, c.visibility, c.is_member
    from combined c left join public.orgs o on o.id = c.oid
   order by c.is_member desc, o.name nulls last, c.name;
$$;

create or replace function amux.list_discoverable_teams()
  returns table(team_id uuid, team_name text, team_slug text, org_id uuid, org_name text, visibility text, is_member boolean)
  language sql stable security definer
  set search_path to 'amux', 'public', 'auth'
  as $$
  select t.id, t.name, t.slug, t.oid, o.name, t.visibility,
         exists (select 1 from amux.actors a where a.user_id = auth.uid() and a.team_id = t.id)
    from amux.teams t
    left join public.orgs o on o.id = t.oid
   where t.visibility = 'public'
   order by o.name nulls last, t.name;
$$;

grant execute on function amux.list_teams_for_picker(uuid) to authenticated, service_role;
grant execute on function amux.list_discoverable_teams() to anon, authenticated, service_role;

create or replace function amux.bootstrap_current_org_team(
  p_fallback_org uuid default null,
  p_display_name text default null
)
returns table(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language plpgsql security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_org_name text;
  v_is_anonymous boolean;
begin
  if v_user_id is null then
    raise exception 'bootstrap_current_org_team requires an authenticated user' using errcode = '42501';
  end if;
  select coalesce(is_anonymous, false) into v_is_anonymous from auth.users where id = v_user_id;
  if coalesce(v_is_anonymous, false) then
    raise exception 'anonymous users cannot bootstrap a team' using errcode = '42501';
  end if;

  -- Serialize bootstrap per user; create_team itself checks first-team-only.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  if exists (select 1 from amux.actors where user_id = v_user_id) then
    raise exception 'bootstrap_current_org_team currently supports first-team onboarding only'
      using errcode = '23514';
  end if;

  v_org_id := coalesce(amux.current_org_id(), p_fallback_org);
  if v_org_id is null then
    raise exception 'current organization is required for team bootstrap' using errcode = '23514';
  end if;
  select name into v_org_name from public.orgs where id = v_org_id;
  if nullif(btrim(v_org_name), '') is null then
    raise exception 'current organization has no name' using errcode = '23514';
  end if;

  return query
    select c.team_id, c.team_name, c.team_slug, c.member_id, c.role, c.workspace_id, c.workspace_name
      from amux.create_team(
        p_name => v_org_name,
        p_display_name => p_display_name,
        p_oid => v_org_id
      ) c;
end;
$function$;

grant execute on function amux.bootstrap_current_org_team(uuid, text) to authenticated, service_role;

-- Keep legacy callers safe while deployments roll forward: they get the new
-- no-implicit-join semantics as well.
create or replace function amux.join_or_create_org_team(
  p_fallback_org uuid default null, p_default_org_id uuid default null,
  p_name text default null, p_slug text default null, p_display_name text default null,
  p_litellm_team_id text default null, p_ai_gateway_endpoint text default null
)
returns table(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language sql security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $$
  select * from amux.bootstrap_current_org_team(p_fallback_org, p_display_name);
$$;

grant execute on function amux.join_or_create_org_team(uuid, uuid, text, text, text, text, text) to authenticated, service_role;

create or replace function amux.join_public_team(p_team_id uuid, p_default_org_id uuid default null)
  returns table(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
  language plpgsql security definer
  set search_path to 'amux', 'public', 'auth', 'extensions'
  as $function$
declare
  v_user_id uuid := auth.uid();
  v_team amux.teams%rowtype;
  v_member_id uuid;
  v_workspace_id uuid;
  v_workspace_name text;
  v_nickname text;
  v_display_name text;
  v_is_anonymous boolean;
begin
  if v_user_id is null then
    raise exception 'join_public_team requires an authenticated user' using errcode = '42501';
  end if;
  select coalesce(is_anonymous, false) into v_is_anonymous from auth.users where id = v_user_id;
  if coalesce(v_is_anonymous, false) then
    raise exception 'anonymous users cannot join a team' using errcode = '42501';
  end if;
  select * into v_team from amux.teams where id = p_team_id;
  if not found then raise exception 'team not found' using errcode = 'P0002'; end if;
  if v_team.visibility is distinct from 'public' then
    raise exception 'team is not a joinable public team' using errcode = '42501';
  end if;
  select a.id into v_member_id from amux.actors a where a.user_id = v_user_id and a.team_id = p_team_id limit 1;
  if v_member_id is null then
    select nickname into v_nickname from public.users where id = v_user_id limit 1;
    v_member_id := gen_random_uuid();
    v_display_name := coalesce(nullif(btrim(v_nickname), ''), 'Member');
    insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
      values (v_member_id, p_team_id, 'member', v_user_id, v_display_name, now());
    insert into amux.members (id, status) values (v_member_id, 'active');
    insert into amux.team_members (team_id, member_id, role) values (p_team_id, v_member_id, 'member');
  end if;
  select w.id, w.name into v_workspace_id, v_workspace_name from amux.workspaces w
    where w.team_id = p_team_id order by w.created_at asc, w.id asc limit 1;
  return query select v_team.id, v_team.name, v_team.slug, v_member_id,
    case when exists (select 1 from amux.team_members tm where tm.team_id = p_team_id and tm.member_id = v_member_id and tm.role = 'owner') then 'owner' else 'member' end,
    v_workspace_id, v_workspace_name;
end;
$function$;

grant execute on function amux.join_public_team(uuid, uuid) to authenticated, service_role;

-- Member invitations may only be claimed by a real account. Keep the existing
-- agent-invite implementation intact behind a wrapper so daemon claims remain
-- bearerless and do not affect desktop team selection.
alter function amux.claim_team_invite(text) rename to claim_team_invite_legacy;

create function amux.claim_team_invite(p_token text)
returns table(actor_id uuid, team_id uuid, actor_type text, display_name text, refresh_token text)
language plpgsql security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_kind text;
  v_user_id uuid := auth.uid();
  v_is_anonymous boolean;
begin
  select kind into v_kind from amux.team_invites where token = p_token;
  if v_kind = 'member' then
    if v_user_id is null then
      raise exception 'member claim requires a non-anonymous account' using errcode = '42501';
    end if;
    select coalesce(is_anonymous, false) into v_is_anonymous from auth.users where id = v_user_id;
    if coalesce(v_is_anonymous, false) then
      raise exception 'member claim requires a non-anonymous account' using errcode = '42501';
    end if;
  end if;
  return query select * from amux.claim_team_invite_legacy(p_token);
end;
$function$;

grant execute on function amux.claim_team_invite(text) to anon, authenticated, service_role;

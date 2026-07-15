-- ============================================================================
-- Onboarding defaults: seed the first team's name from the caller's org name,
-- and the owner actor's display name from the caller's saas-mono nickname.
-- (follows §8 of docs/specs/2026-06-08-teamclaw-saas-mono-integration.md)
--
-- Rationale: when a logged-in account already belongs to an org but has no team
-- yet, the first auto-created team should adopt the org's name rather than a
-- random "Adjective Animal" handle. Likewise, when the account has a human name
-- (public.users.nickname, mirrored from saas-mono), the owner actor should use
-- it instead of a synthesized handle.
--
-- Precedence (each step falls through only when blank):
--   team name    : p_name  ->  orgs.name (caller's org)        -> Adjective Animal
--   display name : users.nickname (caller) -> p_display_name   -> Adjective Animal
--
-- Note: the account's nickname takes precedence over the client-sent display
-- name (a best-effort OS full name / email prefix) so a saas-mono account lands
-- with its real human name; the client value is only a fallback for accounts
-- with no nickname.
--
-- p_name is now OPTIONAL (was required) so clients can omit it and let the
-- server resolve the org name. APPLY WITH Stage 2 (references amux tables);
-- supersedes 20260608040000_create_team_oid.sql.
-- ============================================================================
create or replace function public.create_team(
  p_name text default null::text,
  p_slug text default null::text,
  p_litellm_team_id text default null::text,
  p_ai_gateway_endpoint text default null::text,
  p_display_name text default null::text,
  p_oid uuid default null::uuid
)
returns table(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language plpgsql security definer
set search_path to 'amux', 'public', 'auth'
as $function$
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
    where u.auth_user_id = v_user_id
    limit 1;
  end if;

  -- Resolve the caller's nickname (for the default owner display name).
  select nickname into v_nickname
  from public.users
  where auth_user_id = v_user_id
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

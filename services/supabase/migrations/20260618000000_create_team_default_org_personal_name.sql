-- ============================================================================
-- Tenancy alignment with betly: the first team is always stamped with the
-- shared DEFAULT_ORG (FC passes p_oid = DEFAULT_ORG_ID); a per-user org is no
-- longer minted on signup (that now happens only at account upgrade).
--
-- Because every new user's personal team lives in the SAME default org, the
-- team name must NOT fall back to the org name (that would name everyone's
-- team after the default tenant, e.g. "Betly 倍拓"). Team-name precedence is now:
--   explicit p_name -> deterministic "Adjective Animal".
-- Owner display name is unchanged: nickname -> client best-effort -> Adjective Animal.
--
-- See docs/specs/2026-06-17-teamclaw-phone-login-and-tenancy.md.
-- APPLY WITH the amux schema (references amux tables). Supersedes
-- 20260616000000_create_team_org_defaults.sql.
-- ============================================================================
create or replace function amux.create_team(
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
$function$;

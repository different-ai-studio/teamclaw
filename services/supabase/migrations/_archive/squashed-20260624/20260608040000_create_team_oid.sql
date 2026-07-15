-- ============================================================================
-- Stage 3-FC support: extend create_team to stamp teams.oid (the caller's org)
-- (spec: docs/specs/2026-06-08-teamclaw-saas-mono-integration.md §5 Step A, §8)
--
-- ⚠️ APPLY WITH Stage 2 (references amux tables). Supersedes the generic
--    public.→amux. rewrite that Stage 2 applies to create_team, adding p_oid.
--
-- FC's createTeam passes p_oid = caller's app_metadata.org_id so a newly
-- created team belongs to the caller's org (strict single-org; teams_org_guard
-- requires teams.oid = current_org_id for non-service-role mutations).
-- ============================================================================
create or replace function public.create_team(
  p_name text,
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
  v_team_id      uuid;
  v_workspace_id uuid;
  v_slug_base    text;
  v_slug         text;
  v_suffix       integer := 1;
  v_display_name text;
  v_adjectives   text[] := array['Curious','Brave','Calm','Eager','Lively','Mellow','Nimble','Quick','Quiet','Sunny','Witty','Zesty','Bright','Daring','Gentle','Jolly','Keen','Plucky','Spry','Sparkling'];
  v_animals      text[] := array['Otter','Panda','Falcon','Fox','Heron','Lynx','Owl','Puffin','Quokka','Raven','Seal','Tapir','Viper','Walrus','Yak','Zebra','Badger','Cougar','Dolphin','Hare'];
begin
  if v_user_id is null then
    raise exception 'create_team requires an authenticated user' using errcode = '42501';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'team name is required' using errcode = '22023';
  end if;
  if exists (select 1 from amux.actors where user_id = v_user_id) then
    raise exception 'create_team currently supports first-team onboarding only'
      using errcode = '23514', detail = 'Existing actors already have a team-scoped identity.';
  end if;

  v_slug_base := lower(regexp_replace(coalesce(nullif(btrim(p_slug), ''), btrim(p_name)), '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug_base := trim(both '-' from v_slug_base);
  if v_slug_base = '' then v_slug_base := 'team'; end if;
  v_slug := v_slug_base;
  while exists (select 1 from amux.teams t where t.slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := format('%s-%s', v_slug_base, v_suffix);
  end loop;

  -- NEW: stamp the caller's org onto the team
  insert into amux.teams (name, slug, oid)
  values (btrim(p_name), v_slug, p_oid)
  returning id into v_team_id;

  v_member_id := gen_random_uuid();
  v_display_name := coalesce(
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
  select v_team_id, btrim(p_name), v_slug, v_member_id, 'owner'::text, v_workspace_id, 'General'::text;
end;
$function$;

-- 20260528000001_create_team_with_workspace_config.sql
--
-- Unify team provisioning: make the create_team RPC own the
-- team_workspace_config row so every team (AuthGate auto-create, /v1/teams
-- explicit creation, ...) has a workspace_config from the moment it exists.
--
-- Adds two optional parameters that the FC POST /v1/teams handler fills in
-- after LiteLLM provisioning:
--   - p_litellm_team_id
--   - p_ai_gateway_endpoint
-- Both default to NULL so legacy callers (deprecated supabase backend, tests)
-- continue to work without LiteLLM provisioning.

create or replace function public.create_team(
  p_name text,
  p_slug text default null,
  p_litellm_team_id text default null,
  p_ai_gateway_endpoint text default null
)
returns table (team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_user_id     uuid := auth.uid();
  v_member_id   uuid;
  v_team_id     uuid;
  v_workspace_id uuid;
  v_slug_base   text;
  v_slug        text;
  v_suffix      integer := 1;
begin
  if v_user_id is null then
    raise exception 'create_team requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'team name is required'
      using errcode = '22023';
  end if;

  -- Guard: user already has an actor in any team → refuse (first-team onboarding only).
  if exists (select 1 from public.actors where user_id = v_user_id) then
    raise exception 'create_team currently supports first-team onboarding only'
      using errcode = '23514',
            detail = 'Existing actors already have a team-scoped identity.';
  end if;

  v_slug_base := lower(
    regexp_replace(
      coalesce(nullif(btrim(p_slug), ''), btrim(p_name)),
      '[^a-zA-Z0-9]+', '-', 'g'
    )
  );
  v_slug_base := trim(both '-' from v_slug_base);
  if v_slug_base = '' then v_slug_base := 'team'; end if;

  v_slug := v_slug_base;
  while exists (select 1 from public.teams t where t.slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := format('%s-%s', v_slug_base, v_suffix);
  end loop;

  insert into public.teams (name, slug)
  values (btrim(p_name), v_slug)
  returning id into v_team_id;

  v_member_id := gen_random_uuid();

  insert into public.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
  values (v_member_id, v_team_id, 'member', v_user_id, 'You', now());

  insert into public.members (id, status)
  values (v_member_id, 'active');

  insert into public.team_members (team_id, member_id, role)
  values (v_team_id, v_member_id, 'owner');

  insert into public.workspaces (team_id, created_by_member_id, name, path)
  values (v_team_id, v_member_id, 'General', null)
  returning id into v_workspace_id;

  -- Seed team_workspace_config so /sync/* and downstream features always have
  -- a row to read/update. sync_mode defaults to 'oss' per migration
  -- 20260527000005; oss_change_seq defaults to 0; enabled defaults to true.
  -- The guard trigger (migration 20260527000002/4) only fires on UPDATE, not
  -- INSERT, so litellm_team_id / ai_gateway_endpoint can be set here freely.
  insert into public.team_workspace_config (team_id, litellm_team_id, ai_gateway_endpoint)
  values (v_team_id, p_litellm_team_id, p_ai_gateway_endpoint);

  return query
  select v_team_id, btrim(p_name), v_slug,
         v_member_id, 'owner'::text,
         v_workspace_id, 'General'::text;
end;
$$;

revoke all on function public.create_team(text, text, text, text) from public;
grant execute on function public.create_team(text, text, text, text) to authenticated;

-- Drop the previous 2-arg signature so callers cannot pin themselves to it
-- and accidentally skip team_workspace_config provisioning.
drop function if exists public.create_team(text, text);

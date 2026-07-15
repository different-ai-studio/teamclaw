-- create_team: replace the hardcoded 'You' owner display_name with a
-- caller-provided name, falling back to a deterministic English
-- "Adjective Animal" handle seeded from the new actor id.
--
-- Why: anonymous / first-team users were landing as "You", which is a
-- perspective-relative word that reads as nonsense to teammates in shared
-- (cloud / OSS) contexts. Clients now pass the user's real name (OS full name
-- or account email prefix) as p_display_name; when absent we generate a stable,
-- non-throwaway-looking name instead. Avatars already derive their color +
-- initials from the actor id (packages/app/src/lib/actor-color.ts), so a real
-- name immediately yields a sensible initial.
--
-- The wordlists mirror apps/ios/.../Onboarding/RandomTeamName.swift and
-- services/fc/src/lib/display-name.ts — keep all three in sync if edited.
--
-- Adding a parameter changes the function signature, which would otherwise
-- leave the old 4-arg overload in place and make PostgREST named-argument
-- resolution ambiguous (PGRST203). Drop the old overload first.

drop function if exists public.create_team(text, text, text, text);

create or replace function public.create_team(
  p_name text,
  p_slug text default null,
  p_litellm_team_id text default null,
  p_ai_gateway_endpoint text default null,
  p_display_name text default null
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
  v_display_name text;
  v_adjectives  text[] := array[
    'Curious','Brave','Calm','Eager','Lively','Mellow','Nimble','Quick',
    'Quiet','Sunny','Witty','Zesty','Bright','Daring','Gentle','Jolly',
    'Keen','Plucky','Spry','Sparkling'
  ];
  v_animals     text[] := array[
    'Otter','Panda','Falcon','Fox','Heron','Lynx','Owl','Puffin','Quokka',
    'Raven','Seal','Tapir','Viper','Walrus','Yak','Zebra','Badger','Cougar',
    'Dolphin','Hare'
  ];
begin
  if v_user_id is null then
    raise exception 'create_team requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'team name is required'
      using errcode = '22023';
  end if;

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

  -- Caller-provided real name wins; otherwise a deterministic Adjective Animal
  -- handle seeded from the actor id (stable across reads, no Math.random).
  -- ((hash % 20) + 20) % 20 keeps the index in [0,19] without abs() overflow.
  v_display_name := coalesce(
    nullif(btrim(p_display_name), ''),
    v_adjectives[((hashtextextended(v_member_id::text, 11) % 20) + 20) % 20 + 1]
      || ' ' ||
    v_animals[((hashtextextended(v_member_id::text, 29) % 20) + 20) % 20 + 1]
  );

  insert into public.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
  values (v_member_id, v_team_id, 'member', v_user_id, v_display_name, now());

  insert into public.members (id, status)
  values (v_member_id, 'active');

  insert into public.team_members (team_id, member_id, role)
  values (v_team_id, v_member_id, 'owner');

  insert into public.workspaces (team_id, created_by_member_id, name, path)
  values (v_team_id, v_member_id, 'General', null)
  returning id into v_workspace_id;

  -- Seed team_workspace_config WITHOUT sync_mode. sync_mode starts NULL and
  -- transitions to 'oss' or 'git' when the owner calls app.enable_team_share.
  insert into public.team_workspace_config (team_id, litellm_team_id, ai_gateway_endpoint)
  values (v_team_id, p_litellm_team_id, p_ai_gateway_endpoint);

  return query
  select v_team_id, btrim(p_name), v_slug,
         v_member_id, 'owner'::text,
         v_workspace_id, 'General'::text;
end;
$$;

revoke all on function public.create_team(text, text, text, text, text) from public;
grant execute on function public.create_team(text, text, text, text, text) to authenticated;

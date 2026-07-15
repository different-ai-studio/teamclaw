create or replace function public.create_team(
  p_name text,
  p_slug text default null
)
returns table (
  team_id uuid,
  team_name text,
  team_slug text,
  member_id uuid,
  role text,
  workspace_id uuid,
  workspace_name text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_member_id uuid;
  v_team_id uuid;
  v_workspace_id uuid;
  v_slug_base text;
  v_slug text;
  v_suffix integer := 1;
begin
  if v_user_id is null then
    raise exception 'create_team requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'team name is required'
      using errcode = '22023';
  end if;

  select m.id
  into v_member_id
  from public.members m
  where m.user_id = v_user_id
  limit 1;

  if v_member_id is not null then
    raise exception 'create_team currently supports first-team onboarding only'
      using errcode = '23514',
            detail = 'Existing members already have a team-scoped actor id.';
  end if;

  v_slug_base := lower(
    regexp_replace(
      coalesce(nullif(btrim(p_slug), ''), btrim(p_name)),
      '[^a-zA-Z0-9]+',
      '-',
      'g'
    )
  );
  v_slug_base := trim(both '-' from v_slug_base);
  if v_slug_base = '' then
    v_slug_base := 'team';
  end if;

  v_slug := v_slug_base;
  while exists (
    select 1
    from public.teams t
    where t.slug = v_slug
  ) loop
    v_suffix := v_suffix + 1;
    v_slug := format('%s-%s', v_slug_base, v_suffix);
  end loop;

  insert into public.teams (name, slug)
  values (btrim(p_name), v_slug)
  returning id into v_team_id;

  v_member_id := gen_random_uuid();

  insert into public.actors (id, team_id, actor_type, display_name, last_active_at)
  values (v_member_id, v_team_id, 'member', 'You', now());

  insert into public.members (id, user_id, status)
  values (v_member_id, v_user_id, 'active');

  insert into public.team_members (team_id, member_id, role)
  values (v_team_id, v_member_id, 'owner');

  insert into public.workspaces (team_id, created_by_member_id, name, path)
  values (v_team_id, v_member_id, 'General', null)
  returning id into v_workspace_id;

  return query
  select
    v_team_id,
    btrim(p_name),
    v_slug,
    v_member_id,
    'owner'::text,
    v_workspace_id,
    'General'::text;
end;
$$;

revoke all on function public.create_team(text, text) from public;
grant execute on function public.create_team(text, text) to authenticated;

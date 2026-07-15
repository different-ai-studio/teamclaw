create or replace function public.create_idea(
  p_team_id uuid,
  p_workspace_id uuid,
  p_title text,
  p_description text default ''
)
returns table (
  id uuid,
  team_id uuid,
  workspace_id uuid,
  created_by_actor_id uuid,
  title text,
  description text,
  status text,
  archived boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_id uuid := app.current_actor_id();
  v_workspace_team_id uuid;
begin
  if v_actor_id is null then
    raise exception 'create_idea requires an authenticated member'
      using errcode = '42501';
  end if;

  if p_team_id is null or not app.is_team_member(p_team_id) then
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
    from public.workspaces w
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

  return query
  insert into public.ideas (
    team_id,
    workspace_id,
    created_by_actor_id,
    title,
    description,
    status,
    archived
  )
  values (
    p_team_id,
    p_workspace_id,
    v_actor_id,
    btrim(p_title),
    coalesce(p_description, ''),
    'open',
    false
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
    ideas.created_at,
    ideas.updated_at;
end;
$$;

create or replace function public.update_idea(
  p_idea_id uuid,
  p_workspace_id uuid,
  p_title text,
  p_description text,
  p_status text
)
returns table (
  id uuid,
  team_id uuid,
  workspace_id uuid,
  created_by_actor_id uuid,
  title text,
  description text,
  status text,
  archived boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_idea_team_id uuid;
  v_workspace_team_id uuid;
begin
  if app.current_actor_id() is null then
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
  from public.ideas t
  where t.id = p_idea_id;

  if v_idea_team_id is null then
    raise exception 'idea not found'
      using errcode = '23503';
  end if;

  if not app.is_team_member(v_idea_team_id) then
    raise exception 'update_idea requires team membership'
      using errcode = '42501';
  end if;

  if p_workspace_id is not null then
    select w.team_id
    into v_workspace_team_id
    from public.workspaces w
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
  update public.ideas
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
    ideas.created_at,
    ideas.updated_at;
end;
$$;

create or replace function public.archive_idea(
  p_idea_id uuid,
  p_archived boolean default true
)
returns table (
  id uuid,
  team_id uuid,
  workspace_id uuid,
  created_by_actor_id uuid,
  title text,
  description text,
  status text,
  archived boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_idea_team_id uuid;
begin
  if app.current_actor_id() is null then
    raise exception 'archive_idea requires an authenticated member'
      using errcode = '42501';
  end if;

  if p_idea_id is null then
    raise exception 'idea id is required'
      using errcode = '22023';
  end if;

  select t.team_id
  into v_idea_team_id
  from public.ideas t
  where t.id = p_idea_id;

  if v_idea_team_id is null then
    raise exception 'idea not found'
      using errcode = '23503';
  end if;

  if not app.is_team_member(v_idea_team_id) then
    raise exception 'archive_idea requires team membership'
      using errcode = '42501';
  end if;

  return query
  update public.ideas
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
    ideas.created_at,
    ideas.updated_at;
end;
$$;

revoke all on function public.create_idea(uuid, uuid, text, text) from public;
revoke all on function public.update_idea(uuid, uuid, text, text, text) from public;
revoke all on function public.archive_idea(uuid, boolean) from public;

grant execute on function public.create_idea(uuid, uuid, text, text) to authenticated;
grant execute on function public.update_idea(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.archive_idea(uuid, boolean) to authenticated;

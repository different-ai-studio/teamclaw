create or replace function public.create_idea(
  p_team_id uuid,
  p_title text,
  p_workspace_id uuid default null,
  p_description text default ''
)
returns table(
  id uuid,
  team_id uuid,
  workspace_id uuid,
  created_by_actor_id uuid,
  title text,
  description text,
  status text,
  archived boolean,
  sort_order integer,
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
  v_sort_order integer;
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

  perform 1
  from public.teams
  where teams.id = p_team_id
  for update;

  select coalesce(min(i.sort_order), 1000) - 1000
  into v_sort_order
  from public.ideas i
  where i.team_id = p_team_id
    and i.archived = false;

  return query
  insert into public.ideas (
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

revoke all on function public.create_idea(uuid, text, uuid, text) from public, anon;
grant execute on function public.create_idea(uuid, text, uuid, text) to authenticated;

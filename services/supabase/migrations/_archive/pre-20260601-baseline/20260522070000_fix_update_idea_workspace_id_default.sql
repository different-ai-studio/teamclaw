-- Fix update_idea: make p_workspace_id optional with a default of null.
-- The Swift Supabase client omits nil optional params, so the old 5-param
-- required signature failed when workspace_id was nil.

drop function if exists public.update_idea(uuid, uuid, text, text, text);

create or replace function public.update_idea(
  p_idea_id uuid,
  p_title text,
  p_workspace_id uuid default null,
  p_description text default '',
  p_status text default 'open'
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
  sort_order integer,
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
    ideas.sort_order,
    ideas.created_at,
    ideas.updated_at;
end;
$$;

revoke all on function public.update_idea(uuid, text, uuid, text, text) from public;
grant execute on function public.update_idea(uuid, text, uuid, text, text) to authenticated;

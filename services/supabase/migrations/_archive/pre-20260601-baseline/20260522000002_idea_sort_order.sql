alter table public.ideas
  add column if not exists sort_order integer not null default 0;

with ranked as (
  select
    id,
    row_number() over (
      partition by team_id
      order by archived asc, updated_at desc, created_at desc, id
    )::integer * 1000 as next_sort_order
  from public.ideas
)
update public.ideas i
set sort_order = ranked.next_sort_order
from ranked
where ranked.id = i.id
  and i.sort_order = 0;

create index if not exists idx_ideas_team_sort_order
  on public.ideas(team_id, archived, sort_order, updated_at desc);

drop function if exists public.create_idea(uuid, text, uuid, text);
drop function if exists public.update_idea(uuid, uuid, text, text, text);
drop function if exists public.update_idea(uuid, text, uuid, text, text);
drop function if exists public.archive_idea(uuid, boolean);
drop function if exists public.reorder_ideas(uuid, uuid[]);

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

  select coalesce(max(i.sort_order), 0) + 1000
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
    ideas.sort_order,
    ideas.created_at,
    ideas.updated_at;
end;
$$;

create or replace function public.reorder_ideas(
  p_team_id uuid,
  p_idea_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if p_team_id is null or not app.is_team_member(p_team_id) then
    raise exception 'reorder_ideas requires team membership'
      using errcode = '42501';
  end if;

  if p_idea_ids is null then
    return;
  end if;

  if exists (
    select 1
    from unnest(p_idea_ids) as ordered(id)
    left join public.ideas i
      on i.id = ordered.id
     and i.team_id = p_team_id
     and i.archived = false
    where i.id is null
  ) then
    raise exception 'reorder_ideas contains an invalid idea'
      using errcode = '23503';
  end if;

  update public.ideas i
  set sort_order = ordered.ordinality::integer * 1000
  from unnest(p_idea_ids) with ordinality as ordered(id, ordinality)
  where i.id = ordered.id
    and i.team_id = p_team_id
    and i.archived = false;
end;
$$;

revoke all on function public.create_idea(uuid, text, uuid, text) from public;
revoke all on function public.update_idea(uuid, text, uuid, text, text) from public;
revoke all on function public.archive_idea(uuid, boolean) from public;
revoke all on function public.reorder_ideas(uuid, uuid[]) from public;

grant execute on function public.create_idea(uuid, text, uuid, text) to authenticated;
grant execute on function public.update_idea(uuid, text, uuid, text, text) to authenticated;
grant execute on function public.archive_idea(uuid, boolean) to authenticated;
grant execute on function public.reorder_ideas(uuid, uuid[]) to authenticated;

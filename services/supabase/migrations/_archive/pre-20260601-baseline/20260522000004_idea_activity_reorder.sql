alter table public.idea_activities
  drop constraint if exists idea_activities_activity_type_check;

alter table public.idea_activities
  add constraint idea_activities_activity_type_check
  check (activity_type in ('progress', 'status_change', 'reorder'));

create or replace function public.create_idea_activity(
  p_idea_id uuid,
  p_activity_type text,
  p_content text default '',
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  team_id uuid,
  idea_id uuid,
  actor_id uuid,
  activity_type text,
  content text,
  metadata jsonb,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_id uuid := app.current_actor_id();
  v_team_id uuid;
begin
  if v_actor_id is null then
    raise exception 'create_idea_activity requires an authenticated member'
      using errcode = '42501';
  end if;

  if p_idea_id is null then
    raise exception 'idea id is required'
      using errcode = '22023';
  end if;

  if p_activity_type not in ('progress', 'status_change', 'reorder') then
    raise exception 'invalid idea activity type'
      using errcode = '22023';
  end if;

  select i.team_id
  into v_team_id
  from public.ideas i
  where i.id = p_idea_id;

  if v_team_id is null then
    raise exception 'idea not found'
      using errcode = '23503';
  end if;

  if not app.is_team_member(v_team_id) then
    raise exception 'create_idea_activity requires team membership'
      using errcode = '42501';
  end if;

  return query
  insert into public.idea_activities (
    team_id,
    idea_id,
    actor_id,
    activity_type,
    content,
    metadata
  )
  values (
    v_team_id,
    p_idea_id,
    v_actor_id,
    p_activity_type,
    coalesce(p_content, ''),
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning
    idea_activities.id,
    idea_activities.team_id,
    idea_activities.idea_id,
    idea_activities.actor_id,
    idea_activities.activity_type,
    idea_activities.content,
    idea_activities.metadata,
    idea_activities.created_at,
    idea_activities.updated_at;
end;
$$;

revoke all on function public.create_idea_activity(uuid, text, text, jsonb) from public;
grant execute on function public.create_idea_activity(uuid, text, text, jsonb) to authenticated;

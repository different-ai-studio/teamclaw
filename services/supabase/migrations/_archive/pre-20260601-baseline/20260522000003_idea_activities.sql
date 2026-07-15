create table if not exists public.idea_activities (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  idea_id uuid not null references public.ideas(id) on delete cascade,
  actor_id uuid not null references public.actors(id) on delete restrict,
  activity_type text not null check (activity_type in ('progress', 'status_change')),
  content text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_idea_activities_idea_created_at
  on public.idea_activities(idea_id, created_at desc);

create index if not exists idx_idea_activities_team_created_at
  on public.idea_activities(team_id, created_at desc);

drop trigger if exists set_idea_activities_updated_at on public.idea_activities;
create trigger set_idea_activities_updated_at before update on public.idea_activities
for each row execute function app.bump_updated_at();

alter table public.idea_activities enable row level security;

drop policy if exists idea_activities_select_if_team_member on public.idea_activities;
create policy idea_activities_select_if_team_member on public.idea_activities
for select to authenticated using (app.is_team_member(team_id));

drop policy if exists idea_activities_insert_if_team_member on public.idea_activities;
create policy idea_activities_insert_if_team_member on public.idea_activities
for insert to authenticated with check (
  app.is_team_member(team_id)
  and actor_id = app.current_actor_id()
  and exists (
    select 1
    from public.ideas i
    where i.id = idea_activities.idea_id
      and i.team_id = idea_activities.team_id
  )
);

drop function if exists public.create_idea_activity(uuid, text, text, jsonb);

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

  if p_activity_type not in ('progress', 'status_change') then
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

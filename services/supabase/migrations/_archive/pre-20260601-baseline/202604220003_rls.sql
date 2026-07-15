create or replace function app.current_member_id()
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select m.id
  from public.members m
  where m.user_id = auth.uid()
    and m.status = 'active'
  limit 1
$$;

create or replace function app.current_actor_id()
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select app.current_member_id()
$$;

create or replace function app.is_team_member(target_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.team_members tm
    where tm.team_id = target_team_id
      and tm.member_id = app.current_member_id()
  )
$$;

create or replace function app.current_team_role(target_team_id uuid)
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select tm.role
  from public.team_members tm
  where tm.team_id = target_team_id
    and tm.member_id = app.current_member_id()
  limit 1
$$;

create or replace function app.uuid_column_matches_existing(
  target_table regclass,
  target_id uuid,
  target_column text,
  target_value uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  existing_value uuid;
begin
  if target_id is null then
    return false;
  end if;

  execute format('select %I from %s where id = $1', target_column, target_table)
    into existing_value
    using target_id;

  return target_value is not distinct from existing_value;
end;
$$;

create or replace function app.is_session_participant(target_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select app.current_actor_id() is not null
    and exists (
      select 1
      from public.sessions s
      where s.id = target_session_id
        and app.is_team_member(s.team_id)
        and exists (
          select 1
          from public.session_participants sp
          where sp.session_id = s.id
            and sp.actor_id = app.current_actor_id()
        )
    )
$$;

create or replace function app.can_prompt_agent(target_agent_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.agent_member_access ama
    join public.agents a on a.id = ama.agent_id
    join public.actors act on act.id = a.id
    where ama.agent_id = target_agent_id
      and ama.member_id = app.current_member_id()
      and ama.permission_level in ('prompt', 'admin')
      and app.is_team_member(act.team_id)
  )
  or exists (
    select 1
    from public.agents a
    join public.actors act on act.id = a.id
    where a.id = target_agent_id
      and app.current_team_role(act.team_id) in ('owner', 'admin')
  )
$$;

revoke all on function app.current_member_id() from public;
revoke all on function app.current_actor_id() from public;
revoke all on function app.is_team_member(uuid) from public;
revoke all on function app.current_team_role(uuid) from public;
revoke all on function app.uuid_column_matches_existing(regclass, uuid, text, uuid) from public;
revoke all on function app.is_session_participant(uuid) from public;
revoke all on function app.can_prompt_agent(uuid) from public;

revoke all on schema app from public;

grant usage on schema app to authenticated;
grant execute on function app.current_member_id() to authenticated;
grant execute on function app.current_actor_id() to authenticated;
grant execute on function app.is_team_member(uuid) to authenticated;
grant execute on function app.current_team_role(uuid) to authenticated;
grant execute on function app.uuid_column_matches_existing(regclass, uuid, text, uuid) to authenticated;
grant execute on function app.is_session_participant(uuid) to authenticated;
grant execute on function app.can_prompt_agent(uuid) to authenticated;

alter table public.teams enable row level security;
alter table public.actors enable row level security;
alter table public.members enable row level security;
alter table public.team_members enable row level security;
alter table public.workspaces enable row level security;
alter table public.agents enable row level security;
alter table public.agent_member_access enable row level security;
alter table public.ideas enable row level security;
alter table public.idea_external_refs enable row level security;
alter table public.sessions enable row level security;
alter table public.session_participants enable row level security;
alter table public.messages enable row level security;
alter table public.agent_runtimes enable row level security;

create policy teams_select_if_member on public.teams
for select to authenticated using (app.is_team_member(id));

create policy actors_select_if_team_member on public.actors
for select to authenticated using (app.is_team_member(team_id));

create policy members_select_self_or_team_member on public.members
for select to authenticated using (
  id = app.current_member_id()
  or exists (
    select 1
    from public.actors a
    where a.id = members.id
      and app.is_team_member(a.team_id)
  )
);

create policy team_members_select_if_team_member on public.team_members
for select to authenticated using (app.is_team_member(team_id));

create policy workspaces_select_if_team_member on public.workspaces
for select to authenticated using (app.is_team_member(team_id));

create policy workspaces_insert_if_team_member on public.workspaces
for insert to authenticated with check (
  app.is_team_member(team_id)
  and (
    created_by_member_id is null
    or created_by_member_id = app.current_member_id()
  )
);

create policy workspaces_update_if_team_member on public.workspaces
for update to authenticated using (app.is_team_member(team_id))
with check (
  app.is_team_member(team_id)
  and app.uuid_column_matches_existing(
    'public.workspaces'::regclass,
    id,
    'created_by_member_id',
    created_by_member_id
  )
);

create policy agents_select_if_team_member on public.agents
for select to authenticated using (
  exists (
    select 1
    from public.actors a
    where a.id = agents.id
      and app.is_team_member(a.team_id)
  )
);

create policy agent_member_access_select_if_team_member on public.agent_member_access
for select to authenticated using (
  exists (
    select 1
    from public.agents a
    join public.actors act on act.id = a.id
    where a.id = agent_member_access.agent_id
      and app.is_team_member(act.team_id)
  )
);

create policy agent_member_access_manage_if_admin on public.agent_member_access
for all to authenticated using (
  exists (
    select 1
    from public.agents a
    join public.actors act on act.id = a.id
    where a.id = agent_member_access.agent_id
      and app.current_team_role(act.team_id) in ('owner', 'admin')
  )
)
with check (
  exists (
    select 1
    from public.agents a
    join public.actors act on act.id = a.id
    where a.id = agent_member_access.agent_id
      and app.current_team_role(act.team_id) in ('owner', 'admin')
  )
);

create policy ideas_select_if_team_member on public.ideas
for select to authenticated using (app.is_team_member(team_id));

create policy ideas_insert_if_team_member on public.ideas
for insert to authenticated with check (
  app.is_team_member(team_id)
  and created_by_actor_id = app.current_actor_id()
);

create policy ideas_update_if_team_member on public.ideas
for update to authenticated using (app.is_team_member(team_id))
with check (
  app.is_team_member(team_id)
  and app.uuid_column_matches_existing(
    'public.ideas'::regclass,
    id,
    'created_by_actor_id',
    created_by_actor_id
  )
);

create policy idea_external_refs_select_if_team_member on public.idea_external_refs
for select to authenticated using (
  exists (
    select 1
    from public.ideas t
    where t.id = idea_external_refs.idea_id
      and app.is_team_member(t.team_id)
  )
);

create policy idea_external_refs_insert_if_team_member on public.idea_external_refs
for insert to authenticated with check (
  exists (
    select 1
    from public.ideas t
    where t.id = idea_external_refs.idea_id
      and app.is_team_member(t.team_id)
  )
  and linked_by_actor_id = app.current_actor_id()
);

create policy sessions_select_if_team_member on public.sessions
for select to authenticated using (app.is_team_member(team_id));

create policy sessions_insert_if_team_member on public.sessions
for insert to authenticated with check (
  app.is_team_member(team_id)
  and created_by_actor_id = app.current_actor_id()
);

create policy sessions_update_if_team_member on public.sessions
for update to authenticated using (app.is_team_member(team_id))
with check (
  app.is_team_member(team_id)
  and app.uuid_column_matches_existing(
    'public.sessions'::regclass,
    id,
    'created_by_actor_id',
    created_by_actor_id
  )
);

create policy session_participants_select_if_team_member on public.session_participants
for select to authenticated using (
  exists (
    select 1
    from public.sessions s
    where s.id = session_participants.session_id
      and app.is_team_member(s.team_id)
  )
);

create policy session_participants_insert_if_team_member on public.session_participants
for insert to authenticated with check (
  exists (
    select 1
    from public.sessions s
    where s.id = session_participants.session_id
      and app.is_team_member(s.team_id)
      and s.created_by_actor_id = app.current_actor_id()
  )
  and app.is_session_participant(session_participants.session_id)
);

create policy messages_select_if_session_participant on public.messages
for select to authenticated using (app.is_session_participant(session_id));

create policy messages_insert_if_session_participant on public.messages
for insert to authenticated with check (
  app.is_session_participant(session_id)
  and sender_actor_id = app.current_actor_id()
);

create policy agent_runtimes_select_if_team_member on public.agent_runtimes
for select to authenticated using (app.is_team_member(team_id));

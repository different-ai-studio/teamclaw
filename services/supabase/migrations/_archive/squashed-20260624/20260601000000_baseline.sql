-- TeamClaw Supabase baseline schema
--
-- Squashed from 93 incremental migrations (20260422 through 20260530) that were
-- applied to the Aliyun Supabase instance during the cloud migration.
--
-- Fresh installs: apply this single file, then run pgTAP tests under tests/.
-- Existing Aliyun database: schema already matches; do not re-apply.
-- Future schema changes: add new timestamped files after this baseline.
--
-- Archived source migrations live in migrations/_archive/pre-20260601-baseline/.


-- >>> BEGIN archived migration: 202604220001_init_extensions.sql

create extension if not exists pgcrypto;
create extension if not exists pgtap with schema extensions;

create schema if not exists app;

create or replace function app.bump_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- <<< END archived migration: 202604220001_init_extensions.sql

-- >>> BEGIN archived migration: 202604220002_core_schema.sql

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.actors (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  actor_type text not null check (actor_type in ('member', 'agent')),
  display_name text not null,
  last_active_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.members (
  id uuid primary key references public.actors(id) on delete cascade,
  user_id uuid null references auth.users(id) on delete set null,
  status text not null check (status in ('invited', 'active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, member_id)
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  created_by_member_id uuid null references public.members(id) on delete set null,
  name text not null,
  path text null,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, name)
);

create table public.agents (
  id uuid primary key references public.actors(id) on delete cascade,
  default_workspace_id uuid null references public.workspaces(id) on delete set null,
  created_by_member_id uuid null references public.members(id) on delete set null,
  agent_kind text not null,
  capabilities jsonb not null default '{}'::jsonb,
  status text not null check (status in ('active', 'disabled', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.agent_member_access (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  permission_level text not null check (permission_level in ('view', 'prompt', 'admin')),
  granted_by_member_id uuid null references public.members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, member_id)
);

create table public.ideas (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  workspace_id uuid null references public.workspaces(id) on delete set null,
  parent_idea_id uuid null references public.ideas(id) on delete set null,
  created_by_actor_id uuid not null references public.actors(id) on delete restrict,
  title text not null,
  description text not null default '',
  status text not null check (status in ('open', 'in_progress', 'done')),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.idea_external_refs (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references public.ideas(id) on delete cascade,
  provider text not null check (provider in ('github', 'linear', 'jira')),
  external_id text not null,
  external_key text null,
  external_url text not null,
  linked_by_actor_id uuid not null references public.actors(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_id)
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  idea_id uuid not null references public.ideas(id) on delete cascade,
  created_by_actor_id uuid not null references public.actors(id) on delete restrict,
  primary_agent_id uuid null references public.agents(id) on delete set null,
  mode text not null check (mode in ('solo', 'collab', 'control')),
  title text not null,
  summary text not null default '',
  last_message_preview text null,
  last_message_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.session_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  actor_id uuid not null references public.actors(id) on delete cascade,
  role text null,
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, actor_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  sender_actor_id uuid not null references public.actors(id) on delete restrict,
  reply_to_message_id uuid null references public.messages(id) on delete set null,
  kind text not null check (kind in ('text', 'system', 'idea_event')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.agent_runtimes (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  workspace_id uuid null references public.workspaces(id) on delete set null,
  backend_type text not null check (backend_type in ('claude', 'codex', 'opencode')),
  backend_session_id text null,
  status text not null check (status in ('starting', 'running', 'stopped', 'failed')),
  current_model text null,
  last_seen_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function app.actor_team_id(p_actor_id uuid)
returns uuid
language sql
stable
as $$
  select team_id
  from public.actors
  where id = p_actor_id
$$;

create or replace function app.table_team_id(p_table regclass, p_id uuid)
returns uuid
language plpgsql
stable
as $$
declare
  v_team_id uuid;
begin
  if p_id is null then
    return null;
  end if;

  execute format('select team_id from %s where id = $1', p_table)
    into v_team_id
    using p_id;

  return v_team_id;
end;
$$;

create or replace function app.require_same_team(
  p_expected_team_id uuid,
  p_actual_team_id uuid,
  p_context text
)
returns void
language plpgsql
as $$
begin
  if p_expected_team_id is null or p_actual_team_id is null then
    return;
  end if;

  if p_expected_team_id is distinct from p_actual_team_id then
    raise exception '% violates team scoping', p_context
      using errcode = '23514',
            detail = format(
              'Expected team %s but found team %s',
              p_expected_team_id,
              p_actual_team_id
            );
  end if;
end;
$$;

create or replace function app.require_actor_type(
  p_actor_id uuid,
  p_expected_type text,
  p_context text
)
returns void
language plpgsql
as $$
declare
  v_actor_type text;
begin
  if p_actor_id is null then
    return;
  end if;

  select actor_type
  into v_actor_type
  from public.actors
  where id = p_actor_id;

  if v_actor_type is null then
    return;
  end if;

  if v_actor_type <> p_expected_type then
    raise exception '% requires actor_type = %', p_context, p_expected_type
      using errcode = '23514',
            detail = format(
              'Actor %s has actor_type %s',
              p_actor_id,
              v_actor_type
            );
  end if;
end;
$$;

create or replace function app.reject_team_reassignment(
  p_context text
)
returns void
language plpgsql
as $$
begin
  raise exception '% cannot change team_id while dependent rows exist', p_context
    using errcode = '23514';
end;
$$;

create or replace function app.enforce_actor_subtype()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'members' then
    perform app.require_actor_type(new.id, 'member', 'members.id');
  elsif tg_table_name = 'agents' then
    perform app.require_actor_type(new.id, 'agent', 'agents.id');
  else
    raise exception 'app.enforce_actor_subtype is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$$;

create or replace function app.enforce_parent_integrity()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'actors' then
    if new.actor_type is distinct from old.actor_type then
      if exists (select 1 from public.members where id = new.id) and new.actor_type <> 'member' then
        raise exception 'actors.actor_type cannot diverge from members.id'
          using errcode = '23514';
      end if;

      if exists (select 1 from public.agents where id = new.id) and new.actor_type <> 'agent' then
        raise exception 'actors.actor_type cannot diverge from agents.id'
          using errcode = '23514';
      end if;
    end if;

    if new.team_id is distinct from old.team_id then
      if exists (select 1 from public.members where id = new.id)
        or exists (select 1 from public.agents where id = new.id)
        or exists (select 1 from public.team_members where member_id = new.id)
        or exists (select 1 from public.workspaces where created_by_member_id = new.id)
        or exists (select 1 from public.agent_member_access where member_id = new.id or granted_by_member_id = new.id or agent_id = new.id)
        or exists (select 1 from public.ideas where created_by_actor_id = new.id)
        or exists (select 1 from public.idea_external_refs where linked_by_actor_id = new.id)
        or exists (select 1 from public.sessions where created_by_actor_id = new.id or primary_agent_id = new.id)
        or exists (select 1 from public.session_participants where actor_id = new.id)
        or exists (select 1 from public.messages where sender_actor_id = new.id)
        or exists (select 1 from public.agent_runtimes where agent_id = new.id) then
        perform app.reject_team_reassignment('actors.team_id');
      end if;
    end if;
  elsif tg_table_name = 'workspaces' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from public.agents where default_workspace_id = new.id)
        or exists (select 1 from public.ideas where workspace_id = new.id)
        or exists (select 1 from public.agent_runtimes where workspace_id = new.id)
      ) then
      perform app.reject_team_reassignment('workspaces.team_id');
    end if;
  elsif tg_table_name = 'ideas' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from public.ideas where parent_idea_id = new.id)
        or exists (select 1 from public.idea_external_refs where idea_id = new.id)
        or exists (select 1 from public.sessions where idea_id = new.id)
      ) then
      perform app.reject_team_reassignment('ideas.team_id');
    end if;
  elsif tg_table_name = 'sessions' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from public.session_participants where session_id = new.id)
        or exists (select 1 from public.messages where session_id = new.id)
        or exists (select 1 from public.agent_runtimes where session_id = new.id)
      ) then
      perform app.reject_team_reassignment('sessions.team_id');
    end if;
  else
    raise exception 'app.enforce_parent_integrity is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$$;

create or replace function app.enforce_core_team_integrity()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'team_members' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.member_id),
      'team_members.member_id'
    );
  elsif tg_table_name = 'workspaces' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_member_id),
      'workspaces.created_by_member_id'
    );
  elsif tg_table_name = 'agents' then
    perform app.require_same_team(
      app.actor_team_id(new.id),
      app.actor_team_id(new.created_by_member_id),
      'agents.created_by_member_id'
    );
    perform app.require_same_team(
      app.actor_team_id(new.id),
      app.table_team_id('public.workspaces'::regclass, new.default_workspace_id),
      'agents.default_workspace_id'
    );
  elsif tg_table_name = 'agent_member_access' then
    perform app.require_same_team(
      app.actor_team_id(new.agent_id),
      app.actor_team_id(new.member_id),
      'agent_member_access.member_id'
    );
    perform app.require_same_team(
      app.actor_team_id(new.agent_id),
      app.actor_team_id(new.granted_by_member_id),
      'agent_member_access.granted_by_member_id'
    );
  elsif tg_table_name = 'ideas' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.workspaces'::regclass, new.workspace_id),
      'ideas.workspace_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.ideas'::regclass, new.parent_idea_id),
      'ideas.parent_idea_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_actor_id),
      'ideas.created_by_actor_id'
    );
  elsif tg_table_name = 'idea_external_refs' then
    perform app.require_same_team(
      app.table_team_id('public.ideas'::regclass, new.idea_id),
      app.actor_team_id(new.linked_by_actor_id),
      'idea_external_refs.linked_by_actor_id'
    );
  elsif tg_table_name = 'sessions' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.ideas'::regclass, new.idea_id),
      'sessions.idea_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_actor_id),
      'sessions.created_by_actor_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.primary_agent_id),
      'sessions.primary_agent_id'
    );
  elsif tg_table_name = 'session_participants' then
    perform app.require_same_team(
      app.table_team_id('public.sessions'::regclass, new.session_id),
      app.actor_team_id(new.actor_id),
      'session_participants.actor_id'
    );
  elsif tg_table_name = 'messages' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.sessions'::regclass, new.session_id),
      'messages.session_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.sender_actor_id),
      'messages.sender_actor_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.messages'::regclass, new.reply_to_message_id),
      'messages.reply_to_message_id'
    );
  elsif tg_table_name = 'agent_runtimes' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.agent_id),
      'agent_runtimes.agent_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.sessions'::regclass, new.session_id),
      'agent_runtimes.session_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.workspaces'::regclass, new.workspace_id),
      'agent_runtimes.workspace_id'
    );
  else
    raise exception 'app.enforce_core_team_integrity is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$$;

create index idx_actors_team_id on public.actors(team_id);
create index idx_team_members_member_id on public.team_members(member_id);
create index idx_workspaces_team_id on public.workspaces(team_id);
create index idx_ideas_team_id on public.ideas(team_id);
create index idx_ideas_workspace_id on public.ideas(workspace_id);
create index idx_sessions_team_id on public.sessions(team_id);
create index idx_sessions_idea_id on public.sessions(idea_id);
create index idx_messages_team_id on public.messages(team_id);
create index idx_messages_session_created_at on public.messages(session_id, created_at desc);
create index idx_session_participants_actor_id on public.session_participants(actor_id);
create index idx_agent_runtimes_session_id on public.agent_runtimes(session_id);
create index idx_agent_runtimes_agent_id on public.agent_runtimes(agent_id);

create trigger enforce_members_actor_type before insert or update on public.members
for each row execute function app.enforce_actor_subtype();
create trigger enforce_agents_actor_type before insert or update on public.agents
for each row execute function app.enforce_actor_subtype();
create trigger enforce_actors_parent_integrity before update on public.actors
for each row execute function app.enforce_parent_integrity();
create trigger enforce_team_members_same_team before insert or update on public.team_members
for each row execute function app.enforce_core_team_integrity();
create trigger enforce_workspaces_same_team before insert or update on public.workspaces
for each row execute function app.enforce_core_team_integrity();
create trigger enforce_workspaces_parent_integrity before update on public.workspaces
for each row execute function app.enforce_parent_integrity();
create trigger enforce_agents_same_team before insert or update on public.agents
for each row execute function app.enforce_core_team_integrity();
create trigger enforce_agent_member_access_same_team before insert or update on public.agent_member_access
for each row execute function app.enforce_core_team_integrity();
create trigger enforce_ideas_same_team before insert or update on public.ideas
for each row execute function app.enforce_core_team_integrity();
create trigger enforce_ideas_parent_integrity before update on public.ideas
for each row execute function app.enforce_parent_integrity();
create trigger enforce_idea_external_refs_same_team before insert or update on public.idea_external_refs
for each row execute function app.enforce_core_team_integrity();
create trigger enforce_sessions_same_team before insert or update on public.sessions
for each row execute function app.enforce_core_team_integrity();
create trigger enforce_sessions_parent_integrity before update on public.sessions
for each row execute function app.enforce_parent_integrity();
create trigger enforce_session_participants_same_team before insert or update on public.session_participants
for each row execute function app.enforce_core_team_integrity();
create trigger enforce_messages_same_team before insert or update on public.messages
for each row execute function app.enforce_core_team_integrity();
create trigger enforce_agent_runtimes_same_team before insert or update on public.agent_runtimes
for each row execute function app.enforce_core_team_integrity();

create trigger set_teams_updated_at before update on public.teams
for each row execute function app.bump_updated_at();
create trigger set_actors_updated_at before update on public.actors
for each row execute function app.bump_updated_at();
create trigger set_members_updated_at before update on public.members
for each row execute function app.bump_updated_at();
create trigger set_team_members_updated_at before update on public.team_members
for each row execute function app.bump_updated_at();
create trigger set_workspaces_updated_at before update on public.workspaces
for each row execute function app.bump_updated_at();
create trigger set_agents_updated_at before update on public.agents
for each row execute function app.bump_updated_at();
create trigger set_agent_member_access_updated_at before update on public.agent_member_access
for each row execute function app.bump_updated_at();
create trigger set_ideas_updated_at before update on public.ideas
for each row execute function app.bump_updated_at();
create trigger set_idea_external_refs_updated_at before update on public.idea_external_refs
for each row execute function app.bump_updated_at();
create trigger set_sessions_updated_at before update on public.sessions
for each row execute function app.bump_updated_at();
create trigger set_session_participants_updated_at before update on public.session_participants
for each row execute function app.bump_updated_at();
create trigger set_messages_updated_at before update on public.messages
for each row execute function app.bump_updated_at();
create trigger set_agent_runtimes_updated_at before update on public.agent_runtimes
for each row execute function app.bump_updated_at();

-- <<< END archived migration: 202604220002_core_schema.sql

-- >>> BEGIN archived migration: 202604220003_rls.sql

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

-- <<< END archived migration: 202604220003_rls.sql

-- >>> BEGIN archived migration: 202604220004_harden_function_search_path.sql

alter function app.bump_updated_at() set search_path = public;
alter function app.actor_team_id(uuid) set search_path = public;
alter function app.table_team_id(regclass, uuid) set search_path = public;
alter function app.require_same_team(uuid, uuid, text) set search_path = public;
alter function app.require_actor_type(uuid, text, text) set search_path = public;
alter function app.reject_team_reassignment(text) set search_path = public;
alter function app.enforce_actor_subtype() set search_path = public;
alter function app.enforce_parent_integrity() set search_path = public;
alter function app.enforce_core_team_integrity() set search_path = public;

-- <<< END archived migration: 202604220004_harden_function_search_path.sql

-- >>> BEGIN archived migration: 202604220005_create_team_rpc.sql

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

-- <<< END archived migration: 202604220005_create_team_rpc.sql

-- >>> BEGIN archived migration: 202604220006_idea_rpc.sql

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

-- <<< END archived migration: 202604220006_idea_rpc.sql

-- >>> BEGIN archived migration: 202604220007_workspace_agent_id.sql

alter table public.workspaces
  add column agent_id uuid null references public.agents(id) on delete set null;

update public.workspaces w
set agent_id = a.id
from public.agents a
where a.default_workspace_id = w.id
  and w.agent_id is null;

create index if not exists idx_workspaces_agent_id on public.workspaces(agent_id);

create or replace function app.enforce_parent_integrity()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'actors' then
    if new.actor_type is distinct from old.actor_type then
      if exists (select 1 from public.members where id = new.id) and new.actor_type <> 'member' then
        raise exception 'actors.actor_type cannot diverge from members.id'
          using errcode = '23514';
      end if;

      if exists (select 1 from public.agents where id = new.id) and new.actor_type <> 'agent' then
        raise exception 'actors.actor_type cannot diverge from agents.id'
          using errcode = '23514';
      end if;
    end if;

    if new.team_id is distinct from old.team_id then
      if exists (select 1 from public.members where id = new.id)
        or exists (select 1 from public.agents where id = new.id)
        or exists (select 1 from public.team_members where member_id = new.id)
        or exists (select 1 from public.workspaces where created_by_member_id = new.id or agent_id = new.id)
        or exists (select 1 from public.agent_member_access where member_id = new.id or granted_by_member_id = new.id or agent_id = new.id)
        or exists (select 1 from public.ideas where created_by_actor_id = new.id)
        or exists (select 1 from public.idea_external_refs where linked_by_actor_id = new.id)
        or exists (select 1 from public.sessions where created_by_actor_id = new.id or primary_agent_id = new.id)
        or exists (select 1 from public.session_participants where actor_id = new.id)
        or exists (select 1 from public.messages where sender_actor_id = new.id)
        or exists (select 1 from public.agent_runtimes where agent_id = new.id) then
        perform app.reject_team_reassignment('actors.team_id');
      end if;
    end if;
  elsif tg_table_name = 'workspaces' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from public.agents where default_workspace_id = new.id)
        or old.agent_id is not null
        or exists (select 1 from public.ideas where workspace_id = new.id)
        or exists (select 1 from public.agent_runtimes where workspace_id = new.id)
      ) then
      perform app.reject_team_reassignment('workspaces.team_id');
    end if;
  elsif tg_table_name = 'ideas' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from public.ideas where parent_idea_id = new.id)
        or exists (select 1 from public.idea_external_refs where idea_id = new.id)
        or exists (select 1 from public.sessions where idea_id = new.id)
      ) then
      perform app.reject_team_reassignment('ideas.team_id');
    end if;
  elsif tg_table_name = 'sessions' then
    if new.team_id is distinct from old.team_id
      and (
        exists (select 1 from public.session_participants where session_id = new.id)
        or exists (select 1 from public.messages where session_id = new.id)
        or exists (select 1 from public.agent_runtimes where session_id = new.id)
      ) then
      perform app.reject_team_reassignment('sessions.team_id');
    end if;
  else
    raise exception 'app.enforce_parent_integrity is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$$;

create or replace function app.enforce_core_team_integrity()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'team_members' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.member_id),
      'team_members.member_id'
    );
  elsif tg_table_name = 'workspaces' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_member_id),
      'workspaces.created_by_member_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.agent_id),
      'workspaces.agent_id'
    );
  elsif tg_table_name = 'agents' then
    perform app.require_same_team(
      app.actor_team_id(new.id),
      app.actor_team_id(new.created_by_member_id),
      'agents.created_by_member_id'
    );
    perform app.require_same_team(
      app.actor_team_id(new.id),
      app.table_team_id('public.workspaces'::regclass, new.default_workspace_id),
      'agents.default_workspace_id'
    );
  elsif tg_table_name = 'agent_member_access' then
    perform app.require_same_team(
      app.actor_team_id(new.agent_id),
      app.actor_team_id(new.member_id),
      'agent_member_access.member_id'
    );
    perform app.require_same_team(
      app.actor_team_id(new.agent_id),
      app.actor_team_id(new.granted_by_member_id),
      'agent_member_access.granted_by_member_id'
    );
  elsif tg_table_name = 'ideas' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.workspaces'::regclass, new.workspace_id),
      'ideas.workspace_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.ideas'::regclass, new.parent_idea_id),
      'ideas.parent_idea_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_actor_id),
      'ideas.created_by_actor_id'
    );
  elsif tg_table_name = 'idea_external_refs' then
    perform app.require_same_team(
      app.table_team_id('public.ideas'::regclass, new.idea_id),
      app.actor_team_id(new.linked_by_actor_id),
      'idea_external_refs.linked_by_actor_id'
    );
  elsif tg_table_name = 'sessions' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.ideas'::regclass, new.idea_id),
      'sessions.idea_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_actor_id),
      'sessions.created_by_actor_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.primary_agent_id),
      'sessions.primary_agent_id'
    );
  elsif tg_table_name = 'session_participants' then
    perform app.require_same_team(
      app.table_team_id('public.sessions'::regclass, new.session_id),
      app.actor_team_id(new.actor_id),
      'session_participants.actor_id'
    );
  elsif tg_table_name = 'messages' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.sessions'::regclass, new.session_id),
      'messages.session_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.sender_actor_id),
      'messages.sender_actor_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.messages'::regclass, new.reply_to_message_id),
      'messages.reply_to_message_id'
    );
  elsif tg_table_name = 'agent_runtimes' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.agent_id),
      'agent_runtimes.agent_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.sessions'::regclass, new.session_id),
      'agent_runtimes.session_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.workspaces'::regclass, new.workspace_id),
      'agent_runtimes.workspace_id'
    );
  else
    raise exception 'app.enforce_core_team_integrity is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$$;

-- <<< END archived migration: 202604220007_workspace_agent_id.sql

-- >>> BEGIN archived migration: 202604220008_workspaces_unique_fix.sql

alter table public.workspaces
  drop constraint if exists workspaces_team_id_name_key;

alter table public.workspaces
  add constraint workspaces_team_id_agent_id_name_key
  unique (team_id, agent_id, name);

-- <<< END archived migration: 202604220008_workspaces_unique_fix.sql

-- >>> BEGIN archived migration: 202604220009_daemon_invites.sql

create table public.daemon_invites (
  id uuid primary key default gen_random_uuid(),
  invite_token uuid not null unique default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  created_by_member_id uuid not null references public.members(id) on delete restrict,
  expires_at timestamptz not null,
  claimed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_daemon_invites_team_id on public.daemon_invites(team_id);
create index idx_daemon_invites_agent_id on public.daemon_invites(agent_id);
create index idx_daemon_invites_expires_at on public.daemon_invites(expires_at)
  where claimed_at is null;

create trigger set_daemon_invites_updated_at before update on public.daemon_invites
  for each row execute function app.bump_updated_at();

alter table public.daemon_invites enable row level security;

create policy daemon_invites_select_for_team_members on public.daemon_invites
  for select using (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = daemon_invites.team_id
        and tm.member_id = app.current_member_id()
    )
  );

-- <<< END archived migration: 202604220009_daemon_invites.sql

-- >>> BEGIN archived migration: 202604220010_daemon_rpcs.sql

-- Relax agents.status to allow the 'invited' intermediate state used by
-- create_daemon_invite / claim_daemon_invite.
alter table public.agents
  drop constraint if exists agents_status_check;

alter table public.agents
  add constraint agents_status_check
  check (status in ('invited', 'active', 'disabled', 'archived'));

create or replace function public.create_daemon_invite(
  p_team_id uuid,
  p_display_name text
)
returns table (
  invite_token uuid,
  agent_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_caller_member uuid := app.current_member_id();
  v_agent_actor uuid;
  v_agent uuid;
  v_invite record;
begin
  if v_caller_member is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.team_members
    where team_id = p_team_id and member_id = v_caller_member
  ) then
    raise exception 'caller not in team' using errcode = '42501';
  end if;

  insert into public.actors (team_id, actor_type, display_name)
    values (p_team_id, 'agent', p_display_name)
    returning id into v_agent_actor;

  insert into public.agents (id, created_by_member_id, agent_kind, status)
    values (v_agent_actor, v_caller_member, 'claude', 'invited')
    returning id into v_agent;

  insert into public.daemon_invites
    (team_id, agent_id, created_by_member_id, expires_at)
    values (p_team_id, v_agent, v_caller_member, now() + interval '15 minutes')
    returning daemon_invites.invite_token,
              daemon_invites.agent_id,
              daemon_invites.expires_at
      into v_invite;

  return query select v_invite.invite_token, v_invite.agent_id, v_invite.expires_at;
end;
$$;

grant execute on function public.create_daemon_invite(uuid, text) to authenticated;

-- <<< END archived migration: 202604220010_daemon_rpcs.sql

-- >>> BEGIN archived migration: 202604220011_claim_daemon_invite.sql

create or replace function public.claim_daemon_invite(
  p_invite_token uuid
)
returns table (
  agent_id uuid,
  team_id uuid,
  auth_email text,
  auth_password text
)
language plpgsql
security definer
set search_path = public, auth, app
as $$
declare
  v_invite record;
  v_uid uuid;
  v_email text;
  v_password text;
begin
  select * into v_invite from public.daemon_invites
    where invite_token = p_invite_token
    for update;

  if not found then
    raise exception 'invite not found' using errcode = 'P0001';
  end if;
  if v_invite.claimed_at is not null then
    raise exception 'invite already claimed' using errcode = 'P0001';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'invite expired' using errcode = 'P0001';
  end if;

  -- Use a plausible-looking domain. Supabase hosted rejects .local TLDs and
  -- obvious test domains (example.com, localhost) in its anti-abuse filter.
  v_email := format('daemon.%s@amuxd.run', v_invite.agent_id);
  -- pgcrypto lives in the extensions schema on Supabase; qualify to avoid
  -- search_path surprises under SECURITY DEFINER.
  v_password := encode(extensions.gen_random_bytes(24), 'hex');

  insert into auth.users (
    id, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, aud, role,
    created_at, updated_at
  )
  values (
    gen_random_uuid(), v_email,
    extensions.crypt(v_password, extensions.gen_salt('bf')),
    now(),
    jsonb_build_object(
      'team_id', v_invite.team_id,
      'actor_id', v_invite.agent_id,
      'kind', 'daemon'
    ),
    'authenticated', 'authenticated',
    now(), now()
  )
  returning id into v_uid;

  -- GoTrue's password grant looks up the identity row keyed by
  -- (provider='email', provider_id=<email>). Without this, login_with_password
  -- returns 400 invalid_credentials.
  insert into auth.identities (
    id, user_id, provider, provider_id, identity_data,
    last_sign_in_at, created_at, updated_at
  )
  values (
    gen_random_uuid(), v_uid, 'email', v_email,
    jsonb_build_object(
      'sub', v_uid::text,
      'email', v_email,
      'email_verified', true,
      'phone_verified', false
    ),
    now(), now(), now()
  );

  update public.agents set status = 'active' where id = v_invite.agent_id;

  update public.daemon_invites
    set claimed_at = now()
    where invite_token = p_invite_token;

  return query
    select v_invite.agent_id, v_invite.team_id, v_email, v_password;
end;
$$;

grant execute on function public.claim_daemon_invite(uuid) to anon, authenticated;

-- <<< END archived migration: 202604220011_claim_daemon_invite.sql

-- >>> BEGIN archived migration: 202604220012_create_session.sql

create or replace function public.create_session(
  p_primary_agent_id uuid,
  p_idea_id uuid,
  p_mode text,
  p_title text
)
returns uuid
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_caller_member uuid := app.current_member_id();
  v_team uuid;
  v_session uuid;
begin
  if v_caller_member is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select team_id into v_team from public.ideas where id = p_idea_id;
  if v_team is null then
    raise exception 'idea not found' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.team_members
    where team_id = v_team and member_id = v_caller_member
  ) then
    raise exception 'caller not in team' using errcode = '42501';
  end if;

  if app.actor_team_id(p_primary_agent_id) <> v_team then
    raise exception 'agent not in team' using errcode = '42501';
  end if;

  insert into public.sessions
    (team_id, idea_id, created_by_actor_id, primary_agent_id, mode, title)
    values (v_team, p_idea_id, v_caller_member, p_primary_agent_id, p_mode, p_title)
    returning id into v_session;

  insert into public.session_participants (session_id, actor_id) values
    (v_session, v_caller_member),
    (v_session, p_primary_agent_id)
  on conflict (session_id, actor_id) do nothing;

  return v_session;
end;
$$;

grant execute on function public.create_session(uuid, uuid, text, text) to authenticated;

-- <<< END archived migration: 202604220012_create_session.sql

-- >>> BEGIN archived migration: 202604220013_agent_role_rls.sql

-- JWT helpers for the daemon role. raw_app_meta_data is copied into
-- the signed JWT by GoTrue as the 'app_metadata' claim.
create or replace function app.current_jwt_kind() returns text
language sql stable
set search_path = public
as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb)->'app_metadata'->>'kind',
    ''
  );
$$;

create or replace function app.current_jwt_team_id() returns uuid
language sql stable
set search_path = public
as $$
  select nullif(
    (current_setting('request.jwt.claims', true)::jsonb)->'app_metadata'->>'team_id',
    ''
  )::uuid;
$$;

create or replace function app.current_jwt_actor_id() returns uuid
language sql stable
set search_path = public
as $$
  select nullif(
    (current_setting('request.jwt.claims', true)::jsonb)->'app_metadata'->>'actor_id',
    ''
  )::uuid;
$$;

create or replace function app.is_daemon() returns boolean
language sql stable
set search_path = public
as $$
  select app.current_jwt_kind() = 'daemon';
$$;

-- agent_runtimes: daemon may insert/update rows tied to its own JWT identity.
create policy agent_runtimes_daemon_write on public.agent_runtimes
  for insert
  with check (
    app.is_daemon()
    and team_id = app.current_jwt_team_id()
    and agent_id = app.current_jwt_actor_id()
  );

create policy agent_runtimes_daemon_update on public.agent_runtimes
  for update
  using (
    app.is_daemon()
    and team_id = app.current_jwt_team_id()
    and agent_id = app.current_jwt_actor_id()
  )
  with check (
    app.is_daemon()
    and team_id = app.current_jwt_team_id()
    and agent_id = app.current_jwt_actor_id()
  );

-- messages: daemon may insert rows where it is the sender.
create policy messages_daemon_write on public.messages
  for insert
  with check (
    app.is_daemon()
    and team_id = app.current_jwt_team_id()
    and sender_actor_id = app.current_jwt_actor_id()
  );

-- workspaces: daemon may insert/update/delete its own rows.
create policy workspaces_daemon_write on public.workspaces
  for insert
  with check (
    app.is_daemon()
    and team_id = app.current_jwt_team_id()
    and agent_id = app.current_jwt_actor_id()
  );

create policy workspaces_daemon_update on public.workspaces
  for update
  using (
    app.is_daemon()
    and team_id = app.current_jwt_team_id()
    and agent_id = app.current_jwt_actor_id()
  )
  with check (
    app.is_daemon()
    and team_id = app.current_jwt_team_id()
    and agent_id = app.current_jwt_actor_id()
  );

-- agents: daemon may update its own row (status, heartbeat).
create policy agents_daemon_self_update on public.agents
  for update
  using (
    app.is_daemon() and id = app.current_jwt_actor_id()
  )
  with check (
    app.is_daemon() and id = app.current_jwt_actor_id()
  );

-- <<< END archived migration: 202604220013_agent_role_rls.sql

-- >>> BEGIN archived migration: 202604220014_claim_mints_refresh_token.sql

-- Pivot claim_daemon_invite from password-grant to direct refresh-token mint.
--
-- Prior design (password grant) failed on hosted Supabase: GoTrue rejects
-- DB-provisioned users at /auth/v1/token?grant_type=password with
-- invalid_credentials even when email + bcrypt hash + identity row are all
-- set correctly. Root cause appears to be a server-side anti-abuse check we
-- cannot satisfy from the DB.
--
-- New design: insert auth.sessions + auth.refresh_tokens directly and return
-- the token string. The daemon persists it and uses grant_type=refresh_token
-- immediately (which DOES work for DB-provisioned users because it's just a
-- token lookup — no password check).

drop function if exists public.claim_daemon_invite(uuid);

create or replace function public.claim_daemon_invite(
  p_invite_token uuid
)
returns table (
  agent_id uuid,
  team_id uuid,
  refresh_token text
)
language plpgsql
security definer
set search_path = public, auth, app
as $$
declare
  v_invite record;
  v_uid uuid;
  v_session uuid;
  v_email text;
  v_token text;
begin
  select * into v_invite from public.daemon_invites
    where invite_token = p_invite_token
    for update;

  if not found then
    raise exception 'invite not found' using errcode = 'P0001';
  end if;
  if v_invite.claimed_at is not null then
    raise exception 'invite already claimed' using errcode = 'P0001';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'invite expired' using errcode = 'P0001';
  end if;

  v_email := format('daemon.%s@amuxd.run', v_invite.agent_id);
  v_uid := gen_random_uuid();
  v_session := gen_random_uuid();
  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  -- auth.users: no password, no identity — we bypass the email/password
  -- flow entirely. raw_app_meta_data carries the claims RLS checks.
  insert into auth.users (
    id, email, email_confirmed_at,
    raw_app_meta_data, aud, role,
    created_at, updated_at,
    instance_id
  )
  values (
    v_uid, v_email, now(),
    jsonb_build_object(
      'team_id', v_invite.team_id,
      'actor_id', v_invite.agent_id,
      'kind', 'daemon'
    ),
    'authenticated', 'authenticated',
    now(), now(),
    '00000000-0000-0000-0000-000000000000'
  );

  -- Active session paired with the refresh token.
  insert into auth.sessions (id, user_id, aal, created_at, updated_at)
    values (v_session, v_uid, 'aal1', now(), now());

  -- Classic (non-HMAC) refresh token. The project does not use the new
  -- rotating-HMAC scheme (auth.sessions.refresh_token_hmac_key is null for
  -- all existing sessions on this project).
  insert into auth.refresh_tokens (
    token, user_id, session_id, revoked,
    instance_id, created_at, updated_at
  )
  values (
    v_token, v_uid::text, v_session, false,
    '00000000-0000-0000-0000-000000000000', now(), now()
  );

  update public.agents set status = 'active' where id = v_invite.agent_id;

  update public.daemon_invites
    set claimed_at = now()
    where invite_token = p_invite_token;

  return query
    select v_invite.agent_id, v_invite.team_id, v_token;
end;
$$;

grant execute on function public.claim_daemon_invite(uuid) to anon, authenticated;

-- <<< END archived migration: 202604220014_claim_mints_refresh_token.sql

-- >>> BEGIN archived migration: 202604220015_actor_unified_identity.sql

-- 202604220015_actor_unified_identity.sql
--
-- Converge the daemon invite flow (from _0009_.._0014_) onto the unified
-- team_invites model. Move user_id from members to actors, add
-- invited_by_actor_id, rewrite app.* helpers, drop JWT-app_metadata
-- daemon-role infrastructure, expose actor_directory view, add
-- update_actor_last_active heartbeat.
--
-- See docs/superpowers/specs/2026-04-21-actors-supabase-migration-design.md.

begin;

-- ===========================================================================
-- 1. Wipe obsolete dev data. Production runs would require a migration plan
--    for existing daemon agents; not applicable here.
-- ===========================================================================
delete from public.daemon_invites;

-- Agents that only ever existed as invite placeholders go away.
-- Claimed agents (status='active') are kept; their actors row stays, and we
-- backfill actors.user_id in Task 3 from auth.users via the
-- (daemon.*@amuxd.run, app_metadata.actor_id) pair.
delete from public.agents where status = 'invited';

-- The deletion cascades via on delete cascade on actors_id_fk would be nice
-- but members.id / agents.id FKs are not ON DELETE CASCADE by default. Clear
-- the matching actor rows explicitly.
delete from public.actors a
 where a.actor_type = 'agent'
   and not exists (select 1 from public.agents where id = a.id);

-- The daemon auth.users rows will be retained only for agents that are still
-- active; orphan ones get dropped below.
delete from auth.users u
 where u.email like 'daemon.%@amuxd.run'
   and not exists (
     select 1 from public.actors a
     where a.actor_type = 'agent'
       and a.display_name = split_part(u.email, '.', 2)
   );
-- Note: the display_name ↔ email pairing is fragile. Step 3 below re-links
-- surviving daemons via auth.users.raw_app_meta_data->>'actor_id'.

-- ===========================================================================
-- 2. Lift user_id and invited_by_actor_id onto actors
-- ===========================================================================
alter table public.actors
  add column user_id uuid references auth.users(id) on delete set null,
  add column invited_by_actor_id uuid references public.actors(id) on delete set null;

-- Backfill: humans from members.user_id
update public.actors a
   set user_id = m.user_id
  from public.members m
 where m.id = a.id and m.user_id is not null;

-- Backfill: surviving daemons from auth.users.raw_app_meta_data->>'actor_id'
-- (written by _0011_/_0014_ into the JWT claims).
update public.actors a
   set user_id = u.id
  from auth.users u
 where a.actor_type = 'agent'
   and a.id::text = u.raw_app_meta_data->>'actor_id'
   and a.user_id is null;

create unique index actors_team_user_idx
  on public.actors (team_id, user_id)
  where user_id is not null;

-- ===========================================================================
-- 3. Tear down the JWT app_metadata daemon-role infrastructure (from _0013_).
--    RLS for agent writes is re-added in Task 6 using actors.user_id.
-- ===========================================================================
drop policy if exists agent_runtimes_daemon_write  on public.agent_runtimes;
drop policy if exists agent_runtimes_daemon_update on public.agent_runtimes;
drop policy if exists messages_daemon_write        on public.messages;
drop policy if exists workspaces_daemon_write      on public.workspaces;
drop policy if exists workspaces_daemon_update     on public.workspaces;
drop policy if exists agents_daemon_self_update    on public.agents;

drop function if exists app.is_daemon();
drop function if exists app.current_jwt_kind();
drop function if exists app.current_jwt_team_id();
drop function if exists app.current_jwt_actor_id();

-- 4. Drop legacy columns now that actors owns them.
alter table public.members drop column user_id;
alter table public.agents  drop column created_by_member_id;

-- 5. Remove the legacy 'invited' agent status (no rows left after Task 2).
alter table public.agents drop constraint if exists agents_status_check;
alter table public.agents
  add constraint agents_status_check
  check (status in ('active', 'disabled', 'archived'));

-- ===========================================================================
-- 6. Helpers rewritten around actors.user_id
-- ===========================================================================
create or replace function app.current_member_id()
returns uuid language sql stable security definer set search_path = public, auth as $$
  select a.id
    from public.actors a
    join public.members m on m.id = a.id
   where a.user_id = auth.uid() and m.status = 'active'
   order by a.created_at limit 1
$$;

create or replace function app.current_actor_id()
returns uuid language sql stable security definer set search_path = public, auth as $$
  select id from public.actors where user_id = auth.uid()
   order by created_at limit 1
$$;

create or replace function app.current_actor_id_for_team(p_team_id uuid)
returns uuid language sql stable security definer set search_path = public, auth as $$
  select id from public.actors
   where user_id = auth.uid() and team_id = p_team_id
$$;

create or replace function app.is_team_member(target_team_id uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from public.actors
     where user_id = auth.uid() and team_id = target_team_id
  )
$$;

create or replace function app.is_current_agent(p_agent_id uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from public.actors a
     where a.id = p_agent_id
       and a.actor_type = 'agent'
       and a.user_id = auth.uid()
  )
$$;

grant execute on function app.current_actor_id_for_team(uuid) to authenticated;
grant execute on function app.is_current_agent(uuid) to authenticated;

-- 6b. Fix enforce_core_team_integrity: remove agents.created_by_member_id branch
--     (column was dropped above; default_workspace_id check is preserved).
create or replace function app.enforce_core_team_integrity()
returns trigger language plpgsql as $$
begin
  if tg_table_name = 'team_members' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.member_id),
      'team_members.member_id'
    );
  elsif tg_table_name = 'workspaces' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_member_id),
      'workspaces.created_by_member_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.agent_id),
      'workspaces.agent_id'
    );
  elsif tg_table_name = 'agents' then
    -- created_by_member_id was dropped in migration 0015; only workspace check remains.
    perform app.require_same_team(
      app.actor_team_id(new.id),
      app.table_team_id('public.workspaces'::regclass, new.default_workspace_id),
      'agents.default_workspace_id'
    );
  elsif tg_table_name = 'agent_member_access' then
    perform app.require_same_team(
      app.actor_team_id(new.agent_id),
      app.actor_team_id(new.member_id),
      'agent_member_access.member_id'
    );
    perform app.require_same_team(
      app.actor_team_id(new.agent_id),
      app.actor_team_id(new.granted_by_member_id),
      'agent_member_access.granted_by_member_id'
    );
  elsif tg_table_name = 'ideas' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.workspaces'::regclass, new.workspace_id),
      'ideas.workspace_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.ideas'::regclass, new.parent_idea_id),
      'ideas.parent_idea_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_actor_id),
      'ideas.created_by_actor_id'
    );
  elsif tg_table_name = 'idea_external_refs' then
    perform app.require_same_team(
      app.table_team_id('public.ideas'::regclass, new.idea_id),
      app.actor_team_id(new.linked_by_actor_id),
      'idea_external_refs.linked_by_actor_id'
    );
  elsif tg_table_name = 'sessions' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.ideas'::regclass, new.idea_id),
      'sessions.idea_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_actor_id),
      'sessions.created_by_actor_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.primary_agent_id),
      'sessions.primary_agent_id'
    );
  elsif tg_table_name = 'session_participants' then
    perform app.require_same_team(
      app.table_team_id('public.sessions'::regclass, new.session_id),
      app.actor_team_id(new.actor_id),
      'session_participants.actor_id'
    );
  elsif tg_table_name = 'messages' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.sessions'::regclass, new.session_id),
      'messages.session_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.sender_actor_id),
      'messages.sender_actor_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.messages'::regclass, new.reply_to_message_id),
      'messages.reply_to_message_id'
    );
  elsif tg_table_name = 'agent_runtimes' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.agent_id),
      'agent_runtimes.agent_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.sessions'::regclass, new.session_id),
      'agent_runtimes.session_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.workspaces'::regclass, new.workspace_id),
      'agent_runtimes.workspace_id'
    );
  else
    raise exception 'app.enforce_core_team_integrity is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$$;

-- 6d. Rewrite create_team: members.user_id is gone; identity lives on actors.
create or replace function public.create_team(
  p_name text,
  p_slug text default null
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

  return query
  select v_team_id, btrim(p_name), v_slug,
         v_member_id, 'owner'::text,
         v_workspace_id, 'General'::text;
end;
$$;

-- ===========================================================================
-- 7. Agent write RLS, now keyed on actors.user_id via app.is_current_agent
-- ===========================================================================
create policy agent_runtimes_agent_write on public.agent_runtimes
  for insert to authenticated
  with check (
    app.is_current_agent(agent_id)
    and team_id = (select team_id from public.actors where id = agent_id)
  );

create policy agent_runtimes_agent_update on public.agent_runtimes
  for update to authenticated
  using (app.is_current_agent(agent_id))
  with check (app.is_current_agent(agent_id));

create policy messages_agent_write on public.messages
  for insert to authenticated
  with check (
    app.is_current_agent(sender_actor_id)
    and team_id = (select team_id from public.actors where id = sender_actor_id)
  );

create policy workspaces_agent_write on public.workspaces
  for insert to authenticated
  with check (
    app.is_current_agent(agent_id)
    and team_id = (select team_id from public.actors where id = agent_id)
  );

create policy workspaces_agent_update on public.workspaces
  for update to authenticated
  using (app.is_current_agent(agent_id))
  with check (app.is_current_agent(agent_id));

create policy agents_self_update on public.agents
  for update to authenticated
  using (app.is_current_agent(id))
  with check (app.is_current_agent(id));

-- ===========================================================================
-- 8. Drop old daemon invite flow (replaced by team_invites in Task 8)
-- ===========================================================================
drop function if exists public.claim_daemon_invite(uuid);
drop function if exists public.create_daemon_invite(uuid, text);
drop table    if exists public.daemon_invites cascade;

-- ===========================================================================
-- 9. team_invites — unified invite token table
-- ===========================================================================
create table public.team_invites (
  id                    uuid primary key default gen_random_uuid(),
  team_id               uuid not null references public.teams(id) on delete cascade,
  token                 text not null unique,
  kind                  text not null check (kind in ('member','agent')),
  team_role             text check (team_role in ('member','admin')),
  agent_kind            text,
  display_name          text not null,
  invited_by_actor_id   uuid not null references public.actors(id),
  expires_at            timestamptz not null,
  consumed_at           timestamptz,
  consumed_by_actor_id  uuid references public.actors(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint team_invites_kind_fields_check check (
    (kind = 'member' and team_role is not null and agent_kind is null)
    or
    (kind = 'agent'  and team_role is null     and agent_kind is not null)
  )
);

create index team_invites_team_unconsumed_idx
  on public.team_invites (team_id) where consumed_at is null;
create index team_invites_token_unconsumed_idx
  on public.team_invites (token) where consumed_at is null;

create trigger set_team_invites_updated_at
  before update on public.team_invites
  for each row execute function app.bump_updated_at();

alter table public.team_invites enable row level security;

create policy team_invites_select_if_team_member on public.team_invites
  for select to authenticated
  using (app.is_team_member(team_id));

create policy team_invites_insert_via_rpc on public.team_invites
  for insert to authenticated
  with check (
    app.is_team_member(team_id)
    and exists (
      select 1 from public.actors a
       where a.id = invited_by_actor_id
         and a.user_id = auth.uid()
         and a.team_id = team_id
    )
  );

-- ===========================================================================
-- 10. actors: allow self-update of last_active_at
-- ===========================================================================
create policy actors_self_heartbeat on public.actors
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ===========================================================================
-- 11. actor_directory view (flat read surface for iOS)
-- ===========================================================================
create view public.actor_directory
  with (security_invoker = true)
as
select
  a.id, a.team_id, a.actor_type, a.user_id, a.invited_by_actor_id,
  a.display_name, a.last_active_at, a.created_at, a.updated_at,
  m.status      as member_status,
  tm.role       as team_role,
  ag.agent_kind as agent_kind,
  ag.status     as agent_status
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id;

grant select on public.actor_directory to authenticated;

-- ===========================================================================
-- 12. RPC: create_team_invite (unified)
-- ===========================================================================
create or replace function public.create_team_invite(
  p_team_id       uuid,
  p_kind          text,
  p_display_name  text,
  p_team_role     text default null,
  p_agent_kind    text default null,
  p_ttl_seconds   int  default 604800
)
returns table (token text, expires_at timestamptz, deeplink text)
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_actor_id  uuid := app.current_actor_id_for_team(p_team_id);
  v_is_member boolean;
  v_token     text;
  v_expires   timestamptz;
  v_ttl       int;
begin
  if v_actor_id is null then
    raise exception 'create_team_invite requires team membership'
      using errcode = '42501';
  end if;

  select exists (select 1 from public.members where id = v_actor_id)
    into v_is_member;
  if not v_is_member then
    raise exception 'only member actors may create invites'
      using errcode = '42501';
  end if;

  if p_kind = 'member' then
    if coalesce(p_team_role, '') not in ('member','admin') then
      raise exception 'team_role must be member or admin' using errcode = '22023';
    end if;
    if p_agent_kind is not null then
      raise exception 'agent_kind not allowed for member invite' using errcode = '22023';
    end if;
  elsif p_kind = 'agent' then
    if p_agent_kind is null or btrim(p_agent_kind) = '' then
      raise exception 'agent_kind is required for agent invite' using errcode = '22023';
    end if;
    if p_team_role is not null then
      raise exception 'team_role not allowed for agent invite' using errcode = '22023';
    end if;
  else
    raise exception 'kind must be member or agent' using errcode = '22023';
  end if;

  if p_display_name is null or btrim(p_display_name) = '' then
    raise exception 'display_name is required' using errcode = '22023';
  end if;

  v_ttl := greatest(60, least(coalesce(p_ttl_seconds, 604800), 60 * 60 * 24 * 30));
  v_expires := now() + make_interval(secs => v_ttl);
  v_token := replace(replace(replace(
    encode(extensions.gen_random_bytes(24), 'base64'), '+','-'), '/','_'), '=','');

  insert into public.team_invites
    (team_id, token, kind, team_role, agent_kind,
     display_name, invited_by_actor_id, expires_at)
  values
    (p_team_id, v_token, p_kind, p_team_role, p_agent_kind,
     btrim(p_display_name), v_actor_id, v_expires);

  return query
  select v_token, v_expires, format('amux://invite?token=%s', v_token);
end;
$$;

revoke all on function public.create_team_invite(uuid, text, text, text, text, int) from public;
grant execute on function public.create_team_invite(uuid, text, text, text, text, int) to authenticated;

-- ===========================================================================
-- 13. RPC: claim_team_invite (unified; kind branches)
-- ===========================================================================
create or replace function public.claim_team_invite(
  p_token text
)
returns table (
  actor_id      uuid,
  team_id       uuid,
  actor_type    text,
  display_name  text,
  refresh_token text   -- non-null only for kind='agent'
)
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_invite   public.team_invites%rowtype;
  v_user_id  uuid;
  v_actor    uuid;
  v_email    text;
  v_session  uuid;
  v_rt       text := null;
begin
  select * into v_invite
    from public.team_invites where token = p_token
    for update;

  if not found then
    raise exception 'invite not found' using errcode = '23503';
  end if;
  if v_invite.consumed_at is not null then
    raise exception 'invite already consumed' using errcode = '23514';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'invite expired' using errcode = '23514';
  end if;

  if v_invite.kind = 'member' then
    v_user_id := auth.uid();
    if v_user_id is null then
      raise exception 'member claim requires authentication' using errcode = '42501';
    end if;
    if exists (select 1 from public.actors act
                where act.team_id = v_invite.team_id and act.user_id = v_user_id) then
      raise exception 'already a member of this team' using errcode = '23505';
    end if;

    insert into public.actors
      (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
    values
      (v_invite.team_id, 'member', v_user_id,
       v_invite.invited_by_actor_id, v_invite.display_name, now())
    returning id into v_actor;

    insert into public.members (id, status) values (v_actor, 'active');
    insert into public.team_members (team_id, member_id, role)
      values (v_invite.team_id, v_actor, v_invite.team_role);
  else
    -- kind = 'agent': mint an auth user for the daemon in-DB.
    v_user_id := gen_random_uuid();
    v_email   := format('daemon.%s@amuxd.run', v_user_id);
    v_session := gen_random_uuid();
    v_rt      := encode(extensions.gen_random_bytes(24), 'hex');

    insert into auth.users
      (id, email, email_confirmed_at, raw_app_meta_data,
       aud, role, created_at, updated_at, instance_id)
    values
      (v_user_id, v_email, now(), '{}'::jsonb,
       'authenticated', 'authenticated',
       now(), now(), '00000000-0000-0000-0000-000000000000');

    insert into auth.sessions (id, user_id, aal, created_at, updated_at)
    values (v_session, v_user_id, 'aal1', now(), now());

    insert into auth.refresh_tokens
      (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
    values
      (v_rt, v_user_id::text, v_session, false,
       '00000000-0000-0000-0000-000000000000', now(), now());

    insert into public.actors
      (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
    values
      (v_invite.team_id, 'agent', v_user_id,
       v_invite.invited_by_actor_id, v_invite.display_name, now())
    returning id into v_actor;

    insert into public.agents (id, agent_kind, status)
      values (v_actor, v_invite.agent_kind, 'active');

    insert into public.agent_member_access
      (agent_id, member_id, permission_level, granted_by_member_id)
    values
      (v_actor, v_invite.invited_by_actor_id, 'admin',
       v_invite.invited_by_actor_id);
  end if;

  update public.team_invites
     set consumed_at = now(), consumed_by_actor_id = v_actor, updated_at = now()
   where id = v_invite.id;

  return query
  select v_actor, v_invite.team_id, v_invite.kind::text,
         v_invite.display_name, v_rt;
end;
$$;

revoke all on function public.claim_team_invite(text) from public;
-- anon allowed so a daemon without a session can claim via the anon key alone.
grant execute on function public.claim_team_invite(text) to anon, authenticated;

-- ===========================================================================
-- 14. RPC: update_actor_last_active (heartbeat)
-- ===========================================================================
create or replace function public.update_actor_last_active()
returns void language sql security definer set search_path = public, auth as $$
  update public.actors
     set last_active_at = now(), updated_at = now()
   where user_id = auth.uid();
$$;

revoke all on function public.update_actor_last_active() from public;
grant execute on function public.update_actor_last_active() to authenticated;

commit;

-- <<< END archived migration: 202604220015_actor_unified_identity.sql

-- >>> BEGIN archived migration: 202604220020_create_idea_workspace_default.sql

-- Make p_workspace_id optional on create_idea so iOS clients can omit it.
-- PostgREST matches functions by the exact set of JSON keys sent, and Swift's
-- JSONEncoder omits nil fields — without a default, create_idea(p_team_id,
-- p_title, p_description) failed with "could not find the function ... in the
-- schema cache".
--
-- Re-declare with p_workspace_id moved after p_title and given DEFAULT NULL,
-- then drop the old (uuid, uuid, text, text) signature so there is only one
-- overload visible to PostgREST.

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

drop function if exists public.create_idea(uuid, uuid, text, text);

-- <<< END archived migration: 202604220020_create_idea_workspace_default.sql

-- >>> BEGIN archived migration: 202604220021_claim_team_invite_shorter_refresh_token.sql

-- GoTrue v2.188+ rejects refresh tokens whose length doesn't fit its bounds
-- (classic tokens are ~12-22 URL-safe chars on this project). The agent
-- branch of claim_team_invite was inserting 48-hex-char tokens; daemon
-- `init` then failed at the first refresh with
-- "crypto: refresh token length is not valid".
--
-- Fix: mint tokens as base64url(gen_random_bytes(16)) → 22 chars, which
-- matches the live format from GoTrue-issued sessions.

create or replace function public.claim_team_invite(
  p_token text
)
returns table (
  actor_id      uuid,
  team_id       uuid,
  actor_type    text,
  display_name  text,
  refresh_token text
)
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_invite   public.team_invites%rowtype;
  v_user_id  uuid;
  v_actor    uuid;
  v_email    text;
  v_session  uuid;
  v_rt       text := null;
begin
  select * into v_invite
    from public.team_invites where token = p_token
    for update;

  if not found then
    raise exception 'invite not found' using errcode = '23503';
  end if;
  if v_invite.consumed_at is not null then
    raise exception 'invite already consumed' using errcode = '23514';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'invite expired' using errcode = '23514';
  end if;

  if v_invite.kind = 'member' then
    v_user_id := auth.uid();
    if v_user_id is null then
      raise exception 'member claim requires authentication' using errcode = '42501';
    end if;
    if exists (select 1 from public.actors act
                where act.team_id = v_invite.team_id and act.user_id = v_user_id) then
      raise exception 'already a member of this team' using errcode = '23505';
    end if;

    insert into public.actors
      (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
    values
      (v_invite.team_id, 'member', v_user_id,
       v_invite.invited_by_actor_id, v_invite.display_name, now())
    returning id into v_actor;

    insert into public.members (id, status) values (v_actor, 'active');
    insert into public.team_members (team_id, member_id, role)
      values (v_invite.team_id, v_actor, v_invite.team_role);
  else
    v_user_id := gen_random_uuid();
    v_email   := format('daemon.%s@amuxd.run', v_user_id);
    v_session := gen_random_uuid();
    -- 12 lowercase hex chars — matches GoTrue's live refresh-token format
    -- on this project. GoTrue rejects longer values with
    -- "crypto: refresh token length is not valid".
    v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);

    insert into auth.users (
      id, email, email_confirmed_at,
      encrypted_password, confirmation_token, recovery_token,
      email_change_token_new, email_change,
      raw_app_meta_data,
      aud, role, created_at, updated_at, instance_id
    )
    values (
      v_user_id, v_email, now(),
      '', '', '',
      '', '',
      '{}'::jsonb,
      'authenticated', 'authenticated',
      now(), now(), '00000000-0000-0000-0000-000000000000'
    );

    insert into auth.sessions (id, user_id, aal, created_at, updated_at)
    values (v_session, v_user_id, 'aal1', now(), now());

    insert into auth.refresh_tokens
      (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
    values
      (v_rt, v_user_id::text, v_session, false,
       '00000000-0000-0000-0000-000000000000', now(), now());

    -- last_active_at is intentionally null: agent is offline until its
    -- daemon publishes the first heartbeat via update_actor_last_active.
    insert into public.actors
      (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
    values
      (v_invite.team_id, 'agent', v_user_id,
       v_invite.invited_by_actor_id, v_invite.display_name, null)
    returning id into v_actor;

    insert into public.agents (id, agent_kind, status)
      values (v_actor, v_invite.agent_kind, 'active');

    insert into public.agent_member_access
      (agent_id, member_id, permission_level, granted_by_member_id)
    values
      (v_actor, v_invite.invited_by_actor_id, 'admin',
       v_invite.invited_by_actor_id);
  end if;

  update public.team_invites
     set consumed_at = now(), consumed_by_actor_id = v_actor, updated_at = now()
   where id = v_invite.id;

  return query
  select v_actor, v_invite.team_id, v_invite.kind::text,
         v_invite.display_name, v_rt;
end;
$$;

-- <<< END archived migration: 202604220021_claim_team_invite_shorter_refresh_token.sql

-- >>> BEGIN archived migration: 202604220022_remove_team_actor_rpc.sql

-- Remove an actor (member or agent) from their team. Owners and admins of
-- the actor's team may call this. Cascades: team_members row is deleted,
-- members/agents detail row is deleted, the actor row is deleted, and any
-- agent_member_access rows pointing at the actor go too. Refuses to remove
-- the caller's own actor to prevent accidental self-eviction.

create or replace function public.remove_team_actor(p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth, app
as $$
declare
  v_team_id uuid;
  v_actor_type text;
  v_caller_actor uuid := app.current_actor_id();
begin
  if v_caller_actor is null then
    raise exception 'remove_team_actor requires authentication'
      using errcode = '42501';
  end if;

  select team_id, actor_type
    into v_team_id, v_actor_type
  from public.actors
  where id = p_actor_id;

  if v_team_id is null then
    raise exception 'actor not found'
      using errcode = '23503';
  end if;

  if v_caller_actor = p_actor_id then
    raise exception 'cannot remove your own actor'
      using errcode = '42501';
  end if;

  if app.current_team_role(v_team_id) not in ('owner', 'admin') then
    raise exception 'remove_team_actor requires owner or admin'
      using errcode = '42501';
  end if;

  if v_actor_type = 'member' and exists (
    select 1 from public.team_members
     where team_id = v_team_id and member_id = p_actor_id and role = 'owner'
  ) then
    if (select count(*) from public.team_members
          where team_id = v_team_id and role = 'owner') <= 1 then
      raise exception 'cannot remove the last owner'
        using errcode = '23514';
    end if;
  end if;

  delete from public.agent_member_access
   where agent_id = p_actor_id or member_id = p_actor_id;

  delete from public.team_members where member_id = p_actor_id;

  if v_actor_type = 'member' then
    delete from public.members where id = p_actor_id;
  else
    delete from public.agents where id = p_actor_id;
  end if;

  delete from public.actors where id = p_actor_id;
end;
$$;

revoke all on function public.remove_team_actor(uuid) from public;
grant execute on function public.remove_team_actor(uuid) to authenticated;

-- <<< END archived migration: 202604220022_remove_team_actor_rpc.sql

-- >>> BEGIN archived migration: 202604220023_actor_fks_on_delete_set_null.sql

-- Allow removing an actor without wiping history. Columns that record who
-- did what (created_by, sender, invited_by, …) drop their NOT NULL and
-- become nullable with ON DELETE SET NULL, so deletion preserves the row
-- but forgets the actor.

alter table public.team_invites alter column invited_by_actor_id drop not null;
alter table public.messages alter column sender_actor_id drop not null;
alter table public.sessions alter column created_by_actor_id drop not null;
alter table public.ideas alter column created_by_actor_id drop not null;
alter table public.idea_external_refs alter column linked_by_actor_id drop not null;

alter table public.team_invites
  drop constraint team_invites_consumed_by_actor_id_fkey;
alter table public.team_invites
  add constraint team_invites_consumed_by_actor_id_fkey
    foreign key (consumed_by_actor_id) references public.actors(id)
    on delete set null;

alter table public.team_invites
  drop constraint team_invites_invited_by_actor_id_fkey;
alter table public.team_invites
  add constraint team_invites_invited_by_actor_id_fkey
    foreign key (invited_by_actor_id) references public.actors(id)
    on delete set null;

alter table public.messages
  drop constraint messages_sender_actor_id_fkey;
alter table public.messages
  add constraint messages_sender_actor_id_fkey
    foreign key (sender_actor_id) references public.actors(id)
    on delete set null;

alter table public.sessions
  drop constraint sessions_created_by_actor_id_fkey;
alter table public.sessions
  add constraint sessions_created_by_actor_id_fkey
    foreign key (created_by_actor_id) references public.actors(id)
    on delete set null;

alter table public.ideas
  drop constraint ideas_created_by_actor_id_fkey;
alter table public.ideas
  add constraint ideas_created_by_actor_id_fkey
    foreign key (created_by_actor_id) references public.actors(id)
    on delete set null;

alter table public.idea_external_refs
  drop constraint idea_external_refs_linked_by_actor_id_fkey;
alter table public.idea_external_refs
  add constraint idea_external_refs_linked_by_actor_id_fkey
    foreign key (linked_by_actor_id) references public.actors(id)
    on delete set null;

-- <<< END archived migration: 202604220023_actor_fks_on_delete_set_null.sql

-- >>> BEGIN archived migration: 202604220024_agents_device_id.sql

-- `device_id` is the daemon's MQTT device identifier — the UUID from
-- daemon.toml [device].id. It's a property of the daemon (= agent actor
-- with agent_kind='daemon'), not a per-session runtime detail.
-- iOS consumes this to route MQTT publishes at `amux/{actor_id}/…`.
alter table public.agents add column if not exists device_id text;

create index if not exists agents_device_id_idx on public.agents(device_id);

-- <<< END archived migration: 202604220024_agents_device_id.sql

-- >>> BEGIN archived migration: 202604220025_team_invite_mqtt_deeplink.sql

create or replace function public.create_team_invite(
  p_team_id       uuid,
  p_kind          text,
  p_display_name  text,
  p_team_role     text default null,
  p_agent_kind    text default null,
  p_ttl_seconds   int  default 604800
)
returns table (token text, expires_at timestamptz, deeplink text)
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_actor_id  uuid := app.current_actor_id_for_team(p_team_id);
  v_is_member boolean;
  v_token     text;
  v_expires   timestamptz;
  v_ttl       int;
  v_broker    text := 'mqtts://ai.ucar.cc:8883';
  v_username  text := 'teamclaw';
  v_password  text := 'teamclaw2026';
begin
  if v_actor_id is null then
    raise exception 'create_team_invite requires team membership'
      using errcode = '42501';
  end if;

  select exists (select 1 from public.members where id = v_actor_id)
    into v_is_member;
  if not v_is_member then
    raise exception 'only member actors may create invites'
      using errcode = '42501';
  end if;

  if p_kind = 'member' then
    if coalesce(p_team_role, '') not in ('member','admin') then
      raise exception 'team_role must be member or admin' using errcode = '22023';
    end if;
    if p_agent_kind is not null then
      raise exception 'agent_kind not allowed for member invite' using errcode = '22023';
    end if;
  elsif p_kind = 'agent' then
    if p_agent_kind is null or btrim(p_agent_kind) = '' then
      raise exception 'agent_kind is required for agent invite' using errcode = '22023';
    end if;
    if p_team_role is not null then
      raise exception 'team_role not allowed for agent invite' using errcode = '22023';
    end if;
  else
    raise exception 'kind must be member or agent' using errcode = '22023';
  end if;

  if p_display_name is null or btrim(p_display_name) = '' then
    raise exception 'display_name is required' using errcode = '22023';
  end if;

  v_ttl := greatest(60, least(coalesce(p_ttl_seconds, 604800), 60 * 60 * 24 * 30));
  v_expires := now() + make_interval(secs => v_ttl);
  v_token := replace(replace(replace(
    encode(extensions.gen_random_bytes(24), 'base64'), '+','-'), '/','_'), '=','');

  insert into public.team_invites
    (team_id, token, kind, team_role, agent_kind,
     display_name, invited_by_actor_id, expires_at)
  values
    (p_team_id, v_token, p_kind, p_team_role, p_agent_kind,
     btrim(p_display_name), v_actor_id, v_expires);

  return query
  select
    v_token,
    v_expires,
    format(
      'amux://invite?token=%s&broker=%s&username=%s&password=%s',
      v_token,
      v_broker,
      v_username,
      v_password
    );
end;
$$;

-- <<< END archived migration: 202604220025_team_invite_mqtt_deeplink.sql

-- >>> BEGIN archived migration: 202604220026_check_agent_permission.sql

-- Daemon-side permission lookup. Called by amuxd over the REST PostgREST
-- bridge: given the daemon's own agent actor id and the iOS caller's
-- Supabase actor id, returns `agent_member_access.permission_level`
-- ('admin' | 'write' | 'view') or NULL if there is no grant.

create or replace function public.check_agent_permission(
  p_agent_id uuid,
  p_actor_id uuid
) returns text
language sql security definer set search_path = public
as $$
  select ama.permission_level
    from public.agent_member_access ama
   where ama.agent_id = p_agent_id and ama.member_id = p_actor_id
   limit 1;
$$;

revoke all on function public.check_agent_permission(uuid, uuid) from public;
grant execute on function public.check_agent_permission(uuid, uuid) to authenticated;

-- <<< END archived migration: 202604220026_check_agent_permission.sql

-- >>> BEGIN archived migration: 202604220027_agent_runtimes_unique_agent_backend.sql

-- daemon upserts agent_runtimes with `on_conflict=agent_id,backend_session_id`.
-- That needs a matching unique index. `backend_session_id` is nullable, and
-- we want NULLs treated as equal so repeated inserts for a legacy/unknown
-- backend still collide on the agent row.
create unique index if not exists agent_runtimes_agent_backend_uniq
  on public.agent_runtimes(agent_id, backend_session_id)
  nulls not distinct;

-- <<< END archived migration: 202604220027_agent_runtimes_unique_agent_backend.sql

-- >>> BEGIN archived migration: 202604220028_agent_runtimes_session_id_nullable.sql

-- daemon upserts an `agent_runtimes` row the moment an agent spawns, which
-- can be before any collab session is wired up (e.g. session-less one-shots
-- or legacy MQTT-first flows). Relax the NOT NULL so the row can live
-- without a session until one is attached.
alter table public.agent_runtimes alter column session_id drop not null;

-- <<< END archived migration: 202604220028_agent_runtimes_session_id_nullable.sql

-- >>> BEGIN archived migration: 202604220029_team_invites_target_actor_reinvite.sql

-- Re-invite support: `create_team_invite` can now bind a fresh invite to an
-- existing agent actor via `p_target_actor_id`. `claim_team_invite`
-- rotates that actor's Supabase credentials (new auth.users / refresh
-- token) in place instead of minting a second actor row.

alter table public.team_invites
  add column if not exists target_actor_id uuid
    references public.actors(id) on delete cascade;

create or replace function public.create_team_invite(
  p_team_id uuid,
  p_kind text,
  p_display_name text,
  p_team_role text default null,
  p_agent_kind text default null,
  p_ttl_seconds int default 604800,
  p_target_actor_id uuid default null
)
returns table (
  token text,
  expires_at timestamptz,
  deeplink text
)
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_caller uuid := app.current_actor_id_for_team(p_team_id);
  v_token  text := translate(
                     encode(extensions.gen_random_bytes(24), 'base64'),
                     '+/=', '-_0'
                   );
  v_expires timestamptz := now() + make_interval(secs => greatest(60, p_ttl_seconds));
  v_kind    text;
  v_role    text;
  v_target  public.actors%rowtype;
begin
  if v_caller is null then
    raise exception 'create_team_invite requires team membership'
      using errcode = '42501';
  end if;

  v_kind := lower(coalesce(p_kind, ''));
  if v_kind not in ('member','agent') then
    raise exception 'p_kind must be member or agent' using errcode = '22023';
  end if;

  if v_kind = 'member' then
    if p_team_role is null or btrim(p_team_role) = '' then
      raise exception 'member invites require p_team_role' using errcode = '22023';
    end if;
    v_role := lower(p_team_role);
    if v_role not in ('owner','admin','member') then
      raise exception 'team_role must be owner/admin/member' using errcode = '22023';
    end if;
    if p_target_actor_id is not null then
      raise exception 'p_target_actor_id is only valid for agent invites'
        using errcode = '22023';
    end if;
  else
    if p_agent_kind is null or btrim(p_agent_kind) = '' then
      raise exception 'agent invites require p_agent_kind' using errcode = '22023';
    end if;
    if p_target_actor_id is not null then
      select * into v_target from public.actors where id = p_target_actor_id;
      if not found then
        raise exception 'target actor not found' using errcode = '23503';
      end if;
      if v_target.team_id <> p_team_id then
        raise exception 'target actor belongs to a different team'
          using errcode = '23514';
      end if;
      if v_target.actor_type <> 'agent' then
        raise exception 'target actor must be an agent' using errcode = '22023';
      end if;
    end if;
  end if;

  insert into public.team_invites (
    team_id, kind, display_name, team_role, agent_kind,
    invited_by_actor_id, token, expires_at, target_actor_id
  )
  values (
    p_team_id, v_kind, btrim(p_display_name), v_role, p_agent_kind,
    v_caller, v_token, v_expires, p_target_actor_id
  );

  return query
  select v_token,
         v_expires,
         format('amux://invite?token=%s', v_token);
end;
$$;

revoke all on function public.create_team_invite(uuid, text, text, text, text, int, uuid) from public;
grant execute on function public.create_team_invite(uuid, text, text, text, text, int, uuid) to authenticated;
drop function if exists public.create_team_invite(uuid, text, text, text, text, int);

create or replace function public.claim_team_invite(
  p_token text
)
returns table (
  actor_id      uuid,
  team_id       uuid,
  actor_type    text,
  display_name  text,
  refresh_token text
)
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_invite   public.team_invites%rowtype;
  v_user_id  uuid;
  v_actor    uuid;
  v_email    text;
  v_session  uuid;
  v_rt       text := null;
  v_old_user uuid;
begin
  select * into v_invite
    from public.team_invites where token = p_token
    for update;

  if not found then
    raise exception 'invite not found' using errcode = '23503';
  end if;
  if v_invite.consumed_at is not null then
    raise exception 'invite already consumed' using errcode = '23514';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'invite expired' using errcode = '23514';
  end if;

  if v_invite.kind = 'member' then
    v_user_id := auth.uid();
    if v_user_id is null then
      raise exception 'member claim requires authentication' using errcode = '42501';
    end if;
    if exists (select 1 from public.actors act
                where act.team_id = v_invite.team_id and act.user_id = v_user_id) then
      raise exception 'already a member of this team' using errcode = '23505';
    end if;

    insert into public.actors
      (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
    values
      (v_invite.team_id, 'member', v_user_id,
       v_invite.invited_by_actor_id, v_invite.display_name, now())
    returning id into v_actor;

    insert into public.members (id, status) values (v_actor, 'active');
    insert into public.team_members (team_id, member_id, role)
      values (v_invite.team_id, v_actor, v_invite.team_role);
  else
    v_user_id := gen_random_uuid();
    v_email   := format('daemon.%s@amuxd.run', v_user_id);
    v_session := gen_random_uuid();
    v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);

    insert into auth.users (
      id, email, email_confirmed_at,
      encrypted_password, confirmation_token, recovery_token,
      email_change_token_new, email_change,
      raw_app_meta_data,
      aud, role, created_at, updated_at, instance_id
    )
    values (
      v_user_id, v_email, now(),
      '', '', '',
      '', '',
      '{}'::jsonb,
      'authenticated', 'authenticated',
      now(), now(), '00000000-0000-0000-0000-000000000000'
    );

    insert into auth.sessions (id, user_id, aal, created_at, updated_at)
    values (v_session, v_user_id, 'aal1', now(), now());

    insert into auth.refresh_tokens
      (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
    values
      (v_rt, v_user_id::text, v_session, false,
       '00000000-0000-0000-0000-000000000000', now(), now());

    if v_invite.target_actor_id is not null then
      select user_id into v_old_user from public.actors where id = v_invite.target_actor_id;
      update public.actors
         set user_id = v_user_id,
             invited_by_actor_id = v_invite.invited_by_actor_id,
             last_active_at = null,
             updated_at = now()
       where id = v_invite.target_actor_id;
      v_actor := v_invite.target_actor_id;

      if v_old_user is not null then
        delete from auth.users where id = v_old_user;
      end if;
    else
      insert into public.actors
        (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values
        (v_invite.team_id, 'agent', v_user_id,
         v_invite.invited_by_actor_id, v_invite.display_name, null)
      returning id into v_actor;

      insert into public.agents (id, agent_kind, status)
        values (v_actor, v_invite.agent_kind, 'active');

      insert into public.agent_member_access
        (agent_id, member_id, permission_level, granted_by_member_id)
      values
        (v_actor, v_invite.invited_by_actor_id, 'admin',
         v_invite.invited_by_actor_id);
    end if;
  end if;

  update public.team_invites
     set consumed_at = now(), consumed_by_actor_id = v_actor, updated_at = now()
   where id = v_invite.id;

  return query
  select v_actor, v_invite.team_id, v_invite.kind::text,
         v_invite.display_name, v_rt;
end;
$$;

-- <<< END archived migration: 202604220029_team_invites_target_actor_reinvite.sql

-- >>> BEGIN archived migration: 202604230001_sessions_idea_id_nullable.sql

alter table public.sessions
  drop constraint if exists sessions_idea_id_fkey;

alter table public.sessions
  alter column idea_id drop not null;

alter table public.sessions
  add constraint sessions_idea_id_fkey
  foreign key (idea_id) references public.ideas(id) on delete set null;

create or replace function public.create_session(
  p_primary_agent_id uuid,
  p_idea_id uuid,
  p_mode text,
  p_title text
)
returns uuid
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_caller_member uuid := app.current_member_id();
  v_team uuid;
  v_session uuid;
begin
  if v_caller_member is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idea_id is not null then
    select team_id into v_team from public.ideas where id = p_idea_id;
    if v_team is null then
      raise exception 'idea not found' using errcode = 'P0001';
    end if;
  else
    v_team := app.actor_team_id(p_primary_agent_id);
  end if;

  if v_team is null then
    raise exception 'agent not in team' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.team_members
    where team_id = v_team and member_id = v_caller_member
  ) then
    raise exception 'caller not in team' using errcode = '42501';
  end if;

  if app.actor_team_id(p_primary_agent_id) <> v_team then
    raise exception 'agent not in team' using errcode = '42501';
  end if;

  insert into public.sessions
    (team_id, idea_id, created_by_actor_id, primary_agent_id, mode, title)
    values (v_team, p_idea_id, v_caller_member, p_primary_agent_id, p_mode, p_title)
    returning id into v_session;

  insert into public.session_participants (session_id, actor_id) values
    (v_session, v_caller_member),
    (v_session, p_primary_agent_id)
  on conflict (session_id, actor_id) do nothing;

  return v_session;
end;
$$;


-- <<< END archived migration: 202604230001_sessions_idea_id_nullable.sql

-- >>> BEGIN archived migration: 202604230002_session_participants_creator_bootstrap_rls.sql

drop policy if exists session_participants_insert_if_team_member on public.session_participants;

create policy session_participants_insert_if_team_member on public.session_participants
for insert to authenticated with check (
  exists (
    select 1
    from public.sessions s
    where s.id = session_participants.session_id
      and app.is_team_member(s.team_id)
      and (
        s.created_by_actor_id = app.current_actor_id()
        or app.is_session_participant(session_participants.session_id)
      )
  )
);

-- <<< END archived migration: 202604230002_session_participants_creator_bootstrap_rls.sql

-- >>> BEGIN archived migration: 202604230003_agent_runtimes_idle_status.sql

alter table public.agent_runtimes
  drop constraint if exists agent_runtimes_status_check;

alter table public.agent_runtimes
  add constraint agent_runtimes_status_check
  check (status in ('starting', 'running', 'idle', 'stopped', 'failed'));

-- <<< END archived migration: 202604230003_agent_runtimes_idle_status.sql

-- >>> BEGIN archived migration: 202604240001_access_token_hook.sql

-- Supabase Custom Access Token Hook: injects MQTT-ready claims into every JWT.
-- See docs/specs/2026-04-24-supabase-access-token-hook.md for the design.

-- --------------------------------------------------------------------------
-- Index: hook queries actors by user_id on every token issuance.
-- The existing actors_team_user_idx is composite (team_id, user_id) and
-- cannot efficiently serve user_id-only lookups.
-- --------------------------------------------------------------------------
create index if not exists idx_actors_user_id
  on public.actors (user_id)
  where user_id is not null;

-- --------------------------------------------------------------------------
-- Rule catalog. Pure function; edit this (in a new migration) to change the
-- ACL shape. Unknown actor_type returns zero rows.
-- --------------------------------------------------------------------------
create or replace function public.amux_acl_rules_for(
  p_team  uuid,
  p_actor uuid,
  p_type  text
) returns table (action text, topic text)
language sql
immutable
set search_path = public
as $$
  -- Member (iOS human): team-wide read, team-wide command/RPC publish.
  select action, topic
    from (values
      ('sub', format('amux/%s/user/%s/notify',              p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/+/state',              p_team)),
      ('sub', format('amux/%s/+/runtime/+/state',    p_team)),
      ('sub', format('amux/%s/+/runtime/+/events',   p_team)),
      ('sub', format('amux/%s/+/rpc/res',            p_team)),
      ('pub', format('amux/%s/+/rpc/req',            p_team)),
      ('pub', format('amux/%s/+/runtime/+/commands', p_team))
    ) as r(action, topic)
   where p_type = 'member'

  union all

  -- Agent (daemon): publish its own device-scoped state, subscribe its own
  -- inbox; pub rpc/res is scoped to its team (in-team RPC only).
  select action, topic
    from (values
      ('pub', format('amux/%s/%s/state',             p_team, p_actor)),
      ('pub', format('amux/%s/%s/runtime/+/state',   p_team, p_actor)),
      ('pub', format('amux/%s/%s/runtime/+/events',  p_team, p_actor)),
      ('pub', format('amux/%s/%s/notify',            p_team, p_actor)),
      ('pub', format('amux/%s/+/rpc/res',            p_team)),
      ('pub', format('amux/%s/session/+/live',              p_team)),
      ('pub', format('amux/%s/user/+/notify',               p_team)),
      ('sub', format('amux/%s/%s/runtime/+/commands',p_team, p_actor)),
      ('sub', format('amux/%s/%s/rpc/req',           p_team, p_actor)),
      ('sub', format('amux/%s/%s/notify',            p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/user/%s/notify',              p_team, p_actor))
    ) as r(action, topic)
   where p_type = 'agent';
$$;

-- --------------------------------------------------------------------------
-- Custom Access Token Hook. Supabase GoTrue calls this on every sign-in and
-- every refresh_token exchange. Contract:
--   input:  jsonb { "user_id": uuid|null, "claims": jsonb, ... }
--   output: jsonb { "claims": <merged claims> }  -- OR the untouched event
--                                                   when there is nothing to do.
-- This function MUST NOT raise on realistic input; a hook error causes every
-- auth call to fail with HTTP 500. All edge cases return sane defaults.
-- --------------------------------------------------------------------------
create or replace function public.amux_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_user_id     uuid;
  v_claims      jsonb;
  v_memberships jsonb;
  v_acl         jsonb;
begin
  v_user_id := nullif(event->>'user_id','')::uuid;

  if v_user_id is null then
    return event;
  end if;

  v_claims := coalesce(event->'claims', '{}'::jsonb);

  -- Memberships: one row per actor this user owns.
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'team_id',    a.team_id::text,
      'actor_id',   a.id::text,
      'actor_type', a.actor_type
    ) order by a.team_id, a.id),
    '[]'::jsonb
  )
    into v_memberships
    from public.actors a
   where a.user_id = v_user_id;

  -- ACL: flatten every actor's rule set, terminate with a deny-all.
  with expanded as (
    select jsonb_build_object(
             'permission', 'allow',
             'action',     r.action,
             'topic',      r.topic
           ) as rule
      from public.actors a,
           lateral public.amux_acl_rules_for(a.team_id, a.id, a.actor_type) r
     where a.user_id = v_user_id
  )
  select coalesce(jsonb_agg(rule), '[]'::jsonb)
           || jsonb_build_array(jsonb_build_object(
                'permission','deny','action','all','topic','#'
              ))
    into v_acl
    from expanded;

  -- Merge. Preserve existing claims; acl at top level; memberships under
  -- app_metadata (merged with whatever GoTrue already put there).
  v_claims := v_claims
    || jsonb_build_object('acl', v_acl)
    || jsonb_build_object(
         'app_metadata',
         coalesce(v_claims->'app_metadata', '{}'::jsonb)
           || jsonb_build_object('memberships', v_memberships)
       );

  return jsonb_build_object('claims', v_claims);
exception
  when others then
    return event;
end;
$$;

-- --------------------------------------------------------------------------
-- Permissions. supabase_auth_admin is the role GoTrue uses to call hooks.
-- --------------------------------------------------------------------------
revoke execute on function public.amux_access_token_hook(jsonb)         from public;
revoke execute on function public.amux_acl_rules_for(uuid, uuid, text)  from public;

grant  execute on function public.amux_access_token_hook(jsonb)         to supabase_auth_admin;
grant  execute on function public.amux_acl_rules_for(uuid, uuid, text)  to supabase_auth_admin;

-- <<< END archived migration: 202604240001_access_token_hook.sql

-- >>> BEGIN archived migration: 202604240002_revoke_acl_rules_for_anon_authenticated.sql

-- The initial access-token-hook migration revoked execute from `public` only.
-- The spec required revoking from `public, anon, authenticated` — the two
-- direct grants made by Supabase at role creation were not stripped, leaving
-- `amux_acl_rules_for` callable via PostgREST by any authenticated iOS user
-- (and anonymous callers with the anon key).
--
-- The function does not grant MQTT access (EMQX validates JWT, not PostgREST),
-- but leaking the rule structure is both a spec violation and unnecessary
-- attack surface.
--
-- The hook itself (`amux_access_token_hook`) already has no anon/authenticated
-- grant — only `supabase_auth_admin` can call it — so no fix needed there.

revoke execute on function public.amux_acl_rules_for(uuid, uuid, text)
  from anon, authenticated;

-- <<< END archived migration: 202604240002_revoke_acl_rules_for_anon_authenticated.sql

-- >>> BEGIN archived migration: 202604270001_messages_kind_agent_reply.sql

alter table public.messages
  drop constraint if exists messages_kind_check;

alter table public.messages
  add constraint messages_kind_check
  check (kind in ('text', 'system', 'idea_event', 'agent_reply'));

-- <<< END archived migration: 202604270001_messages_kind_agent_reply.sql

-- >>> BEGIN archived migration: 202604270002_member_pub_session_live.sql

-- Members (iOS humans) need PUB on amux/{team}/session/+/live so user
-- messages reach the daemon's subscription. Without this, iOS sendMessage
-- gets a PUBACK from EMQX (per its default behavior on ACL-denied
-- publishes) but the broker silently drops the message before fanning
-- out to subscribers, so the daemon never sees second-and-later user
-- messages on a session.
--
-- Symptom that led here (2026-04-27): first user message in a fresh
-- collab session got an agent reply, every subsequent message hung
-- forever. The first message worked only because NewSessionSheet's
-- runtimeStartRpc path delivers the prompt as `initial_prompt` over
-- the RPC channel — completely bypassing session/live. As soon as iOS
-- relied on session/live for the next user message, the publish died
-- at the broker.

create or replace function public.amux_acl_rules_for(
  p_team  uuid,
  p_actor uuid,
  p_type  text
) returns table (action text, topic text)
language sql
immutable
set search_path = public
as $$
  -- Member (iOS human): team-wide read, team-wide command/RPC publish,
  -- plus PUB on session/live so outgoing user messages can reach the
  -- daemon and other team members subscribed to that session.
  select action, topic
    from (values
      ('sub', format('amux/%s/user/%s/notify',              p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('pub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/+/state',              p_team)),
      ('sub', format('amux/%s/+/runtime/+/state',    p_team)),
      ('sub', format('amux/%s/+/runtime/+/events',   p_team)),
      ('sub', format('amux/%s/+/rpc/res',            p_team)),
      ('pub', format('amux/%s/+/rpc/req',            p_team)),
      ('pub', format('amux/%s/+/runtime/+/commands', p_team))
    ) as r(action, topic)
   where p_type = 'member'

  union all

  -- Agent (daemon): unchanged.
  select action, topic
    from (values
      ('pub', format('amux/%s/%s/state',             p_team, p_actor)),
      ('pub', format('amux/%s/%s/runtime/+/state',   p_team, p_actor)),
      ('pub', format('amux/%s/%s/runtime/+/events',  p_team, p_actor)),
      ('pub', format('amux/%s/%s/notify',            p_team, p_actor)),
      ('pub', format('amux/%s/+/rpc/res',            p_team)),
      ('pub', format('amux/%s/session/+/live',              p_team)),
      ('pub', format('amux/%s/user/+/notify',               p_team)),
      ('sub', format('amux/%s/%s/runtime/+/commands',p_team, p_actor)),
      ('sub', format('amux/%s/%s/rpc/req',           p_team, p_actor)),
      ('sub', format('amux/%s/%s/notify',            p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/user/%s/notify',              p_team, p_actor))
    ) as r(action, topic)
   where p_type = 'agent';
$$;

revoke execute on function public.amux_acl_rules_for(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.amux_acl_rules_for(uuid, uuid, text) to supabase_auth_admin;

-- <<< END archived migration: 202604270002_member_pub_session_live.sql

-- >>> BEGIN archived migration: 202604280001_session_last_message_trigger.sql

-- Bumps sessions.last_message_preview / last_message_at when a new
-- message lands so iOS / clients can render a session preview without
-- the daemon having to issue a separate UPDATE. Gates on created_at so
-- a late-arriving older row can't regress a fresher preview.

CREATE OR REPLACE FUNCTION app.bump_session_last_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.sessions
  SET last_message_preview = LEFT(COALESCE(NEW.content, ''), 140),
      last_message_at = NEW.created_at
  WHERE id = NEW.session_id
    AND (last_message_at IS NULL OR last_message_at <= NEW.created_at);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bump_session_last_message ON public.messages;

CREATE TRIGGER bump_session_last_message
AFTER INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION app.bump_session_last_message();

-- <<< END archived migration: 202604280001_session_last_message_trigger.sql

-- >>> BEGIN archived migration: 202604290001_agent_runtimes_runtime_id.sql

-- Daemon's MQTT 8-char runtime id, the segment used in
-- `amux/{team}/device/{device}/runtime/{runtime_id}/state`. Distinct from
-- backend_session_id (the 36-char ACP session id used by the daemon to
-- resume a Claude Code session). iOS bridges Supabase agent_runtimes to
-- the live MQTT-published Runtime row by this column — using
-- backend_session_id is wrong because the topic segment is 8-char.
ALTER TABLE public.agent_runtimes
  ADD COLUMN IF NOT EXISTS runtime_id text;

COMMENT ON COLUMN public.agent_runtimes.runtime_id
  IS 'Daemon-side 8-char runtime id used as the segment in MQTT topic amux/{team}/device/{device}/runtime/{runtime_id}/state. iOS bridges Supabase agent_runtimes to the live MQTT Runtime row by this column.';

CREATE INDEX IF NOT EXISTS agent_runtimes_runtime_id_idx
  ON public.agent_runtimes (runtime_id);

-- <<< END archived migration: 202604290001_agent_runtimes_runtime_id.sql

-- >>> BEGIN archived migration: 202605060001_sessions_select_only_participants.sql

-- The original sessions_select_if_team_member policy let any team member
-- read every session row in the team. The data model already has a
-- participant concept (session_participants table + app.is_session_participant
-- helper) and message rows were already gated through that helper, but
-- session rows themselves leaked: a freshly-joined member could browse
-- every prior session's title, summary, and last_message_preview by
-- listing sessions for the team.
--
-- Tighten the SELECT policy: a session row is only visible if the caller
-- is the creator, the primary agent, or listed in session_participants.
-- Insert/update policies are unchanged — they already require team
-- membership and the create_session RPC seeds session_participants for
-- both the caller and the primary agent, so existing sessions retain
-- visibility for the people who were actually in them.

drop policy if exists sessions_select_if_team_member on public.sessions;

create policy sessions_select_if_participant_or_creator on public.sessions
for select to authenticated using (
  app.is_team_member(team_id)
  and (
    created_by_actor_id = app.current_actor_id()
    or primary_agent_id = app.current_actor_id()
    or exists (
      select 1
      from public.session_participants sp
      where sp.session_id = sessions.id
        and sp.actor_id = app.current_actor_id()
    )
  )
);

-- <<< END archived migration: 202605060001_sessions_select_only_participants.sql

-- >>> BEGIN archived migration: 202605070001_sessions_select_use_security_definer_helper.sql

-- The sessions SELECT policy added in 202605060001 inlined an EXISTS into
-- session_participants. session_participants's own SELECT policy in turn
-- EXISTS-back into sessions, so any insert/update/select that traverses
-- both tables triggered Postgres's "infinite recursion detected" check —
-- in particular, INSERTing into session_participants right after creating
-- a session (which is exactly what the iOS NewSessionSheet does on every
-- session create).
--
-- Replace the inline EXISTS with `app.is_session_participant(id)`. That
-- helper is SECURITY DEFINER and queries both tables without re-entering
-- the RLS rewriter, breaking the cycle. Visibility semantics are
-- unchanged: a session row stays visible only to its creator, primary
-- agent, or anyone present in session_participants.

drop policy if exists sessions_select_if_participant_or_creator on public.sessions;

create policy sessions_select_if_participant_or_creator on public.sessions
for select to authenticated using (
  app.is_team_member(team_id)
  and (
    created_by_actor_id = app.current_actor_id()
    or primary_agent_id = app.current_actor_id()
    or app.is_session_participant(sessions.id)
  )
);

-- <<< END archived migration: 202605070001_sessions_select_use_security_definer_helper.sql

-- >>> BEGIN archived migration: 202605080001_team_invites_member_reinvite.sql

-- services/supabase/migrations/202605080001_team_invites_member_reinvite.sql
--
-- Re-invite for anonymous members. Extends `create_team_invite` to accept
-- `p_target_actor_id` for kind='member' (gated on auth.users.is_anonymous),
-- and extends `claim_team_invite` to mint a fresh session + refresh_token
-- for the target's existing user_id without creating a new auth.users row.

create or replace function public.create_team_invite(
  p_team_id uuid,
  p_kind text,
  p_display_name text,
  p_team_role text default null,
  p_agent_kind text default null,
  p_ttl_seconds int default 604800,
  p_target_actor_id uuid default null
)
returns table (
  token text,
  expires_at timestamptz,
  deeplink text
)
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_caller uuid := app.current_actor_id_for_team(p_team_id);
  v_token  text := translate(
                     encode(extensions.gen_random_bytes(24), 'base64'),
                     '+/=', '-_0'
                   );
  v_expires timestamptz := now() + make_interval(secs => greatest(60, p_ttl_seconds));
  v_kind    text;
  v_role    text;
  v_target  public.actors%rowtype;
  v_target_anon boolean;
begin
  if v_caller is null then
    raise exception 'create_team_invite requires team membership'
      using errcode = '42501';
  end if;

  v_kind := lower(coalesce(p_kind, ''));
  if v_kind not in ('member','agent') then
    raise exception 'p_kind must be member or agent' using errcode = '22023';
  end if;

  if v_kind = 'member' then
    if p_team_role is null or btrim(p_team_role) = '' then
      raise exception 'member invites require p_team_role' using errcode = '22023';
    end if;
    v_role := lower(p_team_role);
    if v_role not in ('owner','admin','member') then
      raise exception 'team_role must be owner/admin/member' using errcode = '22023';
    end if;

    if p_target_actor_id is not null then
      select * into v_target from public.actors where id = p_target_actor_id;
      if not found then
        raise exception 'target actor not found' using errcode = '23503';
      end if;
      if v_target.team_id <> p_team_id then
        raise exception 'target actor belongs to a different team'
          using errcode = '23514';
      end if;
      if v_target.actor_type <> 'member' then
        raise exception 'target actor must be a member' using errcode = '22023';
      end if;
      if v_target.user_id is null then
        raise exception 'target member has no auth user'
          using errcode = '23503';
      end if;
      select coalesce(is_anonymous, false) into v_target_anon
        from auth.users where id = v_target.user_id;
      if not v_target_anon then
        raise exception 'cannot re-invite member with bound auth identity'
          using errcode = '22023';
      end if;
    end if;
  else
    if p_agent_kind is null or btrim(p_agent_kind) = '' then
      raise exception 'agent invites require p_agent_kind' using errcode = '22023';
    end if;
    if p_target_actor_id is not null then
      select * into v_target from public.actors where id = p_target_actor_id;
      if not found then
        raise exception 'target actor not found' using errcode = '23503';
      end if;
      if v_target.team_id <> p_team_id then
        raise exception 'target actor belongs to a different team'
          using errcode = '23514';
      end if;
      if v_target.actor_type <> 'agent' then
        raise exception 'target actor must be an agent' using errcode = '22023';
      end if;
    end if;
  end if;

  insert into public.team_invites (
    team_id, kind, display_name, team_role, agent_kind,
    invited_by_actor_id, token, expires_at, target_actor_id
  )
  values (
    p_team_id, v_kind, btrim(p_display_name), v_role, p_agent_kind,
    v_caller, v_token, v_expires, p_target_actor_id
  );

  return query
  select v_token,
         v_expires,
         format('amux://invite?token=%s', v_token);
end;
$$;

revoke all on function public.create_team_invite(uuid, text, text, text, text, int, uuid) from public;
grant execute on function public.create_team_invite(uuid, text, text, text, text, int, uuid) to authenticated;

create or replace function public.claim_team_invite(
  p_token text
)
returns table (
  actor_id      uuid,
  team_id       uuid,
  actor_type    text,
  display_name  text,
  refresh_token text
)
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_invite     public.team_invites%rowtype;
  v_user_id    uuid;
  v_actor      uuid;
  v_email      text;
  v_session    uuid;
  v_rt         text := null;
  v_old_user   uuid;
  v_target_anon boolean;
begin
  select * into v_invite
    from public.team_invites where token = p_token
    for update;

  if not found then
    raise exception 'invite not found' using errcode = '23503';
  end if;
  if v_invite.consumed_at is not null then
    raise exception 'invite already consumed' using errcode = '23514';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'invite expired' using errcode = '23514';
  end if;

  if v_invite.kind = 'member' then
    if v_invite.target_actor_id is not null then
      select user_id into v_user_id
        from public.actors where id = v_invite.target_actor_id;
      if v_user_id is null then
        raise exception 'target member has no auth user'
          using errcode = '23503';
      end if;

      select coalesce(is_anonymous, false) into v_target_anon
        from auth.users where id = v_user_id;
      if not v_target_anon then
        raise exception 'target member is no longer anonymous'
          using errcode = '23514';
      end if;

      v_session := gen_random_uuid();
      v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);

      insert into auth.sessions (id, user_id, aal, created_at, updated_at)
      values (v_session, v_user_id, 'aal1', now(), now());

      insert into auth.refresh_tokens
        (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
      values
        (v_rt, v_user_id::text, v_session, false,
         '00000000-0000-0000-0000-000000000000', now(), now());

      v_actor := v_invite.target_actor_id;
      update public.actors
         set last_active_at = now(), updated_at = now()
       where id = v_actor;
    else
      v_user_id := auth.uid();
      if v_user_id is null then
        raise exception 'member claim requires authentication' using errcode = '42501';
      end if;
      if exists (select 1 from public.actors act
                  where act.team_id = v_invite.team_id and act.user_id = v_user_id) then
        raise exception 'already a member of this team' using errcode = '23505';
      end if;

      insert into public.actors
        (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values
        (v_invite.team_id, 'member', v_user_id,
         v_invite.invited_by_actor_id, v_invite.display_name, now())
      returning id into v_actor;

      insert into public.members (id, status) values (v_actor, 'active');
      insert into public.team_members (team_id, member_id, role)
        values (v_invite.team_id, v_actor, v_invite.team_role);
    end if;
  else
    v_user_id := gen_random_uuid();
    v_email   := format('daemon.%s@amuxd.run', v_user_id);
    v_session := gen_random_uuid();
    v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);

    insert into auth.users (
      id, email, email_confirmed_at,
      encrypted_password, confirmation_token, recovery_token,
      email_change_token_new, email_change,
      raw_app_meta_data,
      aud, role, created_at, updated_at, instance_id
    )
    values (
      v_user_id, v_email, now(),
      '', '', '',
      '', '',
      '{}'::jsonb,
      'authenticated', 'authenticated',
      now(), now(), '00000000-0000-0000-0000-000000000000'
    );

    insert into auth.sessions (id, user_id, aal, created_at, updated_at)
    values (v_session, v_user_id, 'aal1', now(), now());

    insert into auth.refresh_tokens
      (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
    values
      (v_rt, v_user_id::text, v_session, false,
       '00000000-0000-0000-0000-000000000000', now(), now());

    if v_invite.target_actor_id is not null then
      select user_id into v_old_user from public.actors where id = v_invite.target_actor_id;
      update public.actors
         set user_id = v_user_id,
             invited_by_actor_id = v_invite.invited_by_actor_id,
             last_active_at = null,
             updated_at = now()
       where id = v_invite.target_actor_id;
      v_actor := v_invite.target_actor_id;

      if v_old_user is not null then
        delete from auth.users where id = v_old_user;
      end if;
    else
      insert into public.actors
        (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values
        (v_invite.team_id, 'agent', v_user_id,
         v_invite.invited_by_actor_id, v_invite.display_name, null)
      returning id into v_actor;

      insert into public.agents (id, agent_kind, status)
        values (v_actor, v_invite.agent_kind, 'active');

      insert into public.agent_member_access
        (agent_id, member_id, permission_level, granted_by_member_id)
      values
        (v_actor, v_invite.invited_by_actor_id, 'admin',
         v_invite.invited_by_actor_id);
    end if;
  end if;

  update public.team_invites
     set consumed_at = now(), consumed_by_actor_id = v_actor, updated_at = now()
   where id = v_invite.id;

  return query
  select v_actor, v_invite.team_id, v_invite.kind::text,
         v_invite.display_name, v_rt;
end;
$$;

-- <<< END archived migration: 202605080001_team_invites_member_reinvite.sql

-- >>> BEGIN archived migration: 202605080002_agent_sub_rpc_res.sql

-- Agents (daemons) need SUB on their own amux/{team}/device/{actor}/rpc/res
-- because the daemon also acts as an RPC client (RpcClient::handle_response
-- in daemon/src/teamclaw/rpc.rs listens on this topic to receive responses
-- from RPC calls it makes to peer daemons). The hook's original ACL only
-- granted PUB on rpc/res (for serving requests), missing the symmetric SUB
-- needed when the daemon is the requester.
--
-- Symptom that led here (2026-05-08): after the JWT-embedded ACL went live,
-- daemon's SessionManager.subscribe_all() got SUBACK ReasonCode=128 on
-- device/{me}/rpc/res. Combined with rumqttc's reconnect path, this turned
-- into a self-takeover storm: every reconnect attempt produced multiple
-- short-lived sockets (~5-7 ms each) on the same clientid, each new socket
-- discarding the previous one via MQTT clientid takeover. EMQX
-- session.discarded climbed past 8000 in <2 hours.

create or replace function public.amux_acl_rules_for(
  p_team  uuid,
  p_actor uuid,
  p_type  text
) returns table (action text, topic text)
language sql
immutable
set search_path = public
as $$
  -- Member (iOS human): unchanged from 202604270002.
  select action, topic
    from (values
      ('sub', format('amux/%s/user/%s/notify',              p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('pub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/+/state',              p_team)),
      ('sub', format('amux/%s/+/runtime/+/state',    p_team)),
      ('sub', format('amux/%s/+/runtime/+/events',   p_team)),
      ('sub', format('amux/%s/+/rpc/res',            p_team)),
      ('pub', format('amux/%s/+/rpc/req',            p_team)),
      ('pub', format('amux/%s/+/runtime/+/commands', p_team))
    ) as r(action, topic)
   where p_type = 'member'

  union all

  -- Agent (daemon): adds SUB on its own rpc/res so RpcClient can receive
  -- responses to RPC calls this daemon initiates.
  select action, topic
    from (values
      ('pub', format('amux/%s/%s/state',             p_team, p_actor)),
      ('pub', format('amux/%s/%s/runtime/+/state',   p_team, p_actor)),
      ('pub', format('amux/%s/%s/runtime/+/events',  p_team, p_actor)),
      ('pub', format('amux/%s/%s/notify',            p_team, p_actor)),
      ('pub', format('amux/%s/+/rpc/res',            p_team)),
      ('pub', format('amux/%s/session/+/live',              p_team)),
      ('pub', format('amux/%s/user/+/notify',               p_team)),
      ('sub', format('amux/%s/%s/runtime/+/commands',p_team, p_actor)),
      ('sub', format('amux/%s/%s/rpc/req',           p_team, p_actor)),
      ('sub', format('amux/%s/%s/rpc/res',           p_team, p_actor)),
      ('sub', format('amux/%s/%s/notify',            p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/user/%s/notify',              p_team, p_actor))
    ) as r(action, topic)
   where p_type = 'agent';
$$;

revoke execute on function public.amux_acl_rules_for(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.amux_acl_rules_for(uuid, uuid, text) to supabase_auth_admin;

-- <<< END archived migration: 202605080002_agent_sub_rpc_res.sql

-- >>> BEGIN archived migration: 202605080003_agent_runtimes_cursor.sql

-- Per-runtime read cursor for catchup on spawn / restart.
-- daemon updates this each time it sends or silently injects a message
-- into the runtime; on next spawn or restart, daemon pulls
-- messages WHERE id > last_processed_message_id and routes them through
-- the same mention pipeline so context catches up without reprocessing.

alter table public.agent_runtimes
  add column if not exists last_processed_message_id uuid null
    references public.messages(id) on delete set null;

create index if not exists agent_runtimes_cursor_idx
  on public.agent_runtimes (session_id, last_processed_message_id);

-- <<< END archived migration: 202605080003_agent_runtimes_cursor.sql

-- >>> BEGIN archived migration: 202605080004_sessions_primary_agent_nullable.sql

-- New multi-agent flow stops writing primary_agent_id; participants live
-- in session_participants. Existing rows keep their value (read-only).
-- Column will be dropped in a follow-up migration once old sessions age out.

alter table public.sessions
  alter column primary_agent_id drop not null;

-- <<< END archived migration: 202605080004_sessions_primary_agent_nullable.sql

-- >>> BEGIN archived migration: 202605120001_member_sub_device_notify.sql

-- Members (iOS humans) need SUB on amux/{team}/device/+/notify so the
-- iOS TeamclawService.resyncDaemonSubscriptions() path can receive
-- `Notify` events from any daemon in the team (e.g. membership.refresh
-- hints). The original member ACL granted only `sub user/{self}/notify`,
-- so iOS's per-daemon `subscribe(deviceNotify(teamID, deviceID))` call
-- got SUBACK in MQTT 3.1.1 but was silently dropped server-side, and the
-- subscription never landed in EMQX's session state. Membership refresh
-- hints from the daemon therefore never reached iOS.
--
-- Symptom that led here (2026-05-12): EMQX trace on the iOS client
-- showed `authorization_matched_deny` for SUBSCRIBE on
-- `amux/<team>/device/<daemon>/notify`, with action=SUBSCRIBE(Q1)
-- source=jwt. The client kept reconnecting and re-attempting, but the
-- broker never accepted the sub, so notify-driven flows on the iOS
-- side stayed dark.

create or replace function public.amux_acl_rules_for(
  p_team  uuid,
  p_actor uuid,
  p_type  text
) returns table (action text, topic text)
language sql
immutable
set search_path = public
as $$
  -- Member (iOS human): team-wide read, team-wide command/RPC publish,
  -- plus SUB on device/+/notify so iOS receives daemon-emitted Notify
  -- events for every daemon in the team.
  select action, topic
    from (values
      ('sub', format('amux/%s/user/%s/notify',              p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('pub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/+/state',              p_team)),
      ('sub', format('amux/%s/+/notify',             p_team)),
      ('sub', format('amux/%s/+/runtime/+/state',    p_team)),
      ('sub', format('amux/%s/+/runtime/+/events',   p_team)),
      ('sub', format('amux/%s/+/rpc/res',            p_team)),
      ('pub', format('amux/%s/+/rpc/req',            p_team)),
      ('pub', format('amux/%s/+/runtime/+/commands', p_team))
    ) as r(action, topic)
   where p_type = 'member'

  union all

  -- Agent (daemon): unchanged from 202605080002.
  select action, topic
    from (values
      ('pub', format('amux/%s/%s/state',             p_team, p_actor)),
      ('pub', format('amux/%s/%s/runtime/+/state',   p_team, p_actor)),
      ('pub', format('amux/%s/%s/runtime/+/events',  p_team, p_actor)),
      ('pub', format('amux/%s/%s/notify',            p_team, p_actor)),
      ('pub', format('amux/%s/+/rpc/res',            p_team)),
      ('pub', format('amux/%s/session/+/live',              p_team)),
      ('pub', format('amux/%s/user/+/notify',               p_team)),
      ('sub', format('amux/%s/%s/runtime/+/commands',p_team, p_actor)),
      ('sub', format('amux/%s/%s/rpc/req',           p_team, p_actor)),
      ('sub', format('amux/%s/%s/rpc/res',           p_team, p_actor)),
      ('sub', format('amux/%s/%s/notify',            p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/user/%s/notify',              p_team, p_actor))
    ) as r(action, topic)
   where p_type = 'agent';
$$;

revoke execute on function public.amux_acl_rules_for(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.amux_acl_rules_for(uuid, uuid, text) to supabase_auth_admin;

-- <<< END archived migration: 202605120001_member_sub_device_notify.sql

-- >>> BEGIN archived migration: 202605130001_messages_model_column.sql

-- Per-message model identity. The daemon already round-trips `model` on
-- the MQTT wire (Message.model, proto field 9) so clients render the
-- bubble with the correct model name during live streaming, but the
-- value was dropped at the Supabase write boundary. After reload, the
-- only signal left was `runtime_state.current_model`, which reflects
-- whatever the runtime is set to NOW — not what the agent answered with
-- two turns ago. The mismatch is most visible after the user toggles
-- the model picker mid-session.
--
-- Nullable: historical rows pre-dating this column have no value, and
-- non-agent kinds (user_message, system, idea_event) don't carry a
-- model. Clients must tolerate NULL and fall back to runtime-state.

alter table public.messages
  add column if not exists model text;

comment on column public.messages.model is
  'Model identifier (e.g. claude-haiku-4-5) the agent used to produce this message. NULL for non-agent messages and rows older than the column.';

-- <<< END archived migration: 202605130001_messages_model_column.sql

-- >>> BEGIN archived migration: 202605130002_messages_turn_id.sql

-- Group consecutive agent reply rows that came out of the same logical
-- turn. Today the daemon's TurnAggregator emits one AgentReply at every
-- ToolUse interruption AND another at Active→Idle, so a single "the
-- agent replied X" turn lands in `messages` as 2+ rows — fine while you
-- watch live, but on reload the gap is jarring because the tool calls
-- that bridged them live in MQTT-only and never made it into DB.
--
-- Per-message `turn_id` is the correlation key the daemon stamps on
-- every emit within one turn. Clients group consecutive same-turn_id
-- AgentReply rows into one bubble.
--
-- Nullable: historical rows pre-dating the column have no value; clients
-- must fall back to "each row is its own bubble" for those.
--
-- We are intentionally NOT persisting per-tool-call rows to Supabase:
-- the daemon's TOML log and the live MQTT stream are the source of
-- truth for tool history. Reload only restores `messages`. Scenarios
-- that need full forensic detail (cron / share / replay across
-- devices) will get a dedicated table later.

alter table public.messages
  add column if not exists turn_id text;

comment on column public.messages.turn_id is
  'Daemon-assigned correlation id stamped on every emit within one ACP turn (Idle→Active→…→Idle). Clients merge consecutive same-turn_id AgentReply rows into a single bubble. NULL for rows older than this column.';

create index if not exists messages_turn_id_idx
  on public.messages (session_id, turn_id)
  where turn_id is not null;

-- <<< END archived migration: 202605130002_messages_turn_id.sql

-- >>> BEGIN archived migration: 20260514002741_create_attachments_bucket.sql

-- Create attachments bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'attachments',
  'attachments',
  false,
  52428800,  -- 50MB in bytes
  ARRAY[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf',
    'text/plain', 'text/markdown', 'text/csv',
    'application/json',
    'text/x-swift', 'text/x-python', 'text/x-javascript',
    'application/zip',
    'application/octet-stream'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- RLS: SELECT (download) — user must be a session participant.
-- Object path convention used by the gateway port:
--   <team_id>/<session_id>/<uuid>-<filename>
-- SPLIT_PART(name, '/', 2) extracts the session_id segment.
-- actors.user_id (set on member-type actors by 202604220015) maps to
-- auth.uid(); external-IM actors have user_id NULL and are excluded.
CREATE POLICY "session_participants_can_download"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'attachments'
  AND auth.uid() IN (
    SELECT a.user_id
    FROM public.session_participants sp
    JOIN public.actors a ON a.id = sp.actor_id
    WHERE sp.session_id::text = SPLIT_PART(name, '/', 2)
      AND a.user_id IS NOT NULL
  )
);

-- RLS: INSERT (upload) — authenticated users
CREATE POLICY "authenticated_can_upload"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'attachments'
);

-- RLS: DELETE — deny all (cleanup via backend task)
CREATE POLICY "no_delete"
ON storage.objects FOR DELETE
TO authenticated
USING (false);

-- <<< END archived migration: 20260514002741_create_attachments_bucket.sql

-- >>> BEGIN archived migration: 20260515000001_rename_team_rpc.sql

-- rename_team RPC: lets a team owner/admin update the team's display name.
-- RLS on public.teams only exposes SELECT to members, so updates have to go
-- through a security-definer function that re-checks role authorization.

create or replace function public.rename_team(
  p_team_id uuid,
  p_name text
)
returns table (
  team_id uuid,
  team_name text,
  team_slug text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_new_name text;
begin
  if v_user_id is null then
    raise exception 'rename_team requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_team_id is null then
    raise exception 'team id is required'
      using errcode = '22023';
  end if;

  v_new_name := btrim(coalesce(p_name, ''));
  if v_new_name = '' then
    raise exception 'team name is required'
      using errcode = '22023';
  end if;

  if length(v_new_name) > 80 then
    raise exception 'team name too long (max 80 characters)'
      using errcode = '22001';
  end if;

  -- Caller must be an active owner or admin of the team.
  select tm.role
  into v_role
  from public.team_members tm
  join public.members m on m.id = tm.member_id
  where tm.team_id = p_team_id
    and m.user_id = v_user_id
    and m.status = 'active'
  limit 1;

  if v_role is null then
    raise exception 'not a member of this team'
      using errcode = '42501';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'only team owners or admins can rename the team'
      using errcode = '42501';
  end if;

  update public.teams
  set name = v_new_name
  where id = p_team_id;

  return query
  select
    t.id,
    t.name,
    t.slug
  from public.teams t
  where t.id = p_team_id;
end;
$$;

revoke all on function public.rename_team(uuid, text) from public;
grant execute on function public.rename_team(uuid, text) to authenticated;

-- <<< END archived migration: 20260515000001_rename_team_rpc.sql

-- >>> BEGIN archived migration: 20260515000010_team_workspace_config.sql

-- team_workspace_config: 1:1 with teams, holds desktop workspace metadata
-- that used to live in .teamclaw/teamclaw.json.

create table public.team_workspace_config (
  team_id              uuid primary key references public.teams(id) on delete cascade,
  git_url              text,
  git_branch           text,
  -- Team-shared bot PAT. Stored plaintext for v2; encryption (e.g. pgsodium
  -- vault.secrets) is a follow-up. RLS limits read to team members.
  git_token            text,
  ai_gateway_endpoint  text,
  enabled              boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger set_team_workspace_config_updated_at
  before update on public.team_workspace_config
  for each row execute function app.bump_updated_at();

alter table public.team_workspace_config enable row level security;

create policy team_workspace_config_select_if_team_member
  on public.team_workspace_config
  for select to authenticated
  using (app.is_team_member(team_id));

create policy team_workspace_config_insert_if_team_member
  on public.team_workspace_config
  for insert to authenticated
  with check (app.is_team_member(team_id));

create policy team_workspace_config_update_if_team_member
  on public.team_workspace_config
  for update to authenticated
  using (app.is_team_member(team_id))
  with check (app.is_team_member(team_id));

create policy team_workspace_config_delete_if_owner
  on public.team_workspace_config
  for delete to authenticated
  using (
    exists (
      select 1 from public.team_members tm
       join public.actors a on a.id = tm.member_id
      where tm.team_id = team_workspace_config.team_id
        and a.user_id = auth.uid()
        and tm.role   = 'owner'
    )
  );

grant select, insert, update, delete on public.team_workspace_config to authenticated;

-- <<< END archived migration: 20260515000010_team_workspace_config.sql

-- >>> BEGIN archived migration: 20260515000011_actor_telemetry.sql

-- actor_message_feedback + actor_session_report
-- Replaces the libSQL telemetry.db tables that used to live at
-- ~/.teamclaw/telemetry.db.

create table public.actor_message_feedback (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid not null references public.actors(id)   on delete cascade,
  team_id      uuid not null references public.teams(id)    on delete cascade,
  session_id   uuid references public.sessions(id)          on delete set null,
  message_id   uuid,
  kind         text not null check (kind in ('positive','negative')),
  star_rating  smallint check (star_rating between 1 and 5),
  skill        text,
  created_at   timestamptz not null default now()
);

create index actor_message_feedback_team_idx
  on public.actor_message_feedback (team_id, created_at desc);
create index actor_message_feedback_actor_idx
  on public.actor_message_feedback (actor_id, created_at desc);

alter table public.actor_message_feedback enable row level security;

create policy actor_message_feedback_select_if_team_member
  on public.actor_message_feedback
  for select to authenticated
  using (app.is_team_member(team_id));

create policy actor_message_feedback_insert_self
  on public.actor_message_feedback
  for insert to authenticated
  with check (
    app.is_team_member(team_id)
    and exists (
      select 1 from public.actors a
       where a.id = actor_id
         and a.user_id = auth.uid()
         and a.team_id = team_id
    )
  );

grant select, insert on public.actor_message_feedback to authenticated;

create table public.actor_session_report (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid not null references public.actors(id)  on delete cascade,
  team_id      uuid not null references public.teams(id)   on delete cascade,
  session_id   uuid references public.sessions(id)         on delete set null,
  tokens_used  bigint   not null default 0,
  cost_usd     numeric(12,4) not null default 0,
  model        text,
  agent_kind   text,
  created_at   timestamptz not null default now(),
  ended_at     timestamptz
);

create index actor_session_report_team_idx
  on public.actor_session_report (team_id, created_at desc);
create index actor_session_report_actor_idx
  on public.actor_session_report (actor_id, created_at desc);

alter table public.actor_session_report enable row level security;

create policy actor_session_report_select_if_team_member
  on public.actor_session_report
  for select to authenticated
  using (app.is_team_member(team_id));

create policy actor_session_report_insert_self
  on public.actor_session_report
  for insert to authenticated
  with check (
    app.is_team_member(team_id)
    and exists (
      select 1 from public.actors a
       where a.id = actor_id
         and a.user_id = auth.uid()
         and a.team_id = team_id
    )
  );

grant select, insert on public.actor_session_report to authenticated;

-- <<< END archived migration: 20260515000011_actor_telemetry.sql

-- >>> BEGIN archived migration: 20260515000012_team_leaderboard_view.sql

-- team_leaderboard: 30-day rolling per-actor aggregate of feedback + reports.
-- security_invoker = on so RLS on the underlying tables is enforced.

create view public.team_leaderboard
  with (security_invoker = on)
as
select
  a.team_id,
  a.id                                              as actor_id,
  a.display_name,
  coalesce(sum(r.tokens_used), 0)                   as tokens_used_30d,
  coalesce(sum(r.cost_usd),    0)                   as cost_usd_30d,
  coalesce(sum((f.kind = 'positive')::int), 0)      as positive_feedback_30d,
  coalesce(sum((f.kind = 'negative')::int), 0)      as negative_feedback_30d
from public.actors a
left join public.actor_session_report   r
  on r.actor_id = a.id
  and r.created_at >= now() - interval '30 days'
left join public.actor_message_feedback f
  on f.actor_id = a.id
  and f.created_at >= now() - interval '30 days'
group by a.team_id, a.id, a.display_name;

grant select on public.team_leaderboard to authenticated;

-- <<< END archived migration: 20260515000012_team_leaderboard_view.sql

-- >>> BEGIN archived migration: 20260515000013_telemetry_self_delete.sql

-- Allow actors to delete their own feedback rows (for removeFeedback / removeStarRating).

create policy actor_message_feedback_delete_self
  on public.actor_message_feedback
  for delete to authenticated
  using (
    exists (
      select 1 from public.actors a
       where a.id = actor_id
         and a.user_id = auth.uid()
    )
  );

grant delete on public.actor_message_feedback to authenticated;

-- <<< END archived migration: 20260515000013_telemetry_self_delete.sql

-- >>> BEGIN archived migration: 202605160001_gateway_external_and_binding.sql

-- 2026-05-16: support external IM actors and session binding URIs for gateway port.

-- actors: allow actor_type='external'; require source + source_id when type=external.
alter table public.actors
  drop constraint actors_actor_type_check;
alter table public.actors
  add constraint actors_actor_type_check
    check (actor_type in ('member', 'agent', 'external'));

alter table public.actors
  add column source text,
  add column source_id text;

alter table public.actors
  add constraint actors_external_has_source
    check ((actor_type = 'external') = (source is not null and source_id is not null));

create unique index actors_team_source_id_uq
  on public.actors (team_id, source, source_id)
  where source is not null;

-- sessions: binding URI for gateway-originated sessions.
alter table public.sessions
  add column binding text;

create unique index sessions_team_binding_uq
  on public.sessions (team_id, binding)
  where binding is not null;

-- <<< END archived migration: 202605160001_gateway_external_and_binding.sql

-- >>> BEGIN archived migration: 202605160002_gateway_rpcs.sql

-- 2026-05-16: gateway RPCs backing amuxd's AcpHandle + ChannelStore adapters.
--
-- Three pieces:
--   1. Persist amuxd's in-process ACP session id on `sessions.acp_session_id`
--      so the gateway can re-bind across daemon restarts.
--   2. RPC `ensure_gateway_session` — idempotent get-or-create of a session
--      for a (team_id, binding) pair, snapshotting participants on first
--      call.
--   3. RPC `upsert_external_actor` — idempotent UPSERT on the actors row
--      for an external IM user (Discord, WeCom, Feishu, Kook, WeChat,
--      Email) using the partial unique index added in migration
--      202605160001.
--   4. `messages.external_id` for idempotent gateway message ingestion.

-- ── sessions.acp_session_id ────────────────────────────────────────────────
alter table public.sessions
  add column acp_session_id text;

create unique index sessions_acp_session_id_uq
  on public.sessions (acp_session_id)
  where acp_session_id is not null;

-- ── messages.external_id ───────────────────────────────────────────────────
alter table public.messages
  add column external_id text;

create unique index messages_session_external_id_uq
  on public.messages (session_id, external_id)
  where external_id is not null;

-- ── RPC: upsert_external_actor ─────────────────────────────────────────────
-- Returns the actor's UUID. Updates `display_name` on every call so the
-- gateway can keep a fresh display string for the IM user.
create or replace function public.upsert_external_actor(
  p_team_id        uuid,
  p_source         text,
  p_source_id      text,
  p_display_name   text
)
returns uuid
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_actor uuid;
begin
  -- Try update first (cheap path: most calls are re-deliveries).
  update public.actors
     set display_name   = p_display_name,
         last_active_at = now(),
         updated_at     = now()
   where team_id   = p_team_id
     and source    = p_source
     and source_id = p_source_id
  returning id into v_actor;

  if v_actor is not null then
    return v_actor;
  end if;

  insert into public.actors
    (team_id, actor_type, source, source_id, display_name, last_active_at)
  values
    (p_team_id, 'external', p_source, p_source_id, p_display_name, now())
  returning id into v_actor;

  return v_actor;
exception when unique_violation then
  -- Race with a concurrent insert on the same (team_id, source, source_id).
  -- The other inserter won; pick up its row.
  select id into v_actor
    from public.actors
   where team_id   = p_team_id
     and source    = p_source
     and source_id = p_source_id;
  return v_actor;
end;
$$;

revoke all on function public.upsert_external_actor(uuid, text, text, text) from public;
grant execute on function public.upsert_external_actor(uuid, text, text, text) to authenticated;

-- ── RPC: ensure_gateway_session ────────────────────────────────────────────
-- Idempotent get-or-create. On first call inserts a new session keyed on
-- (team_id, binding), snapshots the participants, and mints an
-- `acp_session_id` placeholder. Subsequent calls return the existing row
-- unchanged.
create or replace function public.ensure_gateway_session(
  p_team_id                  uuid,
  p_binding                  text,
  p_title                    text,
  p_primary_agent_actor_id   uuid,
  p_owner_member_actor_ids   uuid[],
  p_participant_actor_ids    uuid[]
)
returns table (session_id uuid, acp_session_id text, created boolean)
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_session uuid;
  v_acp     text;
  v_created boolean := false;
begin
  select s.id, s.acp_session_id
    into v_session, v_acp
    from public.sessions s
   where s.team_id = p_team_id
     and s.binding = p_binding;

  if v_session is null then
    insert into public.sessions
      (team_id, idea_id, created_by_actor_id, primary_agent_id,
       mode, title, binding, acp_session_id)
    values
      (p_team_id,
       null,
       p_primary_agent_actor_id,
       p_primary_agent_actor_id,
       'collab',
       p_title,
       p_binding,
       encode(extensions.gen_random_bytes(16), 'hex'))
    returning id, sessions.acp_session_id
      into v_session, v_acp;
    v_created := true;

    insert into public.session_participants (session_id, actor_id)
      select v_session, x
        from unnest(
          array[p_primary_agent_actor_id]
            || coalesce(p_owner_member_actor_ids, '{}'::uuid[])
            || coalesce(p_participant_actor_ids,  '{}'::uuid[])
        ) as x
    on conflict (session_id, actor_id) do nothing;
  end if;

  session_id := v_session;
  acp_session_id := v_acp;
  created := v_created;
  return next;
end;
$$;

revoke all on function public.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]) from public;
grant execute on function public.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]) to authenticated;

-- <<< END archived migration: 202605160002_gateway_rpcs.sql

-- >>> BEGIN archived migration: 202605160003_agent_visibility.sql

-- Agent personal/team visibility and agent-owned permissions.

alter table public.agents
  add column if not exists visibility text;

update public.agents
   set visibility = 'personal'
 where visibility is null;

alter table public.agents
  alter column visibility set default 'personal',
  alter column visibility set not null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'agents_visibility_check'
       and conrelid = 'public.agents'::regclass
  ) then
    alter table public.agents
      add constraint agents_visibility_check
      check (visibility in ('personal', 'team'));
  end if;
end;
$$;

alter table public.agents
  add column if not exists owner_member_id uuid;

update public.agents ag
   set owner_member_id = coalesce(
     (
       select ama.member_id
         from public.agent_member_access ama
        where ama.agent_id = ag.id
          and ama.permission_level = 'admin'
        order by ama.created_at asc
        limit 1
     ),
     (
       select act.invited_by_actor_id
         from public.actors act
         join public.members m on m.id = act.invited_by_actor_id
        where act.id = ag.id
        limit 1
     ),
     (
       select tm.member_id
         from public.actors act
         join public.team_members tm on tm.team_id = act.team_id
        where act.id = ag.id
        order by case tm.role when 'owner' then 0 when 'admin' then 1 else 2 end,
                 tm.joined_at asc
        limit 1
     )
   )
 where ag.owner_member_id is null;

do $$
begin
  if exists (select 1 from public.agents where owner_member_id is null) then
    raise exception 'agents.owner_member_id backfill failed';
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'agents_owner_member_id_fkey'
       and conrelid = 'public.agents'::regclass
  ) then
    alter table public.agents
      add constraint agents_owner_member_id_fkey
      foreign key (owner_member_id)
      references public.members(id)
      on delete restrict
      not valid;
  end if;
end;
$$;

alter table public.agents
  validate constraint agents_owner_member_id_fkey;

alter table public.agents
  alter column owner_member_id set not null;

insert into public.agent_member_access (
  agent_id,
  member_id,
  permission_level,
  granted_by_member_id
)
select
  ag.id,
  ag.owner_member_id,
  'admin',
  ag.owner_member_id
from public.agents ag
on conflict (agent_id, member_id) do update
  set permission_level = 'admin',
      updated_at = now();

drop view if exists public.actor_directory;

create view public.actor_directory
  with (security_invoker = true)
as
select
  a.id, a.team_id, a.actor_type, a.user_id, a.invited_by_actor_id,
  a.display_name, a.last_active_at, a.created_at, a.updated_at,
  m.status      as member_status,
  tm.role       as team_role,
  ag.agent_kind as agent_kind,
  ag.status     as agent_status
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id
where a.actor_type <> 'agent'
   or ag.visibility = 'team';

grant select on public.actor_directory to authenticated;

drop policy if exists agents_select_if_team_member on public.agents;
create policy agents_select_if_visible on public.agents
for select to authenticated using (
  exists (
    select 1
      from public.actors a
     where a.id = agents.id
       and app.is_team_member(a.team_id)
       and (
         agents.visibility = 'team'
         or agents.owner_member_id = app.current_member_id()
       )
  )
);

drop policy if exists agent_member_access_select_if_team_member on public.agent_member_access;
create policy agent_member_access_select_if_agent_owner_or_self on public.agent_member_access
for select to authenticated using (
  member_id = app.current_member_id()
  or exists (
    select 1
      from public.agents ag
     where ag.id = agent_member_access.agent_id
       and ag.owner_member_id = app.current_member_id()
  )
);

drop policy if exists agent_member_access_manage_if_admin on public.agent_member_access;
create policy agent_member_access_manage_if_agent_owner on public.agent_member_access
for all to authenticated using (
  exists (
    select 1
      from public.agents ag
     where ag.id = agent_member_access.agent_id
       and ag.owner_member_id = app.current_member_id()
  )
)
with check (
  exists (
    select 1
      from public.agents ag
     where ag.id = agent_member_access.agent_id
       and ag.owner_member_id = app.current_member_id()
  )
);

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
      join public.agents ag on ag.id = ama.agent_id
      join public.actors act on act.id = ag.id
     where ama.agent_id = target_agent_id
       and ama.member_id = app.current_member_id()
       and ama.permission_level in ('prompt', 'admin')
       and app.is_team_member(act.team_id)
       and (
         ag.visibility = 'team'
         or ag.owner_member_id = app.current_member_id()
       )
  )
$$;

create or replace function public.check_agent_permission(
  p_agent_id uuid,
  p_actor_id uuid
) returns text
language sql security definer set search_path = public
as $$
  select ama.permission_level
    from public.agent_member_access ama
    join public.agents ag on ag.id = ama.agent_id
   where ama.agent_id = p_agent_id
     and ama.member_id = p_actor_id
     and (
       ag.visibility = 'team'
       or ag.owner_member_id = p_actor_id
     )
   limit 1;
$$;

create or replace function public.share_agent_to_team(
  p_agent_id uuid
) returns void
language plpgsql security definer set search_path = public, auth, app
as $$
begin
  if not exists (
    select 1
      from public.agents ag
     where ag.id = p_agent_id
       and ag.owner_member_id = app.current_member_id()
  ) then
    raise exception 'only agent owner can share agent to team'
      using errcode = '42501';
  end if;

  update public.agents
     set visibility = 'team',
         updated_at = now()
   where id = p_agent_id;
end;
$$;

create or replace function public.make_agent_personal(
  p_agent_id uuid
) returns void
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_owner uuid;
begin
  select owner_member_id into v_owner
    from public.agents
   where id = p_agent_id;

  if v_owner is null or v_owner <> app.current_member_id() then
    raise exception 'only agent owner can make agent personal'
      using errcode = '42501';
  end if;

  update public.agents
     set visibility = 'personal',
         updated_at = now()
   where id = p_agent_id;

  delete from public.agent_member_access
   where agent_id = p_agent_id
     and member_id <> v_owner;

  insert into public.agent_member_access (
    agent_id,
    member_id,
    permission_level,
    granted_by_member_id
  )
  values (p_agent_id, v_owner, 'admin', v_owner)
  on conflict (agent_id, member_id) do update
    set permission_level = 'admin',
        granted_by_member_id = excluded.granted_by_member_id,
        updated_at = now();
end;
$$;

revoke all on function public.share_agent_to_team(uuid) from public;
revoke all on function public.make_agent_personal(uuid) from public;
grant execute on function public.share_agent_to_team(uuid) to authenticated;
grant execute on function public.make_agent_personal(uuid) to authenticated;

create or replace function public.claim_team_invite(
  p_token text
)
returns table (
  actor_id      uuid,
  team_id       uuid,
  actor_type    text,
  display_name  text,
  refresh_token text
)
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_invite     public.team_invites%rowtype;
  v_user_id    uuid;
  v_actor      uuid;
  v_email      text;
  v_session    uuid;
  v_rt         text := null;
  v_old_user   uuid;
  v_target_anon boolean;
begin
  select * into v_invite
    from public.team_invites where token = p_token
    for update;

  if not found then
    raise exception 'invite not found' using errcode = '23503';
  end if;
  if v_invite.consumed_at is not null then
    raise exception 'invite already consumed' using errcode = '23514';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'invite expired' using errcode = '23514';
  end if;

  if v_invite.kind = 'member' then
    if v_invite.target_actor_id is not null then
      select user_id into v_user_id
        from public.actors where id = v_invite.target_actor_id;
      if v_user_id is null then
        raise exception 'target member has no auth user'
          using errcode = '23503';
      end if;

      select coalesce(is_anonymous, false) into v_target_anon
        from auth.users where id = v_user_id;
      if not v_target_anon then
        raise exception 'target member is no longer anonymous'
          using errcode = '23514';
      end if;

      v_session := gen_random_uuid();
      v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);

      insert into auth.sessions (id, user_id, aal, created_at, updated_at)
      values (v_session, v_user_id, 'aal1', now(), now());

      insert into auth.refresh_tokens
        (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
      values
        (v_rt, v_user_id::text, v_session, false,
         '00000000-0000-0000-0000-000000000000', now(), now());

      v_actor := v_invite.target_actor_id;
      update public.actors
         set last_active_at = now(), updated_at = now()
       where id = v_actor;
    else
      v_user_id := auth.uid();
      if v_user_id is null then
        raise exception 'member claim requires authentication' using errcode = '42501';
      end if;
      if exists (select 1 from public.actors act
                  where act.team_id = v_invite.team_id and act.user_id = v_user_id) then
        raise exception 'already a member of this team' using errcode = '23505';
      end if;

      insert into public.actors
        (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values
        (v_invite.team_id, 'member', v_user_id,
         v_invite.invited_by_actor_id, v_invite.display_name, now())
      returning id into v_actor;

      insert into public.members (id, status) values (v_actor, 'active');
      insert into public.team_members (team_id, member_id, role)
        values (v_invite.team_id, v_actor, v_invite.team_role);
    end if;
  else
    v_user_id := gen_random_uuid();
    v_email   := format('daemon.%s@amuxd.run', v_user_id);
    v_session := gen_random_uuid();
    v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);

    insert into auth.users (
      id, email, email_confirmed_at,
      encrypted_password, confirmation_token, recovery_token,
      email_change_token_new, email_change,
      raw_app_meta_data,
      aud, role, created_at, updated_at, instance_id
    )
    values (
      v_user_id, v_email, now(),
      '', '', '',
      '', '',
      '{}'::jsonb,
      'authenticated', 'authenticated',
      now(), now(), '00000000-0000-0000-0000-000000000000'
    );

    insert into auth.sessions (id, user_id, aal, created_at, updated_at)
    values (v_session, v_user_id, 'aal1', now(), now());

    insert into auth.refresh_tokens
      (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
    values
      (v_rt, v_user_id::text, v_session, false,
       '00000000-0000-0000-0000-000000000000', now(), now());

    if v_invite.target_actor_id is not null then
      select user_id into v_old_user from public.actors where id = v_invite.target_actor_id;
      update public.actors
         set user_id = v_user_id,
             invited_by_actor_id = v_invite.invited_by_actor_id,
             last_active_at = null,
             updated_at = now()
       where id = v_invite.target_actor_id;
      v_actor := v_invite.target_actor_id;

      update public.agents
         set owner_member_id = v_invite.invited_by_actor_id,
             visibility = 'team',
             updated_at = now()
       where id = v_actor;

      if v_old_user is not null then
        delete from auth.users where id = v_old_user;
      end if;
    else
      insert into public.actors
        (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values
        (v_invite.team_id, 'agent', v_user_id,
         v_invite.invited_by_actor_id, v_invite.display_name, null)
      returning id into v_actor;

      insert into public.agents (id, owner_member_id, visibility, agent_kind, status)
        values (v_actor, v_invite.invited_by_actor_id, 'team', v_invite.agent_kind, 'active');
    end if;

    insert into public.agent_member_access
      (agent_id, member_id, permission_level, granted_by_member_id)
    values
      (v_actor, v_invite.invited_by_actor_id, 'admin',
       v_invite.invited_by_actor_id)
    on conflict (agent_id, member_id) do update
      set permission_level = 'admin',
          granted_by_member_id = excluded.granted_by_member_id,
          updated_at = now();
  end if;

  update public.team_invites
     set consumed_at = now(), consumed_by_actor_id = v_actor, updated_at = now()
   where id = v_invite.id;

  return query
  select v_actor, v_invite.team_id, v_invite.kind::text,
         v_invite.display_name, v_rt;
end;
$$;

-- <<< END archived migration: 202605160003_agent_visibility.sql

-- >>> BEGIN archived migration: 202605160004_actor_profile_avatar.sql

-- Actor profile editing: display name + cross-device avatar URL.

alter table public.actors
  add column if not exists avatar_url text;

drop view if exists public.actor_directory;

create view public.actor_directory
  with (security_invoker = true)
as
select
  a.id, a.team_id, a.actor_type, a.user_id, a.invited_by_actor_id,
  a.display_name, a.avatar_url, a.last_active_at, a.created_at, a.updated_at,
  m.status      as member_status,
  tm.role       as team_role,
  ag.agent_kind as agent_kind,
  ag.status     as agent_status
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id
where a.actor_type <> 'agent'
   or ag.visibility = 'team';

grant select on public.actor_directory to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read
on storage.objects for select
to public
using (bucket_id = 'avatars');

drop policy if exists avatars_owner_insert on storage.objects;
create policy avatars_owner_insert
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'avatars'
  and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
  and exists (
    select 1
      from public.actors a
     where a.id = split_part(name, '/', 1)::uuid
       and a.actor_type = 'member'
       and a.user_id = auth.uid()
  )
);

drop policy if exists avatars_owner_update on storage.objects;
create policy avatars_owner_update
on storage.objects for update
to authenticated
using (
  bucket_id = 'avatars'
  and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
  and exists (
    select 1
      from public.actors a
     where a.id = split_part(name, '/', 1)::uuid
       and a.actor_type = 'member'
       and a.user_id = auth.uid()
  )
)
with check (
  bucket_id = 'avatars'
  and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
  and exists (
    select 1
      from public.actors a
     where a.id = split_part(name, '/', 1)::uuid
       and a.actor_type = 'member'
       and a.user_id = auth.uid()
  )
);

drop policy if exists avatars_owner_delete on storage.objects;
create policy avatars_owner_delete
on storage.objects for delete
to authenticated
using (
  bucket_id = 'avatars'
  and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
  and exists (
    select 1
      from public.actors a
     where a.id = split_part(name, '/', 1)::uuid
       and a.actor_type = 'member'
       and a.user_id = auth.uid()
  )
);

create or replace function public.update_current_actor_profile(
  p_actor_id uuid,
  p_display_name text,
  p_avatar_url text default null
)
returns table (
  id uuid,
  team_id uuid,
  actor_type text,
  user_id uuid,
  invited_by_actor_id uuid,
  display_name text,
  avatar_url text,
  last_active_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  member_status text,
  team_role text,
  agent_kind text,
  agent_status text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_display_name text := nullif(btrim(p_display_name), '');
  v_avatar_url text := nullif(btrim(coalesce(p_avatar_url, '')), '');
begin
  if v_display_name is null then
    raise exception 'display name is required'
      using errcode = '23514';
  end if;

  update public.actors a
     set display_name = v_display_name,
         avatar_url = v_avatar_url,
         updated_at = now()
   where a.id = p_actor_id
     and a.actor_type = 'member'
     and a.user_id = auth.uid();

  if not found then
    raise exception 'actor profile update is not allowed'
      using errcode = '42501';
  end if;

  return query
  select
    ad.id, ad.team_id, ad.actor_type, ad.user_id, ad.invited_by_actor_id,
    ad.display_name, ad.avatar_url, ad.last_active_at, ad.created_at, ad.updated_at,
    ad.member_status, ad.team_role, ad.agent_kind, ad.agent_status
  from public.actor_directory ad
  where ad.id = p_actor_id;
end;
$$;

revoke all on function public.update_current_actor_profile(uuid, text, text) from public;
grant execute on function public.update_current_actor_profile(uuid, text, text) to authenticated;

-- <<< END archived migration: 202605160004_actor_profile_avatar.sql

-- >>> BEGIN archived migration: 202605160005_message_attachments.sql

-- Attachments metadata for gateway-originated messages.
alter table public.messages
  add column attachments jsonb not null default '[]'::jsonb;

-- <<< END archived migration: 202605160005_message_attachments.sql

-- >>> BEGIN archived migration: 202605170001_session_read_markers.sql

create table if not exists public.session_read_markers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  actor_id uuid not null references public.actors(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  last_read_message_id uuid null references public.messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, actor_id)
);

alter table public.session_read_markers enable row level security;

create unique index if not exists session_read_markers_actor_session_idx
on public.session_read_markers(actor_id, session_id);

create index if not exists session_read_markers_session_actor_idx
on public.session_read_markers(session_id, actor_id);

create index if not exists messages_session_created_idx
on public.messages(session_id, created_at desc);

create index if not exists sessions_team_last_message_idx
on public.sessions(team_id, last_message_at desc nulls first, created_at desc);

drop trigger if exists set_session_read_markers_updated_at on public.session_read_markers;
create trigger set_session_read_markers_updated_at before update on public.session_read_markers
for each row execute function app.bump_updated_at();

drop policy if exists session_read_markers_select_own on public.session_read_markers;
create policy session_read_markers_select_own on public.session_read_markers
for select to authenticated using (
  actor_id = app.current_actor_id()
  and app.is_session_participant(session_id)
);

drop policy if exists session_read_markers_insert_own on public.session_read_markers;
create policy session_read_markers_insert_own on public.session_read_markers
for insert to authenticated with check (
  actor_id = app.current_actor_id()
  and app.is_session_participant(session_id)
);

drop policy if exists session_read_markers_update_own on public.session_read_markers;
create policy session_read_markers_update_own on public.session_read_markers
for update to authenticated using (
  actor_id = app.current_actor_id()
  and app.is_session_participant(session_id)
) with check (
  actor_id = app.current_actor_id()
  and app.is_session_participant(session_id)
);

create or replace function public.list_current_actor_sessions(
  p_limit integer default 50,
  p_before_last_message_at timestamptz default null
)
returns table (
  id uuid,
  title text,
  team_id uuid,
  mode text,
  idea_id uuid,
  last_message_at timestamptz,
  last_message_preview text,
  created_at timestamptz,
  updated_at timestamptz,
  has_unread boolean
)
language sql
stable
security invoker
set search_path = public, app
as $$
  select
    s.id,
    s.title,
    s.team_id,
    s.mode,
    s.idea_id,
    s.last_message_at,
    s.last_message_preview,
    s.created_at,
    s.updated_at,
    (
      s.last_message_at is not null
      and s.last_message_at > coalesce(srm.last_read_at, '-infinity'::timestamptz)
    ) as has_unread
  from public.sessions s
  left join public.session_read_markers srm
    on srm.session_id = s.id
   and srm.actor_id = app.current_actor_id()
  where app.is_session_participant(s.id)
    and (
      p_before_last_message_at is null
      or s.last_message_at < p_before_last_message_at
    )
  order by s.last_message_at desc nulls first, s.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

create or replace function public.mark_current_actor_session_viewed(
  p_session_id uuid,
  p_last_read_message_id uuid default null
)
returns void
language plpgsql
security invoker
set search_path = public, app
as $$
declare
  v_actor_id uuid := app.current_actor_id();
begin
  if v_actor_id is null then
    raise exception 'no current actor' using errcode = '42501';
  end if;

  if not app.is_session_participant(p_session_id) then
    raise exception 'not a session participant' using errcode = '42501';
  end if;

  insert into public.session_read_markers (
    session_id,
    actor_id,
    last_read_at,
    last_read_message_id
  )
  values (
    p_session_id,
    v_actor_id,
    now(),
    p_last_read_message_id
  )
  on conflict (session_id, actor_id)
  do update set
    last_read_at = excluded.last_read_at,
    last_read_message_id = excluded.last_read_message_id;
end;
$$;

revoke all on function public.list_current_actor_sessions(integer, timestamptz) from public;
revoke all on function public.mark_current_actor_session_viewed(uuid, uuid) from public;
grant execute on function public.list_current_actor_sessions(integer, timestamptz) to authenticated;
grant execute on function public.mark_current_actor_session_viewed(uuid, uuid) to authenticated;

-- <<< END archived migration: 202605170001_session_read_markers.sql

-- >>> BEGIN archived migration: 202605170002_fix_gateway_session_rpc_ambiguity.sql

-- 2026-05-17: avoid PL/pgSQL output-column ambiguity in gateway session RPC.
--
-- `returns table (session_id ...)` exposes `session_id` as a PL/pgSQL
-- variable. An unqualified conflict target like `(session_id, actor_id)` can
-- therefore be parsed ambiguously inside the function body. Keep the public
-- return shape stable, but avoid bare column references in the body.

create or replace function public.ensure_gateway_session(
  p_team_id                  uuid,
  p_binding                  text,
  p_title                    text,
  p_primary_agent_actor_id   uuid,
  p_owner_member_actor_ids   uuid[],
  p_participant_actor_ids    uuid[]
)
returns table (session_id uuid, acp_session_id text, created boolean)
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_session uuid;
  v_acp     text;
  v_created boolean := false;
begin
  select s.id, s.acp_session_id
    into v_session, v_acp
    from public.sessions as s
   where s.team_id = p_team_id
     and s.binding = p_binding;

  if v_session is null then
    insert into public.sessions
      (team_id, idea_id, created_by_actor_id, primary_agent_id,
       mode, title, binding, acp_session_id)
    values
      (p_team_id,
       null,
       p_primary_agent_actor_id,
       p_primary_agent_actor_id,
       'collab',
       p_title,
       p_binding,
       encode(extensions.gen_random_bytes(16), 'hex'))
    returning public.sessions.id, public.sessions.acp_session_id
      into v_session, v_acp;
    v_created := true;

    insert into public.session_participants (session_id, actor_id)
      select v_session, participant_actor_id
        from unnest(
          array[p_primary_agent_actor_id]
            || coalesce(p_owner_member_actor_ids, '{}'::uuid[])
            || coalesce(p_participant_actor_ids,  '{}'::uuid[])
        ) as participant_actor_id
    on conflict on constraint session_participants_session_id_actor_id_key
    do nothing;
  end if;

  return query select v_session, v_acp, v_created;
end;
$$;

revoke all on function public.upsert_external_actor(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.upsert_external_actor(uuid, text, text, text) to authenticated;

revoke all on function public.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]) to authenticated;

-- <<< END archived migration: 202605170002_fix_gateway_session_rpc_ambiguity.sql

-- >>> BEGIN archived migration: 202605170003_fix_gateway_message_external_id_upsert.sql

-- 2026-05-17: make gateway message idempotency usable by PostgREST upsert.
--
-- PostgREST's `on_conflict=session_id,external_id` emits an ON CONFLICT
-- target without a predicate, so it cannot match the previous partial unique
-- index (`where external_id is not null`). A normal unique index still allows
-- multiple NULL external_id rows in Postgres, while allowing provider message
-- ids to dedupe correctly.

drop index if exists public.messages_session_external_id_uq;

create unique index messages_session_external_id_uq
  on public.messages (session_id, external_id);

-- <<< END archived migration: 202605170003_fix_gateway_message_external_id_upsert.sql

-- >>> BEGIN archived migration: 202605170004_gateway_agent_admin_owner_rpc.sql

-- 2026-05-17: let daemon-owned gateway sessions include human agent admins.
--
-- Daemon channel startup runs as the agent actor. RLS on agent_member_access
-- intentionally hides access rows from the agent, so direct REST SELECT can
-- return an empty owner list. This RPC allows the current agent to resolve its
-- own admin member actors for gateway session participant bootstrap.

create or replace function public.list_agent_admin_member_actor_ids(
  p_agent_actor_id uuid
)
returns table (member_actor_id uuid)
language sql
stable
security definer
set search_path = public, app
as $$
  select ama.member_id
    from public.agent_member_access as ama
    join public.agents as ag on ag.id = ama.agent_id
   where ama.agent_id = p_agent_actor_id
     and ama.permission_level = 'admin'
     and (
       p_agent_actor_id = app.current_actor_id()
       or ag.owner_member_id = app.current_member_id()
     )
   order by ama.created_at;
$$;

revoke all on function public.list_agent_admin_member_actor_ids(uuid) from public, anon, authenticated;
grant execute on function public.list_agent_admin_member_actor_ids(uuid) to authenticated;

-- Backfill existing gateway sessions so the current desktop session list can
-- see them without waiting for a fresh gateway session to be created.
insert into public.session_participants (session_id, actor_id)
select s.id, ama.member_id
  from public.sessions as s
  join public.agent_member_access as ama
    on ama.agent_id = s.primary_agent_id
   and ama.permission_level = 'admin'
 where s.binding is not null
   and split_part(s.binding, '://', 1) in ('discord', 'wecom', 'feishu', 'kook', 'wechat', 'email')
on conflict on constraint session_participants_session_id_actor_id_key
do nothing;

-- <<< END archived migration: 202605170004_gateway_agent_admin_owner_rpc.sql

-- >>> BEGIN archived migration: 202605170005_gateway_external_message_rls.sql

-- 2026-05-17: allow daemon gateways to record messages from external actors.
--
-- Gateway callbacks write the provider user as `messages.sender_actor_id`
-- (for example the WeCom external actor), while the authenticated JWT belongs
-- to the daemon agent. Keep the existing daemon self-write policy, and add a
-- narrow policy for gateway ingestion: the daemon agent and the sender must
-- both already be participants in the target session.

create or replace function app.current_jwt_kind()
returns text
language sql
stable
set search_path = public
as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb)->'app_metadata'->>'kind',
    ''
  );
$$;

create or replace function app.current_jwt_team_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select nullif(
    (current_setting('request.jwt.claims', true)::jsonb)->'app_metadata'->>'team_id',
    ''
  )::uuid;
$$;

create or replace function app.current_jwt_actor_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select nullif(
    (current_setting('request.jwt.claims', true)::jsonb)->'app_metadata'->>'actor_id',
    ''
  )::uuid;
$$;

create or replace function app.is_daemon()
returns boolean
language sql
stable
set search_path = public
as $$
  select app.current_jwt_kind() = 'daemon';
$$;

revoke all on function app.current_jwt_kind() from public, anon, authenticated;
revoke all on function app.current_jwt_team_id() from public, anon, authenticated;
revoke all on function app.current_jwt_actor_id() from public, anon, authenticated;
revoke all on function app.is_daemon() from public, anon, authenticated;
grant execute on function app.current_jwt_kind() to authenticated;
grant execute on function app.current_jwt_team_id() to authenticated;
grant execute on function app.current_jwt_actor_id() to authenticated;
grant execute on function app.is_daemon() to authenticated;

create or replace function app.daemon_can_write_gateway_message(
  p_team_id uuid,
  p_session_id uuid,
  p_sender_actor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select
    app.is_daemon()
    and p_team_id = app.current_jwt_team_id()
    and exists (
      select 1
        from public.sessions as s
       where s.id = p_session_id
         and s.team_id = p_team_id
    )
    and exists (
      select 1
        from public.session_participants as sp
       where sp.session_id = p_session_id
         and sp.actor_id = app.current_jwt_actor_id()
    )
    and exists (
      select 1
        from public.session_participants as sp
       where sp.session_id = p_session_id
         and sp.actor_id = p_sender_actor_id
    )
    and exists (
      select 1
        from public.actors as a
       where a.id = p_sender_actor_id
         and a.team_id = p_team_id
    );
$$;

revoke all on function app.daemon_can_write_gateway_message(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function app.daemon_can_write_gateway_message(uuid, uuid, uuid) to authenticated;

drop policy if exists messages_daemon_gateway_participant_write on public.messages;
create policy messages_daemon_gateway_participant_write on public.messages
for insert to authenticated
with check (
  app.daemon_can_write_gateway_message(team_id, session_id, sender_actor_id)
);

-- <<< END archived migration: 202605170005_gateway_external_message_rls.sql

-- >>> BEGIN archived migration: 202605170006_gateway_message_rls_memberships.sql

-- 2026-05-17: fix daemon_can_write_gateway_message to match the real JWT shape.
--
-- amux_access_token_hook writes actor info into app_metadata.memberships as
-- an array of {team_id, actor_id, actor_type}. The previous version of this
-- helper (migration 202605170005) read flat app_metadata.{kind,team_id,actor_id}
-- keys that the hook never produces, so every gateway INSERT was denied.
--
-- The check is: caller's JWT must own at least one agent-type membership in
-- the target team whose actor is a participant of the target session, and
-- the sender actor must also be a participant of that session.

create or replace function app.jwt_memberships()
returns jsonb
language sql stable
set search_path = public
as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb)
      -> 'app_metadata' -> 'memberships',
    '[]'::jsonb
  );
$$;

revoke all on function app.jwt_memberships() from public, anon, authenticated;
grant execute on function app.jwt_memberships() to authenticated;

create or replace function app.daemon_can_write_gateway_message(
  p_team_id uuid,
  p_session_id uuid,
  p_sender_actor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select
    exists (
      select 1
        from jsonb_array_elements(app.jwt_memberships()) as m
        join public.session_participants sp
          on sp.actor_id = nullif(m->>'actor_id', '')::uuid
       where nullif(m->>'team_id', '')::uuid = p_team_id
         and m->>'actor_type' = 'agent'
         and sp.session_id = p_session_id
    )
    and exists (
      select 1
        from public.session_participants sp
       where sp.session_id = p_session_id
         and sp.actor_id = p_sender_actor_id
    )
    and exists (
      select 1
        from public.sessions s
       where s.id = p_session_id
         and s.team_id = p_team_id
    )
    and exists (
      select 1
        from public.actors a
       where a.id = p_sender_actor_id
         and a.team_id = p_team_id
    );
$$;

revoke all on function app.daemon_can_write_gateway_message(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function app.daemon_can_write_gateway_message(uuid, uuid, uuid) to authenticated;

-- <<< END archived migration: 202605170006_gateway_message_rls_memberships.sql

-- >>> BEGIN archived migration: 20260517100001_rbac_tables.sql

-- 20260517100001_rbac_tables.sql
-- Generic team-scoped RBAC. Shortcuts is the first consumer; channels/agents
-- can adopt the same `permissions` registry later.

create table public.team_roles (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  code text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, code)
);

create table public.team_member_roles (
  id uuid primary key default gen_random_uuid(),
  team_id   uuid not null references public.teams(id)      on delete cascade,
  member_id uuid not null references public.members(id)    on delete cascade,
  role_id   uuid not null references public.team_roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (team_id, member_id, role_id)
);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  resource_type text not null,
  resource_id   uuid not null,
  code text not null,
  created_at timestamptz not null default now(),
  unique (team_id, resource_type, resource_id),
  unique (team_id, code)
);

create table public.permission_roles (
  id uuid primary key default gen_random_uuid(),
  permission_id uuid not null references public.permissions(id) on delete cascade,
  role_id       uuid not null references public.team_roles(id)  on delete cascade,
  created_at timestamptz not null default now(),
  unique (permission_id, role_id)
);

create index team_member_roles_member_idx on public.team_member_roles (team_id, member_id);
create index permissions_resource_idx     on public.permissions (team_id, resource_type, resource_id);
create index permission_roles_role_idx    on public.permission_roles (role_id);

alter table public.team_roles         enable row level security;
alter table public.team_member_roles  enable row level security;
alter table public.permissions        enable row level security;
alter table public.permission_roles   enable row level security;

-- <<< END archived migration: 20260517100001_rbac_tables.sql

-- >>> BEGIN archived migration: 20260517100002_shortcuts_table.sql

-- 20260517100002_shortcuts_table.sql
-- Personal + team shortcuts, tree via parent_id.
-- Visibility for team scope is governed by public.permissions (see RBAC tables).

create table public.shortcuts (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('personal','team')),
  owner_member_id uuid null references public.members(id) on delete cascade,
  team_id         uuid null references public.teams(id)    on delete cascade,
  parent_id       uuid null references public.shortcuts(id) on delete cascade,
  label text not null,
  icon text null,
  "order" int not null default 0,
  node_type text not null check (node_type in ('native','link','folder')),
  target text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shortcuts_scope_owner_xor check (
    (scope = 'personal' and owner_member_id is not null and team_id is null) or
    (scope = 'team'     and team_id        is not null and owner_member_id is null)
  )
);

create index shortcuts_personal_idx on public.shortcuts (owner_member_id) where scope = 'personal';
create index shortcuts_team_idx     on public.shortcuts (team_id)         where scope = 'team';
create index shortcuts_parent_idx   on public.shortcuts (parent_id);

alter table public.shortcuts enable row level security;

-- <<< END archived migration: 20260517100002_shortcuts_table.sql

-- >>> BEGIN archived migration: 20260517100003_rbac_shortcuts_helpers.sql

-- 20260517100003_rbac_shortcuts_helpers.sql
-- SECURITY DEFINER helpers used by RLS policies. They are explicitly
-- search_path-pinned (per services/supabase/migrations/202604220004_*).

create or replace function app.is_team_admin_or_owner(target_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select app.current_team_role(target_team_id) in ('owner','admin')
$$;

-- Open default: if no permission_roles bindings exist for the permission,
-- every team member can see the underlying resource. Otherwise, the current
-- member must hold at least one bound role.
create or replace function app.member_can_access_permission(target_permission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select case
    when not exists (
      select 1 from public.permission_roles where permission_id = target_permission_id
    ) then true
    else exists (
      select 1
      from public.permission_roles pr
      join public.team_member_roles tmr on tmr.role_id = pr.role_id
      where pr.permission_id = target_permission_id
        and tmr.member_id = app.current_member_id()
    )
  end
$$;

-- Visibility check used by shortcuts RLS for team-scope rows.
create or replace function app.member_can_see_shortcut(target_shortcut_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  with sc as (
    select scope, owner_member_id, team_id from public.shortcuts where id = target_shortcut_id
  )
  select case
    when (select scope from sc) = 'personal'
      then (select owner_member_id from sc) = app.current_member_id()
    when (select scope from sc) = 'team'
      then app.is_team_member((select team_id from sc))
       and app.member_can_access_permission((
         select id from public.permissions
         where team_id = (select team_id from sc)
           and resource_type = 'shortcut'
           and resource_id = target_shortcut_id
       ))
  end
$$;

revoke all on function app.is_team_admin_or_owner(uuid) from public;
revoke all on function app.member_can_access_permission(uuid) from public;
revoke all on function app.member_can_see_shortcut(uuid) from public;
grant execute on function app.is_team_admin_or_owner(uuid) to authenticated;
grant execute on function app.member_can_access_permission(uuid) to authenticated;
grant execute on function app.member_can_see_shortcut(uuid) to authenticated;

-- <<< END archived migration: 20260517100003_rbac_shortcuts_helpers.sql

-- >>> BEGIN archived migration: 20260517100004_rbac_shortcuts_rls.sql

-- 20260517100004_rbac_shortcuts_rls.sql

-- team_roles
create policy team_roles_select_if_member on public.team_roles
for select to authenticated
using (app.is_team_member(team_id));

create policy team_roles_write_if_admin on public.team_roles
for all to authenticated
using       (app.is_team_admin_or_owner(team_id))
with check  (app.is_team_admin_or_owner(team_id));

-- team_member_roles  (decision: SELECT open to all team members)
create policy team_member_roles_select_if_member on public.team_member_roles
for select to authenticated
using (app.is_team_member(team_id));

create policy team_member_roles_write_if_admin on public.team_member_roles
for all to authenticated
using       (app.is_team_admin_or_owner(team_id))
with check  (app.is_team_admin_or_owner(team_id));

-- permissions
create policy permissions_select_if_member on public.permissions
for select to authenticated
using (app.is_team_member(team_id));

create policy permissions_write_if_admin on public.permissions
for all to authenticated
using       (app.is_team_admin_or_owner(team_id))
with check  (app.is_team_admin_or_owner(team_id));

-- permission_roles  (team reached via permissions)
create policy permission_roles_select_if_member on public.permission_roles
for select to authenticated
using (exists (
  select 1 from public.permissions p
  where p.id = permission_roles.permission_id
    and app.is_team_member(p.team_id)
));

create policy permission_roles_write_if_admin on public.permission_roles
for all to authenticated
using (exists (
  select 1 from public.permissions p
  where p.id = permission_roles.permission_id
    and app.is_team_admin_or_owner(p.team_id)
))
with check (exists (
  select 1 from public.permissions p
  where p.id = permission_roles.permission_id
    and app.is_team_admin_or_owner(p.team_id)
));

-- shortcuts
create policy shortcuts_select_personal on public.shortcuts
for select to authenticated
using (
  scope = 'personal' and owner_member_id = app.current_member_id()
);

create policy shortcuts_select_team on public.shortcuts
for select to authenticated
using (
  scope = 'team' and app.member_can_see_shortcut(id)
);

create policy shortcuts_write_personal on public.shortcuts
for all to authenticated
using       (scope = 'personal' and owner_member_id = app.current_member_id())
with check  (scope = 'personal' and owner_member_id = app.current_member_id());

create policy shortcuts_write_team on public.shortcuts
for all to authenticated
using       (scope = 'team' and app.is_team_admin_or_owner(team_id))
with check  (scope = 'team' and app.is_team_admin_or_owner(team_id));

-- <<< END archived migration: 20260517100004_rbac_shortcuts_rls.sql

-- >>> BEGIN archived migration: 20260517100005_rbac_shortcuts_rpcs.sql

-- 20260517100005_rbac_shortcuts_rpcs.sql

-- 1) Create shortcut. Team scope also inserts the permissions registry row
--    in the same tx.
create or replace function public.shortcut_create(
  p_scope text,
  p_label text,
  p_node_type text,
  p_team_id uuid default null,
  p_parent_id uuid default null,
  p_icon text default null,
  p_order int default 0,
  p_target text default ''
) returns uuid
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_id uuid;
  v_member uuid := app.current_member_id();
begin
  if v_member is null then
    raise exception 'not authenticated';
  end if;

  if p_scope = 'personal' then
    insert into public.shortcuts (scope, owner_member_id, parent_id, label, icon, "order", node_type, target)
    values ('personal', v_member, p_parent_id, p_label, p_icon, p_order, p_node_type, p_target)
    returning id into v_id;
  elsif p_scope = 'team' then
    if p_team_id is null then
      raise exception 'team_id required for team scope';
    end if;
    if not app.is_team_admin_or_owner(p_team_id) then
      raise exception 'forbidden';
    end if;
    insert into public.shortcuts (scope, team_id, parent_id, label, icon, "order", node_type, target)
    values ('team', p_team_id, p_parent_id, p_label, p_icon, p_order, p_node_type, p_target)
    returning id into v_id;
    insert into public.permissions (team_id, resource_type, resource_id, code)
    values (p_team_id, 'shortcut', v_id, 'shortcut:' || v_id::text);
  else
    raise exception 'invalid scope: %', p_scope;
  end if;

  return v_id;
end $$;

-- 2) Drag/drop batch reorder. Single tx.
create or replace function public.shortcut_batch_move(
  p_moves jsonb   -- [{"id":"...","parent_id":"..."|null,"order":3}, ...]
) returns int
language plpgsql
security definer
set search_path = public, app
as $$
declare v_count int;
begin
  update public.shortcuts s set
    parent_id  = nullif(m->>'parent_id','')::uuid,
    "order"    = (m->>'order')::int,
    updated_at = now()
  from jsonb_array_elements(p_moves) m
  where s.id = (m->>'id')::uuid
    and (
      (s.scope = 'personal' and s.owner_member_id = app.current_member_id())
      or (s.scope = 'team'  and app.is_team_admin_or_owner(s.team_id))
    );
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- 3) Set the FULL set of roles that can see a team shortcut (swap-in).
create or replace function public.shortcut_set_visible_roles(
  p_shortcut_id uuid,
  p_role_ids uuid[]
) returns void
language plpgsql
security definer
set search_path = public, app
as $$
declare v_team uuid; v_perm uuid;
begin
  select team_id into v_team from public.shortcuts
    where id = p_shortcut_id and scope = 'team';
  if v_team is null then
    raise exception 'shortcut not found or not team-scoped';
  end if;
  if not app.is_team_admin_or_owner(v_team) then
    raise exception 'forbidden';
  end if;
  select id into v_perm from public.permissions
    where team_id = v_team and resource_type = 'shortcut' and resource_id = p_shortcut_id;
  if v_perm is null then
    raise exception 'permission row missing for shortcut %', p_shortcut_id;
  end if;
  delete from public.permission_roles where permission_id = v_perm;
  if array_length(p_role_ids, 1) is not null then
    insert into public.permission_roles (permission_id, role_id)
      select v_perm, unnest(p_role_ids);
  end if;
end $$;

-- 4) Set the FULL set of custom roles a member holds (swap-in).
create or replace function public.team_member_set_roles(
  p_team_id uuid,
  p_member_id uuid,
  p_role_ids uuid[]
) returns void
language plpgsql
security definer
set search_path = public, app
as $$
begin
  if not app.is_team_admin_or_owner(p_team_id) then
    raise exception 'forbidden';
  end if;
  delete from public.team_member_roles
    where team_id = p_team_id and member_id = p_member_id;
  if array_length(p_role_ids, 1) is not null then
    insert into public.team_member_roles (team_id, member_id, role_id)
      select p_team_id, p_member_id, unnest(p_role_ids);
  end if;
end $$;

-- Trigger: when a team shortcut is deleted, also delete its permissions row.
-- (No FK in that direction since permissions is polymorphic via resource_id.)
create or replace function app.cleanup_shortcut_permission()
returns trigger
language plpgsql
security definer
set search_path = public, app
as $$
begin
  if old.scope = 'team' then
    delete from public.permissions
      where team_id = old.team_id
        and resource_type = 'shortcut'
        and resource_id = old.id;
  end if;
  return old;
end $$;

create trigger shortcuts_cleanup_permission_after_delete
  after delete on public.shortcuts
  for each row execute function app.cleanup_shortcut_permission();

revoke all on function public.shortcut_create(text,text,text,uuid,uuid,text,int,text)        from public;
revoke all on function public.shortcut_batch_move(jsonb)                                     from public;
revoke all on function public.shortcut_set_visible_roles(uuid,uuid[])                        from public;
revoke all on function public.team_member_set_roles(uuid,uuid,uuid[])                        from public;
grant execute on function public.shortcut_create(text,text,text,uuid,uuid,text,int,text)     to authenticated;
grant execute on function public.shortcut_batch_move(jsonb)                                  to authenticated;
grant execute on function public.shortcut_set_visible_roles(uuid,uuid[])                     to authenticated;
grant execute on function public.team_member_set_roles(uuid,uuid,uuid[])                     to authenticated;

-- <<< END archived migration: 20260517100005_rbac_shortcuts_rpcs.sql

-- >>> BEGIN archived migration: 20260517110001_push_notifications.sql

-- 2026-05-17: push notifications foundation
-- Five tables + RLS for: device tokens, global prefs, per-session mute,
-- foreground presence heartbeat, dispatch idempotency.

create table public.device_push_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  device_id    text not null,
  platform     text not null check (platform in ('ios','android','desktop')),
  provider     text not null check (provider in ('apns','jpush','tauri')),
  token        text not null,
  app_version  text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  unique (user_id, device_id, provider)
);
create index if not exists device_push_tokens_user_active_idx
  on public.device_push_tokens (user_id) where revoked_at is null;

create table public.notification_prefs (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  enabled       boolean not null default true,
  dnd_start_min smallint check (dnd_start_min between 0 and 1439),
  dnd_end_min   smallint check (dnd_end_min between 0 and 1439),
  dnd_tz        text not null default 'Asia/Shanghai',
  updated_at    timestamptz not null default now()
);

create table public.session_mutes (
  user_id    uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  muted_at   timestamptz not null default now(),
  primary key (user_id, session_id)
);

create table public.client_presence (
  user_id          uuid not null references auth.users(id) on delete cascade,
  device_id        text not null,
  foreground_until timestamptz not null,
  primary key (user_id, device_id)
);

create table public.push_idempotency (
  message_id uuid primary key references public.messages(id) on delete cascade,
  claimed_at timestamptz not null default now()
);
create index if not exists push_idempotency_claimed_at_idx
  on public.push_idempotency(claimed_at);

-- RLS: every table is owner-only for authenticated reads/writes.
-- FC uses service-role key which bypasses RLS.

alter table public.device_push_tokens enable row level security;
create policy device_push_tokens_owner on public.device_push_tokens
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.notification_prefs enable row level security;
create policy notification_prefs_owner on public.notification_prefs
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.session_mutes enable row level security;
create policy session_mutes_owner on public.session_mutes
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.client_presence enable row level security;
create policy client_presence_owner on public.client_presence
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.push_idempotency enable row level security;
-- No authenticated policy: only service-role FC may touch this table.

-- Returns a single jsonb object:
--   { sender_display_name: text,
--     recipients: [{ user_id, tokens, prefs, presence, muted }, ...] }
create or replace function public.list_session_push_targets(
  p_session_id uuid,
  p_exclude_actor_id uuid
) returns jsonb
  language sql security definer
  set search_path = public
as $$
  with sender as (
    select coalesce(display_name, 'Someone') as display_name
      from public.actors where id = p_exclude_actor_id
  ),
  recipients as (
    select
      a.user_id,
      coalesce(
        (select jsonb_agg(jsonb_build_object(
            'provider', dpt.provider,
            'token',    dpt.token,
            'device_id', dpt.device_id))
           from public.device_push_tokens dpt
          where dpt.user_id = a.user_id
            and dpt.revoked_at is null),
        '[]'::jsonb
      ) as tokens,
      coalesce(
        (select to_jsonb(np)
           from public.notification_prefs np
          where np.user_id = a.user_id),
        jsonb_build_object('enabled', true)
      ) as prefs,
      coalesce(
        (select jsonb_agg(jsonb_build_object(
            'device_id',        cp.device_id,
            'foreground_until', cp.foreground_until))
           from public.client_presence cp
          where cp.user_id = a.user_id
            and cp.foreground_until > now()),
        '[]'::jsonb
      ) as presence,
      exists(
        select 1 from public.session_mutes sm
         where sm.user_id = a.user_id
           and sm.session_id = p_session_id
      ) as muted
    from public.session_participants sp
    join public.actors a on a.id = sp.actor_id
    where sp.session_id = p_session_id
      and sp.actor_id <> p_exclude_actor_id
      and a.user_id is not null
      and a.actor_type = 'member'
  )
  select jsonb_build_object(
    'sender_display_name', (select display_name from sender),
    'recipients', coalesce(
       (select jsonb_agg(to_jsonb(r)) from recipients r),
       '[]'::jsonb)
  );
$$;

revoke all on function public.list_session_push_targets(uuid, uuid) from public, anon, authenticated;
-- Only service-role may call (FC uses service-role).

create or replace function public.push_idempotency_claim(p_message_id uuid)
returns table(claimed boolean)
  language plpgsql security definer
  set search_path = public
as $$
begin
  insert into public.push_idempotency(message_id) values (p_message_id)
  on conflict do nothing;
  return query select found;
end;
$$;

revoke all on function public.push_idempotency_claim(uuid) from public, anon, authenticated;

-- <<< END archived migration: 20260517110001_push_notifications.sql

-- >>> BEGIN archived migration: 20260518030001_session_list_v2_upgrade.sql

-- Upgrade `list_current_actor_sessions` to keyset pagination + session archive.
--
-- 202605170001 deployed the v1 shape (single-cursor, 3-col index, no archive).
-- The v2 frontend (single source of truth) calls the RPC with the keyset
-- triple (last_message_at, created_at, id) and renders archived sessions
-- separately, so the deployed function/index need to be replaced in lock-step
-- with the column add.

alter table public.sessions
  add column if not exists archived_at timestamptz null;

drop index if exists sessions_team_last_message_idx;

create index if not exists sessions_team_last_message_idx
  on public.sessions (team_id, last_message_at desc nulls first, created_at desc, id desc);

create index if not exists sessions_team_active_last_message_idx
  on public.sessions (team_id, last_message_at desc nulls first, created_at desc, id desc)
  where archived_at is null;

drop function if exists public.list_current_actor_sessions(integer, timestamptz);

create or replace function public.list_current_actor_sessions(
  p_limit integer default 50,
  p_before_last_message_at timestamptz default null,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null
)
returns table (
  id uuid,
  title text,
  team_id uuid,
  mode text,
  idea_id uuid,
  last_message_at timestamptz,
  last_message_preview text,
  created_at timestamptz,
  updated_at timestamptz,
  has_unread boolean
)
language sql
stable
security invoker
set search_path = public, app
as $$
  with current_actor as (
    select app.current_actor_id() as actor_id
  )
  select
    s.id,
    s.title,
    s.team_id,
    s.mode,
    s.idea_id,
    s.last_message_at,
    s.last_message_preview,
    s.created_at,
    s.updated_at,
    (
      s.last_message_at is not null
      and s.last_message_at > coalesce(srm.last_read_at, '-infinity'::timestamptz)
    ) as has_unread
  from public.sessions s
  cross join current_actor ca
  left join public.session_read_markers srm
    on srm.session_id = s.id
   and srm.actor_id = ca.actor_id
  where app.is_session_participant(s.id)
    and s.archived_at is null
    and (
      p_before_id is null
      or (
        case
          when p_before_last_message_at is null then
            s.last_message_at is not null
            or (
              s.last_message_at is null
              and (
                s.created_at < p_before_created_at
                or (s.created_at = p_before_created_at and s.id < p_before_id)
              )
            )
          when s.last_message_at is null then false
          when s.last_message_at < p_before_last_message_at then true
          when s.last_message_at = p_before_last_message_at then
            s.created_at < p_before_created_at
            or (s.created_at = p_before_created_at and s.id < p_before_id)
          else false
        end
      )
    )
  order by
    s.last_message_at desc nulls first,
    s.created_at desc,
    s.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

revoke all on function public.list_current_actor_sessions(integer, timestamptz, timestamptz, uuid) from public;
grant execute on function public.list_current_actor_sessions(integer, timestamptz, timestamptz, uuid) to authenticated;

-- <<< END archived migration: 20260518030001_session_list_v2_upgrade.sql

-- >>> BEGIN archived migration: 20260518100001_agent_defaults.sql

-- Per-agent defaults: surface agents.default_workspace_id in actor_directory
-- and add an RPC any teammate can call to update an agent's
-- default_workspace_id and agent_kind. Lets iOS new-session flow skip the
-- workspace/agent-type picker by using each agent's preconfigured defaults.

begin;

-- ===========================================================================
-- 1. Re-create actor_directory to include default_workspace_id
-- ===========================================================================
drop view if exists public.actor_directory;

create view public.actor_directory
  with (security_invoker = true)
as
select
  a.id, a.team_id, a.actor_type, a.user_id, a.invited_by_actor_id,
  a.display_name, a.avatar_url, a.last_active_at, a.created_at, a.updated_at,
  m.status      as member_status,
  tm.role       as team_role,
  ag.agent_kind as agent_kind,
  ag.status     as agent_status,
  ag.default_workspace_id as default_workspace_id
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id
where a.actor_type <> 'agent'
   or ag.visibility = 'team';

grant select on public.actor_directory to authenticated;

-- ===========================================================================
-- 2. Keep update_current_actor_profile returning the new column too so
--    callers that decode actor_directory rows from it stay consistent.
-- ===========================================================================
-- Drop first: adding default_workspace_id changes the RETURNS TABLE shape,
-- which `create or replace` is not allowed to do for set-returning fns.
drop function if exists public.update_current_actor_profile(uuid, text, text);

create or replace function public.update_current_actor_profile(
  p_actor_id uuid,
  p_display_name text,
  p_avatar_url text default null
)
returns table (
  id uuid,
  team_id uuid,
  actor_type text,
  user_id uuid,
  invited_by_actor_id uuid,
  display_name text,
  avatar_url text,
  last_active_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  member_status text,
  team_role text,
  agent_kind text,
  agent_status text,
  default_workspace_id uuid
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_display_name text := nullif(btrim(p_display_name), '');
  v_avatar_url text := nullif(btrim(coalesce(p_avatar_url, '')), '');
begin
  if v_display_name is null then
    raise exception 'display name is required'
      using errcode = '23514';
  end if;

  update public.actors a
     set display_name = v_display_name,
         avatar_url = v_avatar_url,
         updated_at = now()
   where a.id = p_actor_id
     and a.actor_type = 'member'
     and a.user_id = auth.uid();

  if not found then
    raise exception 'actor profile update is not allowed'
      using errcode = '42501';
  end if;

  return query
  select
    ad.id, ad.team_id, ad.actor_type, ad.user_id, ad.invited_by_actor_id,
    ad.display_name, ad.avatar_url, ad.last_active_at, ad.created_at, ad.updated_at,
    ad.member_status, ad.team_role, ad.agent_kind, ad.agent_status,
    ad.default_workspace_id
  from public.actor_directory ad
  where ad.id = p_actor_id;
end;
$$;

revoke all on function public.update_current_actor_profile(uuid, text, text) from public;
grant execute on function public.update_current_actor_profile(uuid, text, text) to authenticated;

-- ===========================================================================
-- 3. update_agent_defaults — any teammate can set an agent's
--    default workspace + agent_kind. Both args are optional; nulls leave
--    the existing value untouched (use a sentinel-less coalesce because
--    'clearing' a default is rare and reachable via member workspace
--    deletion which already nulls the FK via ON DELETE SET NULL).
-- ===========================================================================
create or replace function public.update_agent_defaults(
  p_agent_id uuid,
  p_default_workspace_id uuid default null,
  p_agent_kind text default null
)
returns table (
  agent_id uuid,
  default_workspace_id uuid,
  agent_kind text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_team_id     uuid;
  v_caller      uuid := auth.uid();
  v_new_kind    text := nullif(btrim(coalesce(p_agent_kind, '')), '');
begin
  if v_caller is null then
    raise exception 'update_agent_defaults requires authentication'
      using errcode = '42501';
  end if;

  select a.team_id into v_team_id
    from public.actors a
   where a.id = p_agent_id and a.actor_type = 'agent';

  if v_team_id is null then
    raise exception 'agent not found' using errcode = '23503';
  end if;

  -- Caller must be a teammate of the agent (any role).
  if not app.is_team_member(v_team_id) then
    raise exception 'caller is not a member of the agent team'
      using errcode = '42501';
  end if;

  -- Workspace, if specified, must belong to the same team.
  if p_default_workspace_id is not null then
    if not exists (
      select 1 from public.workspaces w
       where w.id = p_default_workspace_id and w.team_id = v_team_id
    ) then
      raise exception 'workspace is not in the agent team'
        using errcode = '23514';
    end if;
  end if;

  update public.agents ag
     set default_workspace_id = coalesce(p_default_workspace_id, ag.default_workspace_id),
         agent_kind           = coalesce(v_new_kind, ag.agent_kind),
         updated_at           = now()
   where ag.id = p_agent_id;

  if not found then
    raise exception 'agent row missing' using errcode = '23503';
  end if;

  return query
  select ag.id, ag.default_workspace_id, ag.agent_kind
    from public.agents ag
   where ag.id = p_agent_id;
end;
$$;

revoke all on function public.update_agent_defaults(uuid, uuid, text) from public;
grant execute on function public.update_agent_defaults(uuid, uuid, text) to authenticated;

commit;

-- <<< END archived migration: 20260518100001_agent_defaults.sql

-- >>> BEGIN archived migration: 20260519110001_push_dispatch_webhook.sql

-- Enable pg_net for async HTTP calls from triggers
create extension if not exists pg_net with schema net;

-- Trigger function: fires on messages INSERT, calls FC /push/dispatch
-- Reads webhook secret from vault so no plaintext secret in migration.
create or replace function public.notify_push_dispatch()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'push_webhook_secret'
   limit 1;

  -- Silently skip if secret not configured yet
  if v_secret is null then
    return new;
  end if;

  perform net.http_post(
    url     := 'https://cloud.ucar.cc/push/dispatch',
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'x-webhook-secret', v_secret
    ),
    body    := jsonb_build_object(
      'type',   'INSERT',
      'table',  'messages',
      'record', row_to_json(new)
    )
  );

  return new;
end;
$$;

revoke all on function public.notify_push_dispatch() from public, anon, authenticated;

create trigger messages_push_dispatch
  after insert on public.messages
  for each row execute function public.notify_push_dispatch();

-- <<< END archived migration: 20260519110001_push_dispatch_webhook.sql

-- >>> BEGIN archived migration: 20260520000001_agent_default_type.sql

-- Add dedicated default_agent_type column to agents.
--
-- agent_kind  = runner/host type ('daemon' | 'cli')
-- default_agent_type = preferred LLM backend ('opencode' | 'codex' | 'claude_code')
--
-- Previously agent_kind was overloaded with both meanings.  This migration
-- splits them: adds the new column, backfills from the old mixed values, and
-- resets any agent_kind that was used as a backend preference back to 'daemon'.

begin;

-- ===========================================================================
-- 1. Add column
-- ===========================================================================
alter table public.agents
  add column if not exists default_agent_type text
    check (default_agent_type in ('opencode', 'codex', 'claude_code'));

comment on column public.agents.agent_kind is
  'Runner/host type for this agent. Canonical values: ''daemon'' (amuxd-hosted), ''cli'' (server CLI). Does not indicate which LLM backend is preferred — see default_agent_type.';

comment on column public.agents.default_agent_type is
  'Preferred LLM backend when no explicit agent type is requested. Canonical values: ''opencode'', ''codex'', ''claude_code''. Null means use the daemon''s compiled-in default (currently opencode). Stored separately from agent_kind so agent_kind can remain a stable runner descriptor.';

comment on column public.agents.capabilities is
  'Reserved for future use: extensible JSONB config, e.g. a list of supported_backends the agent advertises, feature flags, or per-backend overrides. Not used for backend selection today — use default_agent_type instead.';

-- ===========================================================================
-- 2. Backfill: move backend-preference values out of agent_kind
--    'claude'   → default_agent_type = 'claude_code', agent_kind = 'daemon'
--    'opencode' → default_agent_type = 'opencode',    agent_kind = 'daemon'
-- ===========================================================================
update public.agents
   set default_agent_type = case agent_kind
                              when 'claude'    then 'claude_code'
                              when 'opencode'  then 'opencode'
                            end,
       agent_kind         = 'daemon',
       updated_at         = now()
 where agent_kind in ('claude', 'opencode');

-- ===========================================================================
-- 3. Re-create actor_directory view to expose default_agent_type
-- ===========================================================================
drop view if exists public.actor_directory;

create view public.actor_directory
  with (security_invoker = true)
as
select
  a.id, a.team_id, a.actor_type, a.user_id, a.invited_by_actor_id,
  a.display_name, a.avatar_url, a.last_active_at, a.created_at, a.updated_at,
  m.status      as member_status,
  tm.role       as team_role,
  ag.agent_kind,
  ag.default_agent_type,
  ag.status     as agent_status,
  ag.default_workspace_id
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id
where a.actor_type <> 'agent'
   or ag.visibility = 'team';

grant select on public.actor_directory to authenticated;

-- ===========================================================================
-- 4. Update update_agent_defaults RPC: add p_default_agent_type parameter
-- ===========================================================================
create or replace function public.update_agent_defaults(
  p_agent_id             uuid,
  p_default_workspace_id uuid    default null,
  p_agent_kind           text    default null,
  p_default_agent_type   text    default null
)
returns table (
  agent_id             uuid,
  default_workspace_id uuid,
  agent_kind           text,
  default_agent_type   text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_team_id          uuid;
  v_caller           uuid := auth.uid();
  v_new_kind         text := nullif(btrim(coalesce(p_agent_kind, '')), '');
  v_new_backend      text := nullif(btrim(coalesce(p_default_agent_type, '')), '');
begin
  if v_caller is null then
    raise exception 'update_agent_defaults requires authentication'
      using errcode = '42501';
  end if;

  select a.team_id into v_team_id
    from public.actors a
   where a.id = p_agent_id and a.actor_type = 'agent';

  if v_team_id is null then
    raise exception 'agent not found' using errcode = '23503';
  end if;

  if not app.is_team_member(v_team_id) then
    raise exception 'caller is not a member of the agent team'
      using errcode = '42501';
  end if;

  if p_default_workspace_id is not null then
    if not exists (
      select 1 from public.workspaces w
       where w.id = p_default_workspace_id and w.team_id = v_team_id
    ) then
      raise exception 'workspace is not in the agent team'
        using errcode = '23514';
    end if;
  end if;

  if v_new_backend is not null
     and v_new_backend not in ('opencode', 'codex', 'claude_code') then
    raise exception 'invalid default_agent_type: must be opencode, codex, or claude_code'
      using errcode = '23514';
  end if;

  update public.agents ag
     set default_workspace_id = coalesce(p_default_workspace_id, ag.default_workspace_id),
         agent_kind           = coalesce(v_new_kind, ag.agent_kind),
         default_agent_type   = coalesce(v_new_backend, ag.default_agent_type),
         updated_at           = now()
   where ag.id = p_agent_id;

  if not found then
    raise exception 'agent row missing' using errcode = '23503';
  end if;

  return query
  select ag.id, ag.default_workspace_id, ag.agent_kind, ag.default_agent_type
    from public.agents ag
   where ag.id = p_agent_id;
end;
$$;

revoke all on function public.update_agent_defaults(uuid, uuid, text, text) from public;
grant execute on function public.update_agent_defaults(uuid, uuid, text, text) to authenticated;

commit;

-- <<< END archived migration: 20260520000001_agent_default_type.sql

-- >>> BEGIN archived migration: 20260522000001_agent_types.sql

-- Move backend capability off agents.agent_kind.
--
-- agents.agent_types        = JSON array of supported runtime backend types.
-- agents.default_agent_type = default backend type selected at runtime start.
-- agent_runtimes.backend_type remains the actual backend used by that spawn.

begin;

alter table public.agents
  add column if not exists agent_types jsonb not null default '[]'::jsonb;

alter table public.agents
  drop constraint if exists agents_default_agent_type_check;

update public.agents
   set default_agent_type = 'claude',
       updated_at = now()
 where default_agent_type = 'claude_code';

update public.agents
   set agent_types = (
         select coalesce(jsonb_agg(distinct t), '[]'::jsonb)
           from (
             select case
                      when default_agent_type = 'claude_code' then 'claude'
                      when default_agent_type in ('claude', 'opencode', 'codex') then default_agent_type
                    end as t
             union all
             select case
                      when agent_kind in ('claude', 'claude_code') then 'claude'
                      when agent_kind in ('opencode', 'codex') then agent_kind
                    end as t
           ) s
          where t is not null
       ),
       updated_at = now()
 where agent_types = '[]'::jsonb
   and (
     default_agent_type in ('claude', 'claude_code', 'opencode', 'codex')
     or agent_kind in ('claude', 'claude_code', 'opencode', 'codex')
   );

alter table public.agents
  add constraint agents_default_agent_type_check
  check (default_agent_type is null or default_agent_type in ('claude', 'opencode', 'codex', 'pi'));

alter table public.agents
  add constraint agents_agent_types_array_check
  check (jsonb_typeof(agent_types) = 'array');

comment on column public.agents.agent_types is
  'Supported runtime backend types for this agent as a JSON array, e.g. ["claude","opencode","codex"]. Empty means the daemon has not advertised support yet.';

comment on column public.agents.default_agent_type is
  'Preferred runtime backend type when no explicit agent type is requested. Canonical values match agent_runtimes.backend_type: claude, opencode, codex.';

drop view if exists public.actor_directory;

create view public.actor_directory
  with (security_invoker = true)
as
select
  a.id, a.team_id, a.actor_type, a.user_id, a.invited_by_actor_id,
  a.display_name, a.avatar_url, a.last_active_at, a.created_at, a.updated_at,
  m.status      as member_status,
  tm.role       as team_role,
  ag.agent_types,
  ag.default_agent_type,
  ag.default_workspace_id,
  ag.status     as agent_status
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id
where a.actor_type <> 'agent'
   or ag.visibility = 'team';

grant select on public.actor_directory to authenticated;

drop function if exists public.update_current_actor_profile(uuid, text, text);

create function public.update_current_actor_profile(
  p_actor_id uuid,
  p_display_name text,
  p_avatar_url text default null
)
returns table (
  id uuid,
  team_id uuid,
  actor_type text,
  user_id uuid,
  invited_by_actor_id uuid,
  display_name text,
  avatar_url text,
  last_active_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  member_status text,
  team_role text,
  agent_types jsonb,
  default_agent_type text,
  agent_status text,
  default_workspace_id uuid
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_display_name text := nullif(btrim(p_display_name), '');
  v_avatar_url text := nullif(btrim(coalesce(p_avatar_url, '')), '');
begin
  if v_display_name is null then
    raise exception 'display name is required'
      using errcode = '23514';
  end if;

  update public.actors a
     set display_name = v_display_name,
         avatar_url = v_avatar_url,
         updated_at = now()
   where a.id = p_actor_id
     and a.actor_type = 'member'
     and a.user_id = auth.uid();

  if not found then
    raise exception 'actor profile update is not allowed'
      using errcode = '42501';
  end if;

  return query
  select
    ad.id, ad.team_id, ad.actor_type, ad.user_id, ad.invited_by_actor_id,
    ad.display_name, ad.avatar_url, ad.last_active_at, ad.created_at, ad.updated_at,
    ad.member_status, ad.team_role, ad.agent_types, ad.default_agent_type,
    ad.agent_status, ad.default_workspace_id
  from public.actor_directory ad
  where ad.id = p_actor_id;
end;
$$;

revoke all on function public.update_current_actor_profile(uuid, text, text) from public;
grant execute on function public.update_current_actor_profile(uuid, text, text) to authenticated;

drop function if exists public.update_agent_defaults(uuid, uuid, text, text);
drop function if exists public.update_agent_defaults(uuid, uuid, text);

create function public.update_agent_defaults(
  p_agent_id             uuid,
  p_default_workspace_id uuid    default null,
  p_agent_kind           text    default null,
  p_default_agent_type   text    default null
)
returns table (
  agent_id             uuid,
  default_workspace_id uuid,
  agent_types          jsonb,
  default_agent_type   text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_team_id          uuid;
  v_caller           uuid := auth.uid();
  v_new_backend      text := nullif(btrim(coalesce(p_default_agent_type, '')), '');
begin
  if v_caller is null then
    raise exception 'update_agent_defaults requires authentication'
      using errcode = '42501';
  end if;

  select a.team_id into v_team_id
    from public.actors a
   where a.id = p_agent_id and a.actor_type = 'agent';

  if v_team_id is null then
    raise exception 'agent not found' using errcode = '23503';
  end if;

  if not app.is_team_member(v_team_id) then
    raise exception 'caller is not a member of the agent team'
      using errcode = '42501';
  end if;

  if p_default_workspace_id is not null then
    if not exists (
      select 1 from public.workspaces w
       where w.id = p_default_workspace_id and w.team_id = v_team_id
    ) then
      raise exception 'workspace is not in the agent team'
        using errcode = '23514';
    end if;
  end if;

  if v_new_backend in ('claude_code', 'claude-code') then
    v_new_backend := 'claude';
  end if;

  if v_new_backend is not null
     and v_new_backend not in ('opencode', 'codex', 'claude', 'pi') then
    raise exception 'invalid default_agent_type: must be opencode, codex, claude, or pi'
      using errcode = '23514';
  end if;

  if v_new_backend is not null and not exists (
    select 1 from public.agents ag, jsonb_array_elements_text(ag.agent_types) t(value)
     where ag.id = p_agent_id and t.value = v_new_backend
  ) then
    raise exception 'default_agent_type must be one of agent_types'
      using errcode = '23514';
  end if;

  update public.agents ag
     set default_workspace_id = coalesce(p_default_workspace_id, ag.default_workspace_id),
         default_agent_type   = coalesce(v_new_backend, ag.default_agent_type),
         updated_at           = now()
   where ag.id = p_agent_id;

  if not found then
    raise exception 'agent row missing' using errcode = '23503';
  end if;

  return query
  select ag.id, ag.default_workspace_id, ag.agent_types, ag.default_agent_type
    from public.agents ag
   where ag.id = p_agent_id;
end;
$$;

revoke all on function public.update_agent_defaults(uuid, uuid, text, text) from public;
grant execute on function public.update_agent_defaults(uuid, uuid, text, text) to authenticated;

create or replace function public.list_connected_agents(p_team_id uuid)
returns table (
  agent_id uuid,
  display_name text,
  agent_types jsonb,
  default_agent_type text,
  permission_level text,
  visibility text,
  is_owner boolean,
  device_id text,
  last_active_at timestamptz
)
language sql
security definer
set search_path = public, auth
as $$
  select
    ag.id as agent_id,
    a.display_name,
    ag.agent_types,
    ag.default_agent_type,
    coalesce(ama.permission_level, case when app.is_team_member(p_team_id) then 'view' end) as permission_level,
    ag.visibility,
    ag.owner_member_id = app.current_member_id() as is_owner,
    ag.device_id,
    a.last_active_at
  from public.agents ag
  join public.actors a on a.id = ag.id
  left join public.agent_member_access ama
    on ama.agent_id = ag.id
   and ama.member_id = app.current_member_id()
  where a.team_id = p_team_id
    and ag.status = 'active'
    and (
      ag.visibility = 'team'
      or ag.owner_member_id = app.current_member_id()
      or ama.member_id is not null
    )
$$;

revoke all on function public.list_connected_agents(uuid) from public;
grant execute on function public.list_connected_agents(uuid) to authenticated;

create or replace function public.claim_team_invite(
  p_token text
)
returns table (
  actor_id      uuid,
  team_id       uuid,
  actor_type    text,
  display_name  text,
  refresh_token text
)
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_invite     public.team_invites%rowtype;
  v_user_id    uuid;
  v_actor      uuid;
  v_email      text;
  v_session    uuid;
  v_rt         text := null;
  v_old_user   uuid;
  v_target_anon boolean;
begin
  select * into v_invite
    from public.team_invites where token = p_token
    for update;

  if not found then
    raise exception 'invite not found' using errcode = '23503';
  end if;
  if v_invite.consumed_at is not null then
    raise exception 'invite already consumed' using errcode = '23514';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'invite expired' using errcode = '23514';
  end if;

  if v_invite.kind = 'member' then
    if v_invite.target_actor_id is not null then
      select user_id into v_user_id
        from public.actors where id = v_invite.target_actor_id;
      if v_user_id is null then
        raise exception 'target member has no auth user'
          using errcode = '23503';
      end if;

      select coalesce(is_anonymous, false) into v_target_anon
        from auth.users where id = v_user_id;
      if not v_target_anon then
        raise exception 'target member is no longer anonymous'
          using errcode = '23514';
      end if;

      v_session := gen_random_uuid();
      v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);

      insert into auth.sessions (id, user_id, aal, created_at, updated_at)
      values (v_session, v_user_id, 'aal1', now(), now());

      insert into auth.refresh_tokens
        (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
      values
        (v_rt, v_user_id::text, v_session, false,
         '00000000-0000-0000-0000-000000000000', now(), now());

      v_actor := v_invite.target_actor_id;
      update public.actors
         set last_active_at = now(), updated_at = now()
       where id = v_actor;
    else
      v_user_id := auth.uid();
      if v_user_id is null then
        raise exception 'member claim requires authentication' using errcode = '42501';
      end if;
      if exists (select 1 from public.actors act
                  where act.team_id = v_invite.team_id and act.user_id = v_user_id) then
        raise exception 'already a member of this team' using errcode = '23505';
      end if;

      insert into public.actors
        (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values
        (v_invite.team_id, 'member', v_user_id,
         v_invite.invited_by_actor_id, v_invite.display_name, now())
      returning id into v_actor;

      insert into public.members (id, status) values (v_actor, 'active');
      insert into public.team_members (team_id, member_id, role)
        values (v_invite.team_id, v_actor, v_invite.team_role);
    end if;
  else
    v_user_id := gen_random_uuid();
    v_email   := format('daemon.%s@amuxd.run', v_user_id);
    v_session := gen_random_uuid();
    v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);

    insert into auth.users (
      id, email, email_confirmed_at,
      encrypted_password, confirmation_token, recovery_token,
      email_change_token_new, email_change,
      raw_app_meta_data,
      aud, role, created_at, updated_at, instance_id
    )
    values (
      v_user_id, v_email, now(),
      '', '', '',
      '', '',
      '{}'::jsonb,
      'authenticated', 'authenticated',
      now(), now(), '00000000-0000-0000-0000-000000000000'
    );

    insert into auth.sessions (id, user_id, aal, created_at, updated_at)
    values (v_session, v_user_id, 'aal1', now(), now());

    insert into auth.refresh_tokens
      (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
    values
      (v_rt, v_user_id::text, v_session, false,
       '00000000-0000-0000-0000-000000000000', now(), now());

    if v_invite.target_actor_id is not null then
      select user_id into v_old_user from public.actors where id = v_invite.target_actor_id;
      update public.actors
         set user_id = v_user_id,
             invited_by_actor_id = v_invite.invited_by_actor_id,
             last_active_at = null,
             updated_at = now()
       where id = v_invite.target_actor_id;
      v_actor := v_invite.target_actor_id;

      update public.agents
         set owner_member_id = v_invite.invited_by_actor_id,
             visibility = 'team',
             updated_at = now()
       where id = v_actor;

      if v_old_user is not null then
        delete from auth.users where id = v_old_user;
      end if;
    else
      insert into public.actors
        (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values
        (v_invite.team_id, 'agent', v_user_id,
         v_invite.invited_by_actor_id, v_invite.display_name, null)
      returning id into v_actor;

      insert into public.agents (id, owner_member_id, visibility, status)
        values (v_actor, v_invite.invited_by_actor_id, 'team', 'active');
    end if;

    insert into public.agent_member_access
      (agent_id, member_id, permission_level, granted_by_member_id)
    values
      (v_actor, v_invite.invited_by_actor_id, 'admin',
       v_invite.invited_by_actor_id)
    on conflict (agent_id, member_id) do update
      set permission_level = 'admin',
          granted_by_member_id = excluded.granted_by_member_id,
          updated_at = now();
  end if;

  update public.team_invites
     set consumed_at = now(), consumed_by_actor_id = v_actor, updated_at = now()
   where id = v_invite.id;

  return query
  select v_actor, v_invite.team_id, v_invite.kind::text,
         v_invite.display_name, v_rt;
end;
$$;

revoke all on function public.claim_team_invite(text) from public;
grant execute on function public.claim_team_invite(text) to anon, authenticated;

alter table public.agents drop column if exists agent_kind;

commit;

-- <<< END archived migration: 20260522000001_agent_types.sql

-- >>> BEGIN archived migration: 20260522000002_idea_sort_order.sql

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

-- <<< END archived migration: 20260522000002_idea_sort_order.sql

-- >>> BEGIN archived migration: 20260522000003_idea_activities.sql

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

-- <<< END archived migration: 20260522000003_idea_activities.sql

-- >>> BEGIN archived migration: 20260522000004_idea_activity_reorder.sql

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

-- <<< END archived migration: 20260522000004_idea_activity_reorder.sql

-- >>> BEGIN archived migration: 20260522000005_agent_owner_profile_rpc.sql

create or replace function public.update_owned_agent_profile(
  p_agent_id uuid,
  p_display_name text,
  p_visibility text default null
)
returns table (
  agent_id uuid,
  display_name text,
  visibility text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth, app
as $$
declare
  v_display_name text := nullif(btrim(p_display_name), '');
  v_visibility text := nullif(btrim(coalesce(p_visibility, '')), '');
begin
  if v_display_name is null then
    raise exception 'display name is required'
      using errcode = '23514';
  end if;

  if v_visibility is not null and v_visibility not in ('personal', 'team') then
    raise exception 'visibility must be personal or team'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
      from public.agents ag
     where ag.id = p_agent_id
       and ag.owner_member_id = app.current_member_id()
  ) then
    raise exception 'only agent owner can update agent profile'
      using errcode = '42501';
  end if;

  update public.actors a
     set display_name = v_display_name,
         updated_at = now()
   where a.id = p_agent_id
     and a.actor_type = 'agent';

  update public.agents ag
     set visibility = coalesce(v_visibility, ag.visibility),
         updated_at = now()
   where ag.id = p_agent_id;

  return query
  select ag.id, a.display_name, ag.visibility, greatest(a.updated_at, ag.updated_at)
    from public.agents ag
    join public.actors a on a.id = ag.id
   where ag.id = p_agent_id;
end;
$$;

revoke all on function public.update_owned_agent_profile(uuid, text, text) from public;
grant execute on function public.update_owned_agent_profile(uuid, text, text) to authenticated;

-- <<< END archived migration: 20260522000005_agent_owner_profile_rpc.sql

-- >>> BEGIN archived migration: 20260522070000_fix_update_idea_workspace_id_default.sql

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

-- <<< END archived migration: 20260522070000_fix_update_idea_workspace_id_default.sql

-- >>> BEGIN archived migration: 20260523000001_messages_sequence.sql

-- Add per-runtime monotonic `sequence` to messages so iOS can order rows
-- deterministically when created_at collides (multi-runtime fanning into the
-- same session, or sub-millisecond emits). Daemon stamps this from the same
-- counter that drives Envelope.sequence in EventHistory, so a Supabase row
-- and its corresponding ACP event share one sequence number.
--
-- Existing rows keep sequence = 0; the daemon writes the real value for
-- every new emit. iOS orders by (created_at, sequence) and treats 0 as
-- "no sequence available" (legacy).

alter table public.messages
  add column sequence bigint not null default 0;

create index messages_session_sequence_idx
  on public.messages (session_id, sequence)
  where sequence > 0;

-- <<< END archived migration: 20260523000001_messages_sequence.sql

-- >>> BEGIN archived migration: 20260523000002_create_idea_top_sort_order.sql

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

-- <<< END archived migration: 20260523000002_create_idea_top_sort_order.sql

-- >>> BEGIN archived migration: 20260523000003_idea_activity_attachment_urls.sql

alter table public.idea_activities
  add column if not exists attachment_urls text[] not null default '{}'::text[];

drop function if exists public.create_idea_activity(uuid, text, text, jsonb);

create or replace function public.create_idea_activity(
  p_idea_id uuid,
  p_activity_type text,
  p_content text default '',
  p_metadata jsonb default '{}'::jsonb,
  p_attachment_urls text[] default '{}'::text[]
)
returns table (
  id uuid,
  team_id uuid,
  idea_id uuid,
  actor_id uuid,
  activity_type text,
  content text,
  metadata jsonb,
  attachment_urls text[],
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
    metadata,
    attachment_urls
  )
  values (
    v_team_id,
    p_idea_id,
    v_actor_id,
    p_activity_type,
    coalesce(p_content, ''),
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_attachment_urls, '{}'::text[])
  )
  returning
    idea_activities.id,
    idea_activities.team_id,
    idea_activities.idea_id,
    idea_activities.actor_id,
    idea_activities.activity_type,
    idea_activities.content,
    idea_activities.metadata,
    idea_activities.attachment_urls,
    idea_activities.created_at,
    idea_activities.updated_at;
end;
$$;

revoke all on function public.create_idea_activity(uuid, text, text, jsonb, text[]) from public;
revoke all on function public.create_idea_activity(uuid, text, text, jsonb, text[]) from anon;
grant execute on function public.create_idea_activity(uuid, text, text, jsonb, text[]) to authenticated;

-- <<< END archived migration: 20260523000003_idea_activity_attachment_urls.sql

-- >>> BEGIN archived migration: 20260523000004_revoke_anon_create_idea_activity_attachment_urls.sql

revoke all on function public.create_idea_activity(uuid, text, text, jsonb, text[]) from anon;
grant execute on function public.create_idea_activity(uuid, text, text, jsonb, text[]) to authenticated;

-- <<< END archived migration: 20260523000004_revoke_anon_create_idea_activity_attachment_urls.sql

-- >>> BEGIN archived migration: 20260525000001_idea_attachment_storage_rls.sql

-- Allow team members to download idea attachments.
--
-- Idea attachments are uploaded under the path
--   <team_id>/ideas/<idea_id>/<attachment_id>/<filename>
-- (see AttachmentUploadManager in apps/ios — IdeaSheet / IdeaDetailView
-- pass `sessionID = "ideas/<idea_id>"` to namespace ideas separately from
-- sessions).
--
-- The original `session_participants_can_download` policy created in
-- 20260514002741_create_attachments_bucket.sql checks
--   SPLIT_PART(name, '/', 2) = <session_id>
-- which for idea attachments is the literal text 'ideas', so it never
-- matches a real session and SELECT (including signed-URL creation,
-- which requires SELECT) is denied. Uploads succeed under the open
-- INSERT policy, but `createSignedURL` then throws and the iOS
-- AttachmentUpload record is marked `.failed`, surfacing as an
-- exclamation triangle on the local thumbnail tile.
--
-- This migration adds a parallel SELECT policy scoped to the
-- idea path layout: if the second segment is the literal 'ideas' and
-- the first segment is the user's team_id, allow the download.

create policy "team_members_can_download_idea_attachments"
on storage.objects for select
to authenticated
using (
  bucket_id = 'attachments'
  and split_part(name, '/', 2) = 'ideas'
  and split_part(name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  and app.is_team_member(split_part(name, '/', 1)::uuid)
);

-- <<< END archived migration: 20260525000001_idea_attachment_storage_rls.sql

-- >>> BEGIN archived migration: 20260527000001_add_gateway_session_participant_rpc.sql

-- 2026-05-27: SECURITY DEFINER RPC for the gateway-side "add participant"
-- path. The daemon-side gateway flow (WeCom/Discord/Feishu/Kook/WeChat/Email)
-- calls this after every inbound message to make sure the external sender is
-- recorded as a participant on the gateway session.
--
-- Previously the daemon did a plain PostgREST INSERT on
-- `session_participants`. That goes through the
-- `session_participants_insert_if_team_member` RLS check
-- (`202604230002_session_participants_creator_bootstrap_rls.sql`), which
-- requires the inserter's `app.current_actor_id()` to be either the session
-- creator or an existing participant. In normal operation the daemon's
-- primary-agent actor is both, but in practice we've seen 42501 RLS
-- failures here when the JWT's resolved actor doesn't line up with the
-- session's `primary_agent_id` (multi-actor user_id, team mismatch, etc.).
--
-- The gateway path is server-trusted (the channel-side auth already
-- happened). Replacing the REST INSERT with a SECURITY DEFINER RPC removes
-- the RLS edge case, with authorization re-asserted inside the function:
--   - caller's auth.uid() must own the session's primary_agent actor
--   - target actor must belong to the same team as the session
--
-- The function is idempotent (on conflict do nothing) and returns void.

create or replace function public.add_gateway_session_participant(
  p_session_id uuid,
  p_actor_id   uuid
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_primary_agent uuid;
  v_team          uuid;
begin
  select s.primary_agent_id, s.team_id
    into v_primary_agent, v_team
    from public.sessions as s
   where s.id = p_session_id;

  if v_primary_agent is null then
    raise exception 'add_gateway_session_participant: session % not found',
      p_session_id
      using errcode = 'P0002';
  end if;

  -- Authorization: the caller's JWT must own the session's primary-agent
  -- actor. This matches how the daemon authenticates (it spawns Supabase
  -- requests using the agent's user_id).
  if not exists (
    select 1
      from public.actors a
     where a.id = v_primary_agent
       and a.user_id = auth.uid()
  ) then
    raise exception
      'add_gateway_session_participant: caller is not the session primary agent'
      using errcode = '42501';
  end if;

  -- The target actor must be in the same team as the session. Mirrors the
  -- `enforce_session_participants_same_team` trigger (202604220002) so we
  -- fail fast with a clear error rather than tripping the trigger.
  if not exists (
    select 1
      from public.actors a
     where a.id = p_actor_id
       and a.team_id = v_team
  ) then
    raise exception
      'add_gateway_session_participant: actor % not in session team %',
      p_actor_id, v_team
      using errcode = '23514';
  end if;

  insert into public.session_participants (session_id, actor_id)
    values (p_session_id, p_actor_id)
  on conflict on constraint session_participants_session_id_actor_id_key
  do nothing;
end;
$$;

revoke all on function public.add_gateway_session_participant(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.add_gateway_session_participant(uuid, uuid)
  to authenticated;

-- <<< END archived migration: 20260527000001_add_gateway_session_participant_rpc.sql

-- >>> BEGIN archived migration: 20260527000002_oss_sync_schema.sql

-- 20260527000001_oss_sync_schema.sql
--
-- OSS Sync v3 (PR1): add sync_mode + waterline columns to
-- team_workspace_config, plus four new tables for content-addressed blob
-- tracking, file pointers, immutable version chain, and prepare/complete
-- upload sessions. Locks down sync-state fields via a BEFORE UPDATE trigger
-- so authenticated callers cannot rewrite the waterline.
--
-- See docs/superpowers/specs/2026-05-27-oss-sync-redesign-design.md §2.

begin;

-- ===========================================================================
-- 1. Extend team_workspace_config
-- ===========================================================================
alter table public.team_workspace_config
  add column if not exists sync_mode text not null default 'git'
    check (sync_mode in ('git', 'oss')),
  add column if not exists oss_change_seq bigint not null default 0,
  add column if not exists litellm_team_id text;

comment on column public.team_workspace_config.sync_mode is
  'Sync backend for this team. Set at team creation; immutable thereafter (enforced by trg_team_workspace_config_guard).';
comment on column public.team_workspace_config.oss_change_seq is
  'Per-team monotonic sequence written by /sync/upload/complete inside the same tx as amuxc_files.change_seq. Manifest high-water mark.';
comment on column public.team_workspace_config.litellm_team_id is
  'LiteLLM team id provisioned for this team during /sync/create-team.';

-- ===========================================================================
-- 2. amuxc_blobs: content-addressed blob registry, per-team isolated
-- ===========================================================================
create table public.amuxc_blobs (
  team_id      uuid        not null references public.teams(id) on delete cascade,
  content_hash text        not null,
  oss_key      text        not null,
  size         bigint      not null check (size >= 0),
  verified     boolean     not null default false,
  created_at   timestamptz not null default now(),
  primary key (team_id, content_hash)
);

create index idx_amuxc_blobs_verified_created
  on public.amuxc_blobs (created_at) where verified = false;

comment on table public.amuxc_blobs is
  'OSS blob registry. (team_id, content_hash) PK acts as a per-team dedup key. verified=false means prepare-stage placeholder, flipped true by /sync/upload/complete.';

-- ===========================================================================
-- 3. amuxc_files: current pointer per path
-- ===========================================================================
create table public.amuxc_files (
  id              uuid        primary key default gen_random_uuid(),
  team_id         uuid        not null references public.teams(id) on delete cascade,
  path            text        not null,
  current_version int         not null default 0,
  content_hash    text,                            -- cipher_hash; null only when deleted
  size            bigint      not null default 0 check (size >= 0),
  deleted         boolean     not null default false,
  change_seq      bigint      not null default 0,
  row_version     int         not null default 0,
  updated_by      uuid        not null references public.actors(id) on delete restrict,
  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create unique index uniq_amuxc_path
  on public.amuxc_files (team_id, path);
create index idx_amuxc_files_team_updated
  on public.amuxc_files (team_id, updated_at);
create index idx_amuxc_files_team_seq
  on public.amuxc_files (team_id, change_seq);

comment on table public.amuxc_files is
  'Current pointer per (team, path). Soft-delete keeps the same row (deleted=true) so revival increments current_version on the existing row and preserves the immutable version chain in amuxc_file_versions.';
comment on column public.amuxc_files.content_hash is
  'Ciphertext sha256 (see design §3.-1). Null iff deleted=true.';
comment on column public.amuxc_files.change_seq is
  'Per-team manifest sequence, assigned by /sync/upload/complete. See team_workspace_config.oss_change_seq.';

-- ===========================================================================
-- 4. amuxc_file_versions: append-only history
-- ===========================================================================
create table public.amuxc_file_versions (
  id                 uuid        primary key default gen_random_uuid(),
  file_id            uuid        not null references public.amuxc_files(id) on delete cascade,
  version            int         not null,
  parent_version     int         not null,
  content_hash       text,                       -- cipher_hash; null iff deleted version
  size               bigint      not null default 0 check (size >= 0),
  deleted            boolean     not null default false,
  created_by         uuid        not null references public.actors(id) on delete restrict,
  created_by_node_id text,
  message            text,
  created_at         timestamptz not null default now(),
  unique (file_id, version)
);

create index idx_amuxc_file_versions_file
  on public.amuxc_file_versions (file_id, version desc);

comment on table public.amuxc_file_versions is
  'Append-only version chain. parent_version=current_version at time of complete, so cas conflicts surface as a 409 before this row is written.';

-- ===========================================================================
-- 5. amuxc_upload_sessions: prepare/complete bridge
-- ===========================================================================
create table public.amuxc_upload_sessions (
  id              uuid        primary key default gen_random_uuid(),
  team_id         uuid        not null references public.teams(id) on delete cascade,
  actor_id        uuid        not null references public.actors(id) on delete cascade,
  node_id         text,
  path            text        not null,
  parent_version  int         not null,
  content_hash    text        not null,
  size            bigint      not null check (size >= 0),
  oss_key         text        not null,
  status          text        not null default 'pending'
    check (status in ('pending', 'completed', 'abandoned')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null
);

create index idx_amuxc_sessions_expires
  on public.amuxc_upload_sessions (expires_at);
create index idx_amuxc_sessions_team_status
  on public.amuxc_upload_sessions (team_id, status);

comment on table public.amuxc_upload_sessions is
  'Tracks in-flight uploads between /prepare and /complete. actor_id is the creator; /complete must verify caller.actor_id == session.actor_id.';

-- ===========================================================================
-- 6. Guard trigger: lock down sync waterline against authenticated writes
-- ===========================================================================
create or replace function app.guard_team_workspace_sync_fields()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  -- service_role can do anything; everything else is restricted.
  if current_setting('role', true) = 'service_role' then
    return new;
  end if;

  if new.sync_mode is distinct from old.sync_mode then
    raise exception 'team_workspace_config.sync_mode is service-role only'
      using errcode = '42501';
  end if;
  if new.oss_change_seq is distinct from old.oss_change_seq then
    raise exception 'team_workspace_config.oss_change_seq is service-role only'
      using errcode = '42501';
  end if;
  if new.litellm_team_id is distinct from old.litellm_team_id then
    raise exception 'team_workspace_config.litellm_team_id is service-role only'
      using errcode = '42501';
  end if;

  return new;
end
$$;

create trigger trg_team_workspace_config_guard
  before update on public.team_workspace_config
  for each row
  execute function app.guard_team_workspace_sync_fields();

comment on function app.guard_team_workspace_sync_fields() is
  'Enforces the §2.6 waterline invariant: sync_mode / oss_change_seq / litellm_team_id are mutable only by service_role (FC). Authenticated team members can update other columns.';

-- ===========================================================================
-- 7. RLS: team members SELECT only, all writes are service_role only
-- ===========================================================================
alter table public.amuxc_blobs           enable row level security;
alter table public.amuxc_files           enable row level security;
alter table public.amuxc_file_versions   enable row level security;
alter table public.amuxc_upload_sessions enable row level security;

-- Force RLS on table owner too, so service_role policies (and lack of write
-- policies for authenticated) are honored when running migrations/tests as
-- postgres.
alter table public.amuxc_blobs           force row level security;
alter table public.amuxc_files           force row level security;
alter table public.amuxc_file_versions   force row level security;
alter table public.amuxc_upload_sessions force row level security;

-- ---- SELECT: team members of the row's team -------------------------------
create policy amuxc_blobs_select_team_member
  on public.amuxc_blobs           for select to authenticated
  using (app.is_team_member(team_id));

create policy amuxc_files_select_team_member
  on public.amuxc_files           for select to authenticated
  using (app.is_team_member(team_id));

-- amuxc_file_versions has no team_id column; route through file_id.
create policy amuxc_file_versions_select_team_member
  on public.amuxc_file_versions   for select to authenticated
  using (exists (
    select 1 from public.amuxc_files f
     where f.id = amuxc_file_versions.file_id
       and app.is_team_member(f.team_id)
  ));

create policy amuxc_upload_sessions_select_team_member
  on public.amuxc_upload_sessions for select to authenticated
  using (app.is_team_member(team_id));

-- ---- service_role: bypass everything --------------------------------------
-- Authenticated has no INSERT/UPDATE/DELETE policy → all writes denied for
-- that role. service_role bypasses RLS, so it can do everything.

-- ---- Grants ---------------------------------------------------------------
revoke all on public.amuxc_blobs, public.amuxc_files,
              public.amuxc_file_versions, public.amuxc_upload_sessions
  from public, anon, authenticated;
grant select on public.amuxc_blobs, public.amuxc_files,
                public.amuxc_file_versions, public.amuxc_upload_sessions
  to authenticated;
grant all on public.amuxc_blobs, public.amuxc_files,
             public.amuxc_file_versions, public.amuxc_upload_sessions
  to service_role;

-- ===========================================================================
-- 8. Helper: actor_id_for_user_in_team
--    FC auth middleware calls this (via service-role) to resolve the caller's
--    actor_id for a given (user_id, team_id) pair without using auth.uid().
-- ===========================================================================
create or replace function public.actor_id_for_user_in_team(
  p_user_id uuid,
  p_team_id uuid
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select id
    from public.actors
   where user_id  = p_user_id
     and team_id  = p_team_id
   limit 1;
$$;

comment on function public.actor_id_for_user_in_team(uuid, uuid) is
  'Resolves actor.id for a (user_id, team_id) pair. Used by FC /sync/* auth middleware (service_role) where auth.uid() is not available. Returns NULL if the user is not a member of the team.';

-- Grant execution to service_role only; authenticated callers should use
-- app.current_actor_id_for_team() which relies on auth.uid().
revoke all on function public.actor_id_for_user_in_team(uuid, uuid) from public, anon, authenticated;
grant execute on function public.actor_id_for_user_in_team(uuid, uuid) to service_role;

-- ===========================================================================
-- 9. amuxc_complete_upload — atomic CAS upload-complete transaction
--
-- Implements spec §3.3 waterline invariant:
--   team_workspace_config update MUST be the first write in the transaction.
--
-- Returns: TABLE(version int, content_hash text, change_seq bigint)
-- Raises:
--   P0409 with hint JSON { remote_version, remote_hash } on CAS mismatch
--   P0403 on actor/session ownership mismatch
--   P0410 on expired or non-pending session
-- ===========================================================================
create or replace function public.amuxc_complete_upload(
  p_session_id uuid,
  p_actor_id   uuid
)
returns table(version int, content_hash text, change_seq bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session   public.amuxc_upload_sessions%rowtype;
  v_file      public.amuxc_files%rowtype;
  v_seq       bigint;
  v_new_ver   int;
begin
  -- Lock and read session
  select * into v_session
    from public.amuxc_upload_sessions
   where id = p_session_id
   for update;

  if not found then
    raise exception 'session not found' using errcode = 'P0404';
  end if;
  if v_session.actor_id <> p_actor_id then
    raise exception 'session does not belong to caller' using errcode = 'P0403';
  end if;
  if v_session.status <> 'pending' then
    raise exception 'session is %', v_session.status using errcode = 'P0410';
  end if;
  if v_session.expires_at < now() then
    raise exception 'session has expired' using errcode = 'P0410';
  end if;

  -- WATERLINE INVARIANT (§2.6): push seq FIRST, before any amuxc_files write.
  -- Any snapshot that can see oss_change_seq=N is guaranteed to also see
  -- all amuxc_files rows with change_seq<=N because they are committed in
  -- the same atomic transaction.
  update public.team_workspace_config
     set oss_change_seq = oss_change_seq + 1
   where team_id = v_session.team_id
  returning oss_change_seq into v_seq;

  if not found then
    raise exception 'team_workspace_config row missing for team %', v_session.team_id;
  end if;

  -- Ensure file row exists (upsert the pointer row)
  insert into public.amuxc_files (team_id, path, updated_by)
    values (v_session.team_id, v_session.path, p_actor_id)
  on conflict (team_id, path) do nothing;

  -- Lock file row
  select * into v_file
    from public.amuxc_files
   where team_id = v_session.team_id
     and path    = v_session.path
   for update;

  -- CAS check
  if v_file.current_version <> v_session.parent_version then
    raise exception 'cas-mismatch'
      using errcode = 'P0409',
            hint    = json_build_object(
                        'remote_version', v_file.current_version,
                        'remote_hash',    v_file.content_hash
                      )::text;
  end if;

  v_new_ver := v_file.current_version + 1;

  -- Mark blob verified (table-qualify to avoid PL/pgSQL ambiguity with local var)
  update public.amuxc_blobs b
     set verified = true
   where b.team_id      = v_session.team_id
     and b.content_hash = v_session.content_hash;

  -- Append version record
  insert into public.amuxc_file_versions
    (file_id, version, parent_version, content_hash, size, deleted,
     created_by, created_by_node_id)
  values
    (v_file.id, v_new_ver, v_session.parent_version, v_session.content_hash,
     v_session.size, false, p_actor_id, v_session.node_id);

  -- Advance file pointer
  update public.amuxc_files
     set current_version = v_new_ver,
         content_hash    = v_session.content_hash,
         size            = v_session.size,
         deleted         = false,
         change_seq      = v_seq,
         updated_by      = p_actor_id,
         updated_at      = now()
   where id = v_file.id;

  -- Mark session completed
  update public.amuxc_upload_sessions
     set status = 'completed'
   where id = p_session_id;

  return query select v_new_ver, v_session.content_hash, v_seq;
end;
$$;

comment on function public.amuxc_complete_upload(uuid, uuid) is
  'Atomic CAS upload-complete per spec §3.3. Waterline invariant: team_workspace_config.oss_change_seq is incremented BEFORE any amuxc_files write. Raises P0409 on CAS conflict, P0403 on ownership mismatch, P0410 on expired/non-pending session.';

revoke all on function public.amuxc_complete_upload(uuid, uuid) from public, anon, authenticated;
grant execute on function public.amuxc_complete_upload(uuid, uuid) to service_role;

-- ===========================================================================
-- 10. amuxc_complete_delete — atomic delete tombstone transaction
--
-- Same waterline invariant as amuxc_complete_upload.
-- Writes a tombstone version (content_hash=null, deleted=true).
--
-- Returns: TABLE(version int, change_seq bigint)
-- Raises:  P0409 on CAS mismatch, P0404 if file not found
-- ===========================================================================
create or replace function public.amuxc_complete_delete(
  p_team_id        uuid,
  p_path           text,
  p_parent_version int,
  p_actor_id       uuid,
  p_node_id        text default null
)
returns table(version int, change_seq bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_file    public.amuxc_files%rowtype;
  v_seq     bigint;
  v_new_ver int;
begin
  -- WATERLINE INVARIANT (§2.6): push seq FIRST.
  update public.team_workspace_config
     set oss_change_seq = oss_change_seq + 1
   where team_id = p_team_id
  returning oss_change_seq into v_seq;

  if not found then
    raise exception 'team_workspace_config row missing for team %', p_team_id;
  end if;

  -- Lock file row
  select * into v_file
    from public.amuxc_files
   where team_id = p_team_id
     and path    = p_path
   for update;

  if not found then
    raise exception 'file not found: %', p_path using errcode = 'P0404';
  end if;

  -- CAS check
  if v_file.current_version <> p_parent_version then
    raise exception 'cas-mismatch'
      using errcode = 'P0409',
            hint    = json_build_object(
                        'remote_version', v_file.current_version,
                        'remote_hash',    v_file.content_hash
                      )::text;
  end if;

  v_new_ver := v_file.current_version + 1;

  -- Append tombstone version record
  insert into public.amuxc_file_versions
    (file_id, version, parent_version, content_hash, size, deleted,
     created_by, created_by_node_id)
  values
    (v_file.id, v_new_ver, p_parent_version, null, 0, true, p_actor_id, p_node_id);

  -- Mark file as deleted and advance pointer
  update public.amuxc_files
     set current_version = v_new_ver,
         content_hash    = null,
         size            = 0,
         deleted         = true,
         change_seq      = v_seq,
         updated_by      = p_actor_id,
         updated_at      = now()
   where id = v_file.id;

  return query select v_new_ver, v_seq;
end;
$$;

comment on function public.amuxc_complete_delete(uuid, text, int, uuid, text) is
  'Atomic delete tombstone per spec §3.5. Same waterline invariant as amuxc_complete_upload. Raises P0409 on CAS conflict, P0404 if file not found.';

revoke all on function public.amuxc_complete_delete(uuid, text, int, uuid, text) from public, anon, authenticated;
grant execute on function public.amuxc_complete_delete(uuid, text, int, uuid, text) to service_role;

commit;

-- <<< END archived migration: 20260527000002_oss_sync_schema.sql

-- >>> BEGIN archived migration: 20260527000003_oss_sync_cleanup.sql

-- 20260527000002_oss_sync_cleanup.sql
--
-- OSS Sync v3 cleanup jobs:
--   1. Every 15 minutes: mark abandoned upload sessions (status=pending and
--      expired) → status='abandoned'. Hard-delete abandoned rows older than 24h.
--   2. Once a day: GC orphan blobs that no amuxc_file_versions row references
--      and that are >7 days old (covers both verified=false stale prepares and
--      verified=true blobs whose file was deleted). Note: OSS object deletion
--      is OUT OF SCOPE for this migration — only DB rows here. A future FC
--      side-task can scan amuxc_blobs missing from amuxc_file_versions and
--      DELETE from OSS.
--
-- See docs/superpowers/specs/2026-05-27-oss-sync-redesign-design.md §5.3.

begin;

create extension if not exists pg_cron;

-- Abandon expired upload sessions.
create or replace function app.oss_sync_abandon_expired_sessions()
returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  update public.amuxc_upload_sessions
     set status = 'abandoned'
   where status = 'pending'
     and expires_at < now();

  delete from public.amuxc_upload_sessions
   where status = 'abandoned'
     and expires_at < now() - interval '24 hours';
end;
$$;

-- GC orphan blobs (DB rows only).
create or replace function app.oss_sync_gc_orphan_blobs()
returns int
language plpgsql security definer set search_path = public, auth as $$
declare
  v_deleted int;
begin
  with orphan as (
    select b.team_id, b.content_hash
      from public.amuxc_blobs b
     where b.created_at < now() - interval '7 days'
       and not exists (
         select 1 from public.amuxc_file_versions v
          join public.amuxc_files f on f.id = v.file_id
          where f.team_id = b.team_id
            and v.content_hash = b.content_hash
       )
  )
  delete from public.amuxc_blobs b
   using orphan
   where b.team_id = orphan.team_id
     and b.content_hash = orphan.content_hash;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Schedule (guarded: pg_cron may not be available in all environments).
do $guard$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'oss-sync-abandon-expired-sessions',
      '*/15 * * * *',
      'select app.oss_sync_abandon_expired_sessions()'
    );

    perform cron.schedule(
      'oss-sync-gc-orphan-blobs',
      '17 4 * * *',
      'select app.oss_sync_gc_orphan_blobs()'
    );
  end if;
end $guard$;

commit;

-- <<< END archived migration: 20260527000003_oss_sync_cleanup.sql

-- >>> BEGIN archived migration: 20260527000004_oss_sync_mode_switch.sql

-- 20260527000004_oss_sync_mode_switch.sql
--
-- Allow team owners to hard-switch sync_mode after team creation.
-- Spec §2.6 originally treated sync_mode as immutable; user overrode this:
-- switching does NOT migrate data (existing blobs/files are abandoned in place).
-- The guard trigger in 20260527000002_oss_sync_schema.sql still blocks raw
-- authenticated writes; this RPC is the sole allowed mutation path.
--
-- Strategy: rather than trying to detect SECURITY DEFINER via session_user
-- (which is 'postgres' in both local dev and CI), the set_team_sync_mode RPC
-- sets a LOCAL GUC flag before performing the UPDATE. The trigger reads this
-- flag to allow the write. SET LOCAL resets automatically at sub-transaction
-- boundary so the flag cannot leak between calls.

begin;

-- ===========================================================================
-- 1. Re-create the guard trigger — adds custom GUC bypass
-- ===========================================================================
create or replace function app.guard_team_workspace_sync_fields()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  -- Service-role callers (direct DB writes, migrations, FC) are always allowed.
  if current_setting('role', true) = 'service_role' then
    return new;
  end if;

  -- Allow when the owner-only RPC (set_team_sync_mode) signals it's running.
  -- The RPC sets this LOCAL GUC after performing its own ownership check.
  if current_setting('app.allow_sync_mode_switch', true) = 'on' then
    return new;
  end if;

  if new.sync_mode is distinct from old.sync_mode then
    raise exception 'team_workspace_config.sync_mode is service-role only (use public.set_team_sync_mode)'
      using errcode = '42501';
  end if;
  if new.oss_change_seq is distinct from old.oss_change_seq then
    raise exception 'team_workspace_config.oss_change_seq is service-role only'
      using errcode = '42501';
  end if;
  if new.litellm_team_id is distinct from old.litellm_team_id then
    raise exception 'team_workspace_config.litellm_team_id is service-role only'
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- ===========================================================================
-- 2. Owner-only sync_mode switch RPC
-- ===========================================================================
create or replace function public.set_team_sync_mode(
  p_team_id uuid,
  p_mode text
) returns text
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_actor_id uuid;
  v_role text;
begin
  if p_mode not in ('git', 'oss') then
    raise exception 'invalid sync_mode: %', p_mode using errcode = '22023';
  end if;

  v_actor_id := app.current_actor_id_for_team(p_team_id);
  if v_actor_id is null then
    raise exception 'caller is not a member of team %', p_team_id
      using errcode = '42501';
  end if;

  select tm.role into v_role
    from public.team_members tm
   where tm.team_id = p_team_id and tm.member_id = v_actor_id;

  if v_role <> 'owner' then
    raise exception 'only team owners may switch sync_mode (caller role=%)', coalesce(v_role, 'null')
      using errcode = '42501';
  end if;

  -- Signal the guard trigger that this update is coming from the owner-only RPC.
  -- SET LOCAL auto-reverts after this sub-transaction / function call.
  perform set_config('app.allow_sync_mode_switch', 'on', true);

  update public.team_workspace_config
     set sync_mode = p_mode
   where team_id = p_team_id;

  -- Clear the flag immediately after the update (belt-and-suspenders).
  perform set_config('app.allow_sync_mode_switch', 'off', true);

  return p_mode;
end;
$$;

revoke all on function public.set_team_sync_mode(uuid, text) from public;
grant execute on function public.set_team_sync_mode(uuid, text) to authenticated;

-- ===========================================================================
-- 3. Read helper for join auto-detect
-- ===========================================================================
-- Avoids exposing the whole team_workspace_config row to authenticated callers.
-- Performs no ownership/membership check beyond the caller holding a valid JWT.
create or replace function public.get_team_sync_mode(p_team_id uuid)
returns text
language sql security definer set search_path = public, auth
stable as $$
  select sync_mode from public.team_workspace_config where team_id = p_team_id
$$;

revoke all on function public.get_team_sync_mode(uuid) from public;
grant execute on function public.get_team_sync_mode(uuid) to authenticated;

commit;

-- <<< END archived migration: 20260527000004_oss_sync_mode_switch.sql

-- >>> BEGIN archived migration: 20260527000005_oss_sync_default_mode.sql

-- 20260527000005_oss_sync_default_mode.sql
--
-- Flip the default sync_mode for team_workspace_config from 'git' to 'oss'.
-- Existing rows are not touched; only newly-inserted rows that omit sync_mode
-- pick up the new default. Explicit inserts (public.create_team writing 'git',
-- FC /sync/create-team writing 'oss') keep their behavior.
--
-- See docs/superpowers/specs/2026-05-27-oss-sync-redesign-design.md.

begin;

alter table public.team_workspace_config
  alter column sync_mode set default 'oss';

commit;

-- <<< END archived migration: 20260527000005_oss_sync_default_mode.sql

-- >>> BEGIN archived migration: 20260528000001_create_team_with_workspace_config.sql

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

-- <<< END archived migration: 20260528000001_create_team_with_workspace_config.sql

-- >>> BEGIN archived migration: 20260528000002_team_share_mode.sql

-- 20260528000002_team_share_mode.sql
--
-- Split "create team" from "enable team share". After this migration:
--   * Creating a team (public.create_team — see PR #212 migration
--     20260528000001_create_team_with_workspace_config.sql) only writes a
--     teams row and a bare team_workspace_config row. sync_mode is NULL until
--     the owner explicitly opens team-share via app.enable_team_share().
--   * public.teams gains share_mode + share_enabled_at + custom-git fields.
--   * share_mode is once-only: NULL -> value is allowed, value -> different
--     value (or NULL) is blocked by the app.guard_team_share_mode trigger.
--   * app.enable_team_share is the sole intended writer of share_mode; it
--     also mirrors the choice into team_workspace_config.sync_mode.
--
-- See docs/superpowers/plans/2026-05-28-team-share-onboarding-refactor.md
-- (Task 1) for the broader plan.

begin;

-- ===========================================================================
-- 1. share_mode enum (idempotent)
-- ===========================================================================
do $$ begin
  create type app.team_share_mode as enum ('oss', 'managed_git', 'custom_git');
exception when duplicate_object then null; end $$;

-- ===========================================================================
-- 2. Add columns to public.teams
-- ===========================================================================
alter table public.teams
  add column if not exists share_mode         app.team_share_mode,
  add column if not exists share_enabled_at   timestamptz,
  add column if not exists git_remote_url     text,
  add column if not exists git_auth_kind      text,
  add column if not exists git_credential_ref text;

-- Constrain git_auth_kind values (NULL still allowed) — separate from
-- add column so re-runs don't try to create the same constraint twice.
do $$ begin
  alter table public.teams
    add constraint teams_git_auth_kind_check
    check (git_auth_kind is null or git_auth_kind in ('ssh_key', 'https_token'));
exception when duplicate_object then null; end $$;

-- ===========================================================================
-- 3. Once-only lock trigger for share_mode
-- ===========================================================================
-- Reject any UPDATE that changes share_mode away from a non-null value.
-- INSERTs are unaffected (no OLD row). The trigger guards both direct table
-- writes and authenticated UPDATEs; app.enable_team_share works fine because
-- it only updates rows WHERE share_mode IS NULL (so OLD.share_mode IS NULL
-- and the guard short-circuits).
create or replace function app.guard_team_share_mode()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if old.share_mode is not null
     and new.share_mode is distinct from old.share_mode then
    raise exception 'teams.share_mode is locked once enabled (was %, attempted %)',
      old.share_mode, new.share_mode
      using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists guard_team_share_mode on public.teams;
create trigger guard_team_share_mode
  before update on public.teams
  for each row execute function app.guard_team_share_mode();

-- ===========================================================================
-- 4. team_workspace_config.sync_mode: drop DEFAULT, drop NOT NULL
-- ===========================================================================
-- Originally added by 20260527000002 as `not null default 'git'`, later
-- 20260527000005 flipped the default to 'oss'. Both PR #212's create_team
-- and the AuthGate auto-create path implicitly seeded sync_mode. After this
-- migration, sync_mode starts NULL ("share not opened yet") and is only set
-- when app.enable_team_share runs. The CHECK constraint (sync_mode in
-- ('git','oss')) is unaffected; CHECK constraints are satisfied by NULL.
alter table public.team_workspace_config
  alter column sync_mode drop default;

alter table public.team_workspace_config
  alter column sync_mode drop not null;

-- ===========================================================================
-- 5. Rewrite public.create_team (introduced in PR #212) to NOT seed sync_mode
-- ===========================================================================
-- Same signature as 20260528000001 so /v1/teams handler and FC callers do not
-- need to change. The only behaviour delta is the INSERT into
-- team_workspace_config: we omit sync_mode so it stays NULL until
-- app.enable_team_share fills it in.
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

  -- Seed team_workspace_config WITHOUT sync_mode. sync_mode starts NULL and
  -- transitions to 'oss' or 'git' when the owner calls app.enable_team_share.
  -- litellm_team_id / ai_gateway_endpoint can still be set here (PR #212).
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

-- ===========================================================================
-- 6. app.enable_team_share — atomic, idempotent-at-the-NULL-edge writer
-- ===========================================================================
-- Atomically asserts share_mode IS NULL and writes the chosen mode + custom-
-- git fields. Mirrors the choice into team_workspace_config.sync_mode so the
-- sync engine (oss / git) keeps reading from team_workspace_config as today.
-- Returns the updated public.teams row. Raises if the team does not exist or
-- already has share_mode set (locked).
create or replace function app.enable_team_share(
  p_team_id            uuid,
  p_mode               app.team_share_mode,
  p_git_remote_url     text default null,
  p_git_auth_kind      text default null,
  p_git_credential_ref text default null
) returns public.teams
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_team public.teams;
  v_sync_mode text;
begin
  if p_git_auth_kind is not null
     and p_git_auth_kind not in ('ssh_key', 'https_token') then
    raise exception 'git_auth_kind must be ssh_key or https_token'
      using errcode = '22023';
  end if;

  update public.teams
     set share_mode         = p_mode,
         share_enabled_at   = now(),
         git_remote_url     = p_git_remote_url,
         git_auth_kind      = p_git_auth_kind,
         git_credential_ref = p_git_credential_ref
   where id = p_team_id
     and share_mode is null
  returning * into v_team;

  if v_team.id is null then
    raise exception 'team % does not exist or share_mode is already locked', p_team_id
      using errcode = '23514';
  end if;

  v_sync_mode := case p_mode when 'oss' then 'oss' else 'git' end;

  -- Mirror sync_mode into team_workspace_config. The 20260527000004 guard on
  -- team_workspace_config blocks sync_mode changes unless current role is
  -- service_role or the app.allow_sync_mode_switch GUC is on. Since this RPC
  -- is SECURITY DEFINER but `current_setting('role', true)` reflects the
  -- caller's role (e.g. 'authenticated'), we flip the GUC explicitly to
  -- authorise the update, exactly like public.set_team_sync_mode does.
  perform set_config('app.allow_sync_mode_switch', 'on', true);

  insert into public.team_workspace_config (team_id, sync_mode)
       values (p_team_id, v_sync_mode)
  on conflict (team_id) do update
       set sync_mode = excluded.sync_mode;

  perform set_config('app.allow_sync_mode_switch', 'off', true);

  return v_team;
end
$$;

-- service_role needs USAGE on the app schema to resolve the function name and
-- the enum type. The app schema is currently postgres-only; grant the minimum
-- needed for this RPC + enum type lookup.
grant usage on schema app to service_role;
grant usage on type app.team_share_mode to service_role;

revoke all on function app.enable_team_share(uuid, app.team_share_mode, text, text, text) from public;
grant execute on function app.enable_team_share(uuid, app.team_share_mode, text, text, text) to service_role;

-- ===========================================================================
-- 7. app.update_team_litellm — owner-only LiteLLM credential writeback
-- ===========================================================================
-- team_workspace_config.litellm_team_id is guarded by
-- app.guard_team_workspace_sync_fields() (see 20260527000004) which blocks
-- direct UPDATEs from authenticated callers. The FC `setupLiteLlm(teamId)`
-- repo method needs to persist the LiteLLM team id + AI gateway endpoint after
-- calling out to LiteLLM. Reuse the same `app.allow_sync_mode_switch` GUC
-- bypass that public.set_team_sync_mode uses, since the guard accepts that
-- flag for all sync-related field updates.
--
-- We do NOT re-check ownership here because the FC layer is already trusted
-- (caller's bearer is forwarded to PostgREST and the route handler validates
-- the caller is a team owner before invoking this). If/when the RPC is
-- exposed to authenticated callers directly, add an ownership check.
create or replace function app.update_team_litellm(
  p_team_id             uuid,
  p_litellm_team_id     text,
  p_ai_gateway_endpoint text
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform set_config('app.allow_sync_mode_switch', 'on', true);

  insert into public.team_workspace_config (team_id, litellm_team_id, ai_gateway_endpoint)
       values (p_team_id, p_litellm_team_id, p_ai_gateway_endpoint)
  on conflict (team_id) do update
       set litellm_team_id     = excluded.litellm_team_id,
           ai_gateway_endpoint = excluded.ai_gateway_endpoint;

  perform set_config('app.allow_sync_mode_switch', 'off', true);
end
$$;

revoke all on function app.update_team_litellm(uuid, text, text) from public;
grant execute on function app.update_team_litellm(uuid, text, text) to service_role;

commit;

-- <<< END archived migration: 20260528000002_team_share_mode.sql

-- >>> BEGIN archived migration: 20260529000003_team_share_public_rpc_fix.sql

-- 20260529000003_team_share_public_rpc_fix.sql
--
-- 20260528000002_team_share_mode.sql created enable_team_share and
-- update_team_litellm in the `app` schema. But the FC repository layer calls
-- them via PostgREST in the PUBLIC schema:
--   services/fc/lib/supabase-repo.mjs
--     supabase.rpc("enable_team_share", ...)
--     supabase.rpc("update_team_litellm", ...)
-- PostgREST RPC (no .schema()) only resolves functions in the exposed (public)
-- schema, so every call failed with PGRST202 "Could not find the function
-- public.enable_team_share(...) in the schema cache" -> opaque 500. This
-- mirrors public.set_team_sync_mode, which is (correctly) in public and uses
-- the same app.allow_sync_mode_switch GUC bypass.
--
-- Recreate both RPCs in public (identical bodies) and drop the unreachable
-- app-schema versions. The app.team_share_mode enum (param type) and the
-- `grant usage on type app.team_share_mode to service_role` from
-- 20260528000002 stay as-is.

begin;

create or replace function public.enable_team_share(
  p_team_id            uuid,
  p_mode               app.team_share_mode,
  p_git_remote_url     text default null,
  p_git_auth_kind      text default null,
  p_git_credential_ref text default null
) returns public.teams
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_team public.teams;
  v_sync_mode text;
begin
  if p_git_auth_kind is not null
     and p_git_auth_kind not in ('ssh_key', 'https_token') then
    raise exception 'git_auth_kind must be ssh_key or https_token'
      using errcode = '22023';
  end if;

  update public.teams
     set share_mode         = p_mode,
         share_enabled_at   = now(),
         git_remote_url     = p_git_remote_url,
         git_auth_kind      = p_git_auth_kind,
         git_credential_ref = p_git_credential_ref
   where id = p_team_id
     and share_mode is null
  returning * into v_team;

  if v_team.id is null then
    raise exception 'team % does not exist or share_mode is already locked', p_team_id
      using errcode = '23514';
  end if;

  v_sync_mode := case p_mode when 'oss' then 'oss' else 'git' end;

  perform set_config('app.allow_sync_mode_switch', 'on', true);

  insert into public.team_workspace_config (team_id, sync_mode)
       values (p_team_id, v_sync_mode)
  on conflict (team_id) do update
       set sync_mode = excluded.sync_mode;

  perform set_config('app.allow_sync_mode_switch', 'off', true);

  return v_team;
end
$$;

revoke all on function public.enable_team_share(uuid, app.team_share_mode, text, text, text) from public;
grant execute on function public.enable_team_share(uuid, app.team_share_mode, text, text, text) to service_role;

create or replace function public.update_team_litellm(
  p_team_id             uuid,
  p_litellm_team_id     text,
  p_ai_gateway_endpoint text
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform set_config('app.allow_sync_mode_switch', 'on', true);

  insert into public.team_workspace_config (team_id, litellm_team_id, ai_gateway_endpoint)
       values (p_team_id, p_litellm_team_id, p_ai_gateway_endpoint)
  on conflict (team_id) do update
       set litellm_team_id     = excluded.litellm_team_id,
           ai_gateway_endpoint = excluded.ai_gateway_endpoint;

  perform set_config('app.allow_sync_mode_switch', 'off', true);
end
$$;

revoke all on function public.update_team_litellm(uuid, text, text) from public;
grant execute on function public.update_team_litellm(uuid, text, text) to service_role;

-- Remove the unreachable app-schema versions created by 20260528000002.
drop function if exists app.enable_team_share(uuid, app.team_share_mode, text, text, text);
drop function if exists app.update_team_litellm(uuid, text, text);

commit;

-- <<< END archived migration: 20260529000003_team_share_public_rpc_fix.sql

-- >>> BEGIN archived migration: 202605290001_telemetry_leaderboard_fix.sql

-- Telemetry leaderboard fix:
--  * actor_skill_usage table (skill dimension storage)
--  * unique (actor_id, message_id) index so feedback upsert is valid
--  * replace the cartesian-product team_leaderboard view with a
--    period-aware aggregate function that also returns skill_usage + score

-- 1) Per-skill usage -------------------------------------------------------
create table public.actor_skill_usage (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid not null references public.actors(id)  on delete cascade,
  team_id     uuid not null references public.teams(id)   on delete cascade,
  session_id  uuid references public.sessions(id)         on delete set null,
  skill       text not null,
  count       integer not null default 1 check (count > 0),
  created_at  timestamptz not null default now()
);

create index actor_skill_usage_team_idx
  on public.actor_skill_usage (team_id, created_at desc);
create index actor_skill_usage_actor_idx
  on public.actor_skill_usage (actor_id, created_at desc);

alter table public.actor_skill_usage enable row level security;

create policy actor_skill_usage_select_if_team_member
  on public.actor_skill_usage
  for select to authenticated
  using (app.is_team_member(team_id));

create policy actor_skill_usage_insert_self
  on public.actor_skill_usage
  for insert to authenticated
  with check (
    app.is_team_member(team_id)
    and exists (
      select 1 from public.actors a
       where a.id = actor_id
         and a.user_id = auth.uid()
         and a.team_id = team_id
    )
  );

grant select, insert on public.actor_skill_usage to authenticated;

-- 2) Make the feedback upsert key valid -----------------------------------
-- supabase-repo upserts on (actor_id, message_id); the table had no matching
-- unique constraint, so the upsert would error.
-- Non-partial unique index: required so supabase-js .upsert({ onConflict:
-- "actor_id,message_id" }) (which emits ON CONFLICT with no WHERE) can match it.
-- NULL message_id rows (session-level feedback) remain unconstrained because
-- Postgres treats NULLs as distinct in a unique index.
create unique index actor_message_feedback_actor_message_uidx
  on public.actor_message_feedback (actor_id, message_id);

-- The feedback upsert (INSERT ... ON CONFLICT DO UPDATE) needs UPDATE rights
-- for the re-rate path. Mirror the existing insert-self policy.
create policy actor_message_feedback_update_self
  on public.actor_message_feedback
  for update to authenticated
  using (
    app.is_team_member(team_id)
    and exists (
      select 1 from public.actors a
       where a.id = actor_id
         and a.user_id = auth.uid()
         and a.team_id = team_id
    )
  )
  with check (
    app.is_team_member(team_id)
    and exists (
      select 1 from public.actors a
       where a.id = actor_id
         and a.user_id = auth.uid()
         and a.team_id = team_id
    )
  );

grant update on public.actor_message_feedback to authenticated;

-- 3) Period-aware leaderboard ---------------------------------------------
drop view if exists public.team_leaderboard;

create or replace function public.team_leaderboard(p_team_id uuid, p_period text default 'week')
returns table (
  team_id           uuid,
  actor_id          uuid,
  display_name      text,
  period            text,
  tokens_used       bigint,
  cost_usd          numeric,
  positive_feedback bigint,
  negative_feedback bigint,
  session_count     bigint,
  skill_usage       jsonb,
  score             numeric
)
language sql
stable
security invoker
as $$
  with bounds as (
    select case p_period
      when 'day'   then now() - interval '1 day'
      when 'week'  then now() - interval '7 days'
      when 'month' then now() - interval '30 days'
      else              now() - interval '7 days'
    end as since
  ),
  reports as (
    select r.actor_id,
           sum(r.tokens_used)::bigint   as tokens_used,
           sum(r.cost_usd)::numeric     as cost_usd,
           count(*)::bigint             as session_count
    from public.actor_session_report r, bounds b
    where r.team_id = p_team_id and r.created_at >= b.since
    group by r.actor_id
  ),
  fb as (
    select f.actor_id,
           sum((f.kind = 'positive')::int)::bigint as positive_feedback,
           sum((f.kind = 'negative')::int)::bigint as negative_feedback
    from public.actor_message_feedback f, bounds b
    where f.team_id = p_team_id and f.created_at >= b.since
    group by f.actor_id
  ),
  skills as (
    select s.actor_id,
           jsonb_object_agg(s.skill, s.cnt) as skill_usage
    from (
      select su.actor_id, su.skill, sum(su.count)::bigint as cnt
      from public.actor_skill_usage su, bounds b
      where su.team_id = p_team_id and su.created_at >= b.since
      group by su.actor_id, su.skill
    ) s
    group by s.actor_id
  )
  select
    a.team_id,
    a.id                                          as actor_id,
    a.display_name,
    p_period                                      as period,
    coalesce(reports.tokens_used, 0)              as tokens_used,
    coalesce(reports.cost_usd, 0)                 as cost_usd,
    coalesce(fb.positive_feedback, 0)             as positive_feedback,
    coalesce(fb.negative_feedback, 0)             as negative_feedback,
    coalesce(reports.session_count, 0)            as session_count,
    coalesce(skills.skill_usage, '{}'::jsonb)     as skill_usage,
    -- score = tokens_used (placeholder ranking key; cost-weighted formula TBD)
    coalesce(reports.tokens_used, 0)::numeric     as score
  from public.actors a
  left join reports on reports.actor_id = a.id
  left join fb      on fb.actor_id      = a.id
  left join skills  on skills.actor_id  = a.id
  where a.team_id = p_team_id;
$$;

grant execute on function public.team_leaderboard(uuid, text) to authenticated;

-- <<< END archived migration: 202605290001_telemetry_leaderboard_fix.sql

-- >>> BEGIN archived migration: 20260529100001_list_connected_agents_team_scoped_actor.sql

-- Fix: agent ownership / access checks must be team-scoped.
--
-- Root cause: `app.current_member_id()` is NOT team-scoped. It returns the
-- caller's oldest member actor across ALL teams (`order by created_at limit 1`).
-- A user who belongs to more than one team has a distinct actor per team, so
-- every agent-ownership comparison of the form
--     agents.owner_member_id = app.current_member_id()
-- (and the matching agent_member_access self-checks) resolved against the wrong
-- actor in every team except the one holding the caller's oldest actor.
--
-- Symptom: a user who invited / owns a daemon in their non-oldest team saw the
-- agent filtered out of `list_connected_agents` entirely (personal visibility),
-- `is_owner = false`, and every write path (update_owned_agent_profile,
-- share_agent_to_team, make_agent_personal, agent_member_access management RLS)
-- rejected them with "only agent owner can ...". The owner DATA is correct
-- (`claim_team_invite` sets owner_member_id = inviter); only the resolution of
-- the *caller's* actor was wrong.
--
-- Fix: resolve the caller's actor within the agent's OWN team. A new helper
-- `app.current_actor_for_agent(agent_id)` builds on the existing team-scoped
-- `app.current_actor_id_for_team` (added in 202604220015) and replaces every
-- agent-domain use of `app.current_member_id()`.
--
-- NOTE: non-agent uses of `app.current_member_id()` (sessions, personal
-- shortcuts, core team_members RLS) share the same latent multi-team bug and are
-- intentionally left for a separate, separately-tested change.

-- 1. Team-scoped helper: the caller's actor id within the agent's own team.
create or replace function app.current_actor_for_agent(p_agent_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select app.current_actor_id_for_team(a.team_id)
    from public.actors a
   where a.id = p_agent_id
$$;

grant execute on function app.current_actor_for_agent(uuid) to authenticated;

-- 2. list_connected_agents — uses p_team_id directly (already team-scoped).
create or replace function public.list_connected_agents(p_team_id uuid)
returns table (
  agent_id uuid,
  display_name text,
  agent_types jsonb,
  default_agent_type text,
  permission_level text,
  visibility text,
  is_owner boolean,
  device_id text,
  last_active_at timestamptz
)
language sql
security definer
set search_path = public, auth
as $$
  select
    ag.id as agent_id,
    a.display_name,
    ag.agent_types,
    ag.default_agent_type,
    coalesce(ama.permission_level, case when app.is_team_member(p_team_id) then 'view' end) as permission_level,
    ag.visibility,
    ag.owner_member_id = app.current_actor_id_for_team(p_team_id) as is_owner,
    ag.device_id,
    a.last_active_at
  from public.agents ag
  join public.actors a on a.id = ag.id
  left join public.agent_member_access ama
    on ama.agent_id = ag.id
   and ama.member_id = app.current_actor_id_for_team(p_team_id)
  where a.team_id = p_team_id
    and ag.status = 'active'
    and (
      ag.visibility = 'team'
      or ag.owner_member_id = app.current_actor_id_for_team(p_team_id)
      or ama.member_id is not null
    )
$$;

revoke all on function public.list_connected_agents(uuid) from public;
grant execute on function public.list_connected_agents(uuid) to authenticated;

-- 3. agents SELECT RLS — let owners see their own personal agents.
drop policy if exists agents_select_if_visible on public.agents;
create policy agents_select_if_visible on public.agents
for select to authenticated using (
  exists (
    select 1
      from public.actors a
     where a.id = agents.id
       and app.is_team_member(a.team_id)
       and (
         agents.visibility = 'team'
         or agents.owner_member_id = app.current_actor_id_for_team(a.team_id)
       )
  )
);

-- 4. agent_member_access SELECT RLS — self rows or rows on agents I own.
drop policy if exists agent_member_access_select_if_agent_owner_or_self on public.agent_member_access;
create policy agent_member_access_select_if_agent_owner_or_self on public.agent_member_access
for select to authenticated using (
  member_id = app.current_actor_for_agent(agent_member_access.agent_id)
  or exists (
    select 1
      from public.agents ag
     where ag.id = agent_member_access.agent_id
       and ag.owner_member_id = app.current_actor_for_agent(ag.id)
  )
);

-- 5. agent_member_access manage (ALL) RLS — only the agent owner.
drop policy if exists agent_member_access_manage_if_agent_owner on public.agent_member_access;
create policy agent_member_access_manage_if_agent_owner on public.agent_member_access
for all to authenticated using (
  exists (
    select 1
      from public.agents ag
     where ag.id = agent_member_access.agent_id
       and ag.owner_member_id = app.current_actor_for_agent(ag.id)
  )
)
with check (
  exists (
    select 1
      from public.agents ag
     where ag.id = agent_member_access.agent_id
       and ag.owner_member_id = app.current_actor_for_agent(ag.id)
  )
);

-- 6. can_prompt_agent — caller has prompt/admin on a visible/owned agent.
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
      join public.agents ag on ag.id = ama.agent_id
      join public.actors act on act.id = ag.id
     where ama.agent_id = target_agent_id
       and ama.member_id = app.current_actor_id_for_team(act.team_id)
       and ama.permission_level in ('prompt', 'admin')
       and app.is_team_member(act.team_id)
       and (
         ag.visibility = 'team'
         or ag.owner_member_id = app.current_actor_id_for_team(act.team_id)
       )
  )
$$;

-- 7. share_agent_to_team — only the agent owner.
create or replace function public.share_agent_to_team(
  p_agent_id uuid
) returns void
language plpgsql security definer set search_path = public, auth, app
as $$
begin
  if not exists (
    select 1
      from public.agents ag
     where ag.id = p_agent_id
       and ag.owner_member_id = app.current_actor_for_agent(p_agent_id)
  ) then
    raise exception 'only agent owner can share agent to team'
      using errcode = '42501';
  end if;

  update public.agents
     set visibility = 'team',
         updated_at = now()
   where id = p_agent_id;
end;
$$;

-- 8. make_agent_personal — only the agent owner.
create or replace function public.make_agent_personal(
  p_agent_id uuid
) returns void
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_owner uuid;
begin
  select owner_member_id into v_owner
    from public.agents
   where id = p_agent_id;

  if v_owner is null or v_owner <> app.current_actor_for_agent(p_agent_id) then
    raise exception 'only agent owner can make agent personal'
      using errcode = '42501';
  end if;

  update public.agents
     set visibility = 'personal',
         updated_at = now()
   where id = p_agent_id;

  delete from public.agent_member_access
   where agent_id = p_agent_id
     and member_id <> v_owner;

  insert into public.agent_member_access (
    agent_id,
    member_id,
    permission_level,
    granted_by_member_id
  )
  values (p_agent_id, v_owner, 'admin', v_owner)
  on conflict (agent_id, member_id) do update
    set permission_level = 'admin',
        granted_by_member_id = excluded.granted_by_member_id,
        updated_at = now();
end;
$$;

-- 9. update_owned_agent_profile — only the agent owner.
create or replace function public.update_owned_agent_profile(
  p_agent_id uuid,
  p_display_name text,
  p_visibility text default null
)
returns table (
  agent_id uuid,
  display_name text,
  visibility text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth, app
as $$
declare
  v_display_name text := nullif(btrim(p_display_name), '');
  v_visibility text := nullif(btrim(coalesce(p_visibility, '')), '');
begin
  if v_display_name is null then
    raise exception 'display name is required'
      using errcode = '23514';
  end if;

  if v_visibility is not null and v_visibility not in ('personal', 'team') then
    raise exception 'visibility must be personal or team'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
      from public.agents ag
     where ag.id = p_agent_id
       and ag.owner_member_id = app.current_actor_for_agent(p_agent_id)
  ) then
    raise exception 'only agent owner can update agent profile'
      using errcode = '42501';
  end if;

  update public.actors a
     set display_name = v_display_name,
         updated_at = now()
   where a.id = p_agent_id
     and a.actor_type = 'agent';

  update public.agents ag
     set visibility = coalesce(v_visibility, ag.visibility),
         updated_at = now()
   where ag.id = p_agent_id;

  return query
  select ag.id, a.display_name, ag.visibility, greatest(a.updated_at, ag.updated_at)
    from public.agents ag
    join public.actors a on a.id = ag.id
   where ag.id = p_agent_id;
end;
$$;

revoke all on function public.update_owned_agent_profile(uuid, text, text) from public;
grant execute on function public.update_owned_agent_profile(uuid, text, text) to authenticated;

-- 10. list_agent_admin_member_actor_ids — owner branch must be team-scoped.
create or replace function public.list_agent_admin_member_actor_ids(
  p_agent_actor_id uuid
)
returns table (member_actor_id uuid)
language sql
stable
security definer
set search_path = public, app
as $$
  select ama.member_id
    from public.agent_member_access as ama
    join public.agents as ag on ag.id = ama.agent_id
   where ama.agent_id = p_agent_actor_id
     and ama.permission_level = 'admin'
     and (
       p_agent_actor_id = app.current_actor_id()
       or ag.owner_member_id = app.current_actor_for_agent(p_agent_actor_id)
     )
   order by ama.created_at;
$$;

revoke all on function public.list_agent_admin_member_actor_ids(uuid) from public, anon, authenticated;
grant execute on function public.list_agent_admin_member_actor_ids(uuid) to authenticated;

-- <<< END archived migration: 20260529100001_list_connected_agents_team_scoped_actor.sql

-- >>> BEGIN archived migration: 20260530000001_attachments_bucket_public.sql

-- Make the `attachments` bucket public.
--
-- The iOS Supabase→Cloud API cutover removed the Supabase SDK and with it the
-- `createSignedURL` path that minted tokenless 1-year signed URLs. Attachment
-- URLs are persisted into message content / idea `attachment_urls` and rendered
-- by every client (iOS/web/expo) via a plain image fetch, so they must resolve
-- without a bearer. We therefore make the bucket public (mirroring `avatars`),
-- and rely on the unguessable object path (`<team>/<session>/<uuid>/<file>`) as
-- the capability — the same confidentiality model already used for avatars.
update storage.buckets set public = true where id = 'attachments';

-- Explicit public read for the bucket (public-object serving bypasses RLS, but
-- declare the policy so the intent is visible and direct PostgREST/storage reads
-- are also allowed).
drop policy if exists attachments_public_read on storage.objects;
create policy attachments_public_read
on storage.objects for select
to public
using (bucket_id = 'attachments');

-- The legacy authenticated participant-scoped read policy is now redundant with
-- public read; drop it to avoid confusion.
drop policy if exists "session_participants_can_download" on storage.objects;

-- <<< END archived migration: 20260530000001_attachments_bucket_public.sql

-- >>> BEGIN archived migration: 20260530010707_actor_directory_agent_visibility.sql

-- Surface agent visibility (team | personal) in the actor_directory read
-- surface, and stop hiding the caller's OWN personal agents from it.
--
-- Background: the previous actor_directory definition (20260522000001) only
-- exposed agents whose visibility = 'team', so personal agents never appeared
-- in the team members list. The UI now wants to render each agent's
-- Team/Personal kind in the actors list, which requires (a) the visibility
-- column to be readable and (b) the caller's own personal agents to be
-- included alongside team agents.
--
-- The owner predicate mirrors the canonical team-scoped pattern used by
-- list_connected_agents / agent RLS (20260529100001):
--     ag.visibility = 'team'
--     OR ag.owner_member_id = app.current_actor_id_for_team(team_id)
-- Note: app.current_actor_id_for_team is team-scoped — NOT app.current_member_id(),
-- which returns the oldest actor across all teams and breaks multi-team owner checks.
--
-- This view is security_invoker = true, so the owner predicate is evaluated per
-- caller; combined with the existing agents RLS (team OR owner) it never leaks
-- another user's personal agent.

drop view if exists public.actor_directory;

create view public.actor_directory
  with (security_invoker = true)
as
select
  a.id, a.team_id, a.actor_type, a.user_id, a.invited_by_actor_id,
  a.display_name, a.avatar_url, a.last_active_at, a.created_at, a.updated_at,
  m.status      as member_status,
  tm.role       as team_role,
  ag.agent_types,
  ag.default_agent_type,
  ag.default_workspace_id,
  ag.visibility as agent_visibility,
  ag.status     as agent_status
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id
where a.actor_type <> 'agent'
   or ag.visibility = 'team'
   or ag.owner_member_id = app.current_actor_id_for_team(a.team_id);

grant select on public.actor_directory to authenticated;

-- <<< END archived migration: 20260530010707_actor_directory_agent_visibility.sql

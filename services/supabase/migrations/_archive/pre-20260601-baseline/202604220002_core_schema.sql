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

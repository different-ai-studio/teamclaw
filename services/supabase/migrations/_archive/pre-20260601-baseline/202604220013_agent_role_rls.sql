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

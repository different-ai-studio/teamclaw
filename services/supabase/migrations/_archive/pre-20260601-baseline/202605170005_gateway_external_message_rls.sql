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

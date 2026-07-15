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

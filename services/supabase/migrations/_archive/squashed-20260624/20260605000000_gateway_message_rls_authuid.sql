-- Fix: inbound gateway (WeCom/Feishu/Discord/…) user messages were silently
-- dropped — the daemon's INSERT was rejected by RLS, so Tauri/iOS clients saw
-- only the agent's replies, never the external user's message.
--
-- Root cause: `app.daemon_can_write_gateway_message` (and the earlier baseline
-- variant) authorize the daemon by reading a custom JWT claim — either
-- `app_metadata.memberships` (via `app.jwt_memberships()`) or
-- `app_metadata.actor_id`/`team_id` (via `app.current_jwt_*`). Those claims are
-- only populated by the `amux_access_token_hook`, which requires GoTrue's
-- custom-access-token hook to be enabled. On this deployment the hook is NOT
-- enabled, so the daemon's token carries an empty `app_metadata` and every
-- gateway (external-sender) insert fails the policy. Agent replies still land
-- because `messages_agent_write` authorizes via `app.is_current_agent()`, which
-- only needs `actors.user_id = auth.uid()` — and the daemon's `sub`/`auth.uid()`
-- is always present and correct.
--
-- Fix: authorize the daemon the same way the agent-reply path already does —
-- purely from `auth.uid()`. The daemon may write a gateway message on behalf of
-- an external participant iff it owns an agent (any team it owns) that is a
-- participant of the target session. No custom claim required, so this works
-- with or without the access-token hook. Conditions 2–4 (sender is a
-- participant, session in team, sender actor in team) are unchanged.

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
    -- the caller owns an agent that participates in this session+team
    exists (
      select 1
        from public.actors as agent
        join public.session_participants as sp
          on sp.actor_id = agent.id
       where agent.user_id = auth.uid()
         and agent.actor_type = 'agent'
         and agent.team_id = p_team_id
         and sp.session_id = p_session_id
    )
    -- the sender is a participant of the session
    and exists (
      select 1
        from public.session_participants as sp
       where sp.session_id = p_session_id
         and sp.actor_id = p_sender_actor_id
    )
    -- the session belongs to the team
    and exists (
      select 1
        from public.sessions as s
       where s.id = p_session_id
         and s.team_id = p_team_id
    )
    -- the sender actor belongs to the team
    and exists (
      select 1
        from public.actors as a
       where a.id = p_sender_actor_id
         and a.team_id = p_team_id
    );
$$;

revoke all on function app.daemon_can_write_gateway_message(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function app.daemon_can_write_gateway_message(uuid, uuid, uuid) to authenticated;

-- Re-assert the policy (idempotent; the function signature is unchanged so the
-- existing policy already binds to it — this guards against drift).
drop policy if exists messages_daemon_gateway_participant_write on public.messages;
create policy messages_daemon_gateway_participant_write on public.messages
for insert to authenticated
with check (
  app.daemon_can_write_gateway_message(team_id, session_id, sender_actor_id)
);

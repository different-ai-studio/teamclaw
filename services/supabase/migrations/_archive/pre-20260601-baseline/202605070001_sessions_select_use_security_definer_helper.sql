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

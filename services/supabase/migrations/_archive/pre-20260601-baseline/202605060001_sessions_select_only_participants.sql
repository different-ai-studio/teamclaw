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

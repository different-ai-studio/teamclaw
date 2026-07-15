-- sessions INSERT RLS used app.current_actor_id() (oldest actor globally), which
-- breaks multi-team users and rejected Cloud API creates that correctly set
-- created_by_actor_id to the caller's actor in the target team.
-- Scope the check to the session's team, matching app.current_actor_id_for_team().

drop policy if exists sessions_insert_if_team_member on public.sessions;
create policy sessions_insert_if_team_member on public.sessions
for insert to authenticated with check (
  app.is_team_member(team_id)
  and created_by_actor_id = app.current_actor_id_for_team(team_id)
);

drop policy if exists session_participants_insert_if_team_member on public.session_participants;
create policy session_participants_insert_if_team_member on public.session_participants
for insert to authenticated with check (
  exists (
    select 1
    from public.sessions s
    where s.id = session_participants.session_id
      and app.is_team_member(s.team_id)
      and (
        s.created_by_actor_id = app.current_actor_id_for_team(s.team_id)
        or app.is_session_participant(session_participants.session_id)
      )
  )
);

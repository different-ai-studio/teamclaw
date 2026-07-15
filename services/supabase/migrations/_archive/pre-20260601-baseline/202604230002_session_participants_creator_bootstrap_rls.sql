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

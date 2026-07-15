-- Session share links let a teammate open teamclaw://session/<id> and join the
-- session. Under RLS a non-participant team member can neither SELECT the
-- session (sessions_select_if_participant_or_creator) nor INSERT themselves into
-- session_participants (session_participants_insert_if_team_member requires
-- being the creator or an existing participant). This SECURITY DEFINER RPC lets
-- any member of the session's team add themselves once, in a controlled way
-- (membership is still enforced). Mirrors amux.mark_current_actor_session_viewed
-- and amux.list_my_teams_current_org (post teamclaw->amux move; the FC supabase
-- client is configured with db.schema='amux').

create or replace function amux.join_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $$
declare
  v_team_id uuid;
  v_actor_id uuid;
begin
  select team_id into v_team_id from amux.sessions where id = p_session_id;
  if v_team_id is null then
    raise exception 'session not found' using errcode = 'no_data_found'; -- P0002
  end if;

  v_actor_id := amux.current_actor_id_for_team(v_team_id);
  if v_actor_id is null then
    raise exception 'not a member of this session''s team'
      using errcode = 'insufficient_privilege'; -- 42501
  end if;

  insert into amux.session_participants (session_id, actor_id, role)
  values (p_session_id, v_actor_id, 'member')
  on conflict (session_id, actor_id) do nothing;
end;
$$;

revoke all on function amux.join_session(uuid) from public;
grant execute on function amux.join_session(uuid) to authenticated;

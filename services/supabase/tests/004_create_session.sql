begin;

do $$
declare
  v_team uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_idea uuid := gen_random_uuid();
  v_session uuid;
  v_ad_hoc_session uuid;
begin
  insert into auth.users (id) values (v_member);
  insert into public.teams (id, slug, name) values (v_team, 'sess-test', 'Sess Test');
  insert into public.actors (id, team_id, actor_type, display_name) values
    (v_member, v_team, 'member', 'me'),
    (v_agent, v_team, 'agent', 'ci');
  insert into public.members (id, user_id, status) values (v_member, v_member, 'active');
  insert into public.team_members (team_id, member_id, role)
    values (v_team, v_member, 'owner');
  insert into public.agents (id, owner_member_id, visibility, agent_kind, status)
    values (v_agent, v_member, 'team', 'claude', 'active');
  insert into public.ideas (id, team_id, created_by_actor_id, title, status)
    values (v_idea, v_team, v_member, 'fix bug', 'open');

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_member::text, 'role', 'authenticated')::text, true);

  v_session := public.create_session(v_agent, v_idea, 'solo', 'First try');

  if v_session is null then
    raise exception 'create_session returned null';
  end if;

  if not exists (
    select 1 from public.sessions
    where id = v_session
      and primary_agent_id = v_agent
      and idea_id = v_idea
      and created_by_actor_id = v_member
  ) then
    raise exception 'session row malformed';
  end if;

  if not exists (
    select 1 from public.session_participants
    where session_id = v_session and actor_id = v_member
  ) then
    raise exception 'caller not added as participant';
  end if;

  if not exists (
    select 1 from public.session_participants
    where session_id = v_session and actor_id = v_agent
  ) then
    raise exception 'agent not added as participant';
  end if;

  v_ad_hoc_session := public.create_session(v_agent, null, 'collab', 'Session without idea');

  if v_ad_hoc_session is null then
    raise exception 'create_session with null idea returned null';
  end if;

  if not exists (
    select 1 from public.sessions
    where id = v_ad_hoc_session
      and primary_agent_id = v_agent
      and idea_id is null
      and created_by_actor_id = v_member
  ) then
    raise exception 'null-idea session row malformed';
  end if;
end;
$$;

rollback;

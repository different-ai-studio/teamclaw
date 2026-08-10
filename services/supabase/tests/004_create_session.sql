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
  insert into amux.teams (id, slug, name) values (v_team, 'sess-test', 'Sess Test');
  -- user_id lives on actors now, not on members: identity is per-team, so the
  -- link to auth.users belongs on the per-team row.
  insert into amux.actors (id, team_id, actor_type, display_name, user_id) values
    (v_member, v_team, 'member', 'me', v_member),
    (v_agent, v_team, 'agent', 'ci', null);
  insert into amux.members (id, status) values (v_member, 'active');
  insert into amux.team_members (team_id, member_id, role)
    values (v_team, v_member, 'owner');
  -- agent_kind is gone; the runtime is named by default_agent_type / agent_types.
  insert into amux.agents (id, owner_member_id, visibility, status)
    values (v_agent, v_member, 'team', 'active');
  insert into amux.ideas (id, team_id, created_by_actor_id, title, status)
    values (v_idea, v_team, v_member, 'fix bug', 'open');

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_member::text, 'role', 'authenticated')::text, true);

  v_session := amux.create_session(v_agent, v_idea, 'solo', 'First try');

  if v_session is null then
    raise exception 'create_session returned null';
  end if;

  if not exists (
    select 1 from amux.sessions
    where id = v_session
      and primary_agent_id = v_agent
      and idea_id = v_idea
      and created_by_actor_id = v_member
  ) then
    raise exception 'session row malformed';
  end if;

  if not exists (
    select 1 from amux.session_participants
    where session_id = v_session and actor_id = v_member
  ) then
    raise exception 'caller not added as participant';
  end if;

  if not exists (
    select 1 from amux.session_participants
    where session_id = v_session and actor_id = v_agent
  ) then
    raise exception 'agent not added as participant';
  end if;

  v_ad_hoc_session := amux.create_session(v_agent, null, 'collab', 'Session without idea');

  if v_ad_hoc_session is null then
    raise exception 'create_session with null idea returned null';
  end if;

  if not exists (
    select 1 from amux.sessions
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

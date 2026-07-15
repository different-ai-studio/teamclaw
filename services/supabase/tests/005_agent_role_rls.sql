begin;

-- Seed: team, member, agent, session with both as participants.
create temp table _rls_ids (
  team_id uuid,
  other_team uuid,
  member_id uuid,
  agent_id uuid,
  session_id uuid
) on commit drop;

do $$
declare
  v_team uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_idea uuid := gen_random_uuid();
  v_session uuid;
begin
  insert into auth.users (id) values (v_member);
  insert into public.teams (id, slug, name) values
    (v_team, 'rls-agent', 'RLS Agent'),
    (v_other, 'other-team', 'Other Team');
  insert into public.actors (id, team_id, actor_type, display_name) values
    (v_member, v_team, 'member', 'm'),
    (v_agent, v_team, 'agent', 'a');
  insert into public.members (id, user_id, status) values (v_member, v_member, 'active');
  insert into public.team_members (team_id, member_id, role)
    values (v_team, v_member, 'owner');
  insert into public.agents (id, owner_member_id, visibility, agent_kind, status)
    values (v_agent, v_member, 'team', 'claude', 'active');
  insert into public.ideas (id, team_id, created_by_actor_id, title, status)
    values (v_idea, v_team, v_member, 't', 'open');
  insert into public.sessions (id, team_id, idea_id, created_by_actor_id,
                               primary_agent_id, mode, title)
    values (gen_random_uuid(), v_team, v_idea, v_member, v_agent, 'solo', 's')
    returning id into v_session;
  insert into public.session_participants (session_id, actor_id) values
    (v_session, v_member), (v_session, v_agent);

  insert into _rls_ids values (v_team, v_other, v_member, v_agent, v_session);
end;
$$;

-- Run policy checks under a daemon JWT + authenticated role.
do $$
declare
  r _rls_ids;
  v_claims text;
  v_err_code text;
begin
  select * into r from _rls_ids;
  v_claims := json_build_object(
    'sub', gen_random_uuid()::text,
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'kind', 'daemon',
      'team_id', r.team_id::text,
      'actor_id', r.agent_id::text
    )
  )::text;
  perform set_config('request.jwt.claims', v_claims, true);
  perform set_config('role', 'authenticated', true);

  -- Allowed: insert agent_runtimes for own agent.
  insert into public.agent_runtimes
    (team_id, agent_id, session_id, backend_type, status)
    values (r.team_id, r.agent_id, r.session_id, 'claude', 'running');

  -- Allowed: insert messages as self.
  insert into public.messages
    (team_id, session_id, sender_actor_id, kind, content)
    values (r.team_id, r.session_id, r.agent_id, 'text', 'hi');

  -- Allowed: insert a workspace for self.
  insert into public.workspaces (team_id, agent_id, name, path)
    values (r.team_id, r.agent_id, 'amux', '/tmp/amux');

  -- Denied: impersonating another actor as the message sender.
  begin
    insert into public.messages
      (team_id, session_id, sender_actor_id, kind, content)
      values (r.team_id, r.session_id, r.member_id, 'text', 'spoof');
    raise exception 'impersonation should be blocked';
  exception
    when insufficient_privilege then null;
    when check_violation then null;
    when others then
      get stacked diagnostics v_err_code = returned_sqlstate;
      if v_err_code not in ('42501','23514') then
        raise exception 'impersonation wrong sqlstate %', v_err_code;
      end if;
  end;

  -- Denied: writing workspace in a different team.
  begin
    insert into public.workspaces (team_id, agent_id, name)
      values (r.other_team, r.agent_id, 'other');
    raise exception 'cross-team workspace should be blocked';
  exception
    when insufficient_privilege then null;
    when check_violation then null;
    when others then
      get stacked diagnostics v_err_code = returned_sqlstate;
      if v_err_code not in ('42501','23514') then
        raise exception 'cross-team wrong sqlstate %', v_err_code;
      end if;
  end;

  -- Reset role so rollback can run cleanly.
  perform set_config('role', 'postgres', true);
end;
$$;

-- Sanity: a non-daemon JWT cannot insert into agent_runtimes (no matching policy).
do $$
declare
  r _rls_ids;
  v_err_code text;
begin
  select * into r from _rls_ids;
  perform set_config('request.jwt.claims',
    json_build_object('sub', r.member_id::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  begin
    insert into public.agent_runtimes
      (team_id, agent_id, session_id, backend_type, status)
      values (r.team_id, r.agent_id, r.session_id, 'claude', 'running');
    raise exception 'non-daemon should not be able to insert agent_runtimes';
  exception
    when insufficient_privilege then null;
    when others then
      get stacked diagnostics v_err_code = returned_sqlstate;
      if v_err_code <> '42501' then
        raise exception 'non-daemon wrong sqlstate %', v_err_code;
      end if;
  end;

  perform set_config('role', 'postgres', true);
end;
$$;

rollback;

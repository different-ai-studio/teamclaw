begin;

-- Seed: team, member, agent, session with both as participants.
create temp table _rls_ids (
  team_id uuid,
  other_team uuid,
  member_id uuid,
  agent_id uuid,
  session_id uuid,
  daemon_user uuid,
  bystander_id uuid
) on commit drop;

do $$
declare
  v_team uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_idea uuid := gen_random_uuid();
  v_session uuid;
  -- The agent needs its own auth user. is_current_agent() matches the agent
  -- actor by actors.user_id = auth.uid(), so a daemon JWT only authorizes the
  -- agent whose row carries that user id -- the app_metadata.actor_id claim the
  -- old ACP policies keyed off no longer takes part.
  v_daemon uuid := gen_random_uuid();
  -- A team member who is NOT in the session. The daemon relays for session
  -- participants by design (that is the whole gateway path), so impersonation
  -- has to be probed with someone the session does not contain.
  v_bystander uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_member), (v_daemon);
  insert into amux.teams (id, slug, name) values
    (v_team, 'rls-agent', 'RLS Agent'),
    (v_other, 'other-team', 'Other Team');
-- user_id lives on actors now: identity is per team, so the link to
-- auth.users belongs on the per-team row rather than on members.
  insert into amux.actors (id, team_id, actor_type, display_name, user_id) values
    (v_member, v_team, 'member', 'm', v_member),
    (v_agent, v_team, 'agent', 'a', v_daemon),
    (v_bystander, v_team, 'member', 'b', null);
  insert into amux.members (id, status) values (v_member, 'active');
  insert into amux.team_members (team_id, member_id, role)
    values (v_team, v_member, 'owner');
  insert into amux.agents (id, owner_member_id, visibility, status) values (v_agent, v_member, 'team', 'active');
  insert into amux.ideas (id, team_id, created_by_actor_id, title, status)
    values (v_idea, v_team, v_member, 't', 'open');
  insert into amux.sessions (id, team_id, idea_id, created_by_actor_id,
                               primary_agent_id, mode, title)
    values (gen_random_uuid(), v_team, v_idea, v_member, v_agent, 'solo', 's')
    returning id into v_session;
  insert into amux.session_participants (session_id, actor_id) values
    (v_session, v_member), (v_session, v_agent);

  insert into _rls_ids values (v_team, v_other, v_member, v_agent, v_session, v_daemon, v_bystander);
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
    'sub', r.daemon_user::text,
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'kind', 'daemon',
      'team_id', r.team_id::text,
      'actor_id', r.agent_id::text
    )
  )::text;
  perform set_config('request.jwt.claims', v_claims, true);
  perform set_config('role', 'authenticated', true);

  -- The agent_runtimes coverage that used to open this block is gone with the
  -- table: the ACP era gave every runtime a row here, and the single-agent
  -- opencode HTTP runtime has no per-runtime record to write. What remains is
  -- the part that still exists -- a daemon JWT writing as its own agent.

  -- Allowed: insert messages as self.
  insert into amux.messages
    (team_id, session_id, sender_actor_id, kind, content)
    values (r.team_id, r.session_id, r.agent_id, 'text', 'hi');

  -- Allowed: insert a workspace for self.
  insert into amux.workspaces (team_id, agent_id, name, path)
    values (r.team_id, r.agent_id, 'amux', '/tmp/amux');

  -- Denied: impersonating an actor the session does not contain.
  --
  -- daemon_can_write_gateway_message authorizes a relay for any *participant*
  -- of the session -- that is how a WeCom user's message reaches the table --
  -- so the member sitting in this session is legitimately relayable and cannot
  -- serve as the impersonation probe. A team member outside the session is.
  begin
    insert into amux.messages
      (team_id, session_id, sender_actor_id, kind, content)
      values (r.team_id, r.session_id, r.bystander_id, 'text', 'spoof');
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
    insert into amux.workspaces (team_id, agent_id, name)
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

-- Sanity: a plain member JWT cannot speak as the agent.
--
-- This replaces the agent_runtimes check that used to live here (that table is
-- gone) and keeps its shape: a non-daemon caller must not reach the
-- agent-scoped write path. Note it has to be a *message*, not a workspace --
-- workspaces_insert_if_team_member lets any team member insert a workspace row
-- and never constrains agent_id, so a workspace write proves nothing here.
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
    insert into amux.messages
      (team_id, session_id, sender_actor_id, kind, content)
      values (r.team_id, r.session_id, r.agent_id, 'text', 'as the agent');
    raise exception 'non-daemon should not be able to send as the agent';
  exception
    when insufficient_privilege then null;
    when check_violation then null;
    when others then
      get stacked diagnostics v_err_code = returned_sqlstate;
      if v_err_code not in ('42501', '23514') then
        raise exception 'non-daemon wrong sqlstate %', v_err_code;
      end if;
  end;

  perform set_config('role', 'postgres', true);
end;
$$;

rollback;

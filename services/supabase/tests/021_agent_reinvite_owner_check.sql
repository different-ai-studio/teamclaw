-- services/supabase/tests/021_agent_reinvite_owner_check.sql
-- Verifies that create_team_invite with p_target_actor_id (agent kind)
-- requires the caller to be the agent's owner (owner_member_id).
begin;

-- Helpers for switching JWT context
create or replace function pg_temp.as_member(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- Fixture:
--   alice  — team owner, also the agent's owner_member_id
--   bob    — a second team member (not the agent owner)
--   agent  — an agent actor owned by alice
do $$
declare
  v_team      uuid := gen_random_uuid();
  v_alice_uid uuid := gen_random_uuid();
  v_bob_uid   uuid := gen_random_uuid();
  v_alice_mem uuid := gen_random_uuid();
  v_bob_mem   uuid := gen_random_uuid();
  v_agent_actor uuid := gen_random_uuid();
  v_err_code  text;
begin
  -- auth users
  insert into auth.users (id, email, aud, role, instance_id, is_anonymous)
  values
    (v_alice_uid, 'alice-oc@amux.test', 'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false),
    (v_bob_uid,   'bob-oc@amux.test',   'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false)
  on conflict do nothing;

  -- members
  insert into public.members (id, user_id, status)
  values
    (v_alice_mem, v_alice_uid, 'active'),
    (v_bob_mem,   v_bob_uid,   'active');

  -- team
  insert into public.teams (id, slug, name)
  values (v_team, 'oc-test-' || left(v_team::text, 8), 'Owner Check Test');

  -- actors for alice and bob (members)
  insert into public.actors (id, team_id, actor_type, display_name, user_id)
  values
    (v_alice_mem, v_team, 'member', 'Alice', v_alice_uid),
    (v_bob_mem,   v_team, 'member', 'Bob',   v_bob_uid);

  -- team_members
  insert into public.team_members (team_id, member_id, role)
  values
    (v_team, v_alice_mem, 'owner'),
    (v_team, v_bob_mem,   'member');

  -- agent actor owned by alice
  insert into public.actors (id, team_id, actor_type, display_name)
  values (v_agent_actor, v_team, 'agent', 'TestAgent');

  insert into public.agents (id, agent_kind, status, owner_member_id)
  values (v_agent_actor, 'claude', 'active', v_alice_mem);

  -- ── Test 1: owner (alice) can create a re-invite for her agent ───────────
  perform pg_temp.as_member(v_alice_uid);
  perform public.create_team_invite(
    v_team, 'agent', 'TestAgent',
    p_agent_kind    => 'claude',
    p_target_actor_id => v_agent_actor
  );
  -- reaching here without exception = pass

  -- ── Test 2: non-owner (bob) is rejected with 42501 ───────────────────────
  perform pg_temp.as_member(v_bob_uid);
  begin
    perform public.create_team_invite(
      v_team, 'agent', 'TestAgent',
      p_agent_kind      => 'claude',
      p_target_actor_id => v_agent_actor
    );
    raise exception 'expected 42501 but no exception was raised';
  exception
    when others then
      get stacked diagnostics v_err_code = returned_sqlstate;
      if v_err_code <> '42501' then
        raise exception 'wrong sqlstate: got % expected 42501', v_err_code;
      end if;
  end;

  raise notice 'agent_reinvite_owner_check: all assertions passed';
end;
$$;

rollback;

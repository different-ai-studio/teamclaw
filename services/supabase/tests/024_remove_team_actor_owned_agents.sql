-- services/supabase/tests/024_remove_team_actor_owned_agents.sql
-- Admin removing a member who owns agent(s) should cascade-delete those agents.
-- Post-S2: all business tables live in amux; remove_team_actor must too.
begin;

create or replace function pg_temp.as_member(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

do $$
declare
  v_team        uuid := gen_random_uuid();
  v_owner_uid   uuid := gen_random_uuid();
  v_member_uid  uuid := gen_random_uuid();
  v_owner_mem   uuid := gen_random_uuid();
  v_member_mem  uuid := gen_random_uuid();
  v_agent_actor uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, aud, role, instance_id, is_anonymous)
  values
    (v_owner_uid,  'owner-rm@amux.test',  'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false),
    (v_member_uid, 'member-rm@amux.test', 'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false)
  on conflict do nothing;

  insert into amux.teams (id, slug, name)
  values (v_team, 'rm-own-' || left(v_team::text, 8), 'Remove Owned Agents');

  -- actors first (members/agents.id FK → actors.id)
  insert into amux.actors (id, team_id, actor_type, display_name, user_id)
  values
    (v_owner_mem,  v_team, 'member', 'Owner',  v_owner_uid),
    (v_member_mem, v_team, 'member', 'Member', v_member_uid);

  insert into amux.members (id, status)
  values
    (v_owner_mem,  'active'),
    (v_member_mem, 'active');

  insert into amux.team_members (team_id, member_id, role)
  values
    (v_team, v_owner_mem,  'owner'),
    (v_team, v_member_mem, 'member');

  insert into amux.actors (id, team_id, actor_type, display_name)
  values (v_agent_actor, v_team, 'agent', 'MemberAgent');

  insert into amux.agents (id, status, owner_member_id)
  values (v_agent_actor, 'active', v_member_mem);

  perform pg_temp.as_member(v_owner_uid);
  perform amux.remove_team_actor(v_member_mem);

  if exists (select 1 from amux.actors where id = v_member_mem) then
    raise exception 'member actor should be deleted';
  end if;

  if exists (select 1 from amux.actors where id = v_agent_actor) then
    raise exception 'owned agent actor should be deleted';
  end if;
end;
$$;

select plan(1);
select pass('remove_team_actor cascades owned agents when removing member');
select * from finish();
rollback;

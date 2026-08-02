-- services/supabase/tests/026_workspaces_insert_rls.sql
-- Multi-team users can insert a workspace in team B with team B's member id
-- even when their oldest member actor lives on team A (current_member_id bug).
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
  v_team_a     uuid := gen_random_uuid();
  v_team_b     uuid := gen_random_uuid();
  v_uid        uuid := gen_random_uuid();
  v_member_a   uuid := gen_random_uuid();
  v_member_b   uuid := gen_random_uuid();
  v_other_uid  uuid := gen_random_uuid();
  v_other_mem  uuid := gen_random_uuid();
  v_ws_id      uuid;
begin
  insert into auth.users (id, email, aud, role, instance_id, is_anonymous)
  values
    (v_uid, 'ws-multi@amux.test', 'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false),
    (v_other_uid, 'ws-other@amux.test', 'authenticated', 'authenticated',
     '00000000-0000-0000-0000-000000000000', false)
  on conflict do nothing;

  insert into amux.teams (id, slug, name)
  values
    (v_team_a, 'ws-rls-a-' || substr(v_team_a::text, 1, 8), 'WS RLS Team A'),
    (v_team_b, 'ws-rls-b-' || substr(v_team_b::text, 1, 8), 'WS RLS Team B');

  -- Team A member created first → current_member_id() would return v_member_a.
  insert into amux.actors (id, team_id, actor_type, user_id, display_name)
  values
    (v_member_a, v_team_a, 'member', v_uid, 'Me@A'),
    (v_member_b, v_team_b, 'member', v_uid, 'Me@B'),
    (v_other_mem, v_team_b, 'member', v_other_uid, 'Other@B');
  insert into amux.members (id, status)
  values (v_member_a, 'active'), (v_member_b, 'active'), (v_other_mem, 'active');
  insert into amux.team_members (team_id, member_id, role)
  values
    (v_team_a, v_member_a, 'owner'),
    (v_team_b, v_member_b, 'member'),
    (v_team_b, v_other_mem, 'member');

  perform pg_temp.as_member(v_uid);

  -- Allowed: insert in team B attributed to the team-B member actor.
  insert into amux.workspaces (team_id, created_by_member_id, name, path)
  values (v_team_b, v_member_b, 'Team B Workspace', '/tmp/team-b-ws')
  returning id into v_ws_id;

  if v_ws_id is null then
    raise exception 'expected workspace insert in team B to succeed';
  end if;

  -- Denied: spoof another member as created_by.
  begin
    insert into amux.workspaces (team_id, created_by_member_id, name)
    values (v_team_b, v_other_mem, 'Spoofed');
    raise exception 'creator spoofing should be blocked';
  exception
    when insufficient_privilege then null;
    when others then
      if sqlstate is distinct from '42501' then
        raise;
      end if;
  end;

  perform set_config('role', 'postgres', true);
end;
$$;

rollback;

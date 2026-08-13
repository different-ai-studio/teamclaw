-- 027_current_team_role_multi_team.sql
--
-- Multi-team user: oldest actor is owner on team A; newer actor is admin on
-- team B. current_team_role(B) must return 'admin' (not null via the buggy
-- current_member_id path), and set_team_default_agent(B, …) must succeed.
--
-- Run via:
--   pg_prove -d "$DATABASE_URL" services/supabase/tests/027_current_team_role_multi_team.sql

begin;

select plan(4);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
    true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- Auth user present on two teams
insert into auth.users (id, email, aud, role, instance_id) values
  ('c7a01001-0000-4000-8000-000000000001', 'ctr-multi@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

insert into amux.teams (id, slug, name) values
  ('c7a02001-0000-4000-8000-00000000000a', 'ctr-team-a', 'CTR Team A'),
  ('c7a02001-0000-4000-8000-00000000000b', 'ctr-team-b', 'CTR Team B');

-- Team A actor created first (older) → would win under current_member_id()
insert into amux.actors (id, team_id, actor_type, display_name, user_id, created_at) values
  ('c7a03001-0000-4000-8000-00000000000a', 'c7a02001-0000-4000-8000-00000000000a', 'member', 'CTR On A', 'c7a01001-0000-4000-8000-000000000001', '2026-01-01T00:00:00Z'),
  ('c7a03001-0000-4000-8000-00000000000b', 'c7a02001-0000-4000-8000-00000000000b', 'member', 'CTR On B', 'c7a01001-0000-4000-8000-000000000001', '2026-06-01T00:00:00Z');

insert into amux.members (id, status) values
  ('c7a03001-0000-4000-8000-00000000000a', 'active'),
  ('c7a03001-0000-4000-8000-00000000000b', 'active');

insert into amux.team_members (team_id, member_id, role) values
  ('c7a02001-0000-4000-8000-00000000000a', 'c7a03001-0000-4000-8000-00000000000a', 'owner'),
  ('c7a02001-0000-4000-8000-00000000000b', 'c7a03001-0000-4000-8000-00000000000b', 'admin');

-- Team-visible active agent on B (valid team default)
insert into amux.actors (id, team_id, actor_type, display_name) values
  ('c7a04001-0000-4000-8000-00000000000b', 'c7a02001-0000-4000-8000-00000000000b', 'agent', 'CTR Agent B');

insert into amux.agents (id, owner_member_id, status, visibility) values
  ('c7a04001-0000-4000-8000-00000000000b', 'c7a03001-0000-4000-8000-00000000000b', 'active', 'team');

select pg_temp.as_user('c7a01001-0000-4000-8000-000000000001');

select is(
  amux.current_member_id(),
  'c7a03001-0000-4000-8000-00000000000a'::uuid,
  'current_member_id still returns the oldest actor (team A)'
);

select is(
  amux.current_team_role('c7a02001-0000-4000-8000-00000000000b'::uuid),
  'admin',
  'current_team_role(B) uses team-scoped actor → admin'
);

select is(
  amux.current_team_role('c7a02001-0000-4000-8000-00000000000a'::uuid),
  'owner',
  'current_team_role(A) still returns owner'
);

select is(
  amux.set_team_default_agent(
    'c7a02001-0000-4000-8000-00000000000b'::uuid,
    'c7a04001-0000-4000-8000-00000000000b'::uuid
  ),
  'c7a04001-0000-4000-8000-00000000000b'::uuid,
  'admin on B can set_team_default_agent even when oldest actor is on A'
);

select * from finish();
rollback;

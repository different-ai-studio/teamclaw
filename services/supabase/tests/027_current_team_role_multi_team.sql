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
  ('ctr01001-0000-4000-8000-000000000001', 'ctr-multi@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

insert into amux.teams (id, slug, name) values
  ('ctr02001-0000-4000-8000-00000000000a', 'ctr-team-a', 'CTR Team A'),
  ('ctr02001-0000-4000-8000-00000000000b', 'ctr-team-b', 'CTR Team B');

-- Team A actor created first (older) → would win under current_member_id()
insert into amux.actors (id, team_id, actor_type, display_name, user_id, created_at) values
  ('ctr03001-0000-4000-8000-00000000000a', 'ctr02001-0000-4000-8000-00000000000a', 'member', 'CTR On A', 'ctr01001-0000-4000-8000-000000000001', '2026-01-01T00:00:00Z'),
  ('ctr03001-0000-4000-8000-00000000000b', 'ctr02001-0000-4000-8000-00000000000b', 'member', 'CTR On B', 'ctr01001-0000-4000-8000-000000000001', '2026-06-01T00:00:00Z');

insert into amux.members (id, status) values
  ('ctr03001-0000-4000-8000-00000000000a', 'active'),
  ('ctr03001-0000-4000-8000-00000000000b', 'active');

insert into amux.team_members (team_id, member_id, role) values
  ('ctr02001-0000-4000-8000-00000000000a', 'ctr03001-0000-4000-8000-00000000000a', 'owner'),
  ('ctr02001-0000-4000-8000-00000000000b', 'ctr03001-0000-4000-8000-00000000000b', 'admin');

-- Team-visible active agent on B (valid team default)
insert into amux.actors (id, team_id, actor_type, display_name) values
  ('ctr04001-0000-4000-8000-00000000000b', 'ctr02001-0000-4000-8000-00000000000b', 'agent', 'CTR Agent B');

insert into amux.agents (id, owner_member_id, status, visibility) values
  ('ctr04001-0000-4000-8000-00000000000b', 'ctr03001-0000-4000-8000-00000000000b', 'active', 'team');

select pg_temp.as_user('ctr01001-0000-4000-8000-000000000001');

select is(
  amux.current_member_id(),
  'ctr03001-0000-4000-8000-00000000000a'::uuid,
  'current_member_id still returns the oldest actor (team A)'
);

select is(
  amux.current_team_role('ctr02001-0000-4000-8000-00000000000b'::uuid),
  'admin',
  'current_team_role(B) uses team-scoped actor → admin'
);

select is(
  amux.current_team_role('ctr02001-0000-4000-8000-00000000000a'::uuid),
  'owner',
  'current_team_role(A) still returns owner'
);

select is(
  amux.set_team_default_agent(
    'ctr02001-0000-4000-8000-00000000000b'::uuid,
    'ctr04001-0000-4000-8000-00000000000b'::uuid
  ),
  'ctr04001-0000-4000-8000-00000000000b'::uuid,
  'admin on B can set_team_default_agent even when oldest actor is on A'
);

select * from finish();
rollback;

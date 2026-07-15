begin;

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

select plan(22);

select has_column('public', 'agents', 'visibility');
select col_has_default('public', 'agents', 'visibility');
select has_column('public', 'agents', 'owner_member_id');
select col_not_null('public', 'agents', 'owner_member_id');
select fk_ok('public', 'agents', 'owner_member_id', 'public', 'members', 'id');

insert into auth.users (id, email, aud, role, instance_id)
values
  ('91000000-0000-0000-0000-000000000001', 'agent-owner@teamclaw.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('91000000-0000-0000-0000-000000000002', 'agent-admin@teamclaw.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('91000000-0000-0000-0000-000000000003', 'agent-member@teamclaw.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

insert into public.teams (id, slug, name)
values ('01000000-0000-0000-0000-000000000001', 'agent-visibility', 'Agent Visibility');

insert into public.actors (id, team_id, actor_type, user_id, display_name)
values
  ('11000000-0000-0000-0000-000000000001', '01000000-0000-0000-0000-000000000001', 'member', '91000000-0000-0000-0000-000000000001', 'Owner'),
  ('11000000-0000-0000-0000-000000000002', '01000000-0000-0000-0000-000000000001', 'member', '91000000-0000-0000-0000-000000000002', 'Team Admin'),
  ('11000000-0000-0000-0000-000000000003', '01000000-0000-0000-0000-000000000001', 'member', '91000000-0000-0000-0000-000000000003', 'Granted Member'),
  ('11000000-0000-0000-0000-0000000000a1', '01000000-0000-0000-0000-000000000001', 'agent', null, 'Personal Agent');

insert into public.members (id, status)
values
  ('11000000-0000-0000-0000-000000000001', 'active'),
  ('11000000-0000-0000-0000-000000000002', 'active'),
  ('11000000-0000-0000-0000-000000000003', 'active');

insert into public.team_members (team_id, member_id, role)
values
  ('01000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'member'),
  ('01000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000002', 'admin'),
  ('01000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000003', 'member');

insert into public.agents (id, owner_member_id, agent_kind, status)
values ('11000000-0000-0000-0000-0000000000a1', '11000000-0000-0000-0000-000000000001', 'daemon', 'active');

insert into public.agent_member_access (agent_id, member_id, permission_level, granted_by_member_id)
values
  ('11000000-0000-0000-0000-0000000000a1', '11000000-0000-0000-0000-000000000001', 'admin', '11000000-0000-0000-0000-000000000001'),
  ('11000000-0000-0000-0000-0000000000a1', '11000000-0000-0000-0000-000000000003', 'prompt', '11000000-0000-0000-0000-000000000001');

select pg_temp.as_user('91000000-0000-0000-0000-000000000002');

select ok(
  not exists (
    select 1 from public.actor_directory
    where id = '11000000-0000-0000-0000-0000000000a1'
  ),
  'personal agent is hidden from team actor_directory'
);

select ok(
  not app.can_prompt_agent('11000000-0000-0000-0000-0000000000a1'::uuid),
  'team admin without grant cannot prompt personal agent'
);

select is(
  public.check_agent_permission(
    '11000000-0000-0000-0000-0000000000a1'::uuid,
    '11000000-0000-0000-0000-000000000002'::uuid
  ),
  null,
  'check_agent_permission returns null for ungranted admin'
);

select pg_temp.as_user('91000000-0000-0000-0000-000000000001');

select ok(
  exists (
    select 1 from public.actor_directory
    where id = '11000000-0000-0000-0000-0000000000a1'
  ),
  'owner sees their own personal agent in actor_directory'
);

select ok(
  app.can_prompt_agent('11000000-0000-0000-0000-0000000000a1'::uuid),
  'agent owner can prompt personal agent'
);

select is(
  public.check_agent_permission(
    '11000000-0000-0000-0000-0000000000a1'::uuid,
    '11000000-0000-0000-0000-000000000001'::uuid
  ),
  'admin',
  'check_agent_permission returns admin for owner grant'
);

select lives_ok(
  $$ select public.share_agent_to_team('11000000-0000-0000-0000-0000000000a1'::uuid) $$,
  'owner can share personal agent to team'
);

select is(
  (select visibility from public.agents where id = '11000000-0000-0000-0000-0000000000a1'),
  'team',
  'share_agent_to_team flips visibility only'
);

select is(
  (select owner_member_id from public.agents where id = '11000000-0000-0000-0000-0000000000a1'),
  '11000000-0000-0000-0000-000000000001'::uuid,
  'share_agent_to_team preserves agent owner'
);

select pg_temp.as_user('91000000-0000-0000-0000-000000000002');

select ok(
  exists (
    select 1 from public.actor_directory
    where id = '11000000-0000-0000-0000-0000000000a1'
  ),
  'team agent appears in actor_directory'
);

select throws_ok(
  $$ select public.make_agent_personal('11000000-0000-0000-0000-0000000000a1'::uuid) $$,
  '42501',
  'only agent owner can make agent personal'
);

select ok(
  not app.can_prompt_agent('11000000-0000-0000-0000-0000000000a1'::uuid),
  'team admin still cannot prompt team-visible agent without grant'
);

select pg_temp.as_user('91000000-0000-0000-0000-000000000003');

select ok(
  app.can_prompt_agent('11000000-0000-0000-0000-0000000000a1'::uuid),
  'explicit prompt grant allows team member to prompt team agent'
);

select pg_temp.as_user('91000000-0000-0000-0000-000000000001');

select lives_ok(
  $$ select public.make_agent_personal('11000000-0000-0000-0000-0000000000a1'::uuid) $$,
  'owner can make team agent personal'
);

select is(
  (select visibility from public.agents where id = '11000000-0000-0000-0000-0000000000a1'),
  'personal',
  'make_agent_personal flips visibility to personal'
);

select ok(
  not exists (
    select 1 from public.agent_member_access
    where agent_id = '11000000-0000-0000-0000-0000000000a1'
      and member_id <> '11000000-0000-0000-0000-000000000001'
  ),
  'make_agent_personal removes non-owner grants'
);

select is(
  (select permission_level from public.agent_member_access
   where agent_id = '11000000-0000-0000-0000-0000000000a1'
     and member_id = '11000000-0000-0000-0000-000000000001'),
  'admin',
  'make_agent_personal preserves owner admin grant'
);

select * from finish();
rollback;

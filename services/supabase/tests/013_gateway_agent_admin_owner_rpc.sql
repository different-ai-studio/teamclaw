begin;

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
    true
  );
  perform set_config('role', 'authenticated', true);
end;
$$;

select plan(7);

insert into auth.users (id, email, aud, role, instance_id)
values
  ('00000000-0000-0000-0013-000000000001', 'gateway-agent@teamclaw.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0013-000000000002', 'gateway-owner@teamclaw.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0013-000000000003', 'gateway-other@teamclaw.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

insert into public.teams (id, slug, name)
values ('00000000-0000-0000-0013-000000000010', 'gw-owner-rpc', 'Gateway Owner RPC');

insert into public.actors (id, team_id, actor_type, user_id, display_name)
values
  ('00000000-0000-0000-0013-000000000020', '00000000-0000-0000-0013-000000000010', 'agent', '00000000-0000-0000-0013-000000000001', 'Gateway Agent'),
  ('00000000-0000-0000-0013-000000000030', '00000000-0000-0000-0013-000000000010', 'member', '00000000-0000-0000-0013-000000000002', 'Owner Member'),
  ('00000000-0000-0000-0013-000000000040', '00000000-0000-0000-0013-000000000010', 'member', '00000000-0000-0000-0013-000000000003', 'Other Member');

insert into public.members (id, status)
values
  ('00000000-0000-0000-0013-000000000030', 'active'),
  ('00000000-0000-0000-0013-000000000040', 'active');

insert into public.team_members (team_id, member_id, role)
values
  ('00000000-0000-0000-0013-000000000010', '00000000-0000-0000-0013-000000000030', 'member'),
  ('00000000-0000-0000-0013-000000000010', '00000000-0000-0000-0013-000000000040', 'member');

insert into public.agents (id, owner_member_id, agent_kind, status)
values ('00000000-0000-0000-0013-000000000020', '00000000-0000-0000-0013-000000000030', 'gateway', 'active');

insert into public.agent_member_access (agent_id, member_id, permission_level, granted_by_member_id)
values
  ('00000000-0000-0000-0013-000000000020', '00000000-0000-0000-0013-000000000030', 'admin', '00000000-0000-0000-0013-000000000030'),
  ('00000000-0000-0000-0013-000000000020', '00000000-0000-0000-0013-000000000040', 'prompt', '00000000-0000-0000-0013-000000000030');

select ok(
  not has_function_privilege('anon', 'public.list_agent_admin_member_actor_ids(uuid)', 'EXECUTE'),
  'anon cannot execute gateway owner resolver'
);

select ok(
  has_function_privilege('authenticated', 'public.list_agent_admin_member_actor_ids(uuid)', 'EXECUTE'),
  'authenticated can execute gateway owner resolver'
);

select pg_temp.as_user('00000000-0000-0000-0013-000000000001');

select results_eq(
  $$ select member_actor_id from public.list_agent_admin_member_actor_ids('00000000-0000-0000-0013-000000000020') $$,
  $$ values ('00000000-0000-0000-0013-000000000030'::uuid) $$,
  'agent actor can resolve its admin member owner'
);

select pg_temp.as_user('00000000-0000-0000-0013-000000000002');

select results_eq(
  $$ select member_actor_id from public.list_agent_admin_member_actor_ids('00000000-0000-0000-0013-000000000020') $$,
  $$ values ('00000000-0000-0000-0013-000000000030'::uuid) $$,
  'agent owner member can resolve admin owner ids'
);

select pg_temp.as_user('00000000-0000-0000-0013-000000000003');

select is_empty(
  $$ select member_actor_id from public.list_agent_admin_member_actor_ids('00000000-0000-0000-0013-000000000020') $$,
  'unrelated member cannot resolve agent owner ids'
);

select pg_temp.as_user('00000000-0000-0000-0013-000000000001');

create temporary table gateway_session_result as
select *
  from public.ensure_gateway_session(
    '00000000-0000-0000-0013-000000000010',
    'wecom://aibot/test/single/LiangLiang',
    'WeCom - LiangLiang',
    '00000000-0000-0000-0013-000000000020',
    array(select member_actor_id from public.list_agent_admin_member_actor_ids('00000000-0000-0000-0013-000000000020')),
    '{}'::uuid[]
  );

select is(
  (
    select count(*)
      from public.session_participants
     where session_id = (select session_id from gateway_session_result)
       and actor_id = '00000000-0000-0000-0013-000000000030'
  ),
  1::bigint,
  'gateway session includes admin owner participant'
);

select is(
  (
    select count(*)
      from public.session_participants
     where session_id = (select session_id from gateway_session_result)
       and actor_id = '00000000-0000-0000-0013-000000000040'
  ),
  0::bigint,
  'gateway session does not include prompt-only member as owner'
);

select * from finish();
rollback;

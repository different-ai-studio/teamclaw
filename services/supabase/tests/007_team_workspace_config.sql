begin;

select plan(19);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('role', 'anon')::text,
                     true);
  perform set_config('role', 'anon', true);
end;
$$;

-- Fixture: owner (alice), same-team member (bob), stranger (cara)
insert into auth.users (id, email, aud, role, instance_id) values
  ('a1111111-1111-1111-1111-111111111111', 'alice-wc@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('b2222222-2222-2222-2222-222222222222', 'bob-wc@amux.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('c3333333-3333-3333-3333-333333333333', 'cara-wc@amux.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select * from public.create_team('WC Team');

create temp table ctx as
  select (select id from public.teams where slug = 'wc-team') as team_id;

insert into public.actors (id, team_id, actor_type, display_name)
values ('b2222222-0000-0000-0000-000000000000', (select team_id from ctx), 'member', 'Bob');

insert into public.members (id, user_id, status)
values ('b2222222-0000-0000-0000-000000000000', 'b2222222-2222-2222-2222-222222222222', 'active');

insert into public.team_members (id, team_id, member_id, role)
values (
  'b2222222-0000-0000-0000-000000000001',
  (select team_id from ctx),
  'b2222222-0000-0000-0000-000000000000',
  'member'
);

-- 1. Table exists
select has_table('public', 'team_workspace_config', 'team_workspace_config table exists');

-- 2-9. Has expected columns
select has_column('public', 'team_workspace_config', 'team_id', 'has team_id');
select has_column('public', 'team_workspace_config', 'git_url', 'has git_url');
select has_column('public', 'team_workspace_config', 'git_token', 'has git_token');
select has_column('public', 'team_workspace_config', 'ai_gateway_endpoint', 'has ai_gateway_endpoint');
select has_column('public', 'team_workspace_config', 'shared_dir_name', 'has shared_dir_name');
select has_column('public', 'team_workspace_config', 'env_secret', 'has env_secret');
select has_column('public', 'team_workspace_config', 'last_sync_at', 'has last_sync_at');
select has_column('public', 'team_workspace_config', 'last_sync_error', 'has last_sync_error');

-- 10. Owner can write own team_workspace_config (the create_team RPC seeds an
-- empty row at team creation; the owner fills it in via UPDATE).
update public.team_workspace_config
   set git_url             = 'https://github.com/x/y.git',
       git_branch          = 'main',
       git_token           = 'ghp_abc',
       ai_gateway_endpoint = 'https://gw.example'
 where team_id = (select team_id from ctx);
select pass('owner can update own team_workspace_config');

-- 11. Member can read
select results_eq(
  $$ select git_url from public.team_workspace_config where team_id = (select team_id from ctx) $$,
  $$ values ('https://github.com/x/y.git'::text) $$,
  'owner reads own row'
);

-- 12. Anon cannot read
select pg_temp.as_anon();
select throws_ok(
  $$ select 1 from public.team_workspace_config where team_id = (select team_id from ctx) $$,
  '42501',
  null,
  'anon cannot read'
);

-- 13. Non-owner team member can read
select pg_temp.as_user('b2222222-2222-2222-2222-222222222222');
select results_eq(
  $$ select git_url from public.team_workspace_config where team_id = (select team_id from ctx) $$,
  $$ values ('https://github.com/x/y.git'::text) $$,
  'non-owner team member reads own team row'
);

-- 14. Shared directory name rejects path traversal
select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select throws_ok(
  $$ update public.team_workspace_config set shared_dir_name = '../bad' where team_id = (select team_id from ctx) $$,
  '23514',
  null,
  'shared_dir_name rejects path traversal'
);

-- 15. Stranger cannot read
select pg_temp.as_user('c3333333-3333-3333-3333-333333333333');
select is_empty(
  $$ select 1 from public.team_workspace_config where team_id = (select team_id from ctx) $$,
  'stranger cannot read'
);

-- 16. Stranger UPDATE is silently filtered (RLS USING returns no row), so
-- the owner's row is unchanged.
update public.team_workspace_config set git_url = 'https://stolen.example'
  where team_id = (select team_id from ctx);
select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select results_eq(
  $$ select git_url from public.team_workspace_config where team_id = (select team_id from ctx) $$,
  $$ values ('https://github.com/x/y.git'::text) $$,
  'stranger UPDATE silently filtered (RLS)'
);
select pg_temp.as_user('c3333333-3333-3333-3333-333333333333');

-- 17. enabled defaults true (after switching back to alice)
select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select results_eq(
  $$ select enabled from public.team_workspace_config where team_id = (select team_id from ctx) $$,
  $$ values (true) $$,
  'enabled defaults true'
);

-- 18. Stranger cannot delete (no rows affected, row still exists)
select pg_temp.as_user('c3333333-3333-3333-3333-333333333333');
delete from public.team_workspace_config where team_id = (select team_id from ctx);
select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select isnt_empty(
  $$ select 1 from public.team_workspace_config where team_id = (select team_id from ctx) $$,
  'stranger cannot delete'
);

-- 19. Owner can delete their own row
delete from public.team_workspace_config where team_id = (select team_id from ctx);
select is_empty(
  $$ select 1 from public.team_workspace_config where team_id = (select team_id from ctx) $$,
  'owner can delete own row'
);

select * from finish();
rollback;

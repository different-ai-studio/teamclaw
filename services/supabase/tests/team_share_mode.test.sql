-- team_share_mode.test.sql
--
-- pgTAP tests for migration 20260528000002_team_share_mode.sql:
--   1. Fresh team has share_mode NULL and team_workspace_config.sync_mode NULL
--      (i.e. PR #212's create_team no longer seeds sync_mode='git').
--   2. app.enable_team_share(t, 'oss') sets teams.share_mode='oss' and
--      team_workspace_config.sync_mode='oss'.
--   3. Calling app.enable_team_share again raises (locked).
--   4. Direct UPDATE that changes share_mode raises (trigger).
--   5. app.enable_team_share(t, 'custom_git', url, kind, ref) writes the git
--      remote/auth/cred fields onto teams.
--
-- Run via:
--   supabase db reset
--   supabase test db
-- or:
--   pg_prove -d "$DATABASE_URL" services/supabase/tests/team_share_mode.test.sql

begin;

select plan(12);

-- Helpers (mirror 007_team_workspace_config.sql)
create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.as_service_role()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('role', 'service_role')::text,
                     true);
  perform set_config('role', 'service_role', true);
end;
$$;

-- Fixture: one authenticated user, one team via public.create_team
insert into auth.users (id, email, aud, role, instance_id) values
  ('aa111111-1111-1111-1111-111111111111', 'alice-share@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('bb222222-2222-2222-2222-222222222222', 'bob-share@amux.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

select pg_temp.as_user('aa111111-1111-1111-1111-111111111111');
select * from public.create_team('Share Team');

-- 1. teams.share_mode column exists with the expected enum type
select has_column('public', 'teams', 'share_mode', 'teams.share_mode column exists');
select col_type_is('public', 'teams', 'share_mode', 'app.team_share_mode', 'share_mode is app.team_share_mode');

-- 2. Fresh team: share_mode IS NULL
select is(
  (select share_mode from public.teams where slug = 'share-team'),
  null::app.team_share_mode,
  'fresh team has null share_mode'
);

-- 3. Fresh team: team_workspace_config.sync_mode IS NULL
select is(
  (select twc.sync_mode
     from public.team_workspace_config twc
     join public.teams t on t.id = twc.team_id
    where t.slug = 'share-team'),
  null::text,
  'fresh team_workspace_config has null sync_mode'
);

-- Stash team ids in a temp table the test can read under any role context.
-- (We grant read on it so service_role can still read it; postgres-owned
-- temp tables are not visible to other roles by default.)
create temp table _ids (key text primary key, id uuid);
insert into _ids values
  ('team1', (select id from public.teams where slug = 'share-team'));
grant select on _ids to service_role, authenticated;

-- Second team — create_team enforces first-team-only per user, so we switch
-- to a different authenticated user before calling it.
select pg_temp.as_user('bb222222-2222-2222-2222-222222222222');
select * from public.create_team('Git Team');
insert into _ids values
  ('team2', (select id from public.teams where slug = 'git-team'));

-- 4. enable_team_share('oss') succeeds (service_role context)
select pg_temp.as_service_role();
select lives_ok(
  $q$ select app.enable_team_share((select id from _ids where key='team1'), 'oss'::app.team_share_mode) $q$,
  'enable_team_share oss succeeds'
);

-- 5. teams.share_mode is now 'oss'
select is(
  (select share_mode::text from public.teams
    where id = (select id from _ids where key='team1')),
  'oss',
  'teams.share_mode is oss after enable'
);

-- 6. team_workspace_config.sync_mode mirrors to 'oss'
select is(
  (select sync_mode from public.team_workspace_config
    where team_id = (select id from _ids where key='team1')),
  'oss',
  'team_workspace_config.sync_mode mirrored to oss'
);

-- 7. Second enable_team_share switches mode (no longer locked).
select lives_ok(
  $q$ select public.enable_team_share((select id from _ids where key='team1'), 'managed_git'::app.team_share_mode) $q$,
  'second enable_team_share switches mode'
);

select is(
  (select share_mode::text from public.teams
    where id = (select id from _ids where key='team1')),
  'managed_git',
  'teams.share_mode updated to managed_git'
);

-- 8. Direct UPDATE of share_mode is allowed after guard trigger removal.
select lives_ok(
  $q$ update public.teams set share_mode = 'oss'::app.team_share_mode
       where id = (select id from _ids where key='team1') $q$,
  'direct UPDATE of share_mode is allowed'
);

-- 9. UPDATE that keeps share_mode unchanged still works (regression guard).
select lives_ok(
  $q$ update public.teams set name = 'Share Team Renamed'
       where id = (select id from _ids where key='team1') $q$,
  'UPDATE that leaves share_mode unchanged is allowed'
);

-- 10. custom_git path: enable the second team with git fields.
select lives_ok(
  $q$ select app.enable_team_share((select id from _ids where key='team2'),
                                   'custom_git'::app.team_share_mode,
                                   'https://example.com/repo.git',
                                   'ssh_key',
                                   'cred-ref-1') $q$,
  'enable_team_share custom_git with git fields succeeds'
);

select results_eq(
  $q$ select share_mode::text, git_remote_url, git_auth_kind, git_credential_ref
        from public.teams where id = (select id from _ids where key='team2') $q$,
  $$ values ('custom_git'::text,
             'https://example.com/repo.git'::text,
             'ssh_key'::text,
             'cred-ref-1'::text) $$,
  'custom_git fields written to teams row'
);

select * from finish();
rollback;

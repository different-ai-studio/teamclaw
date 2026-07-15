-- claim_team_invite_agent_org.test.sql
--
-- pgTAP tests for daemon org_id stamping on claim (20260611000000 public,
-- 20260618000000 amux — FC calls amux.claim_team_invite):
--   1. Agent claim on an org-stamped team mints a daemon auth user whose
--      raw_app_meta_data carries org_id = teams.oid (new-agent path).
--   2. With that claim in the JWT (as GoTrue would embed it), the daemon user
--      passes teams_org_guard and can SELECT the team row (e.g. share_mode).
--   3. Without the claim, the same daemon user is blocked (regression control
--      — this was the bug: Sync Now → team_share_not_enabled_for_daemon).
--   4. Rebind path (target_actor_id) rotates to a new daemon user that also
--      carries the org claim.
--   5. Agent claim on a team without oid keeps raw_app_meta_data empty.
--
-- Run via:
--   supabase db reset
--   supabase test db
-- or:
--   pg_prove -d "$DATABASE_URL" services/supabase/tests/claim_team_invite_agent_org.test.sql

begin;

select plan(10);

-- Helpers: simulate an authenticated JWT, optionally with app_metadata.org_id
-- (mirrors how GoTrue embeds raw_app_meta_data into minted access tokens).
create or replace function pg_temp.as_user(p_user uuid, p_org uuid default null)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_org is null then
      json_build_object('sub', p_user::text, 'role', 'authenticated')::text
    else
      json_build_object('sub', p_user::text, 'role', 'authenticated',
                        'app_metadata', json_build_object('org_id', p_org::text))::text
    end,
    true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'anon', true);
end;
$$;

-- Fixture: an org, alice (team owner), and an org-stamped team.
insert into public.orgs (id, name)
values ('99aa0000-0000-4000-8000-000000000001', 'Org Guard Test Org');

insert into auth.users (id, email, aud, role, instance_id) values
  ('aa110000-0000-4000-8000-000000000001', 'alice-agentorg@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

select pg_temp.as_user('aa110000-0000-4000-8000-000000000001');
select * from amux.create_team('Agent Org Team', p_oid => '99aa0000-0000-4000-8000-000000000001');

create temp table ctx as
  select
    (select id from amux.teams where slug = 'agent-org-team') as team,
    '99aa0000-0000-4000-8000-000000000001'::uuid as org;

select isnt((select team from ctx), null, 'fixture team created');
select is((select oid from amux.teams where id = (select team from ctx)),
          (select org from ctx),
          'fixture team is org-stamped (oid set)');

-- ── 1. New-agent claim stamps org_id into the daemon user's app_metadata ────
create temp table ai as
  select * from amux.create_team_invite(
    (select team from ctx), 'agent', 'Daemon One', p_agent_kind => 'daemon');

select pg_temp.as_anon();
create temp table ac as select * from amux.claim_team_invite((select token from ai));

create temp table daemon1 as
  select a.user_id from amux.actors a where a.id = (select actor_id from ac);

select ok((select refresh_token is not null from ac),
          'agent claim returns a refresh_token');
select is((select u.raw_app_meta_data ->> 'org_id' from auth.users u
            where u.id = (select user_id from daemon1)),
          (select org from ctx)::text,
          'new daemon user carries app_metadata.org_id = teams.oid');

-- ── 2. With the org claim, the daemon passes teams_org_guard ────────────────
select pg_temp.as_user((select user_id from daemon1), (select org from ctx));
select ok(exists (select 1 from amux.teams where id = (select team from ctx)),
          'daemon JWT with org claim can SELECT the team row (share-mode readable)');

-- ── 3. Without the claim, the daemon is blocked (the original regression) ───
select pg_temp.as_user((select user_id from daemon1));
select ok(not exists (select 1 from amux.teams where id = (select team from ctx)),
          'daemon JWT without org claim is blocked by teams_org_guard');

-- ── 4. Rebind (target_actor_id) rotates to a new user that keeps the claim ──
select pg_temp.as_user('aa110000-0000-4000-8000-000000000001');
create temp table ri as
  select * from amux.create_team_invite(
    (select team from ctx), 'agent', 'Daemon One', p_agent_kind => 'daemon',
    p_target_actor_id => (select actor_id from ac));

select pg_temp.as_anon();
create temp table rc as select * from amux.claim_team_invite((select token from ri));

create temp table daemon2 as
  select a.user_id from amux.actors a where a.id = (select actor_id from rc);

select isnt((select user_id from daemon2), (select user_id from daemon1),
            'rebind rotates the actor onto a new daemon auth user');
select is((select u.raw_app_meta_data ->> 'org_id' from auth.users u
            where u.id = (select user_id from daemon2)),
          (select org from ctx)::text,
          'rebound daemon user also carries app_metadata.org_id');

-- ── 5. Team without oid: daemon user gets no org claim, still sees the team ─
select pg_temp.as_user('aa110000-0000-4000-8000-000000000001');
update amux.teams set oid = null where id = (select team from ctx);

create temp table ni as
  select * from amux.create_team_invite(
    (select team from ctx), 'agent', 'Daemon Two', p_agent_kind => 'daemon');

select pg_temp.as_anon();
create temp table nc as select * from amux.claim_team_invite((select token from ni));

select is((select u.raw_app_meta_data from auth.users u
            where u.id = (select a.user_id from amux.actors a
                           where a.id = (select actor_id from nc))),
          '{}'::jsonb,
          'team without oid mints daemon user with empty app_metadata');
select pg_temp.as_user(
  (select a.user_id from amux.actors a where a.id = (select actor_id from nc)));
select ok(exists (select 1 from amux.teams where id = (select team from ctx)),
          'oid-less team stays visible to claim-less daemon (guard tolerates null oid)');

select * from finish();
rollback;

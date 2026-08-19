-- 034_claim_invite_keeps_daemon_user.sql
--
-- A rebind claim (create_team_invite with p_target_actor_id — the "重新生成邀请"
-- path, i.e. every credential rotation) must replace the agent's *credential*,
-- not its account. Before 20260819000000 the agent branch opened with
-- `v_user_id := gen_random_uuid()` and deleted the account the actor had been
-- bound to, which reset every durable fact keyed on that user id — public.users
-- lands back at admin_type DEFAULT 1, and any grant an operator made to the
-- digital employee's account was silently gone.
--
-- The fixture grants admin_type = 2 between the two claims because that is the
-- property that has to survive; asserting only "same uuid" would pass on a
-- function that kept the id and dropped the row.
--
-- The other half is revocation: deleting the account used to kill the previous
-- refresh token as a side effect, so reuse has to do it explicitly or a retired
-- device keeps a working credential.

begin;

select plan(6);

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

-- ── Fixture: an org, its owner, and a team ──────────────────────────────────
insert into public.orgs (id, name) values
  ('9e000000-0000-4000-8000-000000000001', 'Daemon Reuse Org');

insert into auth.users (id, email, aud, role, instance_id) values
  ('9e000000-0000-4000-8000-0000000000a1', 'owner-daemonreuse@amux.test',
   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

insert into public.users (id, org_id, mobile) values
  ('9e000000-0000-4000-8000-0000000000a1', '9e000000-0000-4000-8000-000000000001', '');

select pg_temp.as_user('9e000000-0000-4000-8000-0000000000a1',
                       '9e000000-0000-4000-8000-000000000001');

create temp table team as
  select team_id from amux.create_team('Daemon Reuse Team',
    p_oid => '9e000000-0000-4000-8000-000000000001');
grant select on team to anon, authenticated;

-- ── First claim: the agent gets its account ─────────────────────────────────
create temp table inv1 as
  select * from amux.create_team_invite((select team_id from team), 'agent', 'Badge Bot',
    p_agent_kind => 'daemon');
grant select on inv1 to anon, authenticated;

create temp table claim1 as
  select * from amux.claim_team_invite((select token from inv1));
grant select on claim1 to anon, authenticated;

reset role;

create temp table before as
  select a.user_id, (select refresh_token from claim1) as rt
    from amux.actors a
   where a.id = (select actor_id from claim1);

-- What an operator does once, by hand, on the account the digital employee
-- authenticates as. On a merged instance this is what makes the bot's calls
-- pass the backend's admin check.
update public.users set admin_type = 2 where id = (select user_id from before);

-- ── Rotate: re-invite the same agent actor ──────────────────────────────────
select pg_temp.as_user('9e000000-0000-4000-8000-0000000000a1',
                       '9e000000-0000-4000-8000-000000000001');

create temp table inv2 as
  select * from amux.create_team_invite((select team_id from team), 'agent', 'Badge Bot',
    p_agent_kind      => 'daemon',
    p_target_actor_id => (select actor_id from claim1));
grant select on inv2 to anon, authenticated;

create temp table claim2 as
  select * from amux.claim_team_invite((select token from inv2));
grant select on claim2 to anon, authenticated;

reset role;

-- ── Assert ──────────────────────────────────────────────────────────────────
select is((select actor_id from claim2), (select actor_id from claim1),
          'the rebind lands on the same agent actor');

select is((select user_id from amux.actors where id = (select actor_id from claim2)),
          (select user_id from before),
          'the actor keeps the account it already had');

select ok(exists (select 1 from auth.users where id = (select user_id from before)),
          'that account still exists — the rotation did not delete it');

-- The regression this file exists for. Keyed on the account the agent
-- authenticates as *after* the rotation, not on the id it had before: the old
-- body left the previous public.users row behind (nothing cascades from
-- auth.users into it — public.users.id is a plain PK), so asserting on the old
-- id passes either way. What actually broke is that the identity the daemon
-- now presents is a different row, and that row is a fresh DEFAULT 1.
select is((select admin_type from public.users
            where id = (select user_id from amux.actors
                         where id = (select actor_id from claim2))),
          2::smallint,
          'the account the agent now authenticates as still carries the grant');

-- ...and the revocation the deletion used to provide for free.
select ok(exists (select 1 from auth.refresh_tokens
                   where token = (select refresh_token from claim2)
                     and user_id = (select user_id from before)::text),
          'the claim returns a fresh, usable refresh token for that account');

select ok(not exists (select 1 from auth.refresh_tokens
                       where token = (select rt from before)),
          'the previous device''s refresh token is revoked');

select * from finish();
rollback;

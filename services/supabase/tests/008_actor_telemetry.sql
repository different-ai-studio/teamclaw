begin;
select plan(17);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

insert into auth.users (id, email, aud, role, instance_id) values
  ('c1111111-1111-1111-1111-111111111111', 'cara-tel@amux.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('d2222222-2222-2222-2222-222222222222', 'dave-tel@amux.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('e3333333-3333-3333-3333-333333333333', 'eve-tel@amux.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

select pg_temp.as_user('c1111111-1111-1111-1111-111111111111');
select * from public.create_team('Tel Team');

create temp table ctx as
  select
    (select id from public.teams where slug = 'tel-team')                                        as team_id,
    (select id from public.actors where user_id = 'c1111111-1111-1111-1111-111111111111' limit 1) as cara_actor;

-- Bring dave into team via invite
select pg_temp.as_user('c1111111-1111-1111-1111-111111111111');
create temp table dave_invite as
  select * from public.create_team_invite(
    (select team_id from ctx), 'member', 'Dave', p_team_role => 'member');

select pg_temp.as_user('d2222222-2222-2222-2222-222222222222');
select public.claim_team_invite((select token from dave_invite));

-- 1. actor_message_feedback exists
select pg_temp.as_user('c1111111-1111-1111-1111-111111111111');
select has_table('public', 'actor_message_feedback', 'actor_message_feedback table exists');
select has_column('public', 'actor_message_feedback', 'star_rating', 'has star_rating');
select has_column('public', 'actor_message_feedback', 'kind', 'has kind');

-- 2. Cara can insert her own feedback
insert into public.actor_message_feedback (actor_id, team_id, kind, skill)
  values ((select cara_actor from ctx), (select team_id from ctx), 'positive', 'editor');
select pass('actor can insert own feedback');

-- 3. Cara cannot insert under another actor_id
select throws_ok(
  $$ insert into public.actor_message_feedback (actor_id, team_id, kind)
     values ('00000000-0000-0000-0000-000000000000', (select team_id from ctx), 'positive') $$,
  '42501',
  null,
  'cannot insert feedback as another actor'
);

-- 4. Cara sees feedback for the team
select results_eq(
  $$ select count(*)::int from public.actor_message_feedback where team_id = (select team_id from ctx) $$,
  $$ values (1) $$,
  'team member sees team feedback'
);

-- 5. Dave (also in team) sees Cara's feedback
select pg_temp.as_user('d2222222-2222-2222-2222-222222222222');
select results_eq(
  $$ select count(*)::int from public.actor_message_feedback where team_id = (select team_id from ctx) $$,
  $$ values (1) $$,
  'other team member sees team feedback'
);

-- 6. Eve (not in team) sees nothing
select pg_temp.as_user('e3333333-3333-3333-3333-333333333333');
select is_empty(
  $$ select 1 from public.actor_message_feedback where team_id = (select team_id from ctx) $$,
  'stranger sees no feedback'
);

-- 7. Eve cannot insert
select throws_ok(
  $$ insert into public.actor_message_feedback (actor_id, team_id, kind)
     values ((select cara_actor from ctx), (select team_id from ctx), 'positive') $$,
  '42501',
  null,
  'stranger cannot insert'
);

-- 8. actor_session_report exists
select pg_temp.as_user('c1111111-1111-1111-1111-111111111111');
select has_table('public', 'actor_session_report', 'actor_session_report table exists');

-- 9. Cara can insert her own report
insert into public.actor_session_report (actor_id, team_id, tokens_used, cost_usd, model)
  values ((select cara_actor from ctx), (select team_id from ctx), 1234, 0.05, 'sonnet');
select pass('actor can insert own session report');

-- 10. Cara cannot insert under another actor
select throws_ok(
  $$ insert into public.actor_session_report (actor_id, team_id, tokens_used)
     values ('00000000-0000-0000-0000-000000000000', (select team_id from ctx), 1) $$,
  '42501',
  null,
  'cannot insert report as another actor'
);

-- 11. Cara sees team reports
select results_eq(
  $$ select count(*)::int from public.actor_session_report where team_id = (select team_id from ctx) $$,
  $$ values (1) $$,
  'team member sees team reports'
);

-- 12. Dave (in team) sees reports
select pg_temp.as_user('d2222222-2222-2222-2222-222222222222');
select results_eq(
  $$ select count(*)::int from public.actor_session_report where team_id = (select team_id from ctx) $$,
  $$ values (1) $$,
  'other team member sees team reports'
);

-- 13. Eve (stranger) sees nothing
select pg_temp.as_user('e3333333-3333-3333-3333-333333333333');
select is_empty(
  $$ select 1 from public.actor_session_report where team_id = (select team_id from ctx) $$,
  'stranger sees no reports'
);

-- 14. Eve cannot insert
select throws_ok(
  $$ insert into public.actor_session_report (actor_id, team_id, tokens_used)
     values ((select cara_actor from ctx), (select team_id from ctx), 1) $$,
  '42501',
  null,
  'stranger cannot insert report'
);

-- 15. View exists
select pg_temp.as_user('c1111111-1111-1111-1111-111111111111');
select has_view('public', 'team_leaderboard', 'team_leaderboard view exists');

-- 16. Cara sees an aggregated row for herself
select results_eq(
  $$ select tokens_used_30d::bigint from public.team_leaderboard
       where team_id = (select team_id from ctx) and actor_id = (select cara_actor from ctx) $$,
  $$ values (1234::bigint) $$,
  'leaderboard aggregates tokens_used for cara'
);

-- 17. Eve sees nothing
select pg_temp.as_user('e3333333-3333-3333-3333-333333333333');
select is_empty(
  $$ select 1 from public.team_leaderboard where team_id = (select team_id from ctx) $$,
  'stranger sees no leaderboard rows'
);

select * from finish();
rollback;

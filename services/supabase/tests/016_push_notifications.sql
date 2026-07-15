-- services/supabase/tests/016_push_notifications.sql
begin;

select plan(16);

-- ── Schema presence ──────────────────────────────────────────────────────────
select has_table('public', 'device_push_tokens');
select has_table('public', 'notification_prefs');
select has_table('public', 'session_mutes');
select has_table('public', 'client_presence');
select has_table('public', 'push_idempotency');

select has_function('public', 'list_session_push_targets', array['uuid','uuid']);
select has_function('public', 'push_idempotency_claim',    array['uuid']);

-- ── RLS enabled ──────────────────────────────────────────────────────────────
select ok(
  (select relrowsecurity from pg_catalog.pg_class
   where oid = 'public.device_push_tokens'::regclass),
  'RLS enabled on device_push_tokens'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class
   where oid = 'public.notification_prefs'::regclass),
  'RLS enabled on notification_prefs'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class
   where oid = 'public.session_mutes'::regclass),
  'RLS enabled on session_mutes'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class
   where oid = 'public.client_presence'::regclass),
  'RLS enabled on client_presence'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class
   where oid = 'public.push_idempotency'::regclass),
  'RLS enabled on push_idempotency'
);

-- ── Idempotency fixture ───────────────────────────────────────────────────────
-- Minimal chain required by FK constraints:
--   teams → actors → agents
--                  → ideas → sessions → messages
-- Static UUIDs in the 0016 namespace for easy identification.

insert into public.teams (id, slug, name)
  values ('00000000-0000-0000-0016-000000000001', 'pn-test-team', 'PN Test Team');

insert into public.actors (id, team_id, actor_type, display_name)
  values ('00000000-0000-0000-0016-000000000010', '00000000-0000-0000-0016-000000000001', 'agent', 'PN Agent');

insert into public.agents (id, agent_kind, capabilities, status)
  values ('00000000-0000-0000-0016-000000000010', 'claude', '{}'::jsonb, 'active');

insert into public.ideas (id, team_id, created_by_actor_id, title, status)
  values (
    '00000000-0000-0000-0016-000000000020',
    '00000000-0000-0000-0016-000000000001',
    '00000000-0000-0000-0016-000000000010',
    'pn-test-idea',
    'open'
  );

insert into public.sessions (id, team_id, idea_id, created_by_actor_id, primary_agent_id, mode, title)
  values (
    '00000000-0000-0000-0016-000000000100',
    '00000000-0000-0000-0016-000000000001',
    '00000000-0000-0000-0016-000000000020',
    '00000000-0000-0000-0016-000000000010',
    '00000000-0000-0000-0016-000000000010',
    'solo',
    'pn-test-session'
  );

insert into public.messages (id, team_id, session_id, sender_actor_id, kind, content)
  values (
    '00000000-0000-0000-0016-000000001000',
    '00000000-0000-0000-0016-000000000001',
    '00000000-0000-0000-0016-000000000100',
    '00000000-0000-0000-0016-000000000010',
    'text',
    'pn-test-message'
  );

-- ── Idempotency: first claim wins, second returns false ───────────────────────
select is(
  (select claimed from public.push_idempotency_claim(
     '00000000-0000-0000-0016-000000001000'::uuid)),
  true,
  'first claim succeeds'
);

select is(
  (select claimed from public.push_idempotency_claim(
     '00000000-0000-0000-0016-000000001000'::uuid)),
  false,
  'second claim is duplicate'
);

-- ── list_session_push_targets: unknown session/actor → safe defaults ──────────
select is(
  public.list_session_push_targets(gen_random_uuid(), gen_random_uuid()) ->> 'sender_display_name',
  'Someone',
  'absent sender falls back to "Someone"'
);

select is(
  jsonb_array_length(
    public.list_session_push_targets(gen_random_uuid(), gen_random_uuid()) -> 'recipients'
  ),
  0,
  'no participants → empty recipients array'
);

select * from finish();
rollback;

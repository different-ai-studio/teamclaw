begin;

select plan(11);

-- Every assertion below passes a description on purpose: without one, two bare
-- string literals bind to pgTAP's (object, description) overload rather than
-- (schema, object), and the assertion silently checks a table named "amux".
-- See QUARANTINE.md.

select has_table('amux', 'session_read_markers', 'session_read_markers exists');
select has_column('amux', 'sessions', 'archived_at', 'sessions.archived_at exists');

select col_type_is('amux', 'session_read_markers', 'session_id', 'uuid',
                   'session_read_markers.session_id is uuid');
select col_type_is('amux', 'session_read_markers', 'actor_id', 'uuid',
                   'session_read_markers.actor_id is uuid');
select col_type_is('amux', 'session_read_markers', 'last_read_at', 'timestamp with time zone',
                   'session_read_markers.last_read_at is timestamptz');
select col_type_is('amux', 'session_read_markers', 'last_read_message_id', 'uuid',
                   'session_read_markers.last_read_message_id is uuid');

select has_index('amux', 'session_read_markers', 'session_read_markers_actor_session_idx',
                 'read markers indexed by (actor, session)');
select has_index('amux', 'messages', 'messages_session_created_idx',
                 'messages indexed by (session, created_at)');

-- p_team_id leads and p_idea_id trails: the session list is team-scoped since
-- 20260810010000 dropped the unscoped variant, and keyset paging carries three
-- cursor columns.
select has_function(
  'amux',
  'list_current_actor_sessions',
  array['uuid', 'integer', 'timestamp with time zone', 'timestamp with time zone', 'uuid', 'uuid'],
  'list_current_actor_sessions(team, limit, keyset…, idea) exists'
);
select has_function('amux', 'mark_current_actor_session_viewed', array['uuid', 'uuid'],
                    'mark_current_actor_session_viewed(session, message) exists');

select policies_are('amux', 'session_read_markers', array[
  'session_read_markers_select_own',
  'session_read_markers_insert_own',
  'session_read_markers_update_own'
], 'session_read_markers carries exactly the three own-row policies');

select * from finish();
rollback;

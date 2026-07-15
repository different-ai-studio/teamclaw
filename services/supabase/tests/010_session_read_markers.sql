begin;

select plan(11);

select has_table('public', 'session_read_markers');
select has_column('public', 'sessions', 'archived_at');
select col_type_is('public', 'session_read_markers', 'session_id', 'uuid');
select col_type_is('public', 'session_read_markers', 'actor_id', 'uuid');
select col_type_is('public', 'session_read_markers', 'last_read_at', 'timestamp with time zone');
select col_type_is('public', 'session_read_markers', 'last_read_message_id', 'uuid');
select has_index('public', 'session_read_markers', 'session_read_markers_actor_session_idx');
select has_index('public', 'messages', 'messages_session_created_idx');
select has_function(
  'public',
  'list_current_actor_sessions',
  array['integer', 'timestamp with time zone', 'timestamp with time zone', 'uuid']
);
select has_function('public', 'mark_current_actor_session_viewed', array['uuid', 'uuid']);

select policies_are('public', 'session_read_markers', array[
  'session_read_markers_select_own',
  'session_read_markers_insert_own',
  'session_read_markers_update_own'
]);

select * from finish();
rollback;

begin;

select plan(2);

select has_index(
  'amux',
  'session_participants',
  'session_participants_actor_session_idx',
  'session list can start from an actor participant lookup'
);

select has_function(
  'amux',
  'list_current_actor_sessions',
  array[
    'integer',
    'timestamp with time zone',
    'timestamp with time zone',
    'uuid',
    'uuid',
    'uuid'
  ],
  'session list RPC retains its six-argument contract'
);

select * from finish();
rollback;

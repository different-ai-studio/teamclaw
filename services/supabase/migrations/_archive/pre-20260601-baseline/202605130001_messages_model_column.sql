-- Per-message model identity. The daemon already round-trips `model` on
-- the MQTT wire (Message.model, proto field 9) so clients render the
-- bubble with the correct model name during live streaming, but the
-- value was dropped at the Supabase write boundary. After reload, the
-- only signal left was `runtime_state.current_model`, which reflects
-- whatever the runtime is set to NOW — not what the agent answered with
-- two turns ago. The mismatch is most visible after the user toggles
-- the model picker mid-session.
--
-- Nullable: historical rows pre-dating this column have no value, and
-- non-agent kinds (user_message, system, idea_event) don't carry a
-- model. Clients must tolerate NULL and fall back to runtime-state.

alter table public.messages
  add column if not exists model text;

comment on column public.messages.model is
  'Model identifier (e.g. claude-haiku-4-5) the agent used to produce this message. NULL for non-agent messages and rows older than the column.';

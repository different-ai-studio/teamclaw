-- Add per-runtime monotonic `sequence` to messages so iOS can order rows
-- deterministically when created_at collides (multi-runtime fanning into the
-- same session, or sub-millisecond emits). Daemon stamps this from the same
-- counter that drives Envelope.sequence in EventHistory, so a Supabase row
-- and its corresponding ACP event share one sequence number.
--
-- Existing rows keep sequence = 0; the daemon writes the real value for
-- every new emit. iOS orders by (created_at, sequence) and treats 0 as
-- "no sequence available" (legacy).

alter table public.messages
  add column sequence bigint not null default 0;

create index messages_session_sequence_idx
  on public.messages (session_id, sequence)
  where sequence > 0;

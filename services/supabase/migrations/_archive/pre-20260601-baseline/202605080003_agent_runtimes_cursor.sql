-- Per-runtime read cursor for catchup on spawn / restart.
-- daemon updates this each time it sends or silently injects a message
-- into the runtime; on next spawn or restart, daemon pulls
-- messages WHERE id > last_processed_message_id and routes them through
-- the same mention pipeline so context catches up without reprocessing.

alter table public.agent_runtimes
  add column if not exists last_processed_message_id uuid null
    references public.messages(id) on delete set null;

create index if not exists agent_runtimes_cursor_idx
  on public.agent_runtimes (session_id, last_processed_message_id);

-- Daemon's MQTT 8-char runtime id, the segment used in
-- `amux/{team}/device/{device}/runtime/{runtime_id}/state`. Distinct from
-- backend_session_id (the 36-char ACP session id used by the daemon to
-- resume a Claude Code session). iOS bridges Supabase agent_runtimes to
-- the live MQTT-published Runtime row by this column — using
-- backend_session_id is wrong because the topic segment is 8-char.
ALTER TABLE public.agent_runtimes
  ADD COLUMN IF NOT EXISTS runtime_id text;

COMMENT ON COLUMN public.agent_runtimes.runtime_id
  IS 'Daemon-side 8-char runtime id used as the segment in MQTT topic amux/{team}/device/{device}/runtime/{runtime_id}/state. iOS bridges Supabase agent_runtimes to the live MQTT Runtime row by this column.';

CREATE INDEX IF NOT EXISTS agent_runtimes_runtime_id_idx
  ON public.agent_runtimes (runtime_id);

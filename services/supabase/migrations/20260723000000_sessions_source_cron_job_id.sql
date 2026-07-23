-- Mark how a session was created and, for scheduled ones, which cron job made it.
--
-- Before this, the only way to know a session was auto-created by a scheduled
-- (cron) task was to scan the desktop daemon's local run-history .jsonl files
-- (cron/storage.rs get_all_session_ids) — device-local, not shared, not
-- queryable. These two columns move that fact onto the session row itself:
--
--   source      — 'user' (default) | 'cron' | 'gateway'. Semantic origin marker,
--                 extensible to future sources (api, subagent, ...).
--   cron_job_id — for source='cron', the desktop-local cron job id that created
--                 it (a daemon-local string id, NOT a cloud FK). Lets us answer
--                 "which sessions did this scheduled task create".
--
-- Idempotent (IF NOT EXISTS) so the self-host apply-migrations loop can re-run.

ALTER TABLE amux.sessions
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'user';

ALTER TABLE amux.sessions
  ADD COLUMN IF NOT EXISTS cron_job_id text;

-- Backfill: sessions whose gateway binding key is a cron key (`cron/<job>/<run>`)
-- predate this column. Recover their origin from the binding.
UPDATE amux.sessions
SET source = 'cron',
    cron_job_id = split_part(binding, '/', 2)
WHERE source = 'user'
  AND binding LIKE 'cron/%';

-- Partial index for the common "list this cron job's sessions" query.
CREATE INDEX IF NOT EXISTS sessions_cron_job_id_idx
  ON amux.sessions (cron_job_id)
  WHERE cron_job_id IS NOT NULL;

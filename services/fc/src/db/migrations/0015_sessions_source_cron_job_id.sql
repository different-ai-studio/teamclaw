-- Session origin marker (postgres backend).
-- Mirrors services/supabase/migrations/20260723000000_sessions_source_cron_job_id.sql.
--
--   source      — 'user' (default) | 'cron' | 'gateway'.
--   cron_job_id — for source='cron', the desktop-local cron job id that created
--                 the session (a daemon-local string id, not a cloud FK).

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'user';
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "cron_job_id" text;

-- Backfill origin for pre-existing cron sessions from their gateway binding key.
UPDATE "sessions"
SET "source" = 'cron',
    "cron_job_id" = split_part("binding", '/', 2)
WHERE "source" = 'user'
  AND "binding" LIKE 'cron/%';

CREATE INDEX IF NOT EXISTS "sessions_cron_job_id_idx"
  ON "sessions" ("cron_job_id")
  WHERE "cron_job_id" IS NOT NULL;

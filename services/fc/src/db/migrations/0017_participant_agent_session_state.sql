-- An agent's per-session working state moves onto the participant row, whose
-- unique key (session_id, actor_id) is already this state's natural key.
--
-- Mirrors services/supabase/migrations/20260803000000_participant_owns_agent_session_state.sql
-- (columns and index only — the backfill in that file runs against the
-- deployed Supabase database; this backend reaches the same shape through
-- Drizzle in src/lib/pg-repo/).
--
-- NULL on member participants means "not applicable", not "missing". See
-- ADR-0005 for why this state previously lived on `agent_runtimes` and what
-- that cost (1306 rows / 1296 sessions → a 48KB PostgREST URL → kong 414).

ALTER TABLE "session_participants" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "session_participants" ADD COLUMN IF NOT EXISTS "model" text;--> statement-breakpoint
ALTER TABLE "session_participants" ADD COLUMN IF NOT EXISTS "last_processed_message_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_participants_actor_workspace_idx" ON "session_participants" ("actor_id","workspace_id") WHERE "workspace_id" IS NOT NULL;

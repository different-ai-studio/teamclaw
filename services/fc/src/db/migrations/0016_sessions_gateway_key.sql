-- The gateway chat a session belongs to, for the session's whole lifetime.
-- Mirrors services/supabase/migrations/20260728000000_gateway_session_switch.sql
-- (the column and its index only — the RPC functions in that file are the
-- supabase path; this backend reaches the same behaviour through Drizzle in
-- src/lib/pg-repo/sessions.ts).
--
-- `binding` cannot serve this purpose: it is the "currently attached" pointer
-- and `/new` nulls it, so a detached session keeps no trace of its origin.
-- `gateway_key` is written at create time from the binding and never cleared,
-- which is what lets one chat enumerate its own past sessions and switch back
-- into one (`/sessions` → `/sessions <n>`).

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "gateway_key" text;

CREATE INDEX IF NOT EXISTS "sessions_gateway_key_idx"
  ON "sessions" ("team_id", "gateway_key")
  WHERE "gateway_key" IS NOT NULL;

-- Recoverable only for sessions still attached: a session detached before this
-- migration has no signal left on the row to recover its chat from.
UPDATE "sessions"
SET "gateway_key" = "binding"
WHERE "gateway_key" IS NULL
  AND "binding" IS NOT NULL;

-- Mirrors services/supabase/migrations/20260803010000_drop_agent_runtimes.sql.
-- See that file for why the table goes and where its columns moved.
DROP TABLE IF EXISTS "agent_runtimes" CASCADE;

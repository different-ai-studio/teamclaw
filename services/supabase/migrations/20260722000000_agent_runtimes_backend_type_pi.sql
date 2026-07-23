-- Allow the pi runtime as an agent_runtimes.backend_type.
--
-- pi is a first-class local agent runtime (peer to opencode/codex/claude), but
-- the agent_runtimes check constraint predated it, so daemon upserts for a pi
-- runtime failed with "agent_runtimes_backend_type_check". The agents table's
-- default_agent_type check already allows 'pi'; this brings agent_runtimes in
-- line. Widening an allowlist CHECK is safe and non-destructive.

ALTER TABLE amux.agent_runtimes
    DROP CONSTRAINT IF EXISTS agent_runtimes_backend_type_check;

ALTER TABLE amux.agent_runtimes
    ADD CONSTRAINT agent_runtimes_backend_type_check
    CHECK (backend_type = ANY (ARRAY['claude'::text, 'codex'::text, 'opencode'::text, 'pi'::text]));

COMMENT ON COLUMN amux.agent_runtimes.backend_type IS 'Runtime backend: claude, opencode, codex, or pi.';

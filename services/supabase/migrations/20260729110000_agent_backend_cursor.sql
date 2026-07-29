-- Allow cursor (and claude-code wire name) as agent backend types.
--
-- PR #636 added Cursor SDK + Claude Agent SDK backends. Daemon startup calls
-- POST /v1/agents/types/ensure with defaultAgentType "cursor" (or
-- "claude-code"), but the agents / agent_runtimes CHECK constraints still
-- only allowed claude, opencode, codex, pi — so cloud advertise failed with
-- agents_default_agent_type_check / agent_runtimes_backend_type_check.

ALTER TABLE amux.agents
    DROP CONSTRAINT IF EXISTS agents_default_agent_type_check;

ALTER TABLE amux.agents
    ADD CONSTRAINT agents_default_agent_type_check
    CHECK (
        default_agent_type IS NULL
        OR default_agent_type = ANY (
            ARRAY[
                'claude'::text,
                'claude-code'::text,
                'opencode'::text,
                'codex'::text,
                'pi'::text,
                'cursor'::text
            ]
        )
    );

ALTER TABLE amux.agent_runtimes
    DROP CONSTRAINT IF EXISTS agent_runtimes_backend_type_check;

ALTER TABLE amux.agent_runtimes
    ADD CONSTRAINT agent_runtimes_backend_type_check
    CHECK (
        backend_type = ANY (
            ARRAY[
                'claude'::text,
                'claude-code'::text,
                'codex'::text,
                'opencode'::text,
                'pi'::text,
                'cursor'::text
            ]
        )
    );

COMMENT ON COLUMN amux.agents.default_agent_type IS
    'Preferred runtime backend type when no explicit agent type is requested. Canonical values match agent_runtimes.backend_type: claude, claude-code, opencode, codex, pi, cursor.';

COMMENT ON COLUMN amux.agent_runtimes.backend_type IS
    'Runtime backend: claude, claude-code, opencode, codex, pi, or cursor.';

-- Move an agent's per-session working state onto `session_participants`,
-- which is where its natural key already lives.
--
-- Background. Three pieces of state — which workspace an agent works in for a
-- session, which model it uses there, and how far it has read — are keyed by
-- (session, actor). That is exactly `session_participants`' unique key. They
-- were instead stored on `agent_runtimes`, whose key is
-- (agent_id, backend_session_id): a fresh row per process start, never deleted.
--
-- One team accumulated 1306 rows across 1296 sessions. `listSessionDisplayRows`
-- then serialised all 1296 session ids into a single PostgREST `id=in.(…)`
-- filter — PostgREST puts `in.(…)` in the query string — producing a ~48KB URL
-- that kong rejected with 414. Users saw an empty session list.
--
-- The root cause was in the glossary, not the query: `proto/CONTEXT.md` defined
-- Participant as "非独立 DB 表实体". A thing declared not to be an entity cannot
-- own state, so the state landed on the only table that looked related. See
-- ADR-0005 and ADR-0004.
--
-- This migration is additive and idempotent. `agent_runtimes` keeps being
-- written until iOS migrates off it (plan phase 7); nothing here drops it.

ALTER TABLE amux.session_participants
  ADD COLUMN IF NOT EXISTS workspace_id uuid,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS last_processed_message_id uuid;

COMMENT ON COLUMN amux.session_participants.workspace_id IS
  'Workspace this agent works in for this session. NULL for member participants — not applicable, not missing.';
COMMENT ON COLUMN amux.session_participants.model IS
  'Model this agent uses in this session. Validated against the live catalog at attach time; a value the current backend cannot serve falls back to the actor default rather than failing (ADR-0002).';
COMMENT ON COLUMN amux.session_participants.last_processed_message_id IS
  'Last inbound message routed to this agent, for catch-up after a restart.';

-- Backfill from the newest runtime row per (session, agent). DISTINCT ON needs
-- its ORDER BY to lead with the distinct keys; `updated_at DESC` then picks the
-- most recent row, matching how listRuntimeTargetsForSession already resolves
-- competing rows.
UPDATE amux.session_participants sp
SET workspace_id              = COALESCE(sp.workspace_id, r.workspace_id),
    model                     = COALESCE(sp.model, r.current_model),
    last_processed_message_id = COALESCE(sp.last_processed_message_id, r.last_processed_message_id),
    updated_at                = now()
FROM (
  SELECT DISTINCT ON (session_id, agent_id)
         session_id,
         agent_id,
         workspace_id,
         current_model,
         last_processed_message_id
  FROM amux.agent_runtimes
  WHERE session_id IS NOT NULL
  ORDER BY session_id, agent_id, updated_at DESC
) r
WHERE sp.session_id = r.session_id
  AND sp.actor_id = r.agent_id
  AND (
    sp.workspace_id IS NULL
    OR sp.model IS NULL
    OR sp.last_processed_message_id IS NULL
  );

-- Cursor lookups are per (session, actor), already served by the unique key.
-- The one new access path is "which sessions does this agent hold a workspace
-- binding for", used to rebuild the desktop's offline workspace filter.
CREATE INDEX IF NOT EXISTS session_participants_actor_workspace_idx
  ON amux.session_participants (actor_id, workspace_id)
  WHERE workspace_id IS NOT NULL;

-- Per-team LLM config moves to cloud storage (single source of truth),
-- replacing the local teamclaw.json. Adds the three columns the Settings
-- "团队共享模型" pane edits onto amux.team_workspace_config.
--
-- Columns inherit the table's existing grants/RLS; no column-specific grant
-- is required. The mutation guard trigger (trg_team_workspace_config_guard)
-- only restricts sync_mode/oss_change_seq/litellm_team_id, so these new
-- columns are freely updatable by the service_role facade.

ALTER TABLE amux.team_workspace_config
  ADD COLUMN IF NOT EXISTS llm_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE amux.team_workspace_config
  ADD COLUMN IF NOT EXISTS llm_base_url text;

ALTER TABLE amux.team_workspace_config
  ADD COLUMN IF NOT EXISTS llm_models jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN amux.team_workspace_config.llm_enabled IS
  'Per-team LLM config: whether the team-shared model config is enabled. Cloud source of truth for the Settings model pane.';

COMMENT ON COLUMN amux.team_workspace_config.llm_base_url IS
  'Per-team LLM config: proxy/base URL for the team-shared model endpoint.';

COMMENT ON COLUMN amux.team_workspace_config.llm_models IS
  'Per-team LLM config: authoritative stored model list [{id,name}]. Distinct from the gateway-listed availableModels (proxied from /v1/models).';

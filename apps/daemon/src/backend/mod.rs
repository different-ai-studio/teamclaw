//! Backend abstraction over the daemon's persistent store.
//!
//! The only production implementation is `CloudApiBackend` in
//! `crate::backend::cloud_api`; `MockBackend` (in `mock`) is the test-side
//! impl. Callers bind to `Arc<dyn Backend>` so the daemon's runtime/
//! channel/session machinery can be exercised against an in-memory backend
//! without going through HTTP.
use async_trait::async_trait;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Reconnect transport this long before the cached JWT expires so the broker
/// never serves traffic on a connection whose ACL has silently gone stale.
pub const PROACTIVE_CREDENTIAL_BUFFER: Duration = Duration::from_secs(5 * 60);

/// Current wall-clock time as epoch seconds. JWT expiry from the auth backend is
/// wall-clock based; do not use `Instant` for credential TTL (macOS suspends
/// the monotonic clock while the laptop sleeps).
pub fn epoch_secs_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs() as i64
}

/// How long to wait before tearing down the current transport connection and
/// fetching a fresh JWT. Returns zero when a cached expiry is within
/// [`PROACTIVE_CREDENTIAL_BUFFER`]; uses a conservative 50-minute fallback
/// when expiry is unknown.
pub fn proactive_reconnect_delay(expires_at_epoch: Option<i64>) -> Duration {
    match expires_at_epoch {
        Some(exp) => {
            let until_reconnect =
                exp - epoch_secs_now() - PROACTIVE_CREDENTIAL_BUFFER.as_secs() as i64;
            if until_reconnect <= 0 {
                Duration::ZERO
            } else {
                Duration::from_secs(until_reconnect as u64)
            }
        }
        None => Duration::from_secs(50 * 60),
    }
}

/// True when the cached JWT should be refreshed before opening transport.
pub fn credential_in_proactive_refresh_window(expires_at_epoch: Option<i64>) -> bool {
    expires_at_epoch.is_some() && proactive_reconnect_delay(expires_at_epoch) == Duration::ZERO
}

pub mod error;
pub use error::{BackendError, BackendResult};

pub mod cloud_api;
pub mod deferred;

pub mod records;
pub use records::{
    AgentRuntimeRow, AgentRuntimeUpsert, BackendParticipantRow, BackendSessionAndParticipants,
    BackendSessionRow, ClaimResult, StoredMessage, WorkspaceRow, WorkspaceUpsert,
};

/// MQTT settings delivered by `/v1/config/bootstrap`. The full broker URL
/// (with scheme + port) is the canonical field; credentials are optional and
/// override the values from the local daemon config when present.
#[derive(Debug, Clone)]
pub struct BootstrapMqttOverride {
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[cfg(test)]
pub mod mock;

/// A team's share-mode + git configuration, as sourced from the TeamClaw Cloud
/// API (`GET /v1/teams/:id/share-mode`). `mode == None` means team-share has not
/// been enabled for this team yet (the daemon should treat this as "no sync").
///
/// Note: the FC `share-mode` endpoint does not surface the git branch (the
/// `git_branch` column lives on `team_workspace_config` and is not selected by
/// `getShareMode`/`getWorkspaceConfig`), so `git_branch` is presently always
/// `None`. The field is kept so a future FC endpoint can populate it without a
/// signature change.
#[derive(Debug, Clone, Default)]
pub struct ShareModeConfig {
    /// `"oss" | "managed_git" | "custom_git"`; `None` when team-share is not
    /// enabled.
    pub mode: Option<String>,
    pub git_remote_url: Option<String>,
    pub git_branch: Option<String>,
    /// `"ssh_key" | "https_token"` for `custom_git`; `None` otherwise.
    pub git_auth_kind: Option<String>,
}

/// One model exposed by the team's managed LLM gateway.
#[derive(Debug, Clone)]
pub struct ManagedLlmModelInfo {
    pub id: String,
    pub name: String,
}

/// The team's managed (shared) LLM, as sourced from
/// `GET /v1/teams/:id/workspace-config` (`llm.*`). This replaces the old
/// disk-mirrored `_meta/provider.json` so the shared provider converges on first
/// install without waiting for the team git clone. The secret API key is NOT part
/// of this struct — it is derived locally from `actor_id` (`sk-tc-{actor_id[..40]}`)
/// at env-assembly time and never written to disk.
#[derive(Debug, Clone, Default)]
pub struct ManagedLlmConfig {
    /// `false` when the team has no managed LLM enabled (or team-share is unset).
    pub enabled: bool,
    /// Gateway base URL (`llm.baseUrl`, falling back to `llm.aiGatewayEndpoint`).
    pub base_url: Option<String>,
    /// Provider display name; `None` falls back to "Team".
    pub name: Option<String>,
    /// Stored, authoritative per-team model list (`llm.models`).
    pub models: Vec<ManagedLlmModelInfo>,
}

/// The daemon's own agent defaults, sourced from `GET /v1/runtime/agent-defaults`.
/// The gateway path uses these to spawn the daemon's agent with its configured
/// backend type and working directory instead of the daemon-wide fallback type
/// and a throwaway scratch dir. All-`None` means "no override; use defaults".
/// The team-scoped managed-git credential, as sourced from the TeamClaw Cloud
/// API (`GET /v1/teams/:id/managed-git-credential`). Used to authenticate the
/// daemon's per-app git push/clone against the team's managed-git remote.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedGitCredential {
    pub username: String,
    pub token: String,
}

#[derive(Debug, Clone, Default)]
pub struct AgentDefaults {
    /// `"claude" | "opencode" | "codex"`; `None` when unset.
    pub default_agent_type: Option<String>,
    /// The agent's default workspace UUID (the daemon resolves it to a local
    /// path via `WorkspaceResolver`); `None` when unset.
    pub default_workspace_id: Option<String>,
}

/// Health of the cloud-auth session, surfaced over the local HTTP `/v1/info`
/// endpoint so the desktop can detect a terminally-expired daemon session and
/// auto re-onboard it.
///
/// `terminal_failure == true` means a token refresh was rejected by the auth
/// backend (HTTP 400/401 from `/v1/auth/refresh` — e.g. `refresh_token_not_found`
/// / `invalid_grant`): the stored refresh token will never work again and the
/// daemon needs fresh credentials. Transient failures (network errors, 5xx,
/// rate limits) do NOT set this flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloudAuthSnapshot {
    pub terminal_failure: bool,
}

#[async_trait]
pub trait Backend: Send + Sync {
    // ── Identity ──────────────────────────────────────────────────────────
    /// The team this backend is authenticated against.
    fn team_id(&self) -> &str;

    /// The actor (member or agent) this backend acts as.
    fn actor_id(&self) -> &str;

    // ── Credentials ───────────────────────────────────────────────────────
    /// Current auth token for downstream services (MQTT, etc.). Implementations
    /// are expected to refresh as needed and return a usable bearer string.
    async fn auth_token(&self) -> BackendResult<String>;

    /// Wall-clock expiry of the cached credential (epoch seconds) without
    /// forcing a refresh. `None` if no credential has been fetched yet or the
    /// impl doesn't expose one.
    fn cached_credential_expiry_epoch(&self) -> Option<i64> {
        None
    }

    /// Drop any cached access token so the next [`auth_token`] call refreshes.
    fn invalidate_cached_credential(&self) {}

    /// Snapshot of the cloud-auth session health. `Some` for HTTP-backed cloud
    /// backends; `None` for backends with no remote auth surface (mock). Read by
    /// the local HTTP `/v1/info` handler so the desktop can detect a terminally
    /// expired session and trigger auto re-onboarding. Diagnostic only — callers
    /// must not gate request behavior on it.
    fn cloud_auth_health(&self) -> Option<CloudAuthSnapshot> {
        None
    }

    /// Fetch runtime MQTT broker overrides from the cloud backend. Default
    /// implementation is a no-op for backends that have no remote config
    /// surface (e.g. mock, Supabase).
    async fn fetch_bootstrap_mqtt(&self) -> BackendResult<Option<BootstrapMqttOverride>> {
        Ok(None)
    }

    /// Fetch a team's share-mode + git config from the Cloud API. A team that
    /// has not yet enabled team-share resolves to `ShareModeConfig::default()`
    /// (all `None`) rather than an error. No default impl: both backends must
    /// implement it since the semantics differ (HTTP fetch vs. in-memory stub).
    async fn team_share_config(&self, team_id: &str) -> BackendResult<ShareModeConfig>;

    /// Fetch the team-scoped managed-git credential from the cloud API
    /// (`GET /v1/teams/:id/managed-git-credential`). Used by the app-seed path
    /// to authenticate the daemon's git operations against the managed remote.
    async fn managed_git_credential(&self, team_id: &str) -> BackendResult<ManagedGitCredential>;

    /// Fetch the team's managed (shared) LLM config from the Cloud API
    /// (`GET /v1/teams/:id/workspace-config` → `llm.*`). Used to materialize
    /// `opencode.json`'s `provider.team` without any disk dependency. Backends
    /// with no HTTP surface (mock) return a disabled config.
    async fn managed_llm_config(&self, _team_id: &str) -> BackendResult<ManagedLlmConfig> {
        Ok(ManagedLlmConfig::default())
    }

    /// Idempotently ensure the caller's LiteLLM member key is provisioned via
    /// `POST /v1/teams/:id/litellm/member-key`. The key value itself is
    /// deterministic (`sk-tc-{actor_id[..40]}`) and derived locally; this call
    /// only guarantees LiteLLM has actually minted it. Called fire-and-forget as
    /// a self-heal, so failures are non-fatal. No-op default for mock backends.
    async fn ensure_llm_member_key(&self, _team_id: &str) -> BackendResult<()> {
        Ok(())
    }

    /// Fetch the calling member's effective default agent for a team
    /// (member default, else team default, else None) via
    /// `GET /v1/teams/:id/members/me/effective-default-agent`.
    async fn get_effective_default_agent(&self, team_id: &str) -> BackendResult<Option<String>>;

    /// The cloud base URL this backend targets (e.g. `https://cloud.ucar.cc`),
    /// trailing slash trimmed. Used by the sync dispatcher to point the OSS
    /// `FcClient` at the same FC the daemon authenticates against. `None` for
    /// backends with no HTTP surface (mock), so the dispatcher falls back to a
    /// default endpoint.
    fn cloud_base_url(&self) -> Option<String> {
        None
    }

    // ── Business operations ───────────────────────────────────────────────
    /// Claim a team invite token. Used both by the human onboarding path
    /// and by the daemon's `claim_daemon_invite` flow.
    #[allow(dead_code)]
    async fn claim_team_invite(&self, token: &str) -> BackendResult<ClaimResult>;

    /// Upsert an `agent_runtimes` row keyed on `(agent_id, backend_session_id)`.
    /// Returns the row id when the response carries one.
    async fn upsert_agent_runtime(
        &self,
        row: &AgentRuntimeUpsert<'_>,
    ) -> BackendResult<Option<String>>;

    /// Fetch one `agent_runtimes` row for an exact runtime/backend session.
    async fn fetch_agent_runtime_for_session(
        &self,
        session_id: &str,
        runtime_id: &str,
        backend_session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>>;

    /// Fetch the newest `agent_runtimes` row for `(agent_id, session_id)`.
    async fn fetch_latest_runtime_for_session(
        &self,
        agent_id: &str,
        session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>>;

    /// Advertise daemon-supported agent backend types on its `agents` row.
    async fn ensure_agent_types(
        &self,
        supported_types: &[String],
        default_agent_type: &str,
    ) -> BackendResult<()>;

    /// Look up `agent_member_access.permission_level` for a caller.
    /// Returns `Some("admin" | "write" | "view")` or `None`.
    async fn check_agent_permission(
        &self,
        agent_id: &str,
        actor_id: &str,
    ) -> BackendResult<Option<String>>;

    /// Touch `actor_last_active` for the current daemon actor.
    async fn heartbeat(&self) -> BackendResult<()>;

    /// Report this daemon's version to the Cloud API once at startup.
    /// `device_id` is supplied by the caller (the bin crate owns the persisted
    /// device-id module) so this trait stays self-contained for test crates that
    /// pull `backend/` in via `#[path]`.
    async fn report_client_version(&self, device_id: &str) -> BackendResult<()>;

    /// Upsert a `workspaces` row, returning the canonical id.
    async fn upsert_workspace(&self, row: &WorkspaceUpsert<'_>) -> BackendResult<WorkspaceRow>;

    /// Resolve workspace UUIDs to their canonical rows (id/team_id/path). Used
    /// by the daemon to look up a workspace's filesystem path from the cloud
    /// `amux.workspaces` table instead of the local `workspaces.toml`.
    async fn get_workspaces_by_ids(&self, ids: &[String]) -> BackendResult<Vec<WorkspaceRow>>;

    /// List every workspace row (id/team_id/path) belonging to `team_id`,
    /// across all devices. Used by the daemon's team-link sweep, which then
    /// filters to paths that exist on *this* machine before symlinking.
    async fn get_workspaces_by_team(&self, team_id: &str) -> BackendResult<Vec<WorkspaceRow>>;

    /// Set `agents.default_workspace_id` for the current daemon actor.
    async fn set_agent_default_workspace(&self, workspace_id: &str) -> BackendResult<()>;

    /// Fetch an agent's defaults (backend type + default workspace) from the
    /// Cloud API. Used by the gateway path to spawn the daemon's own agent with
    /// its configured type/workspace. Backends without an HTTP surface return
    /// all-`None` defaults (the gateway then falls back to daemon-wide defaults).
    async fn get_agent_defaults(&self, _agent_id: &str) -> BackendResult<AgentDefaults> {
        Ok(AgentDefaults::default())
    }

    /// Fetch a `sessions` row alongside its `session_participants`.
    async fn fetch_session_with_participants(
        &self,
        session_id: &str,
    ) -> BackendResult<BackendSessionAndParticipants>;

    /// Messages for `session_id` ordered ascending, with optional exclusive
    /// cursor — messages at or before `after_id` are dropped.
    async fn messages_after_cursor(
        &self,
        session_id: &str,
        after_id: Option<&str>,
    ) -> BackendResult<Vec<StoredMessage>>;

    /// Persist the per-runtime read cursor by PATCHing `agent_runtimes`.
    async fn update_runtime_cursor(
        &self,
        runtime_row_id: &str,
        last_processed_message_id: &str,
    ) -> BackendResult<()>;

    /// Upsert an `actors` row of type `external` keyed on
    /// `(team_id, source, source_id)`. Returns the actor's UUID.
    async fn rpc_upsert_external_actor(
        &self,
        team_id: &str,
        source: &str,
        source_id: &str,
        display_name: &str,
    ) -> BackendResult<String>;

    /// Look up `(sessions.id, binding)` for a gateway session by its
    /// SQL-minted `acp_session_id`. Returns `None` when no row matches.
    async fn get_gateway_session_by_acp_id(
        &self,
        acp_session_id: &str,
    ) -> BackendResult<Option<(String, Option<String>)>>;

    /// Resolve (or create) the `sessions` row for a gateway binding.
    /// Returns `(session_id, acp_session_id, created)`.
    #[allow(clippy::too_many_arguments)]
    async fn rpc_ensure_gateway_session(
        &self,
        team_id: &str,
        binding: &str,
        title: &str,
        primary_agent_actor_id: &str,
        owner_member_actor_ids: &[String],
        participant_actor_ids: &[String],
    ) -> BackendResult<(String, String, bool)>;

    /// Insert one row into `public.messages` from a gateway message.
    /// Idempotent on `(session_id, external_id)`.
    async fn insert_gateway_message(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String>;

    /// Same as `insert_gateway_message` but stored with the `agent_reply`
    /// message kind so clients render it as an assistant turn rather than a
    /// user message. The default delegates to `insert_gateway_message` (which
    /// stores `text`); real backends override to set the correct kind.
    async fn insert_gateway_agent_reply(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        self.insert_gateway_message(session_id, sender_actor_id, content, external_message_id)
            .await
    }

    /// Same as `insert_gateway_message`, with an `attachments` JSON array.
    async fn insert_gateway_message_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: serde_json::Value,
    ) -> BackendResult<String>;

    /// Upload bytes to the attachments bucket.
    async fn upload_attachment_bytes(
        &self,
        path: &str,
        bytes: Vec<u8>,
        mime: &str,
    ) -> BackendResult<String>;

    /// Return admin member actor ids granted access to `agent_actor_id`.
    async fn list_agent_admin_member_actor_ids(
        &self,
        agent_actor_id: &str,
    ) -> BackendResult<Vec<String>>;

    /// Add (or ignore-if-present) a participant on `session_participants`.
    async fn upsert_session_participant(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> BackendResult<()>;

    /// Create a `sessions` row for a cron-triggered turn and seed
    /// participants (primary agent + that agent's admin members).
    async fn create_cron_session(
        &self,
        team_id: &str,
        primary_agent_actor_id: &str,
        title: &str,
    ) -> BackendResult<String>;

    /// Insert one row into `public.messages` from the daemon's runtime.
    #[allow(clippy::too_many_arguments)]
    async fn insert_message(
        &self,
        id: &str,
        team_id: &str,
        session_id: &str,
        sender_actor_id: &str,
        kind: &str,
        content: &str,
        metadata_json: &str,
        model: &str,
        turn_id: &str,
        sequence: u64,
    ) -> BackendResult<()>;
}

#[cfg(test)]
mod proactive_refresh_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn proactive_delay_is_zero_inside_five_minute_buffer() {
        let expiry = epoch_secs_now() + 2 * 60;
        assert!(credential_in_proactive_refresh_window(Some(expiry)));
        assert_eq!(proactive_reconnect_delay(Some(expiry)), Duration::ZERO);
    }

    #[test]
    fn proactive_delay_is_positive_outside_buffer() {
        let expiry = epoch_secs_now() + 10 * 60;
        assert!(!credential_in_proactive_refresh_window(Some(expiry)));
        assert!(proactive_reconnect_delay(Some(expiry)) > Duration::from_secs(4 * 60));
    }

    #[test]
    fn unknown_expiry_uses_conservative_fallback() {
        assert!(!credential_in_proactive_refresh_window(None));
        assert_eq!(
            proactive_reconnect_delay(None),
            Duration::from_secs(50 * 60)
        );
    }
}

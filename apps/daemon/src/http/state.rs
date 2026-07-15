//! Shared application state for the HTTP layer.
//!
//! `HttpState` is the single `Arc`-wrapped bundle the axum router hangs
//! every handler off. Keep it small and trait-object-friendly: handlers
//! that need fine-grained pieces extract from this struct rather than
//! introducing parallel statics.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::{mpsc, oneshot};

use crate::backend::Backend;
use crate::config::workspace_control::WorkspaceControlStore;
use crate::config::HttpConfig;

use super::limit::RateLimiter;
use super::runtime_adapter::RuntimeAdapter;
use super::sessions::{IdempotencyCache, SessionOwnerIndex};
use super::tokens::TokenStore;

/// Request to register a workspace into the cloud `amux.workspaces` table
/// (the sole source of truth), idempotently.
///
/// The HTTP `POST /v1/workspaces` handler cannot upsert directly — the
/// daemon actor loop owns all cloud writes, so a concurrent upsert from the
/// HTTP task would race the actor. Instead the handler sends this request to
/// the actor loop (via the same command channel that backs the Unix control
/// socket) and waits on `reply_tx` for a single JSON line:
/// `{"ok":true,"result":{workspace}}` or `{"ok":false,"error":...}`.
pub struct RegisterWorkspaceRequest {
    /// Absolute workspace path to register (e.g. `~/.amuxd/teams/<teamId>`
    /// already expanded by the caller).
    pub path: String,
    pub reply_tx: oneshot::Sender<String>,
}

/// Producer side of the register-workspace bridge handed to `HttpState`.
pub type RegisterWorkspaceTx = mpsc::Sender<RegisterWorkspaceRequest>;

/// Process metadata surfaced via `/v1/info`. Filled in at startup and
/// treated as immutable thereafter.
#[derive(Debug, Clone)]
pub struct DaemonMetadata {
    pub version: &'static str,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub actor_id: String,
    pub backend_kind: String,
    /// Agent backends this daemon has configured (subset of
    /// `["claude", "opencode", "codex"]`), as reported by
    /// `supported_agent_type_names`. Drives the per-backend model catalog
    /// (`GET /v1/workspaces/:id/model-catalog`). Empty in focused tests that
    /// build metadata via `metadata()` without daemon config.
    pub configured_agent_types: Vec<String>,
    /// Live status of the background "advertise agent_types to the cloud"
    /// task. Shared (interior-mutable) so the task can record the outcome and
    /// `/v1/info` can surface a failure instead of swallowing it in a log line.
    pub agent_types_advertise: Arc<parking_lot::Mutex<AgentTypesAdvertise>>,
    /// Whether the daemon's MQTT connection is currently established.
    /// Updated by the MQTT event loop; surfaced via `/v1/info`.
    pub mqtt_connected: Arc<AtomicBool>,
}

/// Outcome of the cloud `agents.agent_types` advertise. Surfaced via
/// `/v1/info` so a denied/failed advertise (e.g. RLS or permission error) is
/// visible to the desktop instead of only living in a daemon log line.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTypesAdvertise {
    /// True once the advertise has succeeded at least once this run.
    pub advertised: bool,
    /// The last advertise error (cleared on success). `None` while pending or
    /// after a success.
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct HttpState {
    pub config: Arc<HttpConfig>,
    pub tokens: TokenStore,
    pub meta: Arc<DaemonMetadata>,
    pub runtime: Arc<dyn RuntimeAdapter>,
    pub session_index: Arc<SessionOwnerIndex>,
    pub idempotency: Arc<IdempotencyCache>,
    pub limiter: Arc<RateLimiter>,
    /// Workspace configuration control (providers, permissions, allowlist).
    /// `None` when the HTTP server is started without a workspace control
    /// store (e.g. in focused unit tests). Workspace routes return 404 in
    /// that case.
    pub workspace_control: Option<Arc<dyn WorkspaceControlStore>>,
    pub runtime_supervisor: Option<Arc<crate::runtime::RuntimeSupervisor>>,
    /// Workspace refresh state shared with `/v1/workspaces/:id/runtime*`.
    pub runtime_refresh: Option<Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
    /// Loopback `opencode serve` pool for provider OAuth (settings only).
    pub opencode_settings: Option<Arc<crate::opencode_settings::OpenCodeSettingsService>>,
    /// Daemon-owned team sync dispatcher (drives `/v1/team/sync*`).
    pub sync_dispatcher: crate::sync::dispatch::SyncDispatcher,
    /// Bridge to the daemon actor loop for `POST /v1/workspaces`. `None` when
    /// the HTTP server runs without a daemon actor behind it (focused tests) —
    /// the route then returns 503.
    pub register_workspace_tx: Option<RegisterWorkspaceTx>,
    /// The cloud backend this daemon authenticates against, used by `/v1/info`
    /// to surface cloud-auth health (`cloud_auth_health()`). `None` in focused
    /// HTTP tests and for backends with no remote auth surface.
    pub backend: Option<Arc<dyn Backend>>,
    /// Local fast-path live-event tee (`GET /v1/live/events`). Mirrors every
    /// session/live MQTT publish (identical bytes incl. event_id). `None` in
    /// focused tests — the route then returns 503.
    pub live_tee: Option<tokio::sync::broadcast::Sender<super::live_events::LiveTeeEvent>>,
}

impl HttpState {
    // sync_dispatcher was added in the daemon-owns-team-sync pass; constructor
    // is intentionally wide to avoid a builder while the field set is stable.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: HttpConfig,
        tokens: TokenStore,
        meta: DaemonMetadata,
        runtime: Arc<dyn RuntimeAdapter>,
        workspace_control: Option<Arc<dyn WorkspaceControlStore>>,
        runtime_supervisor: Option<Arc<crate::runtime::RuntimeSupervisor>>,
        opencode_settings: Option<Arc<crate::opencode_settings::OpenCodeSettingsService>>,
        sync_dispatcher: crate::sync::dispatch::SyncDispatcher,
        register_workspace_tx: Option<RegisterWorkspaceTx>,
    ) -> Self {
        let runtime_refresh = runtime_supervisor
            .as_ref()
            .map(|supervisor| supervisor.refresh_coordinator());
        Self {
            config: Arc::new(config),
            tokens,
            meta: Arc::new(meta),
            runtime,
            session_index: SessionOwnerIndex::new(),
            idempotency: IdempotencyCache::new(),
            limiter: RateLimiter::new(),
            workspace_control,
            runtime_supervisor,
            runtime_refresh,
            opencode_settings,
            sync_dispatcher,
            register_workspace_tx,
            backend: None,
            live_tee: None,
        }
    }

    /// Attach the cloud backend so `/v1/info` can report cloud-auth health.
    /// Chained after `new()` to keep the (already wide) constructor stable.
    pub fn with_backend(mut self, backend: Option<Arc<dyn Backend>>) -> Self {
        self.backend = backend;
        self
    }

    /// Attach the local live-event tee (enables `GET /v1/live/events`).
    pub fn with_live_tee(
        mut self,
        tee: Option<tokio::sync::broadcast::Sender<super::live_events::LiveTeeEvent>>,
    ) -> Self {
        self.live_tee = tee;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_types_advertise_serializes_camel_case() {
        let s = AgentTypesAdvertise {
            advertised: false,
            last_error: Some("permission denied".into()),
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["advertised"], serde_json::json!(false));
        assert_eq!(v["lastError"], serde_json::json!("permission denied"));
    }

    #[test]
    fn advertise_status_is_shared_through_metadata_clone() {
        // The advertise task holds one clone of the Arc; `/v1/info` reads it
        // through `meta`. A write on one handle must be visible on the other,
        // otherwise a failed advertise would never surface.
        let shared = Arc::new(parking_lot::Mutex::new(AgentTypesAdvertise::default()));
        let via_meta = shared.clone();
        shared.lock().last_error = Some("update did not apply".into());
        assert_eq!(
            via_meta.lock().last_error.as_deref(),
            Some("update did not apply")
        );
        assert!(!via_meta.lock().advertised);
    }
}

//! Backend-neutral local agent runtime abstraction.
//!
//! `RuntimeManager` talks to a local agent runtime (today: the global
//! `opencode serve` HTTP backend in `runtime/opencode_http/`; future: the pi
//! RPC backend, see `docs/architecture/pi-agent-backend.md`) exclusively
//! through the [`AgentBackend`] trait. The per-session channel types
//! ([`AcpCommand`], [`AcpStartupMetadata`], and `AcpEventFrame` in
//! `runtime/acp_event_frame.rs`) are shared across backends and therefore
//! live here rather than inside a specific backend module.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use tokio::sync::{mpsc, oneshot};
use tracing::warn;

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;

use super::manager::AgentLaunchConfig;
use super::opencode_http::AcpHostPool;

// ---------------------------------------------------------------------------
// Shared channel types (backend-neutral)
// ---------------------------------------------------------------------------

/// Commands the runtime manager sends to a local agent backend.
pub enum AcpCommand {
    /// Create or resume an agent session for a worktree.
    AttachSession {
        worktree: String,
        resume_acp_session_id: Option<String>,
        mcp_config_path: Option<PathBuf>,
        initial_model_override: Option<String>,
        initial_prompt: String,
        event_tx: mpsc::Sender<AcpEventFrame>,
        startup_tx: oneshot::Sender<Result<AcpStartupMetadata, String>>,
        /// Gateway sessions auto-allow tool permissions.
        is_gateway: bool,
        /// When resuming, fail instead of falling back to a new session.
        forbid_new_session_fallback: bool,
    },
    /// Drop routing state for a session; the backend process keeps running.
    DetachSession { acp_session_id: String },
    /// Send a prompt to a bound session (async; turn ends on idle).
    Prompt {
        acp_session_id: String,
        text: String,
        attachment_urls: Vec<String>,
        /// Human actor that started this turn; stamped onto PermissionRequest params.
        requester_actor_id: Option<String>,
        /// User message id that triggered this turn; stamped onto AgentReply emits.
        reply_to_message_id: Option<String>,
    },
    /// Cancel the current turn for a bound session.
    Cancel { acp_session_id: String },
    /// Resolve a pending permission request (any session).
    ResolvePermission {
        request_id: String,
        granted: bool,
        /// "always" upgrades the grant; anything else (or None) means "once".
        option_id: Option<String>,
    },
    /// Answer (or reject) an opencode `question` tool request (any session).
    AnswerQuestion {
        request_id: String,
        /// JSON `[[selected labels], ...]` — one array per question, in order.
        answers_json: String,
        reject: bool,
    },
    /// Switch the model used by a bound session (applied on the next prompt).
    SetModel {
        acp_session_id: String,
        model_id: String,
    },
    /// Shut down the backend process (it respawns lazily on next use).
    #[allow(dead_code)]
    Shutdown,
}

#[derive(Debug, Clone)]
pub struct AcpStartupMetadata {
    pub available_models: Vec<amux::ModelInfo>,
    pub initial_model: Option<String>,
    pub acp_session_id: String,
}

// ---------------------------------------------------------------------------
// AgentBackend trait
// ---------------------------------------------------------------------------

/// Local agent runtime backend surface consumed by `RuntimeManager`.
///
/// Mirrors the historical `AcpHostPool` API one-to-one so the opencode HTTP
/// backend is a zero-behavior-change adaptation; a future pi RPC backend
/// implements the same surface.
#[async_trait]
pub trait AgentBackend: Send {
    /// Bind a TeamClaw runtime to a backend session (create or resume).
    #[allow(clippy::too_many_arguments)]
    async fn attach_session(
        &mut self,
        agent_type: amux::AgentType,
        launch: &AgentLaunchConfig,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: String,
        resume_acp_session_id: Option<String>,
        mcp_config_path: Option<PathBuf>,
        initial_model_override: Option<String>,
        initial_prompt: String,
        event_tx: mpsc::Sender<AcpEventFrame>,
        is_gateway: bool,
        forbid_new_session_fallback: bool,
    ) -> crate::error::Result<(mpsc::Sender<AcpCommand>, AcpStartupMetadata)>;

    /// Pre-warm: start the backend process ahead of the first session.
    async fn prewarm(&mut self, launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>);

    /// Pre-warm with a real session env (merged into the backend process env
    /// on its next spawn) and, when a worktree is known, its event stream.
    async fn prewarm_with_env(
        &mut self,
        launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: Option<&str>,
    );

    /// Invalidate backend processes for the given agent types so new sessions
    /// pick up provider auth/config changes. Returns the number removed.
    fn evict_agent_types(&mut self, agent_types: &[amux::AgentType]) -> usize;

    /// Number of live backend processes.
    fn host_count(&self) -> usize;

    /// Model catalog for a workspace directory (cron catalog UI).
    async fn model_catalog(
        &mut self,
        workspace_path: &Path,
    ) -> crate::error::Result<Vec<amux::ModelInfo>>;
}

// ---------------------------------------------------------------------------
// OpencodeHttpBackend — thin adapter over the existing AcpHostPool
// ---------------------------------------------------------------------------

/// The opencode serve HTTP backend (`runtime/opencode_http/`) behind the
/// backend-neutral trait.
pub struct OpencodeHttpBackend {
    pool: AcpHostPool,
}

impl OpencodeHttpBackend {
    pub fn new() -> Self {
        Self {
            pool: AcpHostPool::new(),
        }
    }
}

impl Default for OpencodeHttpBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentBackend for OpencodeHttpBackend {
    async fn attach_session(
        &mut self,
        agent_type: amux::AgentType,
        launch: &AgentLaunchConfig,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: String,
        resume_acp_session_id: Option<String>,
        mcp_config_path: Option<PathBuf>,
        initial_model_override: Option<String>,
        initial_prompt: String,
        event_tx: mpsc::Sender<AcpEventFrame>,
        is_gateway: bool,
        forbid_new_session_fallback: bool,
    ) -> crate::error::Result<(mpsc::Sender<AcpCommand>, AcpStartupMetadata)> {
        self.pool
            .attach_session(
                agent_type,
                launch,
                extra_env,
                force_env_override,
                worktree,
                resume_acp_session_id,
                mcp_config_path,
                initial_model_override,
                initial_prompt,
                event_tx,
                is_gateway,
                forbid_new_session_fallback,
            )
            .await
    }

    async fn prewarm(&mut self, launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>) {
        self.pool.prewarm(launch_configs).await;
    }

    async fn prewarm_with_env(
        &mut self,
        launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: Option<&str>,
    ) {
        self.pool
            .prewarm_with_env(launch_configs, extra_env, force_env_override, worktree)
            .await;
    }

    fn evict_agent_types(&mut self, agent_types: &[amux::AgentType]) -> usize {
        self.pool.evict_agent_types(agent_types)
    }

    fn host_count(&self) -> usize {
        self.pool.host_count()
    }

    async fn model_catalog(
        &mut self,
        workspace_path: &Path,
    ) -> crate::error::Result<Vec<amux::ModelInfo>> {
        self.pool.model_catalog(workspace_path).await
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/// Build the local agent backend selected by daemon config
/// (`agents.local_agent`; default "opencode").
pub fn create_backend(local_agent: &str) -> Box<dyn AgentBackend> {
    match local_agent {
        "pi" => Box::new(super::pi_rpc::PiRpcBackend::new()),
        "opencode" => Box::new(OpencodeHttpBackend::new()),
        other => {
            warn!(
                local_agent = other,
                "unknown agents.local_agent; falling back to opencode"
            );
            Box::new(OpencodeHttpBackend::new())
        }
    }
}

use async_trait::async_trait;

/// Identifier of an amuxd session that a gateway channel is conversing with.
/// Opaque to the gateway; resolved against amuxd's runtime manager.
pub type AmuxSessionId = String;

/// Describes a model the daemon can drive, returned by `list_models`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModelInfo {
    pub provider: String,
    pub model: String,
    pub display_name: String,
}

/// A slash command advertised by the ACP agent via `AcpAvailableCommands`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AcpAvailableCommand {
    pub name: String,
    pub description: String,
    /// `None` means the command takes no input; `Some(hint)` means the command
    /// accepts free-form text input described by the hint string.
    pub input_hint: Option<String>,
}

/// Outcome of a single ACP turn driven by a gateway message.
#[derive(Debug, Clone)]
pub struct AcpTurnOutcome {
    pub reply_text: String,
    pub completed: bool,
}

/// Agent type entry returned by `list_agents`.
#[derive(Debug, Clone)]
pub struct AgentInfo {
    pub agent_type: String,
    pub is_current: bool,
}

/// Workspace entry returned by `list_workspaces`.
#[derive(Debug, Clone)]
pub struct WorkspaceInfo {
    pub workspace_id: String,
    pub display_name: String,
    pub is_current: bool,
}

/// Abstraction over amuxd's in-process ACP runtime. Channels call this
/// instead of POSTing to opencode's HTTP server.
#[async_trait]
pub trait AcpHandle: Send + Sync + 'static {
    /// Create a new ACP-backed session for a freshly-bound gateway conversation.
    /// Returns the amuxd session id to persist on the gateway's `Binding`.
    async fn create_session(
        &self,
        team_id: &str,
        binding: &str,
        title: &str,
    ) -> Result<AmuxSessionId, AcpError>;

    /// Send a user prompt and wait for the agent's reply text. Equivalent to
    /// v1's `prompt_async` + SSE polling, but synchronous and in-process.
    async fn send_prompt(
        &self,
        session: &AmuxSessionId,
        sender_display: &str,
        text: &str,
    ) -> Result<AcpTurnOutcome, AcpError>;

    /// Inject context without triggering a reply (v1 `noReply: true`).
    /// Kept on the trait for future use; not called by v1-of-port channels.
    async fn inject_context(
        &self,
        session: &AmuxSessionId,
        sender_display: &str,
        text: &str,
    ) -> Result<(), AcpError>;

    /// Cancel any in-flight turn on this session. Used by /stop.
    async fn cancel(&self, session: &AmuxSessionId) -> Result<(), AcpError>;

    /// Drop the runtime context for this session — next send_prompt re-spawns
    /// a fresh agent under the same logical id. Used by /reset.
    async fn reset_session(&self, session: &AmuxSessionId) -> Result<(), AcpError>;

    /// List available models the daemon can drive. Used by /model (no arg).
    async fn list_models(&self) -> Result<Vec<ModelInfo>, AcpError>;

    /// Pin a model for this session. Restarts the underlying agent —
    /// conversation context is lost. Used by /model X.
    async fn set_model(
        &self,
        session: &AmuxSessionId,
        provider: &str,
        model: &str,
    ) -> Result<(), AcpError>;

    /// Return the slash commands the running ACP agent has currently advertised.
    /// Returns an empty vec if the session hasn't spawned yet or the agent
    /// hasn't reported commands. Used by `commands::dispatch` for ACP-first priority.
    async fn available_commands(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<AcpAvailableCommand>, AcpError>;

    /// Forward a slash command to the ACP agent. Only call after confirming
    /// via `available_commands` that the agent knows this command.
    /// Behaves like `send_prompt` — returns the agent's reply text.
    async fn send_slash_command(
        &self,
        session: &AmuxSessionId,
        name: &str,
        input: Option<&str>,
    ) -> Result<AcpTurnOutcome, AcpError>;

    /// List all logical sessions this handle knows about (spawned since last
    /// daemon restart). Returns `(session_id, is_current)` pairs.
    async fn list_sessions(
        &self,
        active_session: &AmuxSessionId,
    ) -> Result<Vec<(AmuxSessionId, bool)>, AcpError>;

    /// List available agent types.
    async fn list_agents(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<AgentInfo>, AcpError>;

    /// Set agent type for this session. Restarts the underlying agent —
    /// conversation context is lost (same semantics as `set_model`).
    async fn set_agent(
        &self,
        session: &AmuxSessionId,
        agent_type: &str,
    ) -> Result<(), AcpError>;

    /// List workspaces known to the daemon.
    async fn list_workspaces(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<WorkspaceInfo>, AcpError>;

    /// Set workspace for this session. Restarts the underlying agent —
    /// conversation context is lost (same semantics as `set_model`).
    async fn set_workspace(
        &self,
        session: &AmuxSessionId,
        workspace_id: &str,
    ) -> Result<(), AcpError>;

    /// List workspace skills available to the session.
    /// Returns `(slash_name, description)` pairs, alphabetically sorted.
    async fn list_skills(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<(String, String)>, AcpError>;
}

#[derive(Debug, thiserror::Error)]
pub enum AcpError {
    #[error("acp session creation failed: {0}")]
    Create(String),
    #[error("acp send failed: {0}")]
    Send(String),
    #[error("acp turn timed out")]
    Timeout,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("internal error: {0}")]
    Internal(String),
}

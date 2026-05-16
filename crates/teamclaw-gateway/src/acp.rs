use async_trait::async_trait;

/// Identifier of an amuxd session that a gateway channel is conversing with.
/// Opaque to the gateway; resolved against amuxd's runtime manager.
pub type AmuxSessionId = String;

/// Outcome of a single ACP turn driven by a gateway message.
#[derive(Debug, Clone)]
pub struct AcpTurnOutcome {
    pub reply_text: String,
    pub completed: bool,
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
}

#[derive(Debug, thiserror::Error)]
pub enum AcpError {
    #[error("acp session creation failed: {0}")]
    Create(String),
    #[error("acp send failed: {0}")]
    Send(String),
    #[error("acp turn timed out")]
    Timeout,
}

use async_trait::async_trait;

/// Metadata for a single attachment uploaded alongside a gateway message.
/// Stored as an element of the `messages.attachments` JSONB array.
#[derive(Debug, Clone)]
pub struct AttachmentRecord {
    pub filename: String,
    pub mime: String,
    pub size: usize,
    /// Object path inside the backend attachments storage. Empty when the
    /// upload failed and only the local cache copy exists.
    pub bucket_path: String,
    /// Absolute path to the locally-cached copy on the daemon that received
    /// the message. Optional — only meaningful while that daemon is alive.
    pub local_path: Option<String>,
}

/// What a channel needs the daemon-backed store to do.
/// Concrete impl lives in amuxd and decides which persistence backend to use.
#[async_trait]
pub trait ChannelStore: Send + Sync + 'static {
    /// Resolve or create an external actor (e.g., a WeCom user).
    /// `display_name` is updated on every call (cheap UPSERT).
    async fn ensure_external_actor(
        &self,
        team_id: &str,
        source: &str,
        source_id: &str,
        display_name: &str,
    ) -> Result<String /* actor_id */, StoreError>;

    /// Resolve the amuxd session for a gateway binding, creating one if absent.
    /// Returns (session_id, amuxd_acp_session_id, is_new).
    async fn ensure_session(
        &self,
        team_id: &str,
        binding: &str,
        title: &str,
        primary_agent_actor_id: &str,
        owner_member_actor_ids: &[String],
        participant_actor_ids: &[String],
    ) -> Result<EnsureSessionOutcome, StoreError>;

    /// Persist a single chat message. Idempotent on (session_id, external_message_id).
    async fn record_message(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> Result<String /* message_id */, StoreError>;

    /// Persist an agent reply. Same as `record_message` but stored with the
    /// `agent_reply` message kind so clients render it as an assistant turn
    /// (left-aligned) instead of a user message. Idempotent on
    /// `(session_id, external_message_id)`.
    async fn record_agent_reply(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> Result<String /* message_id */, StoreError>;

    /// Like `record_message` but records `attachments` in the
    /// `messages.attachments` JSONB column. Idempotent on
    /// `(session_id, external_message_id)`.
    async fn record_message_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: Vec<AttachmentRecord>,
    ) -> Result<String /* message_id */, StoreError>;

    /// Upload bytes to backend attachment storage at `bucket_path`.
    /// Returns the stored object path on success.
    async fn upload_attachment(
        &self,
        bucket_path: &str,
        bytes: Vec<u8>,
        mime: &str,
    ) -> Result<String, StoreError>;

    /// Add a participant if not already in session_participants.
    async fn add_participant(&self, session_id: &str, actor_id: &str) -> Result<(), StoreError>;
}

#[derive(Debug, Clone)]
pub struct EnsureSessionOutcome {
    pub session_id: String,
    pub acp_session_id: String,
    pub created: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("backend store error: {0}")]
    Backend(String),
}

use crate::proto::amux;

/// ACP event plus the originating ACP session id (root or child subagent).
#[derive(Clone, Debug)]
pub struct AcpEventFrame {
    pub acp_session_id: String,
    pub event: amux::AcpEvent,
    /// User `messages.id` for the in-flight turn that produced this frame.
    /// Bound when the prompt worker dequeues a job (not at enqueue time), so
    /// concurrent queued prompts cannot overwrite an earlier turn's stamp.
    pub turn_reply_to_message_id: Option<String>,
}

impl AcpEventFrame {
    pub fn new(acp_session_id: impl Into<String>, event: amux::AcpEvent) -> Self {
        Self {
            acp_session_id: acp_session_id.into(),
            event,
            turn_reply_to_message_id: None,
        }
    }

    pub fn with_reply_to(mut self, reply_to_message_id: Option<String>) -> Self {
        self.turn_reply_to_message_id = reply_to_message_id.filter(|id| !id.is_empty());
        self
    }
}

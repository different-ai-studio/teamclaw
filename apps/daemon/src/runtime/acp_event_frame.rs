use crate::proto::amux;

/// ACP event plus the originating ACP session id (root or child subagent).
#[derive(Clone, Debug)]
pub struct AcpEventFrame {
    pub acp_session_id: String,
    pub event: amux::AcpEvent,
}

impl AcpEventFrame {
    pub fn new(acp_session_id: impl Into<String>, event: amux::AcpEvent) -> Self {
        Self {
            acp_session_id: acp_session_id.into(),
            event,
        }
    }
}

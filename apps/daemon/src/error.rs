use thiserror::Error;

#[derive(Error, Debug)]
pub enum AmuxError {
    #[error("config error: {0}")]
    Config(String),
    #[error("mqtt error: {0}")]
    Mqtt(#[from] rumqttc::ClientError),
    #[error("transport error: {0}")]
    Transport(#[from] teamclu_transport::PublisherError),
    #[error("proto encode error: {0}")]
    ProtoEncode(#[from] prost::EncodeError),
    #[error("proto decode error: {0}")]
    ProtoDecode(#[from] prost::DecodeError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("agent error: {0}")]
    Agent(String),
    #[error("auth error: {0}")]
    #[allow(dead_code)]
    Auth(String),
    #[error("ipc error: {0}")]
    #[allow(dead_code)]
    Ipc(String),
}

pub type Result<T> = std::result::Result<T, AmuxError>;

/// The configured runtime for this team is not installed on this device.
///
/// `agent_binary_missing(<agent>)` is a wire contract, not prose: the desktop
/// client matches on it to swap the raw ENOENT for an actionable message
/// naming the runtime (`packages/app/src/lib/teamclu/ensure-agent-runtime.ts`,
/// `daemon.agentRuntime.binaryMissingDesc`). Both sides move together.
///
/// `agents.local_agent` is team-scoped, so this is reachable simply by joining
/// a team whose runtime this machine never installed — it is a normal state to
/// land in, not a corrupt install.
pub fn agent_binary_missing(agent: &str, detail: impl std::fmt::Display) -> AmuxError {
    AmuxError::Agent(format!("agent_binary_missing({agent}): {detail}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_survives_the_display_wrapping_the_daemon_applies() {
        let err = agent_binary_missing("opencode", "spawn opencode serve (opencode): ENOENT");
        // What the client actually receives is this, wrapped again by
        // runtime_lifecycle's `start_runtime failed: {}`.
        let wire = format!("start_runtime failed: {err}");
        assert!(
            wire.contains("agent_binary_missing(opencode)"),
            "got: {wire}"
        );
    }

    #[test]
    fn agent_name_is_recoverable_for_every_selectable_runtime() {
        for agent in ["opencode", "pi", "cursor", "claude-code"] {
            let text = agent_binary_missing(agent, "detail").to_string();
            assert!(
                text.contains(&format!("agent_binary_missing({agent})")),
                "got: {text}"
            );
        }
    }
}

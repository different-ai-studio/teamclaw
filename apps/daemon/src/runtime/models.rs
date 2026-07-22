use crate::proto::amux;

/// Default opencode model id (provider/model form) used when the serve
/// catalog is unreachable. Kept in sync with the free default the frontend
/// tests assume (`opencode/deepseek-v4-flash-free`).
pub const OPENCODE_FALLBACK_MODEL_ID: &str = "opencode/deepseek-v4-flash-free";

/// Hardcoded model list used as a **fallback** when the agent backend has not
/// yet advertised its models. Live runtimes prefer the serve-reported catalog
/// captured onto `RuntimeHandle::available_models` at attach time (see
/// `runtime::opencode_http`); this table is consulted only for placeholder
/// state and historical sessions reconstructed from `session_store`.
///
/// Single-agent mode: every agent type maps to the opencode backend, so the
/// same opencode fallback table is returned regardless of `agent_type`
/// (historical claude/codex sessions run on opencode too).
pub fn available_models_for(_agent_type: amux::AgentType) -> Vec<amux::ModelInfo> {
    vec![amux::ModelInfo {
        id: OPENCODE_FALLBACK_MODEL_ID.to_string(),
        display_name: "DeepSeek V4 Flash Free".to_string(),
        provider_name: "OpenCode Zen".to_string(),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_agent_type_gets_the_opencode_fallback_table() {
        for at in [
            amux::AgentType::Opencode,
            amux::AgentType::ClaudeCode,
            amux::AgentType::Codex,
            amux::AgentType::Unknown,
        ] {
            let models = available_models_for(at);
            assert_eq!(models.len(), 1);
            assert_eq!(models[0].id, OPENCODE_FALLBACK_MODEL_ID);
        }
    }
}

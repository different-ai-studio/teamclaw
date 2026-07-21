use crate::proto::amux;

/// Hardcoded model list used as a **fallback** when the agent backend has not
/// yet advertised its models. Live runtimes prefer the serve-reported catalog
/// captured onto `RuntimeHandle::available_models` at attach time (see
/// `runtime::opencode_http`); this table is consulted only for placeholder
/// state and historical sessions reconstructed from `session_store`.
pub fn available_models_for(agent_type: amux::AgentType) -> Vec<amux::ModelInfo> {
    match agent_type {
        amux::AgentType::ClaudeCode => vec![
            amux::ModelInfo {
                id: "claude-haiku-4-5".to_string(),
                display_name: "Claude Haiku 4.5".to_string(),
            },
            amux::ModelInfo {
                id: "claude-sonnet-4-6".to_string(),
                display_name: "Claude Sonnet 4.6".to_string(),
            },
            amux::ModelInfo {
                id: "claude-opus-4-7".to_string(),
                display_name: "Claude Opus 4.7".to_string(),
            },
        ],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_returns_three_models_in_order() {
        let models = available_models_for(amux::AgentType::ClaudeCode);
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].id, "claude-haiku-4-5");
        assert_eq!(models[1].id, "claude-sonnet-4-6");
        assert_eq!(models[2].id, "claude-opus-4-7");
    }

    #[test]
    fn opencode_fallback_is_empty() {
        assert!(available_models_for(amux::AgentType::Opencode).is_empty());
        assert!(available_models_for(amux::AgentType::Codex).is_empty());
    }
}

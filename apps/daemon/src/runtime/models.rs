use crate::proto::amux;

/// Returns the hardcoded list of models supported by an agent type.
/// v1 only knows about Claude; new agent types return empty until their
/// wrapper integration lands.
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
    fn unknown_agent_type_returns_empty() {
        // Opencode and Codex are placeholders until their wrappers ship.
        let models = available_models_for(amux::AgentType::Opencode);
        assert!(models.is_empty());
    }
}

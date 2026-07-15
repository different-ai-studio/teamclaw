use crate::proto::amux;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstructionDelivery {
    BufferedInject,
    NativeOpenCodePlugin,
    NativeClaudeMd,
}

pub fn resolve_instruction_delivery(
    agent_type: amux::AgentType,
    opencode_plugin_ready: bool,
    claude_md_present: bool,
) -> InstructionDelivery {
    match agent_type {
        amux::AgentType::ClaudeCode if claude_md_present => InstructionDelivery::NativeClaudeMd,
        amux::AgentType::Opencode | amux::AgentType::Codex if opencode_plugin_ready => {
            InstructionDelivery::NativeOpenCodePlugin
        }
        _ => InstructionDelivery::BufferedInject,
    }
}

pub fn skips_buffered_inject(delivery: InstructionDelivery) -> bool {
    !matches!(delivery, InstructionDelivery::BufferedInject)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_buffered_for_unknown_agent() {
        assert_eq!(
            resolve_instruction_delivery(amux::AgentType::ClaudeCode, false, false),
            InstructionDelivery::BufferedInject
        );
    }

    #[test]
    fn resolve_native_opencode_when_plugin_ready() {
        assert_eq!(
            resolve_instruction_delivery(amux::AgentType::Opencode, true, false),
            InstructionDelivery::NativeOpenCodePlugin
        );
        assert_eq!(
            resolve_instruction_delivery(amux::AgentType::Codex, true, false),
            InstructionDelivery::NativeOpenCodePlugin
        );
    }

    #[test]
    fn resolve_native_claude_when_md_synced() {
        assert_eq!(
            resolve_instruction_delivery(amux::AgentType::ClaudeCode, false, true),
            InstructionDelivery::NativeClaudeMd
        );
    }

    #[test]
    fn skips_buffered_inject_only_for_native_paths() {
        assert!(!skips_buffered_inject(InstructionDelivery::BufferedInject));
        assert!(skips_buffered_inject(InstructionDelivery::NativeOpenCodePlugin));
        assert!(skips_buffered_inject(InstructionDelivery::NativeClaudeMd));
    }
}

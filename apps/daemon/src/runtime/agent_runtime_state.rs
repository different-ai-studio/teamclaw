//! Daemon-side mirror of per-agent ACP state, extracted from `manager.rs`.
//!
//! Tracks, per agent id, the model currently applied to the agent's ACP
//! session and the most recent slash commands it announced via
//! `AvailableCommandsUpdate`. These are cached so a fresh subscriber on the
//! retained `runtime/{id}/state` topic sees the same values the agent already
//! announced on the (non-retained) events topic.
//!
//! Previously these were two loose `HashMap` fields on `RuntimeManager`,
//! mutated inline at ~16 call sites and — notably — never cleaned up when an
//! agent stopped (a small unbounded leak). Wrapping them in one type gives a
//! typed API and a single `remove()` that `stop_agent` now calls.

use std::collections::HashMap;

use crate::proto::amux;

/// Per-agent runtime state mirrored for `RuntimeInfo` population.
#[derive(Debug, Default)]
pub struct PerAgentRuntimeState {
    /// Model id currently applied to each agent's ACP session.
    current_model: HashMap<String, String>,
    /// Most recent slash commands reported by each agent.
    available_commands: HashMap<String, Vec<amux::AcpAvailableCommand>>,
}

impl PerAgentRuntimeState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that `agent_id`'s session is now running on `model_id`.
    pub fn set_model(&mut self, agent_id: &str, model_id: &str) {
        self.current_model
            .insert(agent_id.to_string(), model_id.to_string());
    }

    /// The model id last recorded for `agent_id`, if any.
    pub fn model(&self, agent_id: &str) -> Option<&String> {
        self.current_model.get(agent_id)
    }

    /// The model id last recorded for `agent_id`, or an empty string.
    pub fn model_or_default(&self, agent_id: &str) -> String {
        self.current_model
            .get(agent_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Cache the slash commands last reported by `agent_id`.
    pub fn set_commands(&mut self, agent_id: &str, commands: Vec<amux::AcpAvailableCommand>) {
        self.available_commands
            .insert(agent_id.to_string(), commands);
    }

    /// The slash commands last reported by `agent_id`, or an empty vec.
    pub fn commands(&self, agent_id: &str) -> Vec<amux::AcpAvailableCommand> {
        self.available_commands
            .get(agent_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Drop all tracked state for an agent that has stopped.
    pub fn remove(&mut self, agent_id: &str) {
        self.current_model.remove(agent_id);
        self.available_commands.remove(agent_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_round_trips_and_defaults() {
        let mut s = PerAgentRuntimeState::new();
        assert_eq!(s.model("a"), None);
        assert_eq!(s.model_or_default("a"), "");

        s.set_model("a", "anthropic/claude");
        assert_eq!(s.model("a"), Some(&"anthropic/claude".to_string()));
        assert_eq!(s.model_or_default("a"), "anthropic/claude");
    }

    #[test]
    fn commands_default_to_empty() {
        let mut s = PerAgentRuntimeState::new();
        assert!(s.commands("a").is_empty());

        s.set_commands(
            "a",
            vec![amux::AcpAvailableCommand {
                name: "clear".into(),
                description: "Clear".into(),
                input_hint: String::new(),
            }],
        );
        assert_eq!(s.commands("a").len(), 1);
    }

    #[test]
    fn remove_clears_both_maps() {
        let mut s = PerAgentRuntimeState::new();
        s.set_model("a", "m");
        s.set_commands("a", vec![]);
        s.remove("a");
        assert_eq!(s.model("a"), None);
        assert!(s.commands("a").is_empty());
        // Other agents are untouched.
        s.set_model("b", "m2");
        s.remove("a");
        assert_eq!(s.model_or_default("b"), "m2");
    }
}

//! Built-in slash commands per [`AgentType`].
//!
//! # Why this is a table and not a query
//!
//! Commands used to arrive over ACP as `AvailableCommandsUpdate`, cached by
//! `RuntimeManager::set_available_commands`. Under the single-agent opencode
//! HTTP runtime that event has no producer — neither `opencode_http` nor
//! `pi_rpc` emits it — so the cache is permanently empty and anything reading
//! it advertises no commands at all.
//!
//! opencode's HTTP surface exposes no command-list endpoint either (`/session`,
//! `/config/providers`, `/event`, … — none enumerate commands), and
//! `send_slash_command` simply sends `/{name}` as prompt text for the agent to
//! parse. So the set is a property of the backend, known statically.
//!
//! # Scope
//!
//! Built-ins ONLY. Workspace skills are a separate source — the gateway merges
//! them from `scan_roles_skills_state`, and the desktop reads them from its own
//! skills store — so they must not be duplicated here.

use crate::proto::amux;

/// `/share`, `/unshare` and `/export` are deliberately absent for opencode.
/// They publish conversation content outside TeamClu; surfacing them in a team
/// chat's command picker turns a mistyped slash into data egress. They still
/// work if a user types them by hand — this table controls what we advertise,
/// not what the agent accepts.
const OPENCODE: &[(&str, &str, &str)] = &[
    ("compact", "Compact the conversation history", ""),
    ("init", "Write an AGENTS.md for this project", ""),
    ("undo", "Undo the last change", ""),
    ("redo", "Redo the last undone change", ""),
];

const CLAUDE_CODE: &[(&str, &str, &str)] = &[
    ("compact", "Compact the conversation history", ""),
    ("cost", "Show token cost for this session", ""),
];

/// Built-in commands for `agent_type`, empty for backends whose set is unknown.
///
/// Empty is the honest answer for cursor: advertising a command the backend
/// ignores is worse than advertising none, because the user gets no error —
/// the slash just lands in the prompt as literal text.
///
/// pi is empty here for a different reason: it is the one backend that can
/// enumerate its REAL command set at runtime (`get_commands` — extension
/// commands, prompt templates, pi skills), so the pi backend emits an
/// `AvailableCommands` event at attach and the per-runtime cache
/// (`set_available_commands`) carries the live list. A static entry here would
/// only ever be a stale duplicate of that.
pub fn builtin_commands(agent_type: amux::AgentType) -> Vec<amux::AcpAvailableCommand> {
    let table = match agent_type {
        amux::AgentType::Opencode => OPENCODE,
        amux::AgentType::ClaudeCode => CLAUDE_CODE,
        _ => &[][..],
    };
    table
        .iter()
        .map(
            |(name, description, input_hint)| amux::AcpAvailableCommand {
                name: (*name).to_string(),
                description: (*description).to_string(),
                input_hint: (*input_hint).to_string(),
            },
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_advertises_session_scoped_commands_only() {
        let names: Vec<_> = builtin_commands(amux::AgentType::Opencode)
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert!(names.contains(&"compact".to_string()));
        for egress in ["share", "unshare", "export"] {
            assert!(
                !names.contains(&egress.to_string()),
                "{egress} publishes conversation content outside TeamClu and must not be advertised",
            );
        }
    }

    #[test]
    fn unknown_backends_advertise_nothing() {
        // Better than a wrong guess: an unsupported slash reaches the model as
        // literal prompt text, with no error to tell the user it did nothing.
        // (pi's real list arrives at runtime via the AvailableCommands event —
        // see the fn docs — so its static entry must stay empty.)
        assert!(builtin_commands(amux::AgentType::Pi).is_empty());
        assert!(builtin_commands(amux::AgentType::Cursor).is_empty());
    }

    #[test]
    fn every_command_has_a_description() {
        for t in [amux::AgentType::Opencode, amux::AgentType::ClaudeCode] {
            for c in builtin_commands(t) {
                assert!(!c.name.is_empty());
                assert!(!c.description.is_empty(), "{} has no description", c.name);
            }
        }
    }
}

use crate::config::DaemonConfig;
use crate::proto::amux;

pub(crate) fn resolve_requested_agent_type(
    config: &DaemonConfig,
    requested: amux::AgentType,
) -> amux::AgentType {
    let has_claude = config.agents.claude_code.is_some();
    let has_opencode = config.agents.opencode.is_some();
    let has_codex = config.agents.codex.is_some();

    // When the explicitly-requested backend isn't configured, fall back to
    // whatever IS configured (preferring opencode, then claude_code, then codex).
    // If nothing is configured, stay Unknown — never assume claude.
    let fallback = || {
        if has_opencode {
            amux::AgentType::Opencode
        } else if has_claude {
            amux::AgentType::ClaudeCode
        } else if has_codex {
            amux::AgentType::Codex
        } else {
            amux::AgentType::Unknown
        }
    };

    match requested {
        amux::AgentType::Unknown => fallback(),
        amux::AgentType::ClaudeCode => {
            if has_claude {
                amux::AgentType::ClaudeCode
            } else {
                fallback()
            }
        }
        amux::AgentType::Opencode => {
            if has_opencode {
                amux::AgentType::Opencode
            } else {
                fallback()
            }
        }
        amux::AgentType::Codex => {
            if has_codex {
                amux::AgentType::Codex
            } else {
                fallback()
            }
        }
    }
}

pub(crate) fn runtime_start_initial_model_override(
    start: &crate::proto::teamclaw::RuntimeStartRequest,
) -> Option<String> {
    let model_id = start.model_id.trim();
    (!model_id.is_empty()).then(|| model_id.to_string())
}

pub(crate) fn session_message_model_override(
    message: &crate::proto::teamclaw::Message,
) -> Option<String> {
    let model_id = message.model.trim();
    (!model_id.is_empty()).then(|| model_id.to_string())
}

/// Map a backend name (as emitted by `supported_agent_type_names` and stored on
/// cron jobs) to its `amux::AgentType`. Returns `None` for unknown/empty names
/// so callers can fall back to the daemon default. Accepts the common aliases
/// for claude-code so it tolerates either wire spelling.
pub(crate) fn agent_type_from_name(name: &str) -> Option<amux::AgentType> {
    match name.trim() {
        "opencode" => Some(amux::AgentType::Opencode),
        "codex" => Some(amux::AgentType::Codex),
        "claude" | "claude_code" | "claude-code" => Some(amux::AgentType::ClaudeCode),
        _ => None,
    }
}

/// Cloud-facing default backend. Prefer opencode when present, else claude, else
/// codex, else the first entry. Returns `None` when there are no supported types
/// (caller should skip cloud advertise).
pub(crate) fn default_advertised_agent_type(supported_types: &[String]) -> Option<String> {
    if supported_types.is_empty() {
        return None;
    }
    if supported_types.iter().any(|s| s == "opencode") {
        Some("opencode".to_string())
    } else if supported_types.iter().any(|s| s == "claude") {
        Some("claude".to_string())
    } else if supported_types.iter().any(|s| s == "codex") {
        Some("codex".to_string())
    } else {
        Some(supported_types[0].clone())
    }
}

pub(crate) fn supported_agent_type_names(config: &DaemonConfig) -> Vec<String> {
    let mut names = Vec::new();
    if config.agents.claude_code.is_some() {
        names.push("claude".to_string());
    }
    if config.agents.opencode.is_some() {
        names.push("opencode".to_string());
    }
    if config.agents.codex.is_some() {
        names.push("codex".to_string());
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_config() -> DaemonConfig {
        DaemonConfig {
            actor: crate::config::ActorConfig {
                id: "dev-1".to_string(),
                name: "Mac".to_string(),
            },
            mqtt: crate::config::MqttConfig {
                broker_url: "tcp://localhost:1883".to_string(),
                username: None,
                password: None,
            },
            agents: crate::config::AgentsConfig::default(),
            transport: None,
            team_id: None,
            channels: crate::config::ChannelsConfig::default(),
            idle_runtime_timeout_secs: None,
            http: None,
        }
    }

    #[test]
    fn resolves_claude_request_to_opencode_when_only_opencode_is_configured() {
        let mut cfg = base_config();
        cfg.agents.opencode = Some(crate::config::AgentBackendConfig {
            binary: "opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::ClaudeCode),
            amux::AgentType::Opencode
        );
    }

    #[test]
    fn preserves_explicit_non_claude_request() {
        let mut cfg = base_config();
        cfg.agents.opencode = Some(crate::config::AgentBackendConfig {
            binary: "opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Opencode),
            amux::AgentType::Opencode
        );
    }

    #[test]
    fn resolves_unknown_request_to_opencode_when_only_opencode_is_configured() {
        let mut cfg = base_config();
        cfg.agents.opencode = Some(crate::config::AgentBackendConfig {
            binary: "opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Unknown),
            amux::AgentType::Opencode
        );
    }

    #[test]
    fn resolves_unknown_to_opencode_when_both_configured() {
        let mut cfg = base_config();
        cfg.agents.claude_code = Some(crate::config::AgentBackendConfig {
            binary: "claude".to_string(),
            default_flags: Vec::new(),
        });
        cfg.agents.opencode = Some(crate::config::AgentBackendConfig {
            binary: "opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });

        // opencode is the preferred default; Unknown resolves to it even when
        // claude_code is also configured.
        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Unknown),
            amux::AgentType::Opencode
        );
    }

    #[test]
    fn explicit_claude_code_request_honoured_when_both_configured() {
        let mut cfg = base_config();
        cfg.agents.claude_code = Some(crate::config::AgentBackendConfig {
            binary: "claude".to_string(),
            default_flags: Vec::new(),
        });
        cfg.agents.opencode = Some(crate::config::AgentBackendConfig {
            binary: "opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::ClaudeCode),
            amux::AgentType::ClaudeCode
        );
    }

    #[test]
    fn explicit_codex_request_honoured_when_codex_configured() {
        let mut cfg = base_config();
        cfg.agents.codex = Some(crate::config::AgentBackendConfig {
            binary: "codex".to_string(),
            default_flags: Vec::new(),
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Codex),
            amux::AgentType::Codex
        );
    }

    #[test]
    fn codex_request_reroutes_to_opencode_when_codex_absent() {
        let mut cfg = base_config();
        cfg.agents.opencode = Some(crate::config::AgentBackendConfig {
            binary: "opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Codex),
            amux::AgentType::Opencode
        );
    }

    #[test]
    fn opencode_request_reroutes_to_claude_when_opencode_absent() {
        let mut cfg = base_config();
        cfg.agents.claude_code = Some(crate::config::AgentBackendConfig {
            binary: "claude".to_string(),
            default_flags: Vec::new(),
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Opencode),
            amux::AgentType::ClaudeCode
        );
    }

    #[test]
    fn runtime_start_model_id_becomes_initial_spawn_override() {
        let start = crate::proto::teamclaw::RuntimeStartRequest {
            model_id: "opencode/deepseek-v4-flash-free".to_string(),
            ..Default::default()
        };

        assert_eq!(
            runtime_start_initial_model_override(&start).as_deref(),
            Some("opencode/deepseek-v4-flash-free")
        );
    }

    #[test]
    fn agent_type_from_name_maps_known_backends() {
        assert_eq!(
            agent_type_from_name("opencode"),
            Some(amux::AgentType::Opencode)
        );
        assert_eq!(agent_type_from_name("codex"), Some(amux::AgentType::Codex));
        assert_eq!(
            agent_type_from_name("claude"),
            Some(amux::AgentType::ClaudeCode)
        );
        // claude-code aliases tolerated for either wire spelling.
        assert_eq!(
            agent_type_from_name("claude-code"),
            Some(amux::AgentType::ClaudeCode)
        );
        assert_eq!(
            agent_type_from_name("claude_code"),
            Some(amux::AgentType::ClaudeCode)
        );
    }

    #[test]
    fn agent_type_from_name_returns_none_for_unknown_or_empty() {
        assert_eq!(agent_type_from_name(""), None);
        assert_eq!(agent_type_from_name("gpt"), None);
    }

    #[test]
    fn runtime_start_empty_model_id_has_no_initial_spawn_override() {
        let start = crate::proto::teamclaw::RuntimeStartRequest {
            model_id: "   ".to_string(),
            ..Default::default()
        };

        assert_eq!(runtime_start_initial_model_override(&start), None);
    }

    #[test]
    fn session_message_model_becomes_route_override() {
        let message = crate::proto::teamclaw::Message {
            model: "opencode/deepseek-v4-flash-free".to_string(),
            ..Default::default()
        };

        assert_eq!(
            session_message_model_override(&message).as_deref(),
            Some("opencode/deepseek-v4-flash-free")
        );
    }

    #[test]
    fn session_message_empty_model_has_no_route_override() {
        let message = crate::proto::teamclaw::Message {
            model: "   ".to_string(),
            ..Default::default()
        };

        assert_eq!(session_message_model_override(&message), None);
    }

    #[test]
    fn default_advertised_agent_type_prefers_opencode() {
        assert_eq!(
            default_advertised_agent_type(&["claude".into(), "opencode".into()]),
            Some("opencode".into())
        );
        assert_eq!(
            default_advertised_agent_type(&["claude".into(), "codex".into()]),
            Some("claude".into())
        );
        assert_eq!(default_advertised_agent_type(&[]), None);
    }

    #[test]
    fn supported_agent_type_names_empty_when_no_backends_configured() {
        assert!(supported_agent_type_names(&base_config()).is_empty());
    }

    #[test]
    fn unknown_request_stays_unknown_when_no_backends_configured() {
        assert_eq!(
            resolve_requested_agent_type(&base_config(), amux::AgentType::Unknown),
            amux::AgentType::Unknown
        );
    }

    #[test]
    fn unknown_request_resolves_to_codex_when_only_codex_configured() {
        let mut cfg = base_config();
        cfg.agents.codex = Some(crate::config::AgentBackendConfig {
            binary: "codex".to_string(),
            default_flags: Vec::new(),
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Unknown),
            amux::AgentType::Codex
        );
    }
}

use crate::config::DaemonConfig;
use crate::proto::amux;

/// Single-agent mode: opencode is the only supported backend. Any legacy
/// request (claude-code / codex) is rerouted to opencode with a log line.
/// Legacy `[agents.claude_code]` / `[agents.codex]` config sections are still
/// parsed for back-compat but no longer make those backends runnable.
pub(crate) fn resolve_requested_agent_type(
    config: &DaemonConfig,
    requested: amux::AgentType,
) -> amux::AgentType {
    if config.agents.opencode.is_none() {
        tracing::warn!(
            ?requested,
            "no [agents.opencode] configured; cannot resolve a runtime backend"
        );
        return amux::AgentType::Unknown;
    }
    match requested {
        amux::AgentType::Opencode | amux::AgentType::Unknown => amux::AgentType::Opencode,
        legacy => {
            tracing::warn!(
                requested = ?legacy,
                "requested legacy agent backend; rerouting to opencode (single-agent mode)"
            );
            amux::AgentType::Opencode
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

/// Cloud-facing default backend. Single-agent mode: opencode or nothing.
/// Returns `None` when there are no supported types (caller should skip cloud
/// advertise).
pub(crate) fn default_advertised_agent_type(supported_types: &[String]) -> Option<String> {
    supported_types
        .iter()
        .any(|s| s == "opencode")
        .then(|| "opencode".to_string())
}

/// Single-agent mode: only opencode is ever advertised. Legacy
/// `[agents.claude_code]` / `[agents.codex]` sections are accepted in config
/// files but intentionally ignored here.
pub(crate) fn supported_agent_type_names(config: &DaemonConfig) -> Vec<String> {
    if config.agents.opencode.is_some() {
        vec!["opencode".to_string()]
    } else {
        Vec::new()
    }
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
    fn legacy_requests_reroute_to_opencode_even_when_legacy_sections_present() {
        let mut cfg = base_config();
        // Back-compat: legacy sections still parse but are ignored.
        cfg.agents.claude_code = Some(crate::config::AgentBackendConfig {
            binary: "claude".to_string(),
            default_flags: Vec::new(),
        });
        cfg.agents.codex = Some(crate::config::AgentBackendConfig {
            binary: "codex".to_string(),
            default_flags: Vec::new(),
        });
        cfg.agents.opencode = Some(crate::config::AgentBackendConfig {
            binary: "opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });

        for requested in [
            amux::AgentType::Unknown,
            amux::AgentType::ClaudeCode,
            amux::AgentType::Codex,
            amux::AgentType::Opencode,
        ] {
            assert_eq!(
                resolve_requested_agent_type(&cfg, requested),
                amux::AgentType::Opencode
            );
        }
    }

    #[test]
    fn legacy_sections_alone_resolve_nothing() {
        // claude/codex config sections no longer make a backend runnable.
        let mut cfg = base_config();
        cfg.agents.claude_code = Some(crate::config::AgentBackendConfig {
            binary: "claude".to_string(),
            default_flags: Vec::new(),
        });
        cfg.agents.codex = Some(crate::config::AgentBackendConfig {
            binary: "codex".to_string(),
            default_flags: Vec::new(),
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Opencode),
            amux::AgentType::Unknown
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
    fn default_advertised_agent_type_is_opencode_or_none() {
        assert_eq!(
            default_advertised_agent_type(&["claude".into(), "opencode".into()]),
            Some("opencode".into())
        );
        // Without opencode there is nothing to advertise in single-agent mode.
        assert_eq!(
            default_advertised_agent_type(&["claude".into(), "codex".into()]),
            None
        );
        assert_eq!(default_advertised_agent_type(&[]), None);
    }

    #[test]
    fn supported_agent_type_names_is_opencode_only() {
        assert!(supported_agent_type_names(&base_config()).is_empty());

        let mut cfg = base_config();
        cfg.agents.claude_code = Some(crate::config::AgentBackendConfig {
            binary: "claude".to_string(),
            default_flags: Vec::new(),
        });
        // Legacy claude section alone advertises nothing.
        assert!(supported_agent_type_names(&cfg).is_empty());

        cfg.agents.opencode = Some(crate::config::AgentBackendConfig {
            binary: "opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });
        assert_eq!(
            supported_agent_type_names(&cfg),
            vec!["opencode".to_string()]
        );
    }

    #[test]
    fn unknown_request_stays_unknown_when_no_backends_configured() {
        assert_eq!(
            resolve_requested_agent_type(&base_config(), amux::AgentType::Unknown),
            amux::AgentType::Unknown
        );
    }
}

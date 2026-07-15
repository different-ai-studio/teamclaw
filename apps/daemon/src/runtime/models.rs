use agent_client_protocol as acp;

use crate::proto::amux;

/// OpenCode (and similar agents) expose the model picker as a session
/// `configOptions` entry with this id instead of `SessionModelState`.
pub const MODEL_CONFIG_OPTION_ID: &str = "model";

/// Translate the ACP-reported model list (from
/// `SessionModelState.available_models` in the `session/new` /
/// `session/load` response) into amux's protobuf `ModelInfo` shape used
/// over MQTT. The ACP type carries `model_id` + `name`; we map them onto
/// `id` + `display_name` respectively. The optional `description` field
/// is dropped because amux's wire schema doesn't carry it yet.
///
/// Requires the `unstable_session_model` feature on
/// `agent-client-protocol`, which `amuxd` always enables (see
/// `Cargo.toml`).
pub fn acp_models_to_proto(state: &acp::SessionModelState) -> Vec<amux::ModelInfo> {
    state
        .available_models
        .iter()
        .map(|m| amux::ModelInfo {
            id: m.model_id.0.to_string(),
            display_name: m.name.clone(),
        })
        .collect()
}

/// Resolve the model list advertised by the agent on `session/new` or
/// `session/resume`. Prefer unstable `SessionModelState`; OpenCode fills
/// `configOptions[id=model]` instead.
pub fn resolve_available_models(
    agent_type: amux::AgentType,
    model_state: Option<&acp::SessionModelState>,
    config_options: Option<&[acp::SessionConfigOption]>,
) -> Vec<amux::ModelInfo> {
    if let Some(state) = model_state {
        return acp_models_to_proto(state);
    }
    if let Some(from_config) = models_from_config_options(config_options) {
        if !from_config.is_empty() {
            return from_config;
        }
    }
    available_models_for(agent_type)
}

/// Current model id from `SessionModelState` or the `model` config option.
pub fn resolve_current_model_id(
    model_state: Option<&acp::SessionModelState>,
    config_options: Option<&[acp::SessionConfigOption]>,
) -> Option<String> {
    model_state
        .map(|s| s.current_model_id.0.to_string())
        .or_else(|| current_model_from_config_options(config_options))
}

/// Label for startup logs (`acp_models` | `acp_config_options` | `fallback`).
pub fn available_models_source_label(
    model_state: Option<&acp::SessionModelState>,
    config_options: Option<&[acp::SessionConfigOption]>,
) -> &'static str {
    if model_state.is_some() {
        "acp_models"
    } else if models_from_config_options(config_options)
        .is_some_and(|m| !m.is_empty())
    {
        "acp_config_options"
    } else {
        "fallback"
    }
}

fn current_model_from_config_options(
    config_options: Option<&[acp::SessionConfigOption]>,
) -> Option<String> {
    let opt = find_model_config_option(config_options)?;
    let acp::SessionConfigKind::Select(sel) = &opt.kind else {
        return None;
    };
    Some(sel.current_value.0.to_string())
}

fn models_from_config_options(
    config_options: Option<&[acp::SessionConfigOption]>,
) -> Option<Vec<amux::ModelInfo>> {
    let opt = find_model_config_option(config_options)?;
    let acp::SessionConfigKind::Select(sel) = &opt.kind else {
        return None;
    };
    let mut out = Vec::new();
    collect_select_options(&sel.options, &mut out);
    if out.is_empty() { None } else { Some(out) }
}

fn find_model_config_option(
    config_options: Option<&[acp::SessionConfigOption]>,
) -> Option<&acp::SessionConfigOption> {
    config_options?.iter().find(|o| o.id.0.as_ref() == MODEL_CONFIG_OPTION_ID)
}

fn collect_select_options(options: &acp::SessionConfigSelectOptions, out: &mut Vec<amux::ModelInfo>) {
    match options {
        acp::SessionConfigSelectOptions::Ungrouped(items) => {
            for item in items {
                push_select_option(out, item);
            }
        }
        acp::SessionConfigSelectOptions::Grouped(groups) => {
            for group in groups {
                for item in &group.options {
                    push_select_option(out, item);
                }
            }
        }
        _ => {}
    }
}

fn push_select_option(out: &mut Vec<amux::ModelInfo>, item: &acp::SessionConfigSelectOption) {
    let id = item.value.0.to_string();
    if id.is_empty() {
        return;
    }
    let display_name = item.name.trim();
    out.push(amux::ModelInfo {
        id,
        display_name: if display_name.is_empty() {
            item.value.0.to_string()
        } else {
            display_name.to_string()
        },
    });
}

/// Hardcoded model list used as a **fallback** when the ACP agent does
/// not advertise its models via the `unstable_session_model` capability
/// in `session/new` / `session/load`. Live runtimes prefer the
/// agent-reported list captured by `runtime::adapter::run_acp_session`
/// onto `RuntimeHandle::available_models`. This table is consulted only
/// for legacy claude-agent-acp (which doesn't fill `models`) and for
/// historical sessions reconstructed from `session_store`.
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
    fn acp_models_to_proto_maps_id_and_name() {
        let state = acp::SessionModelState::new(
            acp::ModelId::new("anthropic/claude-sonnet-4.6"),
            vec![
                acp::ModelInfo::new(
                    acp::ModelId::new("anthropic/claude-sonnet-4.6"),
                    "Claude Sonnet 4.6",
                )
                .description("balanced"),
                acp::ModelInfo::new(acp::ModelId::new("zai/glm-4.6"), "GLM-4.6"),
            ],
        );
        let out = acp_models_to_proto(&state);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "anthropic/claude-sonnet-4.6");
        assert_eq!(out[0].display_name, "Claude Sonnet 4.6");
        assert_eq!(out[1].id, "zai/glm-4.6");
        assert_eq!(out[1].display_name, "GLM-4.6");
    }

    #[test]
    fn acp_models_to_proto_empty_when_agent_reports_nothing() {
        let state = acp::SessionModelState::new(acp::ModelId::new("x"), Vec::new());
        assert!(acp_models_to_proto(&state).is_empty());
    }

    #[test]
    fn opencode_fallback_is_empty() {
        let models = available_models_for(amux::AgentType::Opencode);
        assert!(models.is_empty());
        let models = available_models_for(amux::AgentType::Codex);
        assert!(models.is_empty());
    }

    #[test]
    fn models_from_config_options_reads_model_select() {
        let opts = vec![acp::SessionConfigOption::select(
            MODEL_CONFIG_OPTION_ID,
            "Model",
            "opencode/big-pickle",
            vec![
                acp::SessionConfigSelectOption::new("opencode/big-pickle", "Big Pickle"),
                acp::SessionConfigSelectOption::new("openai/gpt-5.2", "GPT 5.2"),
            ],
        )];
        let resolved = resolve_available_models(amux::AgentType::Opencode, None, Some(&opts));
        assert_eq!(resolved.len(), 2);
        assert_eq!(resolved[0].id, "opencode/big-pickle");
        assert_eq!(resolved[0].display_name, "Big Pickle");
        assert_eq!(resolved[1].id, "openai/gpt-5.2");
        assert_eq!(
            resolve_current_model_id(None, Some(&opts)).as_deref(),
            Some("opencode/big-pickle")
        );
        assert_eq!(
            available_models_source_label(None, Some(&opts)),
            "acp_config_options"
        );
    }

    #[test]
    fn session_model_state_takes_precedence_over_config_options() {
        let state = acp::SessionModelState::new(
            acp::ModelId::new("a/b"),
            vec![acp::ModelInfo::new(acp::ModelId::new("a/b"), "B")],
        );
        let opts = vec![acp::SessionConfigOption::select(
            MODEL_CONFIG_OPTION_ID,
            "Model",
            "x/y",
            vec![acp::SessionConfigSelectOption::new("x/y", "Y")],
        )];
        let resolved =
            resolve_available_models(amux::AgentType::Opencode, Some(&state), Some(&opts));
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].id, "a/b");
        assert_eq!(available_models_source_label(Some(&state), Some(&opts)), "acp_models");
    }
}

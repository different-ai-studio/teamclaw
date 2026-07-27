use crate::agent::{AgentError, AgentHandle, AmuxSessionId};
use crate::channel_store::ChannelStore;
use std::sync::Arc;

/// Handle a session-scoped slash command (`/stop`, `/reset`, `/model`,
/// `/model <provider>/<model>`) and return the human-readable reply string.
///
/// Shared by the Discord, Feishu, and Kook gateways, which previously each
/// carried a byte-identical copy of this dispatcher. Callers are expected to
/// have already lowercased the content and filtered to known session commands;
/// an unrecognized input falls through to an "Unknown command" reply.
pub async fn dispatch_session_slash_cmd(
    agent: &Arc<dyn AgentHandle>,
    lower_content: &str,
    acp_session_id: &str,
) -> String {
    let session = acp_session_id.to_string();
    if lower_content == "/stop" {
        return match agent.cancel(&session).await {
            Ok(_) => "⏹ Stopped current turn.".to_string(),
            Err(e) => format!("⚠️ Could not stop: {e}"),
        };
    }
    if lower_content == "/reset" {
        return match agent.reset_session(&session).await {
            Ok(_) => "🔄 Session reset. Next message starts fresh.".to_string(),
            Err(e) => format!("⚠️ Could not reset: {e}"),
        };
    }
    if lower_content == "/model" {
        return match agent.list_models().await {
            Ok(models) => {
                if models.is_empty() {
                    "No models available.".to_string()
                } else {
                    let body = models
                        .iter()
                        .map(|m| format!("• `{}/{}` — {}", m.provider, m.model, m.display_name))
                        .collect::<Vec<_>>()
                        .join("\n");
                    format!("Available models:\n{body}\n\nUsage: `/model <provider>/<model>`")
                }
            }
            Err(e) => format!("⚠️ Could not list models: {e}"),
        };
    }
    if let Some(arg) = lower_content.strip_prefix("/model ") {
        let arg = arg.trim();
        let (provider, model) = match arg.split_once('/') {
            Some((p, m)) => (p, m),
            None => ("anthropic", arg),
        };
        return match agent.set_model(&session, provider, model).await {
            Ok(_) => format!(
                "✅ Switched to `{provider}/{model}`. **Note: conversation context was cleared.**"
            ),
            Err(e) => format!("⚠️ Could not switch model: {e}"),
        };
    }
    // Caller should have filtered this out.
    format!("Unknown command: {lower_content}")
}

// ── parse_slash ──────────────────────────────────────────────────────────────

/// Parse a slash command from raw message text.
/// Returns `Some((name, arg))` if text starts with `/`, else `None`.
/// `name` is lowercase. `arg` is `Some(trimmed)` only if non-empty.
pub fn parse_slash(text: &str) -> Option<(String, Option<String>)> {
    let t = text.trim();
    if !t.starts_with('/') {
        return None;
    }
    let body = &t[1..]; // strip leading '/'
    let (name, rest) = match body.split_once(' ') {
        Some((n, r)) => (n, r.trim()),
        None => (body, ""),
    };
    if name.is_empty() {
        return None; // bare "/" is not a command
    }
    let arg = if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    };
    Some((name.to_lowercase(), arg))
}

// ── MetaCommand ──────────────────────────────────────────────────────────────

enum MetaCommand {
    Help,
    Model(Option<String>),
    Sessions(Option<String>),
    Agents(Option<String>),
    Workspaces(Option<String>),
    Skills,
    Clear,
    Stop,
    Ctx(String),
}

fn parse_meta(name: &str, arg: Option<&str>) -> Option<MetaCommand> {
    match name {
        "help" => Some(MetaCommand::Help),
        "model" => Some(MetaCommand::Model(arg.map(str::to_string))),
        "sessions" => Some(MetaCommand::Sessions(arg.map(str::to_string))),
        "agents" => Some(MetaCommand::Agents(arg.map(str::to_string))),
        "workspaces" => Some(MetaCommand::Workspaces(arg.map(str::to_string))),
        "skills" => Some(MetaCommand::Skills),
        "clear" => Some(MetaCommand::Clear),
        "stop" => Some(MetaCommand::Stop),
        "ctx" => match arg {
            Some(t) if !t.is_empty() => Some(MetaCommand::Ctx(t.to_string())),
            _ => None, // missing required arg — handled by caller
        },
        _ => None,
    }
}

const GATEWAY_HELP: &str = "\
Gateway commands:
/help - Show this help
/model [name] - List or switch models
/sessions [id] - List sessions
/agents [type] - List or switch agent type
/workspaces [id] - List or switch workspace
/skills - List workspace skills
/clear - Start new session
/stop - Stop current processing
/ctx <text> - Inject context without reply";

// ── dispatch ─────────────────────────────────────────────────────────────────

/// Dispatch a slash command. Two-layer priority:
/// 1. agent-advertised commands (advertised via `available_commands`) take priority.
/// 2. Gateway meta-commands are the fallback.
///
/// Calls `reply` once with the response string.
/// Returns `Ok(true)` if handled, `Ok(false)` if the command name was unknown.
pub async fn dispatch<A, S>(
    name: &str,
    arg: Option<&str>,
    agent: &A,
    _store: &S,
    session: &AmuxSessionId,
    reply: impl Fn(String) + Send,
) -> Result<bool, AgentError>
where
    A: AgentHandle + Send + Sync + ?Sized,
    S: ChannelStore + Send + Sync + ?Sized,
{
    // 1. agent-advertised commands take priority.
    let agent_cmds = agent.available_commands(session).await?;
    if agent_cmds.iter().any(|c| c.name.to_lowercase() == name) {
        let outcome = agent.send_slash_command(session, name, arg).await?;
        reply(outcome.reply_text);
        return Ok(true);
    }

    // 2. Gateway meta-commands: /ctx needs its arg check before parse_meta.
    if name == "ctx" && arg.map(|a| a.is_empty()).unwrap_or(true) {
        reply("Usage: /ctx <text>".to_string());
        return Ok(true);
    }

    let Some(meta) = parse_meta(name, arg) else {
        return Ok(false);
    };

    let response = match meta {
        MetaCommand::Help => {
            let mut text = GATEWAY_HELP.to_string();
            if !agent_cmds.is_empty() {
                text.push_str("\n\nAgent commands:");
                for cmd in &agent_cmds {
                    match &cmd.input_hint {
                        Some(hint) => text
                            .push_str(&format!("\n/{} <{}> - {}", cmd.name, hint, cmd.description)),
                        None => text.push_str(&format!("\n/{} - {}", cmd.name, cmd.description)),
                    }
                }
            }
            text
        }

        MetaCommand::Model(None) => {
            let models = agent.list_models().await?;
            if models.is_empty() {
                "No models available.".to_string()
            } else {
                let lines: Vec<String> = models
                    .iter()
                    .map(|m| format!("  {}/{}", m.provider, m.model))
                    .collect();
                format!("Models:\n{}", lines.join("\n"))
            }
        }
        MetaCommand::Model(Some(name_arg)) => {
            let (provider, model) = match name_arg.split_once('/') {
                Some((p, m)) => (p.to_string(), m.to_string()),
                None => ("anthropic".to_string(), name_arg.clone()),
            };
            agent.set_model(session, &provider, &model).await?;
            format!("Model set: {}/{}", provider, model)
        }

        MetaCommand::Sessions(None) => {
            let sessions = agent.list_sessions(session).await?;
            if sessions.is_empty() {
                "No sessions.".to_string()
            } else {
                let lines: Vec<String> = sessions
                    .iter()
                    .map(|(id, cur)| {
                        if *cur {
                            format!("* {} (current)", id)
                        } else {
                            format!("  {}", id)
                        }
                    })
                    .collect();
                format!("Sessions:\n{}", lines.join("\n"))
            }
        }
        MetaCommand::Sessions(Some(_id)) => {
            "Session switching is not yet supported. Use /sessions to list sessions.".to_string()
        }

        MetaCommand::Agents(None) => {
            let agents = agent.list_agents(session).await?;
            let lines: Vec<String> = agents
                .iter()
                .map(|a| {
                    if a.is_current {
                        format!("* {} (current)", a.agent_type)
                    } else {
                        format!("  {}", a.agent_type)
                    }
                })
                .collect();
            format!("Agents:\n{}", lines.join("\n"))
        }
        MetaCommand::Agents(Some(agent_type)) => {
            agent.set_agent(session, &agent_type).await?;
            format!("Agent set: {}", agent_type)
        }

        MetaCommand::Workspaces(None) => {
            let workspaces = agent.list_workspaces(session).await?;
            if workspaces.is_empty() {
                "No workspaces.".to_string()
            } else {
                let lines: Vec<String> = workspaces
                    .iter()
                    .map(|w| {
                        if w.is_current {
                            format!("* {} — {} (current)", w.workspace_id, w.display_name)
                        } else {
                            format!("  {} — {}", w.workspace_id, w.display_name)
                        }
                    })
                    .collect();
                format!("Workspaces:\n{}", lines.join("\n"))
            }
        }
        MetaCommand::Workspaces(Some(ws_id)) => {
            agent.set_workspace(session, &ws_id).await?;
            format!("Workspace: {}", ws_id)
        }

        MetaCommand::Skills => {
            let skills = agent.list_skills(session).await?;
            if skills.is_empty() {
                "No workspace skills found.".to_string()
            } else {
                let lines: Vec<String> = skills
                    .iter()
                    .map(|(name, desc)| format!("/{} - {}", name, desc))
                    .collect();
                format!("Skills:\n{}", lines.join("\n"))
            }
        }

        MetaCommand::Clear => {
            agent.reset_session(session).await?;
            "Session cleared.".to_string()
        }

        MetaCommand::Stop => match agent.cancel(session).await {
            Ok(_) => "Stopped.".to_string(),
            Err(AgentError::NotFound(_)) => "Nothing running.".to_string(),
            Err(AgentError::Send(ref _e)) => "Nothing running.".to_string(),
            Err(e) => return Err(e),
        },

        MetaCommand::Ctx(text) => {
            agent.inject_context(session, "user", &text).await?;
            "Context injected.".to_string()
        }
    };

    reply(response);
    Ok(true)
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{
        AgentCommand, AgentError, AgentHandle, AgentInfo, AmuxSessionId, ModelInfo, TurnOutcome,
        WorkspaceInfo,
    };
    use crate::channel_store::{AttachmentRecord, ChannelStore, EnsureSessionOutcome, StoreError};
    use async_trait::async_trait;
    use std::sync::Mutex;

    // ── MockStore ────────────────────────────────────────────────────────────

    struct MockStore;

    #[async_trait]
    impl ChannelStore for MockStore {
        async fn ensure_external_actor(
            &self,
            _team_id: &str,
            _source: &str,
            _source_id: &str,
            _display_name: &str,
        ) -> Result<String, StoreError> {
            Ok("actor-1".to_string())
        }

        async fn ensure_session(
            &self,
            _team_id: &str,
            _binding: &str,
            _title: &str,
            _primary_agent_actor_id: &str,
            _owner_member_actor_ids: &[String],
            _participant_actor_ids: &[String],
        ) -> Result<EnsureSessionOutcome, StoreError> {
            Ok(EnsureSessionOutcome {
                session_id: "sess-1".to_string(),
                acp_session_id: "agent-1".to_string(),
                created: true,
            })
        }

        async fn record_message(
            &self,
            _session_id: &str,
            _sender_actor_id: &str,
            _content: &str,
            _external_message_id: Option<&str>,
        ) -> Result<String, StoreError> {
            Ok("msg-1".to_string())
        }

        async fn record_agent_reply(
            &self,
            _session_id: &str,
            _sender_actor_id: &str,
            _content: &str,
            _external_message_id: Option<&str>,
        ) -> Result<String, StoreError> {
            Ok("reply-1".to_string())
        }

        async fn record_message_with_attachments(
            &self,
            _session_id: &str,
            _sender_actor_id: &str,
            _content: &str,
            _external_message_id: Option<&str>,
            _attachments: Vec<AttachmentRecord>,
        ) -> Result<String, StoreError> {
            Ok("msg-1".to_string())
        }

        async fn upload_attachment(
            &self,
            _bucket_path: &str,
            _bytes: Vec<u8>,
            _mime: &str,
        ) -> Result<String, StoreError> {
            Ok("path".to_string())
        }

        async fn add_participant(
            &self,
            _session_id: &str,
            _actor_id: &str,
        ) -> Result<(), StoreError> {
            Ok(())
        }
    }

    // ── MockAgent ──────────────────────────────────────────────────────────────

    struct MockAgent {
        agent_commands: Vec<AgentCommand>,
        injected: Mutex<Vec<String>>,
        reset_called: Mutex<bool>,
    }

    impl MockAgent {
        fn new() -> Self {
            Self {
                agent_commands: vec![],
                injected: Mutex::new(vec![]),
                reset_called: Mutex::new(false),
            }
        }

        fn with_agent_commands(cmds: Vec<AgentCommand>) -> Self {
            Self {
                agent_commands: cmds,
                injected: Mutex::new(vec![]),
                reset_called: Mutex::new(false),
            }
        }
    }

    #[async_trait]
    impl AgentHandle for MockAgent {
        async fn create_session(
            &self,
            _team_id: &str,
            _binding: &str,
            _title: &str,
        ) -> Result<AmuxSessionId, AgentError> {
            Ok("sess-1".to_string())
        }

        async fn send_prompt(
            &self,
            _session: &AmuxSessionId,
            _sender_display: &str,
            _text: &str,
        ) -> Result<TurnOutcome, AgentError> {
            Ok(TurnOutcome {
                reply_text: "prompt response".to_string(),
                completed: true,
            })
        }

        async fn inject_context(
            &self,
            _session: &AmuxSessionId,
            _sender_display: &str,
            text: &str,
        ) -> Result<(), AgentError> {
            self.injected.lock().unwrap().push(text.to_string());
            Ok(())
        }

        async fn cancel(&self, _session: &AmuxSessionId) -> Result<(), AgentError> {
            Ok(())
        }

        async fn reset_session(&self, _session: &AmuxSessionId) -> Result<(), AgentError> {
            *self.reset_called.lock().unwrap() = true;
            Ok(())
        }

        async fn list_models(&self) -> Result<Vec<ModelInfo>, AgentError> {
            Ok(vec![
                ModelInfo {
                    provider: "anthropic".to_string(),
                    model: "claude-3-5-sonnet".to_string(),
                    display_name: "Claude 3.5 Sonnet".to_string(),
                },
                ModelInfo {
                    provider: "openai".to_string(),
                    model: "gpt-4o".to_string(),
                    display_name: "GPT-4o".to_string(),
                },
            ])
        }

        async fn set_model(
            &self,
            _session: &AmuxSessionId,
            _provider: &str,
            _model: &str,
        ) -> Result<(), AgentError> {
            Ok(())
        }

        async fn available_commands(
            &self,
            _session: &AmuxSessionId,
        ) -> Result<Vec<AgentCommand>, AgentError> {
            Ok(self.agent_commands.clone())
        }

        async fn send_slash_command(
            &self,
            _session: &AmuxSessionId,
            name: &str,
            _input: Option<&str>,
        ) -> Result<TurnOutcome, AgentError> {
            Ok(TurnOutcome {
                reply_text: format!("agent handled: {}", name),
                completed: true,
            })
        }

        async fn list_sessions(
            &self,
            active_session: &AmuxSessionId,
        ) -> Result<Vec<(AmuxSessionId, bool)>, AgentError> {
            Ok(vec![
                (active_session.clone(), true),
                ("sess-old".to_string(), false),
            ])
        }

        async fn list_agents(
            &self,
            _session: &AmuxSessionId,
        ) -> Result<Vec<AgentInfo>, AgentError> {
            Ok(vec![
                AgentInfo {
                    agent_type: "opencode".to_string(),
                    is_current: true,
                },
                AgentInfo {
                    agent_type: "claude".to_string(),
                    is_current: false,
                },
            ])
        }

        async fn set_agent(
            &self,
            _session: &AmuxSessionId,
            _agent_type: &str,
        ) -> Result<(), AgentError> {
            Ok(())
        }

        async fn list_workspaces(
            &self,
            _session: &AmuxSessionId,
        ) -> Result<Vec<WorkspaceInfo>, AgentError> {
            Ok(vec![
                WorkspaceInfo {
                    workspace_id: "ws-1".to_string(),
                    display_name: "Main".to_string(),
                    is_current: true,
                },
                WorkspaceInfo {
                    workspace_id: "ws-2".to_string(),
                    display_name: "Other".to_string(),
                    is_current: false,
                },
            ])
        }

        async fn set_workspace(
            &self,
            _session: &AmuxSessionId,
            _workspace_id: &str,
        ) -> Result<(), AgentError> {
            Ok(())
        }
        async fn list_skills(
            &self,
            _session: &AmuxSessionId,
        ) -> Result<Vec<(String, String)>, AgentError> {
            Ok(vec![("my-skill".to_string(), "A test skill".to_string())])
        }
    }

    // helper to run dispatch and capture reply
    async fn run_dispatch(
        agent: &MockAgent,
        name: &str,
        arg: Option<&str>,
    ) -> (Result<bool, AgentError>, Option<String>) {
        let store = MockStore;
        let session = "test-session".to_string();
        let reply_capture: Mutex<Option<String>> = Mutex::new(None);
        let result = dispatch(name, arg, agent, &store, &session, |s| {
            *reply_capture.lock().unwrap() = Some(s);
        })
        .await;
        let captured = reply_capture.into_inner().unwrap();
        (result, captured)
    }

    // ── parse_slash tests ────────────────────────────────────────────────────

    #[test]
    fn parse_slash_basic() {
        let result = parse_slash("/help");
        assert_eq!(result, Some(("help".to_string(), None)));
    }

    #[test]
    fn parse_slash_with_arg() {
        let result = parse_slash("/model gpt-4");
        assert_eq!(
            result,
            Some(("model".to_string(), Some("gpt-4".to_string())))
        );
    }

    #[test]
    fn parse_slash_lowercases_name() {
        let result = parse_slash("/STOP");
        assert_eq!(result, Some(("stop".to_string(), None)));
    }

    #[test]
    fn parse_slash_trims_whitespace() {
        let result = parse_slash("  /help  ");
        assert_eq!(result, Some(("help".to_string(), None)));
    }

    #[test]
    fn parse_slash_bare_slash_is_none() {
        assert_eq!(parse_slash("/"), None);
        assert_eq!(parse_slash("/  "), None);
    }

    #[test]
    fn parse_slash_non_command_is_none() {
        assert_eq!(parse_slash("hello"), None);
        assert_eq!(parse_slash(""), None);
    }

    #[test]
    fn parse_slash_multiword_arg() {
        let result = parse_slash("/ctx inject this whole sentence");
        assert_eq!(
            result,
            Some((
                "ctx".to_string(),
                Some("inject this whole sentence".to_string())
            ))
        );
    }

    // ── dispatch tests ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn help_returns_all_commands() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "help", None).await;
        assert!(result.unwrap());
        let text = reply.unwrap();
        assert!(text.contains("/help"));
        assert!(text.contains("/model"));
        assert!(text.contains("/clear"));
        assert!(text.contains("/ctx"));
    }

    #[tokio::test]
    async fn model_list_no_arg() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "model", None).await;
        assert!(result.unwrap());
        let text = reply.unwrap();
        assert!(text.contains("anthropic/claude-3-5-sonnet"));
    }

    #[tokio::test]
    async fn model_set_with_arg() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "model", Some("anthropic/opus")).await;
        assert!(result.unwrap());
        assert!(reply.unwrap().contains("Model set"));
    }

    #[tokio::test]
    async fn clear_resets_session() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "clear", None).await;
        assert!(result.unwrap());
        assert_eq!(reply.unwrap(), "Session cleared.");
        assert!(*agent.reset_called.lock().unwrap());
    }

    #[tokio::test]
    async fn stop_when_running() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "stop", None).await;
        assert!(result.unwrap());
        assert_eq!(reply.unwrap(), "Stopped.");
    }

    #[tokio::test]
    async fn ctx_missing_arg_shows_usage() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "ctx", None).await;
        assert!(result.unwrap());
        assert!(reply.unwrap().contains("Usage:"));
    }

    #[tokio::test]
    async fn ctx_with_arg_injects_context() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "ctx", Some("some background")).await;
        assert!(result.unwrap());
        assert_eq!(reply.unwrap(), "Context injected.");
        assert_eq!(
            agent.injected.lock().unwrap().as_slice(),
            &["some background"]
        );
    }

    #[tokio::test]
    async fn unknown_command_returns_false() {
        let agent = MockAgent::new();
        let (result, _reply) = run_dispatch(&agent, "foobar", None).await;
        assert!(!result.unwrap());
    }

    #[tokio::test]
    async fn agent_command_takes_priority_over_meta() {
        let agent = MockAgent::with_agent_commands(vec![AgentCommand {
            name: "clear".to_string(),
            description: "agent clear".to_string(),
            input_hint: None,
        }]);
        let (result, reply) = run_dispatch(&agent, "clear", None).await;
        assert!(result.unwrap());
        let text = reply.unwrap();
        // Should be the agent response, NOT "Session cleared."
        assert_eq!(text, "agent handled: clear");
        assert!(!*agent.reset_called.lock().unwrap());
    }

    // ── dispatch_session_slash_cmd (shared by Discord/Feishu/Kook) ────────────

    fn shared_agent() -> Arc<dyn AgentHandle> {
        Arc::new(MockAgent::new())
    }

    #[tokio::test]
    async fn session_slash_stop_and_reset() {
        let agent = shared_agent();
        assert_eq!(
            dispatch_session_slash_cmd(&agent, "/stop", "s1").await,
            "⏹ Stopped current turn."
        );
        assert_eq!(
            dispatch_session_slash_cmd(&agent, "/reset", "s1").await,
            "🔄 Session reset. Next message starts fresh."
        );
    }

    #[tokio::test]
    async fn session_slash_model_lists_available() {
        let agent = shared_agent();
        let reply = dispatch_session_slash_cmd(&agent, "/model", "s1").await;
        assert!(reply.starts_with("Available models:"));
        assert!(reply.contains("`anthropic/claude-3-5-sonnet`"));
        assert!(reply.contains("`openai/gpt-4o`"));
        assert!(reply.contains("Usage: `/model <provider>/<model>`"));
    }

    #[tokio::test]
    async fn session_slash_model_switch_parses_provider_and_model() {
        let agent = shared_agent();
        assert_eq!(
            dispatch_session_slash_cmd(&agent, "/model openai/gpt-4o", "s1").await,
            "✅ Switched to `openai/gpt-4o`. **Note: conversation context was cleared.**"
        );
        // No slash → defaults the provider to anthropic.
        assert_eq!(
            dispatch_session_slash_cmd(&agent, "/model haiku", "s1").await,
            "✅ Switched to `anthropic/haiku`. **Note: conversation context was cleared.**"
        );
    }

    #[tokio::test]
    async fn session_slash_unknown_falls_through() {
        let agent = shared_agent();
        assert_eq!(
            dispatch_session_slash_cmd(&agent, "/bogus", "s1").await,
            "Unknown command: /bogus"
        );
    }
}

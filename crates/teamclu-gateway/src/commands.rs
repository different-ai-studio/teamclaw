use crate::agent::{AgentError, AgentHandle, AmuxSessionId, ModelInfo, SessionInfo};
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
        return match agent.list_models(&session).await {
            Ok(models) => {
                if models.is_empty() {
                    "No models available.".to_string()
                } else {
                    let current = agent.current_model(&session).await.ok().flatten();
                    let shown = models.len().min(MODEL_LIST_LIMIT);
                    let body = models
                        .iter()
                        .take(shown)
                        .map(|m| {
                            let id = format!("{}/{}", m.provider, m.model);
                            let mark = if current.as_deref() == Some(id.as_str()) {
                                " ← current"
                            } else {
                                ""
                            };
                            format!("• `{id}` — {}{mark}", m.display_name)
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    let more = if models.len() > shown {
                        format!("\n• … and {} more", models.len() - shown)
                    } else {
                        String::new()
                    };
                    format!("Available models:\n{body}{more}\n\nUsage: `/model <provider>/<model>`")
                }
            }
            Err(e) => format!("⚠️ Could not list models: {e}"),
        };
    }
    if let Some(arg) = lower_content.strip_prefix("/model ") {
        let arg = arg.trim();
        let (provider, model) = match arg.split_once('/') {
            Some((p, m)) => (p.to_string(), m.to_string()),
            // Bare name — resolve against the live catalog instead of
            // assuming anthropic, which is wrong for any other backend.
            None => match resolve_bare_model(agent.as_ref(), &session, arg).await {
                Ok(Ok(pair)) => pair,
                Ok(Err(msg)) => return msg,
                Err(e) => return format!("⚠️ Could not switch model: {e}"),
            },
        };
        let (provider, model) = (provider.as_str(), model.as_str());
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
    Workspace(Option<String>),
    Skills,
    New,
    Stop,
    Ctx(String),
}

fn parse_meta(name: &str, arg: Option<&str>) -> Option<MetaCommand> {
    match name {
        "help" => Some(MetaCommand::Help),
        "model" => Some(MetaCommand::Model(arg.map(str::to_string))),
        "sessions" => Some(MetaCommand::Sessions(arg.map(str::to_string))),
        // `/workspaces` stays accepted: it is what the command was called
        // before, and rejecting it would just look broken to anyone who
        // learned the old name.
        "workspace" | "workspaces" => Some(MetaCommand::Workspace(arg.map(str::to_string))),
        "skills" => Some(MetaCommand::Skills),
        // `/clear` is gone rather than aliased: it named the wrong operation.
        // Nothing is cleared — the old session keeps every message, it just
        // stops being this chat's current one, and `/sessions <n>` can go back
        // to it. `/new` says that; `/clear` said the opposite.
        "new" => Some(MetaCommand::New),
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
/sessions [n] - List this chat's sessions, or continue #n
/workspace [n] - List workspaces, or make #n this bot's default
/skills - List workspace skills
/new - Start a new session (the current one stays in /sessions)
/stop - Stop current processing
/ctx <text> - Inject context without reply";

/// What a session shows up as in a `/sessions` listing. Titles are generated
/// from the chat itself ("WeCom DM: LiangLiang", plus a detach timestamp on
/// older generations), so an empty one means the row was written by something
/// that skipped the title — fall back to the id rather than an empty bullet.
fn session_label(s: &SessionInfo) -> String {
    if s.title.trim().is_empty() {
        s.session_id.clone()
    } else {
        s.title.clone()
    }
}

/// How many catalog entries a `/model` listing shows. A real backend catalog
/// runs to hundreds of models across every configured provider; a chat bubble
/// that long is unreadable, so we show the most relevant prefix (the daemon
/// orders current-then-recent-first) and say how many were elided.
pub(crate) const MODEL_LIST_LIMIT: usize = 25;

/// Resolve a bare `/model <name>` (no provider segment) against the live
/// catalog. `Ok(Err(msg))` is a user-facing explanation, not a failure.
#[allow(clippy::type_complexity)]
pub(crate) async fn resolve_bare_model<A>(
    agent: &A,
    session: &AmuxSessionId,
    name: &str,
) -> Result<Result<(String, String), String>, AgentError>
where
    A: AgentHandle + Send + Sync + ?Sized,
{
    let models = agent.list_models(session).await?;
    let matches: Vec<&ModelInfo> = models.iter().filter(|m| m.model == name).collect();
    Ok(match matches.as_slice() {
        [one] => Ok((one.provider.clone(), one.model.clone())),
        [] => Err(format!(
            "Unknown model: {name}. Use /model to list what this workspace offers, \
             or give the full id: /model <provider>/<model>."
        )),
        many => Err(format!(
            "Ambiguous model: {name} is offered by {}. Use the full id: /model <provider>/{name}.",
            many.iter()
                .map(|m| m.provider.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    })
}

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
            let models = agent.list_models(session).await?;
            let current = agent.current_model(session).await?;
            if models.is_empty() {
                match current {
                    Some(cur) => format!("Current model: {cur}\n(Model catalog unavailable.)"),
                    None => "No models available.".to_string(),
                }
            } else {
                let shown = models.len().min(MODEL_LIST_LIMIT);
                let mut listed_current = false;
                let lines: Vec<String> = models
                    .iter()
                    .take(shown)
                    .map(|m| {
                        let id = format!("{}/{}", m.provider, m.model);
                        if current.as_deref() == Some(id.as_str()) {
                            listed_current = true;
                            format!("* {id} (current)")
                        } else {
                            format!("  {id}")
                        }
                    })
                    .collect();
                let mut text = String::new();
                // The current model can sit outside the shown prefix, or be
                // absent from the catalog entirely (provider logged out, model
                // retired) — either way it still has to be reported.
                if let (Some(cur), false) = (current.as_deref(), listed_current) {
                    text.push_str(&format!("Current model: {cur}\n\n"));
                }
                text.push_str(&format!("Models:\n{}", lines.join("\n")));
                if models.len() > shown {
                    text.push_str(&format!("\n  … and {} more", models.len() - shown));
                }
                text.push_str("\n\nUsage: /model <provider>/<model>");
                text
            }
        }
        MetaCommand::Model(Some(name_arg)) => {
            let (provider, model) = match name_arg.split_once('/') {
                Some((p, m)) => (p.to_string(), m.to_string()),
                // A bare name is resolved against the live catalog. It used to
                // be assumed to be anthropic's, which is wrong on any device
                // whose backend runs some other provider.
                None => match resolve_bare_model(agent, session, &name_arg).await? {
                    Ok(pair) => pair,
                    Err(msg) => {
                        reply(msg);
                        return Ok(true);
                    }
                },
            };
            agent.set_model(session, &provider, &model).await?;
            format!("Model set: {}/{}", provider, model)
        }

        MetaCommand::Sessions(None) => {
            let sessions = agent.list_sessions(session).await?;
            if sessions.is_empty() {
                "No sessions.".to_string()
            } else {
                // Numbered and titled, so the reply is usable as the input for
                // the next command. It used to print raw ACP hex ids, which
                // name nothing a chat user can recognise and cannot be typed
                // back in.
                let lines: Vec<String> = sessions
                    .iter()
                    .enumerate()
                    .map(|(i, s)| {
                        let marker = if s.is_current { " (current)" } else { "" };
                        format!("{}. {}{}", i + 1, session_label(s), marker)
                    })
                    .collect();
                format!(
                    "Sessions:\n{}\n\nUsage: /sessions <number> — continue that conversation",
                    lines.join("\n")
                )
            }
        }
        MetaCommand::Sessions(Some(arg)) => {
            let arg = arg.trim();
            let sessions = agent.list_sessions(session).await?;
            // A bare number picks from the list just printed; anything else is
            // taken as a session id, which is what the reply's own ids are.
            let target = match arg.parse::<usize>() {
                Ok(n) => match n.checked_sub(1).and_then(|i| sessions.get(i)) {
                    Some(s) => s.session_id.clone(),
                    None => {
                        reply(format!(
                            "No session #{n}. Use /sessions to list them ({} available).",
                            sessions.len()
                        ));
                        return Ok(true);
                    }
                },
                Err(_) => arg.to_string(),
            };
            let already_current = sessions
                .iter()
                .any(|s| s.session_id == target && s.is_current);
            if already_current {
                "Already in this session.".to_string()
            } else if agent.switch_session(session, &target).await? {
                let title = sessions
                    .iter()
                    .find(|s| s.session_id == target)
                    .map(session_label)
                    .unwrap_or_else(|| target.clone());
                format!("Switched to: {title}\nThe next message continues that conversation.")
            } else {
                "Cannot switch to that session — it is not one of this chat's. \
                 Use /sessions to list them."
                    .to_string()
            }
        }

        MetaCommand::Workspace(None) => {
            let workspaces = agent.list_workspaces(session).await?;
            if workspaces.is_empty() {
                "No workspaces.".to_string()
            } else {
                // Numbered so the reply doubles as the input for the next
                // command: a chat user should not have to retype a UUID.
                let lines: Vec<String> = workspaces
                    .iter()
                    .enumerate()
                    .map(|(i, w)| {
                        let marker = if w.is_current { " (current)" } else { "" };
                        format!("{}. {}{}", i + 1, w.display_name, marker)
                    })
                    .collect();
                format!(
                    "Workspaces:\n{}\n\nUsage: /workspace <number> — set this bot's default",
                    lines.join("\n")
                )
            }
        }
        MetaCommand::Workspace(Some(arg)) => {
            let arg = arg.trim();
            // A bare number picks from the list just printed; anything else is
            // taken as a workspace id so the old form keeps working.
            let ws_id = match arg.parse::<usize>() {
                Ok(n) => {
                    let workspaces = agent.list_workspaces(session).await?;
                    match n.checked_sub(1).and_then(|i| workspaces.get(i)) {
                        Some(w) => w.workspace_id.clone(),
                        None => {
                            reply(format!(
                                "No workspace #{n}. Use /workspace to list them ({} available).",
                                workspaces.len()
                            ));
                            return Ok(true);
                        }
                    }
                }
                Err(_) => arg.to_string(),
            };
            agent.set_workspace(session, &ws_id).await?;
            format!("Default workspace set: {ws_id}")
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

        MetaCommand::New => {
            // Only claim a new session when the chat was really detached. A
            // backend that cannot detach (endpoint missing, unknown id) leaves
            // the next message landing in the SAME session — announcing a fresh
            // conversation there is a lie the user only discovers when the agent
            // keeps its memory.
            if agent.start_new_session(session).await? {
                "Started a new session. The next message begins a fresh conversation \
                 (/sessions to go back to this one)."
                    .to_string()
            } else {
                "Could not start a new session — this chat is still on the same one. \
                 The agent's context was cleared, but its history is unchanged."
                    .to_string()
            }
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
        AgentCommand, AgentError, AgentHandle, AmuxSessionId, ModelInfo, TurnOutcome, WorkspaceInfo,
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
        current_model: Option<String>,
        workspace_set_to: Mutex<Option<String>>,
        new_session_called: Mutex<bool>,
        /// What `start_new_session` reports back: whether the chat was really
        /// detached. Default `true` (the working backend); a test flips it to
        /// model a backend that cannot detach.
        new_session_detaches: bool,
        switched_to: Mutex<Option<String>>,
    }

    impl MockAgent {
        fn new() -> Self {
            Self {
                agent_commands: vec![],
                injected: Mutex::new(vec![]),
                reset_called: Mutex::new(false),
                current_model: None,
                workspace_set_to: Mutex::new(None),
                new_session_called: Mutex::new(false),
                new_session_detaches: true,
                switched_to: Mutex::new(None),
            }
        }

        fn with_agent_commands(cmds: Vec<AgentCommand>) -> Self {
            Self {
                agent_commands: cmds,
                injected: Mutex::new(vec![]),
                reset_called: Mutex::new(false),
                current_model: None,
                workspace_set_to: Mutex::new(None),
                new_session_called: Mutex::new(false),
                new_session_detaches: true,
                switched_to: Mutex::new(None),
            }
        }

        fn with_current_model(model: &str) -> Self {
            Self {
                current_model: Some(model.to_string()),
                ..Self::new()
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

        async fn start_new_session(&self, _session: &AmuxSessionId) -> Result<bool, AgentError> {
            *self.new_session_called.lock().unwrap() = true;
            Ok(self.new_session_detaches)
        }

        async fn list_models(
            &self,
            _session: &AmuxSessionId,
        ) -> Result<Vec<ModelInfo>, AgentError> {
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

        async fn current_model(
            &self,
            _session: &AmuxSessionId,
        ) -> Result<Option<String>, AgentError> {
            Ok(self.current_model.clone())
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
            _active_session: &AmuxSessionId,
        ) -> Result<Vec<SessionInfo>, AgentError> {
            Ok(vec![
                SessionInfo {
                    session_id: "sess-now".to_string(),
                    title: "WeCom DM: LiangLiang".to_string(),
                    is_current: true,
                },
                SessionInfo {
                    session_id: "sess-old".to_string(),
                    title: "WeCom DM: LiangLiang (2026-07-26 09:12)".to_string(),
                    is_current: false,
                },
            ])
        }

        async fn switch_session(
            &self,
            _active_session: &AmuxSessionId,
            target_session_id: &str,
        ) -> Result<bool, AgentError> {
            // Mirrors the real handle: a target outside this chat's own list is
            // declined rather than silently accepted.
            if target_session_id == "sess-old" || target_session_id == "sess-now" {
                *self.switched_to.lock().unwrap() = Some(target_session_id.to_string());
                Ok(true)
            } else {
                Ok(false)
            }
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
            workspace_id: &str,
        ) -> Result<(), AgentError> {
            *self.workspace_set_to.lock().unwrap() = Some(workspace_id.to_string());
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
        assert!(text.contains("/new"));
        assert!(text.contains("/ctx"));
        // /agents was dropped: opencode is the only backend, so it always
        // listed exactly one entry.
        assert!(!text.contains("/agents"), "got {text}");
    }

    #[tokio::test]
    async fn agents_is_no_longer_a_command() {
        let agent = MockAgent::new();
        let (result, _) = run_dispatch(&agent, "agents", None).await;
        assert!(!result.unwrap(), "/agents must fall through as unknown");
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
    async fn model_list_marks_the_current_model() {
        let agent = MockAgent::with_current_model("openai/gpt-4o");
        let (_, reply) = run_dispatch(&agent, "model", None).await;
        let text = reply.unwrap();
        assert!(text.contains("* openai/gpt-4o (current)"), "got {text}");
        // Already marked inline — no separate "Current model:" header.
        assert!(!text.contains("Current model:"), "got {text}");
    }

    #[tokio::test]
    async fn model_list_reports_a_current_model_missing_from_the_catalog() {
        // Provider logged out / model retired: the catalog no longer offers it,
        // but the session is still running on it.
        let agent = MockAgent::with_current_model("opencode/big-pickle");
        let (_, reply) = run_dispatch(&agent, "model", None).await;
        let text = reply.unwrap();
        assert!(
            text.starts_with("Current model: opencode/big-pickle"),
            "got {text}"
        );
    }

    #[tokio::test]
    async fn model_set_with_arg() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "model", Some("anthropic/opus")).await;
        assert!(result.unwrap());
        assert!(reply.unwrap().contains("Model set"));
    }

    #[tokio::test]
    async fn workspace_list_is_numbered_for_reuse_as_input() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "workspace", None).await;
        assert!(result.unwrap());
        let text = reply.unwrap();
        assert!(text.contains("1. Main (current)"), "got {text}");
        assert!(text.contains("2. Other"), "got {text}");
        // The UUID is what /workspace <n> spares the user from typing.
        assert!(!text.contains("ws-1"), "got {text}");
        assert!(text.contains("/workspace <number>"), "got {text}");
    }

    #[tokio::test]
    async fn workspace_number_selects_that_row() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "workspace", Some("2")).await;
        assert!(result.unwrap());
        assert_eq!(
            agent.workspace_set_to.lock().unwrap().as_deref(),
            Some("ws-2")
        );
        assert!(reply.unwrap().contains("ws-2"));
    }

    #[tokio::test]
    async fn workspace_number_out_of_range_explains_instead_of_switching() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "workspace", Some("9")).await;
        assert!(result.unwrap());
        assert!(agent.workspace_set_to.lock().unwrap().is_none());
        assert!(reply.unwrap().contains("No workspace #9"));
    }

    #[tokio::test]
    async fn workspace_still_accepts_a_raw_id() {
        let agent = MockAgent::new();
        let (_, _) = run_dispatch(&agent, "workspace", Some("ws-2")).await;
        assert_eq!(
            agent.workspace_set_to.lock().unwrap().as_deref(),
            Some("ws-2")
        );
    }

    #[tokio::test]
    async fn workspaces_remains_an_alias_for_the_renamed_command() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "workspaces", None).await;
        assert!(result.unwrap());
        assert!(reply.unwrap().starts_with("Workspaces:"));
    }

    #[tokio::test]
    async fn new_starts_a_new_session_rather_than_only_resetting_the_runtime() {
        // This used to be `/clear`, which called reset_session: that swaps the
        // runtime but keeps the same session row — the reply claimed something
        // the user could not observe anywhere.
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "new", None).await;
        assert!(result.unwrap());
        assert!(*agent.new_session_called.lock().unwrap());
        assert!(
            !*agent.reset_called.lock().unwrap(),
            "/new must not stop at a runtime reset"
        );
        assert!(reply.unwrap().starts_with("Started a new session."));
    }

    #[tokio::test]
    async fn new_says_so_when_the_backend_could_not_detach_the_chat() {
        // The failure that shipped: a backend without the detach endpoint left
        // the chat on the same session while `/new` still replied "Started a
        // new session", so the only symptom was the agent remembering things
        // it had just been told to forget.
        let agent = MockAgent {
            new_session_detaches: false,
            ..MockAgent::new()
        };
        let (result, reply) = run_dispatch(&agent, "new", None).await;
        assert!(result.unwrap());
        let text = reply.unwrap();
        assert!(
            text.starts_with("Could not start a new session"),
            "a failed detach must not be reported as a fresh session: {text}"
        );
    }

    #[tokio::test]
    async fn clear_is_no_longer_a_command() {
        // Removed rather than aliased: nothing is cleared, and `/sessions` can
        // still reach the session `/new` pushed aside.
        let agent = MockAgent::new();
        let (result, _) = run_dispatch(&agent, "clear", None).await;
        assert!(!result.unwrap(), "/clear must fall through as unknown");
        assert!(!*agent.new_session_called.lock().unwrap());
    }

    #[tokio::test]
    async fn sessions_lists_numbered_titles_not_raw_ids() {
        // The old listing printed bare ACP hex ids, which name nothing to a
        // chat user and cannot be typed back in as an argument.
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "sessions", None).await;
        assert!(result.unwrap());
        let text = reply.unwrap();
        assert!(
            text.contains("1. WeCom DM: LiangLiang (current)"),
            "got {text}"
        );
        assert!(
            text.contains("2. WeCom DM: LiangLiang (2026-07-26 09:12)"),
            "got {text}"
        );
        assert!(!text.contains("sess-now"), "ids must not leak: {text}");
        assert!(text.contains("/sessions <number>"), "got {text}");
    }

    #[tokio::test]
    async fn sessions_number_switches_to_that_session() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "sessions", Some("2")).await;
        assert!(result.unwrap());
        assert_eq!(
            agent.switched_to.lock().unwrap().as_deref(),
            Some("sess-old")
        );
        let text = reply.unwrap();
        assert!(
            text.starts_with("Switched to: WeCom DM: LiangLiang (2026-07-26"),
            "got {text}"
        );
    }

    #[tokio::test]
    async fn sessions_number_for_the_current_session_is_a_no_op() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "sessions", Some("1")).await;
        assert!(result.unwrap());
        assert_eq!(reply.unwrap(), "Already in this session.");
        assert!(
            agent.switched_to.lock().unwrap().is_none(),
            "switching to the current session must not touch the binding"
        );
    }

    #[tokio::test]
    async fn sessions_out_of_range_number_says_how_many_there_are() {
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "sessions", Some("9")).await;
        assert!(result.unwrap());
        let text = reply.unwrap();
        assert!(text.contains("No session #9"), "got {text}");
        assert!(text.contains("2 available"), "got {text}");
        assert!(agent.switched_to.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn sessions_declined_switch_is_reported_as_such() {
        // A session id from another chat: the handle declines it, and the reply
        // must not claim a switch happened.
        let agent = MockAgent::new();
        let (result, reply) = run_dispatch(&agent, "sessions", Some("sess-elsewhere")).await;
        assert!(result.unwrap());
        assert!(reply.unwrap().contains("not one of this chat's"));
        assert!(agent.switched_to.lock().unwrap().is_none());
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
            name: "new".to_string(),
            description: "agent new".to_string(),
            input_hint: None,
        }]);
        let (result, reply) = run_dispatch(&agent, "new", None).await;
        assert!(result.unwrap());
        let text = reply.unwrap();
        // Should be the agent response, NOT the gateway's own /new reply.
        assert_eq!(text, "agent handled: new");
        assert!(!*agent.new_session_called.lock().unwrap());
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
        // No slash → resolved against the live catalog, not assumed anthropic.
        assert_eq!(
            dispatch_session_slash_cmd(&agent, "/model gpt-4o", "s1").await,
            "✅ Switched to `openai/gpt-4o`. **Note: conversation context was cleared.**"
        );
    }

    #[tokio::test]
    async fn session_slash_bare_model_not_in_catalog_is_rejected() {
        let agent = shared_agent();
        // "haiku" used to be silently rewritten to anthropic/haiku and handed
        // to a backend that never offered it.
        let reply = dispatch_session_slash_cmd(&agent, "/model haiku", "s1").await;
        assert!(reply.starts_with("Unknown model: haiku"), "got {reply}");
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

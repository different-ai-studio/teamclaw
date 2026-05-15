use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use acp::Agent as _; // bring trait methods into scope
use agent_client_protocol as acp;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use tracing::{debug, error, info, warn};

use crate::proto::amux;

// ---------------------------------------------------------------------------
// Messages sent INTO the ACP LocalSet thread
// ---------------------------------------------------------------------------

/// Commands the main tokio runtime sends to the ACP thread.
pub enum AcpCommand {
    /// Send a prompt to the running session.
    Prompt { text: String },
    /// Cancel the current turn.
    Cancel,
    /// Resolve a pending permission request.
    ResolvePermission { request_id: String, granted: bool },
    /// Switch the model used by the current session.
    SetModel { model_id: String },
    /// Shut down the agent.
    Shutdown,
}

// ---------------------------------------------------------------------------
// AmuxClient — implements acp::Client inside the LocalSet
// ---------------------------------------------------------------------------

struct AmuxClient {
    event_tx: mpsc::Sender<amux::AcpEvent>,
    /// Pending permission requests: request_id -> oneshot sender
    pending_permissions: Rc<RefCell<HashMap<String, oneshot::Sender<bool>>>>,
}

#[async_trait::async_trait(?Send)]
impl acp::Client for AmuxClient {
    async fn request_permission(
        &self,
        args: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
        // Extract tool info from the tool_call update
        let tool_id = args.tool_call.tool_call_id.to_string();
        let tool_name = args.tool_call.fields.title.clone().unwrap_or_default();
        let description = args
            .tool_call
            .fields
            .kind
            .map(|k| format!("{:?}", k))
            .unwrap_or_default();

        // Generate a request_id for MQTT routing
        let request_id = uuid::Uuid::new_v4().to_string();

        // Send the permission request event to MQTT
        let _ = self
            .event_tx
            .send(amux::AcpEvent {
                event: Some(amux::acp_event::Event::PermissionRequest(
                    amux::AcpPermissionRequest {
                        request_id: request_id.clone(),
                        tool_name: tool_name.clone(),
                        description,
                        params: Default::default(),
                    },
                )),
                model: String::new(),
            })
            .await;

        // Create oneshot channel and wait for the response
        let (tx, rx) = oneshot::channel();
        self.pending_permissions
            .borrow_mut()
            .insert(request_id.clone(), tx);

        // Wait for the permission response from the main thread
        let granted = rx.await.unwrap_or(false);

        if granted {
            // Find the first "allow" option (AllowOnce or AllowAlways), or fall back to the first option
            let option_id = args
                .options
                .iter()
                .find(|o| {
                    matches!(
                        o.kind,
                        acp::PermissionOptionKind::AllowOnce
                            | acp::PermissionOptionKind::AllowAlways
                    )
                })
                .or_else(|| args.options.first())
                .map(|o| o.option_id.clone())
                .unwrap_or_else(|| acp::PermissionOptionId::new("allow"));

            Ok(acp::RequestPermissionResponse::new(
                acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                    option_id,
                )),
            ))
        } else {
            // Find the first "reject" option, or fall back to last option
            let option_id = args
                .options
                .iter()
                .find(|o| {
                    matches!(
                        o.kind,
                        acp::PermissionOptionKind::RejectOnce
                            | acp::PermissionOptionKind::RejectAlways
                    )
                })
                .or_else(|| args.options.last())
                .map(|o| o.option_id.clone())
                .unwrap_or_else(|| acp::PermissionOptionId::new("deny"));

            Ok(acp::RequestPermissionResponse::new(
                acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                    option_id,
                )),
            ))
        }
    }

    async fn write_text_file(
        &self,
        _args: acp::WriteTextFileRequest,
    ) -> acp::Result<acp::WriteTextFileResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn read_text_file(
        &self,
        _args: acp::ReadTextFileRequest,
    ) -> acp::Result<acp::ReadTextFileResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn create_terminal(
        &self,
        _args: acp::CreateTerminalRequest,
    ) -> acp::Result<acp::CreateTerminalResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn terminal_output(
        &self,
        _args: acp::TerminalOutputRequest,
    ) -> acp::Result<acp::TerminalOutputResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn release_terminal(
        &self,
        _args: acp::ReleaseTerminalRequest,
    ) -> acp::Result<acp::ReleaseTerminalResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn wait_for_terminal_exit(
        &self,
        _args: acp::WaitForTerminalExitRequest,
    ) -> acp::Result<acp::WaitForTerminalExitResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn kill_terminal(
        &self,
        _args: acp::KillTerminalRequest,
    ) -> acp::Result<acp::KillTerminalResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn session_notification(
        &self,
        args: acp::SessionNotification,
    ) -> acp::Result<(), acp::Error> {
        let events = translate_session_update(args.update);
        for event in events {
            let _ = self.event_tx.send(event).await;
        }
        Ok(())
    }

    async fn ext_method(&self, _args: acp::ExtRequest) -> acp::Result<acp::ExtResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn ext_notification(&self, _args: acp::ExtNotification) -> acp::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// SessionUpdate -> amux::AcpEvent translation
// ---------------------------------------------------------------------------

fn translate_session_update(update: acp::SessionUpdate) -> Vec<amux::AcpEvent> {
    match update {
        acp::SessionUpdate::AgentMessageChunk(chunk) => {
            let text = extract_text(&chunk.content);
            if text.is_empty() {
                return vec![];
            }
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                    text,
                    is_complete: false,
                })),
                model: String::new(),
            }]
        }
        acp::SessionUpdate::AgentThoughtChunk(chunk) => {
            let text = extract_text(&chunk.content);
            if text.is_empty() {
                return vec![];
            }
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::Thinking(amux::AcpThinking { text })),
                model: String::new(),
            }]
        }
        acp::SessionUpdate::ToolCall(tc) => {
            info!(
                tool_id = %tc.tool_call_id,
                title = %tc.title,
                kind = ?tc.kind,
                status = ?tc.status,
                content_count = tc.content.len(),
                has_raw_input = tc.raw_input.is_some(),
                "ACP ToolCall"
            );
            let tool_name =
                if tc.title.is_empty() || tc.title == "undefined" || tc.title.starts_with('"') {
                    kind_to_name(&tc.kind)
                } else {
                    tc.title.clone()
                };
            let description = tc
                .raw_input
                .as_ref()
                .map(|v| v.to_string())
                .or_else(|| tc.content.first().map(|c| format!("{:?}", c)))
                .unwrap_or_default();
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                    tool_id: tc.tool_call_id.to_string(),
                    tool_name,
                    description,
                    params: Default::default(),
                    tool_kind: kind_to_snake(&tc.kind),
                })),
                model: String::new(),
            }]
        }
        acp::SessionUpdate::ToolCallUpdate(tcu) => {
            info!(
                tool_id = %tcu.tool_call_id,
                title = ?tcu.fields.title,
                status = ?tcu.fields.status,
                kind = ?tcu.fields.kind,
                content_count = tcu.fields.content.as_ref().map(|c| c.len()).unwrap_or(0),
                "ACP ToolCallUpdate"
            );
            let tool_id = tcu.tool_call_id.to_string();
            let status = tcu.fields.status;
            let is_completed = matches!(
                status,
                Some(acp::ToolCallStatus::Completed) | Some(acp::ToolCallStatus::Failed)
            );

            if is_completed {
                let success = matches!(status, Some(acp::ToolCallStatus::Completed));
                let summary = tcu.fields.title.unwrap_or_else(|| {
                    if success {
                        "completed".into()
                    } else {
                        "failed".into()
                    }
                });
                let summary = if summary.len() > 500 {
                    format!("{}...", &summary[..500])
                } else {
                    summary
                };
                vec![amux::AcpEvent {
                    event: Some(amux::acp_event::Event::ToolResult(amux::AcpToolResult {
                        tool_id,
                        success,
                        summary,
                    })),
                    model: String::new(),
                }]
            } else if let Some(title) = tcu.fields.title {
                // Title update — emit as a ToolUse with updated name so iOS can refresh
                let clean_title = title.trim_matches('"').to_string();
                if !clean_title.is_empty() && clean_title != "undefined" {
                    vec![amux::AcpEvent {
                        event: Some(amux::acp_event::Event::Raw(amux::AcpRawJson {
                            method: "tool_title_update".into(),
                            json_payload: format!("{}|{}", tool_id, clean_title).into_bytes(),
                        })),
                        model: String::new(),
                    }]
                } else {
                    vec![]
                }
            } else {
                vec![]
            }
        }
        acp::SessionUpdate::SessionInfoUpdate(info) => {
            if let acp::MaybeUndefined::Value(title) = info.title {
                // Use RawJson to carry session title update to the main runtime
                vec![amux::AcpEvent {
                    event: Some(amux::acp_event::Event::Raw(amux::AcpRawJson {
                        method: "session_title".into(),
                        json_payload: title.into_bytes(),
                    })),
                    model: String::new(),
                }]
            } else {
                vec![]
            }
        }
        acp::SessionUpdate::AvailableCommandsUpdate(upd) => {
            let commands = upd
                .available_commands
                .into_iter()
                .map(|c| {
                    let input_hint = match c.input {
                        Some(acp::AvailableCommandInput::Unstructured(u)) => u.hint,
                        _ => String::new(),
                    };
                    amux::AcpAvailableCommand {
                        name: c.name,
                        description: c.description,
                        input_hint,
                    }
                })
                .collect();
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::AvailableCommands(
                    amux::AcpAvailableCommands { commands },
                )),
                model: String::new(),
            }]
        }
        _ => {
            debug!("unhandled SessionUpdate variant");
            vec![]
        }
    }
}

fn kind_to_name(kind: &acp::ToolKind) -> String {
    match kind {
        acp::ToolKind::Search => "Search".into(),
        acp::ToolKind::Read => "Read".into(),
        acp::ToolKind::Edit => "Edit".into(),
        acp::ToolKind::Fetch => "WebSearch".into(),
        acp::ToolKind::Execute => "Bash".into(),
        acp::ToolKind::Delete => "Delete".into(),
        acp::ToolKind::Move => "Move".into(),
        acp::ToolKind::Think => "Think".into(),
        _ => format!("{:?}", kind),
    }
}

// ACP ToolKind → snake_case wire string for `AcpToolUse.tool_kind`.
// Matches the ACP JSON schema serde rename so renderers can switch on
// the same vocabulary as the protocol.
fn kind_to_snake(kind: &acp::ToolKind) -> String {
    match kind {
        acp::ToolKind::Read => "read",
        acp::ToolKind::Edit => "edit",
        acp::ToolKind::Delete => "delete",
        acp::ToolKind::Move => "move",
        acp::ToolKind::Search => "search",
        acp::ToolKind::Execute => "execute",
        acp::ToolKind::Think => "think",
        acp::ToolKind::Fetch => "fetch",
        acp::ToolKind::SwitchMode => "switch_mode",
        _ => "other",
    }
    .to_string()
}

fn extract_text(content: &acp::ContentBlock) -> String {
    match content {
        acp::ContentBlock::Text(t) => t.text.clone(),
        acp::ContentBlock::Image(_) => "<image>".into(),
        acp::ContentBlock::Audio(_) => "<audio>".into(),
        acp::ContentBlock::ResourceLink(rl) => rl.uri.clone(),
        acp::ContentBlock::Resource(_) => "<resource>".into(),
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Public API: spawn an ACP agent in its own thread with LocalSet
// ---------------------------------------------------------------------------

/// Spawn a Claude Code agent using the ACP protocol.
///
/// Returns a command sender that the main runtime uses to send prompts,
/// permission responses, and cancellation signals.
///
/// Events from the agent flow through `event_tx`.
///
/// `agent_type` is used to look up the default model from
/// `crate::runtime::models::available_models_for` and apply it via
/// `session/set_model` immediately after Initialize.
///
/// `initial_model_tx` receives `Some(model_id)` if the model was applied
/// successfully, or `None` if no models are configured for `agent_type` or
/// the ACP `set_session_model` call failed.
pub fn spawn_acp_agent(
    binary: String,
    worktree: String,
    initial_prompt: String,
    agent_type: amux::AgentType,
    event_tx: mpsc::Sender<amux::AcpEvent>,
    initial_model_tx: oneshot::Sender<Option<String>>,
    resume_acp_session_id: Option<String>,
    acp_session_id_tx: oneshot::Sender<String>,
) -> crate::error::Result<mpsc::Sender<AcpCommand>> {
    let (cmd_tx, cmd_rx) = mpsc::channel::<AcpCommand>(64);

    // Clone event_tx so we can push an AcpError after run_acp_session
    // fails — without this, the ACP thread would log the failure and
    // silently exit, leaving iOS staring at a runtime that never replies.
    let error_tx = event_tx.clone();

    // Spawn a dedicated thread with its own single-threaded tokio runtime + LocalSet
    // because ACP futures are !Send.
    std::thread::Builder::new()
        .name(format!("acp-agent"))
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to build tokio runtime for ACP agent");

            let local_set = tokio::task::LocalSet::new();
            rt.block_on(local_set.run_until(async move {
                if let Err(e) = run_acp_session(
                    binary,
                    worktree,
                    initial_prompt,
                    agent_type,
                    event_tx,
                    cmd_rx,
                    initial_model_tx,
                    resume_acp_session_id,
                    acp_session_id_tx,
                )
                .await
                {
                    let summary = format!("{}", e);
                    let details = format!("{:#}", e);
                    error!(error = %details, "ACP agent session failed");
                    // Best-effort fanout to iOS. The receiver may already
                    // be gone (RuntimeManager teardown raced ahead) — in
                    // that case the send is a no-op and the log line
                    // above is the only record.
                    let _ = error_tx
                        .send(amux::AcpEvent {
                            event: Some(amux::acp_event::Event::Error(amux::AcpError {
                                message: summary,
                                details,
                            })),
                            model: String::new(),
                        })
                        .await;
                }
            }));
        })
        .map_err(|e| {
            crate::error::AmuxError::Agent(format!("failed to spawn ACP thread: {}", e))
        })?;

    Ok(cmd_tx)
}

/// The main ACP session loop running inside a LocalSet.
async fn run_acp_session(
    binary: String,
    worktree: String,
    initial_prompt: String,
    agent_type: amux::AgentType,
    event_tx: mpsc::Sender<amux::AcpEvent>,
    mut cmd_rx: mpsc::Receiver<AcpCommand>,
    initial_model_tx: oneshot::Sender<Option<String>>,
    resume_acp_session_id: Option<String>,
    acp_session_id_tx: oneshot::Sender<String>,
) -> anyhow::Result<()> {
    // Spawn the ACP agent process
    // Use claude-agent-acp wrapper (Node.js) which speaks ACP JSON-RPC over stdio
    // Falls back to npx if the binary is "claude" (default)
    let mut cmd = if binary == "claude" || binary.ends_with("claude-agent-acp") {
        let mut c = tokio::process::Command::new("npx");
        c.arg("--yes").arg("@zed-industries/claude-agent-acp");
        c
    } else {
        tokio::process::Command::new(&binary)
    };
    let mut child = cmd
        .current_dir(&worktree)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| anyhow::anyhow!("spawn ACP agent: {}", e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdout"))?;

    // Drain stderr line-by-line so the pipe buffer can't fill up and
    // wedge the subprocess. Each line is logged at warn — claude-agent-acp
    // writes its JSON-RPC error envelopes here when something goes wrong,
    // and previously they were invisible (we piped stderr but never read
    // it), making "Internal error" failures impossible to diagnose
    // without manual reproduction outside the daemon.
    if let Some(stderr) = child.stderr.take() {
        tokio::task::spawn_local(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                warn!(target: "acp_stderr", "{}", line);
            }
        });
    }

    info!(binary = %binary, worktree = %worktree, "ACP agent process spawned");

    let pending_permissions: Rc<RefCell<HashMap<String, oneshot::Sender<bool>>>> =
        Rc::new(RefCell::new(HashMap::new()));

    let client = AmuxClient {
        event_tx: event_tx.clone(),
        pending_permissions: pending_permissions.clone(),
    };

    // Create the ACP connection
    let (conn, handle_io) =
        acp::ClientSideConnection::new(client, stdin.compat_write(), stdout.compat(), |fut| {
            tokio::task::spawn_local(fut);
        });

    // Spawn the IO handler
    tokio::task::spawn_local(async move {
        if let Err(e) = handle_io.await {
            warn!("ACP IO task ended: {}", e);
        }
    });

    // Initialize the connection
    conn.initialize(
        acp::InitializeRequest::new(acp::ProtocolVersion::V1)
            .client_info(acp::Implementation::new("amuxd", "0.1.0").title("AMUX Daemon")),
    )
    .await
    .map_err(|e| anyhow::anyhow!("ACP initialize failed: {}", e))?;

    info!("ACP connection initialized");

    // Create or resume session
    let worktree_path = std::path::PathBuf::from(&worktree);
    let session_id = if let Some(ref resume_id) = resume_acp_session_id {
        let resume_req = acp::ResumeSessionRequest::new(
            acp::SessionId::new(resume_id.clone()),
            worktree_path.clone(),
        );
        match conn.resume_session(resume_req).await {
            Ok(_resp) => {
                let sid = acp::SessionId::new(resume_id.clone());
                info!(session_id = %sid, "ACP session resumed");
                sid
            }
            Err(e) => {
                warn!(
                    resume_id,
                    "ACP resume_session failed ({}), falling back to new_session", e
                );
                let resp = conn
                    .new_session(acp::NewSessionRequest::new(worktree_path))
                    .await
                    .map_err(|e| anyhow::anyhow!("ACP new_session failed: {}", e))?;
                let sid = resp.session_id.clone();
                info!(session_id = %sid, "ACP session created (fallback)");
                sid
            }
        }
    } else {
        let resp = conn
            .new_session(acp::NewSessionRequest::new(worktree_path))
            .await
            .map_err(|e| anyhow::anyhow!("ACP new_session failed: {}", e))?;
        let sid = resp.session_id.clone();
        info!(session_id = %sid, "ACP session created");
        sid
    };

    // Report the ACP session_id back to the caller
    let _ = acp_session_id_tx.send(session_id.to_string());

    // Apply the default model from the hardcoded list before any prompt runs.
    // This ensures the very first turn is on the chosen model.
    let initial_model: Option<String> = {
        let models = crate::runtime::models::available_models_for(agent_type);
        if let Some(first) = models.first() {
            let req = acp::SetSessionModelRequest::new(
                session_id.clone(),
                acp::ModelId::new(first.id.clone()),
            );
            match conn.set_session_model(req).await {
                Ok(_) => {
                    info!(model_id = %first.id, "ACP initial set_session_model applied");
                    Some(first.id.clone())
                }
                Err(e) => {
                    warn!(error = %e, "initial set_session_model failed");
                    None
                }
            }
        } else {
            None
        }
    };
    // Notify the caller (manager) of the chosen model. None means no model
    // could be applied (no models known for this agent type, or the ACP call
    // failed); the manager decides what to record.
    let _ = initial_model_tx.send(initial_model);

    // Use Rc to share conn across spawn_local tasks
    let conn = Rc::new(conn);

    // Send the initial prompt (skipped when empty — iOS new-session flow
    // now passes empty initial_prompt and delivers the user's first
    // message via session/live instead, so the runtime sees only one
    // copy of the prompt instead of two).
    if !initial_prompt.is_empty() {
        let conn = conn.clone();
        let session_id = session_id.clone();
        let event_tx = event_tx.clone();
        let text = initial_prompt;

        tokio::task::spawn_local(async move {
            // Emit active status
            let _ = event_tx
                .send(amux::AcpEvent {
                    event: Some(amux::acp_event::Event::StatusChange(
                        amux::AcpStatusChange {
                            old_status: amux::AgentStatus::Idle as i32,
                            new_status: amux::AgentStatus::Active as i32,
                        },
                    )),
                    model: String::new(),
                })
                .await;

            let result = conn
                .prompt(acp::PromptRequest::new(
                    session_id.clone(),
                    vec![text.into()],
                ))
                .await;

            if let Err(e) = result {
                error!("ACP prompt failed: {}", e);
            }

            // Emit idle status when prompt completes
            let _ = event_tx
                .send(amux::AcpEvent {
                    event: Some(amux::acp_event::Event::StatusChange(
                        amux::AcpStatusChange {
                            old_status: amux::AgentStatus::Active as i32,
                            new_status: amux::AgentStatus::Idle as i32,
                        },
                    )),
                    model: String::new(),
                })
                .await;
        });
    }

    // Command loop: receive commands from the main runtime
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            AcpCommand::Prompt { text } => {
                let conn = conn.clone();
                let session_id = session_id.clone();
                let event_tx = event_tx.clone();

                tokio::task::spawn_local(async move {
                    // Emit active status
                    let _ = event_tx
                        .send(amux::AcpEvent {
                            event: Some(amux::acp_event::Event::StatusChange(
                                amux::AcpStatusChange {
                                    old_status: amux::AgentStatus::Idle as i32,
                                    new_status: amux::AgentStatus::Active as i32,
                                },
                            )),
                            model: String::new(),
                        })
                        .await;

                    let result = conn
                        .prompt(acp::PromptRequest::new(
                            session_id.clone(),
                            vec![text.into()],
                        ))
                        .await;

                    if let Err(e) = result {
                        error!("ACP prompt failed: {}", e);
                    }

                    // Emit idle status
                    let _ = event_tx
                        .send(amux::AcpEvent {
                            event: Some(amux::acp_event::Event::StatusChange(
                                amux::AcpStatusChange {
                                    old_status: amux::AgentStatus::Active as i32,
                                    new_status: amux::AgentStatus::Idle as i32,
                                },
                            )),
                            model: String::new(),
                        })
                        .await;
                });
            }
            AcpCommand::Cancel => {
                if let Err(e) = conn
                    .cancel(acp::CancelNotification::new(session_id.clone()))
                    .await
                {
                    warn!("ACP cancel failed: {}", e);
                }
            }
            AcpCommand::ResolvePermission {
                request_id,
                granted,
            } => {
                if let Some(tx) = pending_permissions.borrow_mut().remove(&request_id) {
                    let _ = tx.send(granted);
                } else {
                    warn!(request_id, "no pending permission request found");
                }
            }
            AcpCommand::SetModel { model_id } => {
                let req = acp::SetSessionModelRequest::new(
                    session_id.clone(),
                    acp::ModelId::new(model_id.clone()),
                );
                if let Err(e) = conn.set_session_model(req).await {
                    warn!(error = %e, model_id = %model_id, "set_session_model failed");
                } else {
                    info!(model_id = %model_id, "set_session_model applied");
                }
            }
            AcpCommand::Shutdown => {
                info!("ACP agent shutting down");
                break;
            }
        }
    }

    // Clean up: drop the child process (kill_on_drop will handle it)
    drop(child);
    info!("ACP agent thread exiting");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_available_commands_update_without_input() {
        let upd = acp::AvailableCommandsUpdate::new(vec![acp::AvailableCommand::new(
            "clear",
            "Clear history",
        )]);
        let events = translate_session_update(acp::SessionUpdate::AvailableCommandsUpdate(upd));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::AvailableCommands(ac) => {
                assert_eq!(ac.commands.len(), 1);
                assert_eq!(ac.commands[0].name, "clear");
                assert_eq!(ac.commands[0].description, "Clear history");
                assert_eq!(ac.commands[0].input_hint, "");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_available_commands_update_with_unstructured_input() {
        let cmd = acp::AvailableCommand::new("rename", "Rename the session").input(Some(
            acp::AvailableCommandInput::Unstructured(acp::UnstructuredCommandInput::new(
                "new session name",
            )),
        ));
        let upd = acp::AvailableCommandsUpdate::new(vec![cmd]);
        let events = translate_session_update(acp::SessionUpdate::AvailableCommandsUpdate(upd));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::AvailableCommands(ac) => {
                assert_eq!(ac.commands[0].input_hint, "new session name");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }
}

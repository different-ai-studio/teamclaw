use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use acp::Agent as _; // bring trait methods into scope
use agent_client_protocol as acp;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use tracing::{debug, error, info, warn};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;

const REMOTE_TOOLS_MCP_SERVER_NAME: &str = "amuxd-remote-tools";

mod translate;
use translate::*;

mod envelope;
pub use envelope::*;

mod permission;
use permission::*;

// ---------------------------------------------------------------------------
// Messages sent INTO the ACP LocalSet thread
// ---------------------------------------------------------------------------

/// Commands the main tokio runtime sends to a shared ACP host thread.
pub enum AcpCommand {
    /// Create or resume an ACP session on an already-initialized host.
    AttachSession {
        worktree: String,
        resume_acp_session_id: Option<String>,
        mcp_config_path: Option<PathBuf>,
        initial_model_override: Option<String>,
        initial_prompt: String,
        event_tx: mpsc::Sender<AcpEventFrame>,
        startup_tx: oneshot::Sender<Result<AcpStartupMetadata, String>>,
        /// Gateway sessions auto-allow tool permissions; native runtimes wait
        /// for MQTT approval.
        is_gateway: bool,
        /// When resuming, fail instead of falling back to `session/new`.
        forbid_new_session_fallback: bool,
    },
    /// Drop routing state for a session; the host process keeps running.
    DetachSession { acp_session_id: String },
    /// Send a prompt to a bound session.
    Prompt {
        acp_session_id: String,
        text: String,
        attachment_urls: Vec<String>,
        /// Human actor that started this turn; stamped onto PermissionRequest params.
        requester_actor_id: Option<String>,
        /// User message id that triggered this turn; stamped onto AgentReply emits.
        reply_to_message_id: Option<String>,
    },
    /// Cancel the current turn for a bound session.
    Cancel { acp_session_id: String },
    /// Resolve a pending permission request (any session on this host).
    ResolvePermission {
        request_id: String,
        granted: bool,
        /// ACP option_id when granted (e.g. OpenCode "once" / "always"). Empty = allow_once.
        option_id: Option<String>,
    },
    /// Switch the model used by a bound session.
    SetModel {
        acp_session_id: String,
        model_id: String,
    },
    /// Shut down the entire host process.
    Shutdown,
}

#[derive(Debug, Clone)]
pub struct AcpStartupMetadata {
    pub available_models: Vec<amux::ModelInfo>,
    pub initial_model: Option<String>,
    pub acp_session_id: String,
}

type StartupReporter = Arc<Mutex<Option<oneshot::Sender<Result<AcpStartupMetadata, String>>>>>;

fn report_startup(reporter: &StartupReporter, result: Result<AcpStartupMetadata, String>) {
    if let Some(tx) = reporter.lock().ok().and_then(|mut guard| guard.take()) {
        let _ = tx.send(result);
    }
}

async fn emit_acp_error(
    event_tx: &mpsc::Sender<AcpEventFrame>,
    acp_session_id: &str,
    message: impl Into<String>,
    details: impl Into<String>,
) {
    let message = message.into();
    let details = details.into();
    super::agent_trace::log_acp_error(acp_session_id, &message, &details);
    let _ = event_tx
        .send(AcpEventFrame::new(
            acp_session_id,
            amux::AcpEvent {
                event: Some(amux::acp_event::Event::Error(amux::AcpError {
                    message,
                    details,
                })),
                model: String::new(),
            },
        ))
        .await;
}

// ---------------------------------------------------------------------------
// AmuxClient — implements acp::Client inside the LocalSet
// ---------------------------------------------------------------------------

/// Per-session routing table inside a shared ACP host.
#[derive(Default)]
struct SessionRegistry {
    sessions: HashMap<String, SessionRoute>,
    /// Child ACP session id → root ACP session id (subagent alias routing).
    child_to_root: HashMap<String, String>,
}

impl SessionRegistry {
    fn register_child_session(&mut self, child_id: String, root_id: String) {
        if child_id.is_empty() || root_id.is_empty() {
            return;
        }
        self.child_to_root.insert(child_id, root_id);
    }

    fn detach_session(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
        self.child_to_root.remove(session_id);
        self.child_to_root.retain(|_, root| root != session_id);
    }

    fn resolve_event_route(&self, session_id: &str) -> Option<&SessionRoute> {
        self.sessions.get(session_id).or_else(|| {
            self.child_to_root
                .get(session_id)
                .and_then(|root| self.sessions.get(root))
        })
    }

    fn resolve_event_route_mut(&mut self, session_id: &str) -> Option<&mut SessionRoute> {
        if self.sessions.contains_key(session_id) {
            return self.sessions.get_mut(session_id);
        }
        if let Some(root) = self.child_to_root.get(session_id).cloned() {
            return self.sessions.get_mut(&root);
        }
        None
    }
}

/// Client reply routed back to an in-flight ACP `request_permission` call.
#[derive(Debug)]
enum PermissionResolution {
    Denied,
    Granted { option_id: Option<String> },
}

/// Stamp the collab turn invoker onto PermissionRequest params (wire format).
fn stamp_requester_actor_id(params: &mut HashMap<String, String>, requester: Option<&str>) {
    if let Some(id) = requester.filter(|s| !s.is_empty()) {
        params.insert("requester_actor_id".to_string(), id.to_string());
    }
}

struct SessionRoute {
    event_tx: mpsc::Sender<AcpEventFrame>,
    is_gateway: bool,
    pending_permissions: HashMap<String, oneshot::Sender<PermissionResolution>>,
    /// Human actor id for the in-flight collab turn (PermissionRequest stamp).
    turn_requester_actor_id: Option<String>,
    /// User message id for the in-flight turn (AgentReply `reply_to_message_id`).
    turn_reply_to_message_id: Option<String>,
    tool_progress_deduper: RefCell<ToolProgressDeduper>,
    /// Count of `session_notification` handlers currently between "entered"
    /// and "finished pushing their events onto `event_tx`". The ACP crate
    /// dispatches every incoming `session/update` on its own spawned task,
    /// fully decoupled from when `conn.prompt()` resolves (the prompt
    /// response is read + the response oneshot fired by the rpc reader task,
    /// see `agent-client-protocol` `rpc.rs::handle_io`). So when `prompt()`
    /// returns, the turn's trailing `AgentMessageChunk` handlers may not have
    /// pushed their `Output` onto `event_tx` yet. The prompt worker waits for
    /// this counter to go (and stay) quiescent before emitting Active->Idle,
    /// guaranteeing the turn's final text lands ahead of the turn-end marker.
    notif_inflight: Rc<Cell<usize>>,
    /// Monotonic count of `session_notification` handlers that have *finished*
    /// pushing their events onto `event_tx`. Unlike `notif_inflight` (which
    /// reads 0 both *before* a handler is dispatched and *after* it completes),
    /// this only ever moves forward, so the drain barrier can tell "a handler
    /// just completed" apart from "no handler has started yet" and extend its
    /// quiet window accordingly.
    notif_finished: Rc<Cell<u64>>,
}

#[derive(Default)]
struct ToolProgressDeduper {
    last_by_tool_id: HashMap<String, String>,
}

impl ToolProgressDeduper {
    fn should_drop(&mut self, update: &acp::SessionUpdate) -> bool {
        let Some((tool_id, signature)) = tool_progress_signature(update) else {
            return false;
        };
        if self.last_by_tool_id.get(&tool_id) == Some(&signature) {
            return true;
        }
        self.last_by_tool_id.insert(tool_id, signature);
        false
    }
}

fn tool_progress_signature(update: &acp::SessionUpdate) -> Option<(String, String)> {
    let acp::SessionUpdate::ToolCallUpdate(tcu) = update else {
        return None;
    };
    if !matches!(tcu.fields.status, Some(acp::ToolCallStatus::InProgress)) {
        return None;
    }
    Some((
        tcu.tool_call_id.to_string(),
        format!(
            "{:?}|{:?}|{:?}|{:?}|{:?}|{:?}",
            tcu.fields.title,
            tcu.fields.kind,
            tcu.fields.content,
            tcu.fields.locations,
            tcu.fields.raw_input,
            tcu.fields.raw_output,
        ),
    ))
}

/// RAII guard that marks one in-flight `session_notification` on a session
/// route: increments `inflight` on construction; on drop (panic-safe)
/// decrements `inflight` and bumps the monotonic `finished` counter.
struct NotifInflightGuard {
    inflight: Rc<Cell<usize>>,
    finished: Rc<Cell<u64>>,
}

impl NotifInflightGuard {
    fn new(inflight: Rc<Cell<usize>>, finished: Rc<Cell<u64>>) -> Self {
        inflight.set(inflight.get() + 1);
        Self { inflight, finished }
    }
}

impl Drop for NotifInflightGuard {
    fn drop(&mut self) {
        self.inflight.set(self.inflight.get().saturating_sub(1));
        self.finished.set(self.finished.get().wrapping_add(1));
    }
}

/// Block until the per-session notification dispatch pipeline is quiescent.
///
/// See `SessionRoute::notif_inflight` for why this barrier exists. The ACP
/// crate's reader (`rpc.rs::handle_io`) enqueues every trailing notification
/// onto its internal `incoming_rx` *before* it resolves the prompt response,
/// so by the time `conn.prompt()` returns the whole turn's notifications are
/// already queued. But the handlers run on a *separate* task chain:
/// `handle_incoming` pulls each notification off `incoming_rx` and `spawn`s an
/// independent handler task, and only those handler tasks push `Thinking` /
/// `Output` onto `event_tx`.
///
/// The previous implementation declared the pipeline drained after observing
/// `notif_inflight == 0` across two `yield_now()` turns. That was racy:
/// `notif_inflight` reads 0 *both* before any handler is dispatched *and*
/// after they all complete. When the crate's `BufReader` happened to read the
/// whole turn (every notification line + the prompt response) in one
/// uninterrupted burst, the prompt worker could be scheduled first and burn
/// both zero observations before `handle_incoming` ran even once — emitting
/// `Active->Idle` ahead of the turn's content. The aggregator then flushed
/// empty buffers, closed the turn, and the real chunks (arriving afterward)
/// were stranded in a never-closed follow-up turn and lost.
///
/// We can't hook the crate's dispatcher, so we settle on a *time-bounded quiet
/// window* instead. Giving the local executor real wall-clock time guarantees
/// the ready `handle_incoming` task drains `incoming_rx` (it pulls every
/// already-buffered item in a single poll) and the spawned handlers run. We
/// only return once `notif_inflight == 0` *and* no handler has finished for at
/// least `QUIET_WINDOW` — the monotonic `notif_finished` counter
/// distinguishes "a handler just completed" from "nothing started yet", so a
/// turn that is still flushing keeps extending the window while a genuinely
/// empty turn falls through after one quiet window.
async fn await_notifications_drained(
    registry: &Rc<RefCell<SessionRegistry>>,
    acp_session_id: &str,
) {
    // Minimum span of no-completions + zero-inflight we require before
    // declaring the pipeline drained. Comfortably longer than the few
    // scheduler ticks it takes the executor to drain `incoming_rx` and run
    // the (trivial) handler tasks, yet negligible against multi-second turns.
    const QUIET_WINDOW: Duration = Duration::from_millis(12);
    // Hard ceiling so a wedged/removed session can never pin the prompt worker.
    const MAX_WAIT: Duration = Duration::from_millis(3000);
    // Poll cadence: real sleeps (not bare yields) so the crate's reader,
    // `handle_incoming`, and the handler tasks all get wall-clock time to run.
    const TICK: Duration = Duration::from_millis(1);

    let start = Instant::now();
    let read_state = || -> Option<(usize, u64)> {
        let guard = registry.borrow();
        guard
            .sessions
            .get(acp_session_id)
            .map(|route| (route.notif_inflight.get(), route.notif_finished.get()))
    };

    // Seed with the current completion count; any forward movement marks
    // fresh activity and restarts the quiet window.
    let mut last_finished = match read_state() {
        Some((_, finished)) => finished,
        // Session detached mid-turn: nothing left to order against.
        None => return,
    };
    let mut last_activity = Instant::now();
    let finished0 = last_finished;

    loop {
        tokio::time::sleep(TICK).await;
        let (inflight, finished) = match read_state() {
            Some(state) => state,
            None => return,
        };
        if finished != last_finished {
            last_finished = finished;
            last_activity = Instant::now();
        }
        if inflight == 0 && last_activity.elapsed() >= QUIET_WINDOW {
            debug!(session = %acp_session_id, processed = finished.wrapping_sub(finished0), waited_ms = start.elapsed().as_millis() as u64, "ACP notification drain settled");
            return;
        }
        if start.elapsed() >= MAX_WAIT {
            warn!(session = %acp_session_id, processed = finished.wrapping_sub(finished0), inflight, "ACP notification drain hit MAX_WAIT");
            return;
        }
    }
}

struct AmuxClient {
    registry: Rc<RefCell<SessionRegistry>>,
}

#[async_trait::async_trait(?Send)]
impl acp::Client for AmuxClient {
    async fn request_permission(
        &self,
        args: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
        let session_id = args.session_id.to_string();
        let tool_id = args.tool_call.tool_call_id.to_string();
        let tool_name = args.tool_call.fields.title.clone().unwrap_or_default();
        let description = args
            .tool_call
            .fields
            .kind
            .map(|k| format!("{:?}", k))
            .unwrap_or_default();

        let is_gateway = {
            let guard = self.registry.borrow();
            guard
                .sessions
                .get(&session_id)
                .map(|r| r.is_gateway)
                .unwrap_or(false)
        };

        if is_gateway {
            let option_id = args
                .options
                .iter()
                .find(|o| {
                    matches!(
                        o.kind,
                        acp::PermissionOptionKind::AllowAlways
                            | acp::PermissionOptionKind::AllowOnce
                    )
                })
                .or_else(|| args.options.first())
                .map(|o| o.option_id.clone())
                .unwrap_or_else(|| acp::PermissionOptionId::new("allow"));
            info!(
                tool_id = %tool_id,
                tool_name = %tool_name,
                "auto-allow gateway tool"
            );
            return Ok(acp::RequestPermissionResponse::new(
                acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                    option_id,
                )),
            ));
        }

        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();

        {
            let event_tx = {
                let mut guard = self.registry.borrow_mut();
                let Some(route) = guard.resolve_event_route_mut(&session_id) else {
                    warn!(session_id, "permission request for unknown session");
                    return Ok(acp::RequestPermissionResponse::new(
                        acp::RequestPermissionOutcome::Selected(
                            acp::SelectedPermissionOutcome::new(acp::PermissionOptionId::new(
                                "deny",
                            )),
                        ),
                    ));
                };
                route.pending_permissions.insert(request_id.clone(), tx);
                route.event_tx.clone()
            };

            let mut permission_params =
                tool_call_params(args.tool_call.fields.raw_input.as_ref());
            {
                let guard = self.registry.borrow();
                if let Some(route) = guard.resolve_event_route(&session_id) {
                    stamp_requester_actor_id(
                        &mut permission_params,
                        route.turn_requester_actor_id.as_deref(),
                    );
                }
            }
            let _ = event_tx
                .send(AcpEventFrame::new(
                    session_id.clone(),
                    amux::AcpEvent {
                        event: Some(amux::acp_event::Event::PermissionRequest(
                            amux::AcpPermissionRequest {
                                request_id: request_id.clone(),
                                tool_name: tool_name.clone(),
                                description,
                                params: permission_params,
                                options: amux_permission_options(&args.options),
                            },
                        )),
                        model: String::new(),
                    },
                ))
                .await;
        }

        let resolution = rx.await.unwrap_or(PermissionResolution::Denied);
        let option_id = acp_option_for_resolution(&args.options, &resolution);

        Ok(acp::RequestPermissionResponse::new(
            acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(option_id)),
        ))
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
        let session_id = args.session_id.to_string();
        if let Some((child_id, mut root_id)) = extract_task_child_metadata(&args.update) {
            if root_id.is_empty() {
                root_id = session_id.clone();
            }
            self.registry
                .borrow_mut()
                .register_child_session(child_id, root_id);
        }
        let drop_redundant_progress = {
            let guard = self.registry.borrow();
            guard
                .resolve_event_route(&session_id)
                .map(|route| {
                    route
                        .tool_progress_deduper
                        .borrow_mut()
                        .should_drop(&args.update)
                })
                .unwrap_or(false)
        };
        if drop_redundant_progress {
            debug!(session_id, "dropped redundant ACP tool progress update");
            return Ok(());
        }
        let events = translate_session_update(args.update);
        let route = {
            let guard = self.registry.borrow();
            guard.resolve_event_route(&session_id).map(|r| {
                (
                    r.event_tx.clone(),
                    r.notif_inflight.clone(),
                    r.notif_finished.clone(),
                    r.turn_reply_to_message_id.clone(),
                )
            })
        };
        if let Some((event_tx, inflight, finished, turn_reply_to)) = route {
            let _inflight_guard = NotifInflightGuard::new(inflight, finished);
            for event in &events {
                super::agent_trace::log_acp_event(&session_id, event);
            }
            for event in events {
                let _ = event_tx
                    .send(
                        AcpEventFrame::new(session_id.clone(), event)
                            .with_reply_to(turn_reply_to.clone()),
                    )
                    .await;
            }
        } else {
            debug!(
                session_id,
                event_count = events.len(),
                "dropped ACP events for detached session"
            );
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

/// Read the gateway MCP config JSON we wrote earlier and translate its
/// `mcpServers` map into ACP-native `McpServer::Stdio` entries that can ride
/// on `NewSessionRequest.mcp_servers`. Returns `None` when the file has no
/// entries; bubbles up read/parse errors so callers can degrade gracefully.
fn parse_mcp_config_to_acp(path: &std::path::Path) -> anyhow::Result<Option<Vec<acp::McpServer>>> {
    let body = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("read {}: {e}", path.display()))?;
    let root: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| anyhow::anyhow!("parse {}: {e}", path.display()))?;
    let Some(servers) = root.get("mcpServers").and_then(|v| v.as_object()) else {
        return Ok(None);
    };
    let mut out = Vec::with_capacity(servers.len());
    for (name, def) in servers.iter() {
        let command = def
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("mcp server '{name}' missing 'command'"))?;
        let args: Vec<String> = def
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let mut stdio = acp::McpServerStdio::new(name.clone(), std::path::PathBuf::from(command));
        if !args.is_empty() {
            stdio = stdio.args(args);
        }
        out.push(acp::McpServer::Stdio(stdio));
    }
    if out.is_empty() {
        Ok(None)
    } else {
        Ok(Some(out))
    }
}

fn mcp_server_name(server: &acp::McpServer) -> &str {
    match server {
        acp::McpServer::Http(s) => &s.name,
        acp::McpServer::Sse(s) => &s.name,
        acp::McpServer::Stdio(s) => &s.name,
        _ => "",
    }
}

fn mcp_server_names(servers: &[acp::McpServer]) -> Vec<String> {
    servers
        .iter()
        .map(|server| mcp_server_name(server).to_string())
        .collect()
}

fn should_attach_remote_tools_baseline(agent_type: amux::AgentType) -> bool {
    matches!(agent_type, amux::AgentType::Codex)
}

fn strip_remote_tools_mcp_for_opencode(
    agent_type: amux::AgentType,
    servers: &mut Vec<acp::McpServer>,
) {
    if agent_type != amux::AgentType::Opencode {
        return;
    }
    let before = servers.len();
    servers.retain(|server| mcp_server_name(server) != REMOTE_TOOLS_MCP_SERVER_NAME);
    if servers.len() != before {
        info!(
            ?agent_type,
            server_names = ?mcp_server_names(servers),
            "remote-tools MCP stripped from ACP attach; OpenCode uses workspace config"
        );
    }
}

fn remote_tools_baseline_mcp_server() -> Option<acp::McpServer> {
    let amuxd_bin = match std::env::current_exe() {
        Ok(path) => path,
        Err(e) => {
            warn!(error = %e, "remote-tools MCP baseline skipped: current_exe failed");
            return None;
        }
    };
    let sock = crate::config::DaemonConfig::sock_path();
    debug!(
        amuxd_bin = %amuxd_bin.display(),
        sock = %sock.display(),
        "remote-tools MCP baseline server built"
    );
    Some(acp::McpServer::Stdio(
        acp::McpServerStdio::new(REMOTE_TOOLS_MCP_SERVER_NAME, amuxd_bin).args(vec![
            "remote-tools-mcp".to_string(),
            format!("--sock={}", sock.to_string_lossy()),
        ]),
    ))
}

fn ensure_remote_tools_baseline_mcp(
    agent_type: amux::AgentType,
    servers: &mut Vec<acp::McpServer>,
) {
    if !should_attach_remote_tools_baseline(agent_type) {
        return;
    }
    if servers
        .iter()
        .any(|server| mcp_server_name(server) == REMOTE_TOOLS_MCP_SERVER_NAME)
    {
        debug!(
            ?agent_type,
            server_names = ?mcp_server_names(servers),
            "remote-tools MCP baseline already present"
        );
        return;
    }
    if let Some(server) = remote_tools_baseline_mcp_server() {
        servers.push(server);
        info!(
            ?agent_type,
            server_names = ?mcp_server_names(servers),
            "remote-tools MCP baseline inserted"
        );
    }
}

fn opencode_remote_tools_config_summary(worktree: &str) -> String {
    let path = Path::new(worktree).join("opencode.json");
    if !path.exists() {
        return format!("{} missing", path.display());
    }
    let body = match std::fs::read_to_string(&path) {
        Ok(body) => body,
        Err(e) => return format!("{} read_error={e}", path.display()),
    };
    let root: serde_json::Value = match serde_json::from_str(&body) {
        Ok(root) => root,
        Err(e) => return format!("{} parse_error={e}", path.display()),
    };
    let Some(remote_tools) = root
        .get("mcp")
        .and_then(|mcp| mcp.get(REMOTE_TOOLS_MCP_SERVER_NAME))
    else {
        return format!(
            "{} mcp.{} missing",
            path.display(),
            REMOTE_TOOLS_MCP_SERVER_NAME
        );
    };
    let enabled = remote_tools
        .get("enabled")
        .and_then(|v| v.as_bool())
        .map(|v| v.to_string())
        .unwrap_or_else(|| "unset".to_string());
    let command = remote_tools
        .get("command")
        .map(|v| v.to_string())
        .unwrap_or_else(|| "missing".to_string());
    format!(
        "{} mcp.{} present enabled={} command={}",
        path.display(),
        REMOTE_TOOLS_MCP_SERVER_NAME,
        enabled,
        command
    )
}

fn should_use_claude_agent_acp_wrapper(binary: &str) -> bool {
    let binary_name = Path::new(binary)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(binary);

    binary_name == "claude" || binary_name == "claude-agent-acp"
}

/// `npx` is `npx.cmd` on Windows; CreateProcess does not apply PATHEXT to a
/// bare name the way a shell would, so the spawn must name the .cmd file.
pub(crate) fn npx_program() -> &'static str {
    if cfg!(windows) { "npx.cmd" } else { "npx" }
}

#[cfg(windows)]
const PATH_SEP: char = ';';
#[cfg(not(windows))]
const PATH_SEP: char = ':';

/// Build a PATH for spawned agent runtimes that includes common user-level
/// binary directories.
///
/// amuxd is typically launched by launchd (macOS) or systemd (Linux) with a
/// minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that omits Homebrew
/// (`/opt/homebrew/bin`), `~/.local/bin`, and the other locations where agent
/// runtimes like `npx`, `opencode`, and `claude` actually live. Without this,
/// the ClaudeCode ACP wrapper (`npx @zed-industries/claude-agent-acp`) fails to
/// spawn with `ENOENT`, surfaced to clients as the opaque "ACP host init
/// channel closed".
///
/// Inherited PATH entries keep priority; the well-known directories are
/// appended as fallbacks, and duplicates are removed preserving first
/// occurrence. The extra directories are harmless on platforms where they don't
/// exist — a non-existent PATH entry is simply skipped during lookup.
pub(crate) fn enriched_spawn_path(existing: Option<&str>, home: Option<&Path>) -> String {
    let mut candidates: Vec<String> = Vec::new();

    // Inherited PATH first — preserves whatever the launcher configured.
    if let Some(existing) = existing {
        candidates.extend(existing.split(PATH_SEP).map(|s| s.to_string()));
    }

    // Well-known user-level bin dirs that minimal launchd/systemd PATHs omit.
    if cfg!(windows) {
        // Node installer dir + global npm prefix, where npx.cmd/claude.cmd live.
        if let Ok(pf) = std::env::var("ProgramFiles") {
            candidates.push(format!("{pf}\\nodejs"));
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(format!("{appdata}\\npm"));
        }
    } else {
        if let Some(home) = home {
            for sub in [".local/bin", ".npm-global/bin", ".bun/bin", ".cargo/bin"] {
                candidates.push(home.join(sub).to_string_lossy().into_owned());
            }
        }
        for dir in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] {
            candidates.push(dir.to_string());
        }
    }

    // Dedupe preserving first occurrence; drop empty segments.
    let mut seen = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|d| !d.is_empty() && seen.insert(d.clone()))
        .collect::<Vec<_>>()
        .join(&PATH_SEP.to_string())
}

#[cfg(test)]
mod attachment_ext_tests {
    use super::path_and_ext;

    #[test]
    fn plain_image_url_yields_jpg() {
        let (_, ext) = path_and_ext("https://x.supabase.co/photo-abc.jpg");
        assert_eq!(ext, "jpg");
    }

    #[test]
    fn signed_url_with_jwt_in_query_yields_image_ext_not_jwt_segment() {
        // Supabase signed URLs carry a JWT whose payload contains `.`. The
        // pre-fix code grabbed "bar" (the JWT tail) and treated the file as
        // a non-image. Verify we now strip `?token=…` first.
        let url = "https://x.supabase.co/storage/v1/object/sign/attachments/t/s/abc/photo.png?token=eyJ.foo.bar";
        let (_, ext) = path_and_ext(url);
        assert_eq!(ext, "png");
    }

    #[test]
    fn url_without_extension_returns_empty_string() {
        let (_, ext) = path_and_ext("https://x.supabase.co/storage/v1/object/sign/bin/no-ext");
        // No `.` in path → rsplit yields the whole path; ext won't match
        // any image type, so caller falls back to ResourceLink. The exact
        // value here is incidental but documenting the no-`.` case keeps
        // anyone refactoring the helper from re-introducing the bug.
        assert_ne!(ext, "jpg");
        assert_ne!(ext, "png");
    }
}

#[cfg(test)]
mod command_selection_tests {
    use super::should_use_claude_agent_acp_wrapper;

    #[test]
    fn claude_binary_name_uses_acp_wrapper() {
        assert!(should_use_claude_agent_acp_wrapper("claude"));
    }

    #[test]
    fn absolute_claude_path_uses_acp_wrapper() {
        assert!(should_use_claude_agent_acp_wrapper(
            "/Users/matt.chow/.local/bin/claude"
        ));
    }

    #[test]
    fn non_claude_binary_does_not_use_acp_wrapper() {
        assert!(!should_use_claude_agent_acp_wrapper(
            "/Users/matt.chow/.opencode/bin/opencode"
        ));
    }
}

#[cfg(test)]
mod spawn_path_tests {
    use super::{PATH_SEP, enriched_spawn_path};
    use std::path::Path;

    // Unix-specific: asserts the homebrew / ~/.local candidate dirs and the
    // `:` separator, which only apply on the non-windows branch.
    #[cfg(not(windows))]
    #[test]
    fn appends_homebrew_and_user_local_to_minimal_path() {
        // launchd hands amuxd this minimal PATH, which omits Homebrew and
        // ~/.local/bin where npx/opencode/claude live.
        let path = enriched_spawn_path(
            Some("/usr/bin:/bin:/usr/sbin:/sbin"),
            Some(Path::new("/Users/x")),
        );
        let dirs: Vec<&str> = path.split(':').collect();
        assert!(
            dirs.contains(&"/opt/homebrew/bin"),
            "missing homebrew bin: {path}"
        );
        assert!(
            dirs.contains(&"/Users/x/.local/bin"),
            "missing ~/.local/bin: {path}"
        );
        // Inherited entries keep priority (come first).
        assert!(
            path.starts_with("/usr/bin:/bin:/usr/sbin:/sbin"),
            "inherited PATH not first: {path}"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn dedupes_existing_entries() {
        let path = enriched_spawn_path(
            Some("/opt/homebrew/bin:/usr/bin"),
            Some(Path::new("/home/u")),
        );
        let count = path
            .split(':')
            .filter(|d| *d == "/opt/homebrew/bin")
            .count();
        assert_eq!(count, 1, "duplicate homebrew entry: {path}");
    }

    #[cfg(not(windows))]
    #[test]
    fn handles_missing_existing_path() {
        let path = enriched_spawn_path(None, Some(Path::new("/home/u")));
        assert!(path.split(':').any(|d| d == "/home/u/.local/bin"), "{path}");
        assert!(path.split(':').any(|d| d == "/opt/homebrew/bin"), "{path}");
    }

    #[test]
    fn uses_platform_path_separator() {
        let path = enriched_spawn_path(Some("/usr/bin"), None);
        let sep = if cfg!(windows) { ';' } else { ':' };
        assert!(path.contains(sep) || !path.contains(if cfg!(windows) { ':' } else { ';' }));
        // Confirm PATH_SEP matches the platform expectation.
        assert_eq!(PATH_SEP, sep);
    }
}

// ---------------------------------------------------------------------------
// Public API: long-lived ACP host (initialize once, many session/new)
// ---------------------------------------------------------------------------

struct ActiveSession {
    /// Prompt jobs: text, attachments, optional turn requester, optional reply_to.
    prompt_tx: mpsc::Sender<(String, Vec<String>, Option<String>, Option<String>)>,
}

fn build_acp_process_command(
    binary: &str,
    args: &[String],
    agent_type: amux::AgentType,
    extra_env: &HashMap<String, String>,
    force_env_keys: &std::collections::HashSet<String>,
) -> tokio::process::Command {
    let mut cmd = if should_use_claude_agent_acp_wrapper(binary) {
        let mut c = tokio::process::Command::new(npx_program());
        c.arg("--yes").arg("@zed-industries/claude-agent-acp");
        c
    } else if (agent_type == amux::AgentType::Opencode || agent_type == amux::AgentType::Codex)
        && args.is_empty()
    {
        let mut c = tokio::process::Command::new(binary);
        c.arg("acp");
        c
    } else {
        let mut c = tokio::process::Command::new(binary);
        c.args(args);
        c
    };
    // amuxd is usually launched by launchd/systemd with a minimal PATH that
    // omits Homebrew and ~/.local/bin, so the agent runtime (npx/opencode/
    // claude) can't be found and spawn fails with ENOENT. Enrich PATH before
    // applying caller-supplied env so a forced PATH override still wins.
    cmd.env(
        "PATH",
        enriched_spawn_path(
            std::env::var("PATH").ok().as_deref(),
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from)
                .as_deref(),
        ),
    );
    for (key, value) in extra_env {
        if force_env_keys.contains(key) || std::env::var_os(key).is_none() {
            cmd.env(key, value);
        }
    }
    cmd
}

/// Spawn a long-lived ACP host thread. Returns a command sender immediately;
/// `host_ready_tx` is fulfilled after ACP `initialize` completes.
pub fn spawn_acp_host(
    binary: String,
    args: Vec<String>,
    agent_type: amux::AgentType,
    extra_env: HashMap<String, String>,
    force_env_override: bool,
    host_worktree: Option<String>,
    host_ready_tx: oneshot::Sender<Result<(), String>>,
) -> crate::error::Result<mpsc::Sender<AcpCommand>> {
    let (cmd_tx, cmd_rx) = mpsc::channel::<AcpCommand>(64);

    std::thread::Builder::new()
        .name(format!("acp-host-{agent_type:?}"))
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to build tokio runtime for ACP host");

            let local_set = tokio::task::LocalSet::new();
            rt.block_on(local_set.run_until(async move {
                if let Err(e) = run_acp_host(
                    binary,
                    args,
                    agent_type,
                    extra_env,
                    force_env_override,
                    host_worktree,
                    cmd_rx,
                    host_ready_tx,
                )
                .await
                {
                    error!(error = %e, "ACP host failed");
                }
            }));
        })
        .map_err(|e| {
            crate::error::AmuxError::Agent(format!("failed to spawn ACP host thread: {}", e))
        })?;

    Ok(cmd_tx)
}

/// Attach a TeamClaw runtime to an initialized ACP host via `session/new`.
#[allow(clippy::too_many_arguments)]
async fn attach_acp_session_on_conn(
    conn: &acp::ClientSideConnection,
    registry: &Rc<RefCell<SessionRegistry>>,
    agent_type: amux::AgentType,
    worktree: &str,
    resume_acp_session_id: Option<String>,
    mcp_config_path: Option<PathBuf>,
    initial_model_override: Option<String>,
    event_tx: mpsc::Sender<AcpEventFrame>,
    is_gateway: bool,
    forbid_new_session_fallback: bool,
) -> anyhow::Result<AcpStartupMetadata> {
    let worktree_path = std::path::PathBuf::from(worktree);
    let mut acp_mcp_servers: Vec<acp::McpServer> = match mcp_config_path.as_ref() {
        Some(p) => match parse_mcp_config_to_acp(p) {
            Ok(Some(v)) => {
                info!(
                    ?agent_type,
                    worktree,
                    mcp_config_path = %p.display(),
                    server_names = ?mcp_server_names(&v),
                    "ACP attach parsed MCP config"
                );
                v
            }
            Ok(None) => {
                warn!(
                    ?agent_type,
                    worktree,
                    mcp_config_path = %p.display(),
                    "ACP attach MCP config had no mcpServers entries"
                );
                Vec::new()
            }
            Err(e) => {
                warn!(
                    ?agent_type,
                    worktree,
                    mcp_config_path = %p.display(),
                    error = %e,
                    "MCP config parse failed; continuing with baseline-only MCP if applicable"
                );
                Vec::new()
            }
        },
        None => Vec::new(),
    };
    strip_remote_tools_mcp_for_opencode(agent_type, &mut acp_mcp_servers);
    ensure_remote_tools_baseline_mcp(agent_type, &mut acp_mcp_servers);
    info!(
        ?agent_type,
        worktree,
        resume_acp_session_id = resume_acp_session_id.as_deref().unwrap_or(""),
        has_remote_tools = acp_mcp_servers
            .iter()
            .any(|server| mcp_server_name(server) == REMOTE_TOOLS_MCP_SERVER_NAME),
        server_names = ?mcp_server_names(&acp_mcp_servers),
        opencode_config = %opencode_remote_tools_config_summary(worktree),
        "ACP attach final MCP server set"
    );

    let build_new_req = |cwd: std::path::PathBuf| -> acp::NewSessionRequest {
        let mut req = acp::NewSessionRequest::new(cwd);
        if !acp_mcp_servers.is_empty() {
            req = req.mcp_servers(acp_mcp_servers.clone());
        }
        req
    };

    let build_resume_req =
        |resume_id: &str, cwd: std::path::PathBuf| -> acp::ResumeSessionRequest {
            let mut req =
                acp::ResumeSessionRequest::new(acp::SessionId::new(resume_id.to_string()), cwd);
            if !acp_mcp_servers.is_empty() {
                req = req.mcp_servers(acp_mcp_servers.clone());
            }
            req
        };

    let t_session = Instant::now();
    let (session_id, acp_lists) = if let Some(ref resume_id) = resume_acp_session_id {
        let resume_req = build_resume_req(resume_id, worktree_path.clone());
        match conn.resume_session(resume_req).await {
            Ok(resp) => {
                let sid = acp::SessionId::new(resume_id.clone());
                info!(
                    session_id = %sid,
                    resume_ms = t_session.elapsed().as_millis() as u64,
                    has_remote_tools = acp_mcp_servers
                        .iter()
                        .any(|server| mcp_server_name(server) == REMOTE_TOOLS_MCP_SERVER_NAME),
                    sent_mcp_servers = !acp_mcp_servers.is_empty(),
                    "ACP session resumed on host"
                );
                (sid, (resp.models, resp.config_options))
            }
            Err(e) => {
                if forbid_new_session_fallback {
                    return Err(anyhow::anyhow!(
                        "ACP resume_session failed (new_session fallback forbidden): {e}"
                    ));
                }
                warn!(
                    resume_id,
                    "ACP resume_session failed ({}), falling back to new_session", e
                );
                let resp = conn
                    .new_session(build_new_req(worktree_path.clone()))
                    .await
                    .map_err(|e| anyhow::anyhow!("ACP new_session failed: {}", e))?;
                let sid = resp.session_id.clone();
                info!(
                    session_id = %sid,
                    new_session_ms = t_session.elapsed().as_millis() as u64,
                    has_remote_tools = acp_mcp_servers
                        .iter()
                        .any(|server| mcp_server_name(server) == REMOTE_TOOLS_MCP_SERVER_NAME),
                    sent_mcp_servers = !acp_mcp_servers.is_empty(),
                    "ACP session created on host (fallback)"
                );
                (sid, (resp.models, resp.config_options))
            }
        }
    } else {
        let resp = conn
            .new_session(build_new_req(worktree_path))
            .await
            .map_err(|e| anyhow::anyhow!("ACP new_session failed: {}", e))?;
        let sid = resp.session_id.clone();
        info!(
            session_id = %sid,
            new_session_ms = t_session.elapsed().as_millis() as u64,
            has_remote_tools = acp_mcp_servers
                .iter()
                .any(|server| mcp_server_name(server) == REMOTE_TOOLS_MCP_SERVER_NAME),
            sent_mcp_servers = !acp_mcp_servers.is_empty(),
            "ACP session created on host"
        );
        (sid, (resp.models, resp.config_options))
    };

    let acp_session_key = session_id.to_string();
    registry.borrow_mut().sessions.insert(
        acp_session_key.clone(),
        SessionRoute {
            event_tx: event_tx.clone(),
            is_gateway,
            pending_permissions: HashMap::new(),
            turn_requester_actor_id: None,
            turn_reply_to_message_id: None,
            tool_progress_deduper: RefCell::new(ToolProgressDeduper::default()),
            notif_inflight: Rc::new(Cell::new(0)),
            notif_finished: Rc::new(Cell::new(0)),
        },
    );

    let (acp_model_state, acp_config_options) = acp_lists;
    let acp_current_model_id = crate::runtime::models::resolve_current_model_id(
        acp_model_state.as_ref(),
        acp_config_options.as_deref(),
    );
    let available_models = crate::runtime::models::resolve_available_models(
        agent_type,
        acp_model_state.as_ref(),
        acp_config_options.as_deref(),
    );
    info!(
        agent_type = ?agent_type,
        source = crate::runtime::models::available_models_source_label(
            acp_model_state.as_ref(),
            acp_config_options.as_deref(),
        ),
        count = available_models.len(),
        "available models resolved",
    );

    let initial_model: Option<String> = {
        let chosen = initial_model_override
            .clone()
            .or_else(|| acp_current_model_id.clone())
            .or_else(|| available_models.first().map(|m| m.id.clone()));
        match chosen {
            Some(model_id) if acp_current_model_id.as_ref() == Some(&model_id) => Some(model_id),
            Some(model_id) => {
                let req = acp::SetSessionModelRequest::new(
                    session_id.clone(),
                    acp::ModelId::new(model_id.clone()),
                );
                match conn.set_session_model(req).await {
                    Ok(_) => {
                        info!(model_id = %model_id, "ACP initial set_session_model applied");
                        Some(model_id)
                    }
                    Err(e) => {
                        warn!(error = %e, model_id = %model_id, "initial set_session_model failed");
                        acp_current_model_id.clone()
                    }
                }
            }
            None => None,
        }
    };

    Ok(AcpStartupMetadata {
        available_models,
        initial_model,
        acp_session_id: acp_session_key,
    })
}

fn spawn_prompt_worker(
    conn: Rc<acp::ClientSideConnection>,
    session_id: acp::SessionId,
    event_tx: mpsc::Sender<AcpEventFrame>,
    registry: Rc<RefCell<SessionRegistry>>,
    mut prompt_rx: mpsc::Receiver<(String, Vec<String>, Option<String>, Option<String>)>,
) {
    let acp_session_key = session_id.to_string();
    tokio::task::spawn_local(async move {
        // Watchdog for a wedged prompt RPC. An ACP host (e.g. opencode) can
        // silently retry a failing upstream — a gateway 500 or rate-limit — for
        // minutes without ever resolving `prompt()`, leaving the turn pinned in
        // Active with no client-visible error while the UI spins on "Replying"
        // forever. When the notification pipeline shows no forward progress for
        // this long (and the agent is not blocked on a user permission prompt),
        // we surface a terminal error and close the turn. Override via
        // AMUXD_PROMPT_STALL_TIMEOUT_SECS; 0 disables the watchdog.
        let stall_timeout = std::env::var("AMUXD_PROMPT_STALL_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(Duration::from_secs)
            .unwrap_or_else(|| Duration::from_secs(90));
        while let Some((text, attachment_urls, requester_actor_id, reply_to_message_id)) =
            prompt_rx.recv().await
        {
            // Bind collab turn stamps to THIS worker iteration only — never at
            // Prompt enqueue time, or a queued second prompt would overwrite
            // the in-flight turn's stamp.
            let turn_reply_to = reply_to_message_id.filter(|id| !id.is_empty());
            if let Some(route) = registry.borrow_mut().resolve_event_route_mut(&acp_session_key)
            {
                route.turn_requester_actor_id =
                    requester_actor_id.filter(|id| !id.is_empty());
                route.turn_reply_to_message_id = turn_reply_to.clone();
            }

            let attachment_count = attachment_urls.len();
            super::agent_trace::log_prompt_begin(&acp_session_key, &text, attachment_count);
            let turn_started = Instant::now();

            let status_active = amux::AcpEvent {
                event: Some(amux::acp_event::Event::StatusChange(
                    amux::AcpStatusChange {
                        old_status: amux::AgentStatus::Idle as i32,
                        new_status: amux::AgentStatus::Active as i32,
                    },
                )),
                model: String::new(),
            };
            super::agent_trace::log_acp_event(&acp_session_key, &status_active);
            let _ = event_tx
                .send(
                    AcpEventFrame::new(acp_session_key.clone(), status_active)
                        .with_reply_to(turn_reply_to.clone()),
                )
                .await;

            let mut blocks: Vec<acp::ContentBlock> = vec![text.into()];
            for url in &attachment_urls {
                match build_attachment_block(url).await {
                    Ok(block) => blocks.push(block),
                    Err(e) => warn!(url = %url, err = %e, "attachment fetch failed; skipping"),
                }
            }

            let prompt_fut = conn.prompt(acp::PromptRequest::new(session_id.clone(), blocks));
            tokio::pin!(prompt_fut);

            // `true` once the watchdog gives up on a wedged prompt; suppresses
            // the normal result handling below so we surface a single, clear
            // provider-stall error instead.
            let mut stalled = false;
            let result: Option<_> = if stall_timeout.is_zero() {
                Some(prompt_fut.await)
            } else {
                const STALL_TICK: Duration = Duration::from_secs(1);
                // Seed the activity cursor from the current completion count;
                // any forward movement (a streamed chunk, thought, or tool
                // update) restarts the stall window.
                let mut last_finished = registry
                    .borrow()
                    .sessions
                    .get(&acp_session_key)
                    .map(|r| r.notif_finished.get());
                let mut last_activity = Instant::now();
                loop {
                    tokio::select! {
                        r = &mut prompt_fut => break Some(r),
                        _ = tokio::time::sleep(STALL_TICK) => {
                            let (finished, pending_permission) = {
                                let reg = registry.borrow();
                                match reg.sessions.get(&acp_session_key) {
                                    Some(r) => (
                                        Some(r.notif_finished.get()),
                                        !r.pending_permissions.is_empty(),
                                    ),
                                    None => (None, false),
                                }
                            };
                            // Fresh notification activity, or a pending
                            // permission request (the agent is legitimately
                            // waiting on the user), resets the stall clock.
                            if finished != last_finished || pending_permission {
                                last_finished = finished;
                                last_activity = Instant::now();
                            } else if last_activity.elapsed() >= stall_timeout {
                                stalled = true;
                                break None;
                            }
                        }
                    }
                }
            };

            // Every prompt completion — success, provider error, cancel/abort,
            // or a watchdog-detected stall — must close the turn with
            // Active→Idle so clients can finalize partial streaming content.
            await_notifications_drained(&registry, &acp_session_key).await;
            let status_idle = amux::AcpEvent {
                event: Some(amux::acp_event::Event::StatusChange(
                    amux::AcpStatusChange {
                        old_status: amux::AgentStatus::Active as i32,
                        new_status: amux::AgentStatus::Idle as i32,
                    },
                )),
                model: String::new(),
            };
            super::agent_trace::log_acp_event(&acp_session_key, &status_idle);
            let _ = event_tx
                .send(
                    AcpEventFrame::new(acp_session_key.clone(), status_idle)
                        .with_reply_to(turn_reply_to.clone()),
                )
                .await;

            // Clear collab turn stamps so they cannot leak into the next turn.
            if let Some(route) = registry.borrow_mut().resolve_event_route_mut(&acp_session_key) {
                route.turn_requester_actor_id = None;
                route.turn_reply_to_message_id = None;
            }

            let elapsed_ms = turn_started.elapsed().as_millis() as u64;
            if stalled {
                let details = format!(
                    "The model provider stopped responding (no activity for {}s). \
                     It may be unavailable or rate-limited — retry or switch models.",
                    stall_timeout.as_secs()
                );
                super::agent_trace::log_prompt_end(&acp_session_key, false, &details, elapsed_ms);
                emit_acp_error(
                    &event_tx,
                    &acp_session_key,
                    "Model provider not responding",
                    details,
                )
                .await;
                // Best-effort: tell the host to abandon the wedged turn so it
                // stops burning the upstream. Ignored if the host does not
                // support cancel.
                if let Err(e) = conn
                    .cancel(acp::CancelNotification::new(session_id.clone()))
                    .await
                {
                    warn!(session = %acp_session_key, error = %e, "cancel after prompt stall failed");
                }
            } else if let Some(result) = result {
                match result {
                    Ok(_) => {
                        super::agent_trace::log_prompt_end(&acp_session_key, true, "", elapsed_ms);
                    }
                    Err(e) => {
                        let details = format!("ACP prompt failed: {e}");
                        super::agent_trace::log_prompt_end(
                            &acp_session_key,
                            false,
                            &details,
                            elapsed_ms,
                        );
                        emit_acp_error(&event_tx, &acp_session_key, "ACP prompt failed", details)
                            .await;
                    }
                }
            }
        }
    });
}

/// Long-lived ACP host: `initialize` once, then `session/new` per AttachSession.
async fn run_acp_host(
    binary: String,
    args: Vec<String>,
    agent_type: amux::AgentType,
    extra_env: HashMap<String, String>,
    force_env_override: bool,
    host_worktree: Option<String>,
    mut cmd_rx: mpsc::Receiver<AcpCommand>,
    host_ready_tx: oneshot::Sender<Result<(), String>>,
) -> anyhow::Result<()> {
    let force_env_keys: std::collections::HashSet<String> = if force_env_override {
        extra_env.keys().cloned().collect()
    } else {
        std::collections::HashSet::new()
    };
    let mut cmd =
        build_acp_process_command(&binary, &args, agent_type, &extra_env, &force_env_keys);
    let host_cwd = host_worktree
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(".");
    let sock_path = crate::config::DaemonConfig::sock_path();
    let current_exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|e| format!("current_exe_error={e}"));
    info!(
        ?agent_type,
        binary = %binary,
        args = ?args,
        host_cwd,
        current_exe = %current_exe,
        sock = %sock_path.display(),
        opencode_config = %opencode_remote_tools_config_summary(host_cwd),
        "ACP host spawning process"
    );
    let mut child = cmd
        .current_dir(host_cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| anyhow::anyhow!("spawn ACP host: {}", e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdout"))?;

    if let Some(stderr) = child.stderr.take() {
        tokio::task::spawn_local(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                warn!(target: "acp_stderr", "{}", line);
            }
        });
    }

    info!(
        binary = %binary,
        agent_type = ?agent_type,
        host_cwd,
        "ACP host process spawned"
    );

    let registry = Rc::new(RefCell::new(SessionRegistry::default()));
    let client = AmuxClient {
        registry: registry.clone(),
    };

    let (conn, handle_io) =
        acp::ClientSideConnection::new(client, stdin.compat_write(), stdout.compat(), |fut| {
            tokio::task::spawn_local(fut);
        });

    let (fatal_tx, mut fatal_rx) = mpsc::channel::<String>(4);
    let io_fatal_tx = fatal_tx.clone();
    tokio::task::spawn_local(async move {
        let message = match handle_io.await {
            Ok(()) => "ACP IO task ended".to_string(),
            Err(e) => format!("ACP IO task ended: {e}"),
        };
        warn!("{}", message);
        let _ = io_fatal_tx.send(message).await;
    });

    let t_init = Instant::now();
    conn.initialize(
        acp::InitializeRequest::new(acp::ProtocolVersion::V1)
            .client_info(acp::Implementation::new("amuxd", "0.1.0").title("AMUX Daemon")),
    )
    .await
    .map_err(|e| anyhow::anyhow!("ACP initialize failed: {}", e))?;

    info!(
        agent_type = ?agent_type,
        initialize_ms = t_init.elapsed().as_millis() as u64,
        "ACP host initialized"
    );
    let _ = host_ready_tx.send(Ok(()));

    let conn = Rc::new(conn);
    let mut active_sessions: HashMap<String, ActiveSession> = HashMap::new();

    let child_wait = child.wait();
    tokio::pin!(child_wait);
    loop {
        tokio::select! {
            maybe_cmd = cmd_rx.recv() => {
                let Some(cmd) = maybe_cmd else {
                    break;
                };
                match cmd {
                    AcpCommand::AttachSession {
                        worktree,
                        resume_acp_session_id,
                        mcp_config_path,
                        initial_model_override,
                        initial_prompt,
                        event_tx,
                        startup_tx,
                        is_gateway,
                        forbid_new_session_fallback,
                    } => {
                        let startup_reporter: StartupReporter =
                            Arc::new(Mutex::new(Some(startup_tx)));
                        let attach_session_label = resume_acp_session_id
                            .as_deref()
                            .unwrap_or("new-session")
                            .to_string();
                        if let Some(resume_id) = resume_acp_session_id.as_deref() {
                            if let Some(active) = active_sessions.get(resume_id) {
                                info!(
                                    session_id = %resume_id,
                                    "ACP attach skipped: session already active on host"
                                );
                                report_startup(
                                    &startup_reporter,
                                    Ok(AcpStartupMetadata {
                                        available_models: crate::runtime::models::available_models_for(agent_type),
                                        initial_model: None,
                                        acp_session_id: resume_id.to_string(),
                                    }),
                                );
                                if !initial_prompt.is_empty() {
                                    let _ = active
                                        .prompt_tx
                                        .send((initial_prompt, Vec::new(), None, None))
                                        .await;
                                }
                                continue;
                            }
                        }
                        let attach_result = attach_acp_session_on_conn(
                            &conn,
                            &registry,
                            agent_type,
                            &worktree,
                            resume_acp_session_id,
                            mcp_config_path,
                            initial_model_override,
                            event_tx.clone(),
                            is_gateway,
                            forbid_new_session_fallback,
                        )
                        .await;

                        match attach_result {
                            Ok(meta) => {
                                let acp_sid = meta.acp_session_id.clone();
                                let session_id = acp::SessionId::new(acp_sid.clone());
                                let (prompt_tx, prompt_rx) =
                                    mpsc::channel::<(String, Vec<String>, Option<String>, Option<String>)>(64);
                                spawn_prompt_worker(
                                    conn.clone(),
                                    session_id,
                                    event_tx.clone(),
                                    registry.clone(),
                                    prompt_rx,
                                );
                                active_sessions.insert(acp_sid.clone(), ActiveSession { prompt_tx });
                                report_startup(&startup_reporter, Ok(meta));
                                if !initial_prompt.is_empty() {
                                    if let Some(active) = active_sessions.get(&acp_sid) {
                                        let _ = active
                                            .prompt_tx
                                            .send((initial_prompt, Vec::new(), None, None))
                                            .await;
                                    }
                                }
                            }
                            Err(e) => {
                                let details = format!("{e:#}");
                                report_startup(&startup_reporter, Err(details.clone()));
                                let session_label = attach_session_label.as_str();
                                emit_acp_error(
                                    &event_tx,
                                    session_label,
                                    "ACP attach failed",
                                    details,
                                )
                                .await;
                            }
                        }
                    }
                    AcpCommand::Prompt {
                        acp_session_id,
                        text,
                        attachment_urls,
                        requester_actor_id,
                        reply_to_message_id,
                    } => {
                        if let Some(active) = active_sessions.get(&acp_session_id) {
                            if active
                                .prompt_tx
                                .send((text, attachment_urls, requester_actor_id, reply_to_message_id))
                                .await
                                .is_err()
                            {
                                if let Some(route) = registry.borrow().sessions.get(&acp_session_id) {
                                    emit_acp_error(
                                        &route.event_tx,
                                        &acp_session_id,
                                        "ACP prompt failed",
                                        "ACP prompt worker stopped",
                                    )
                                    .await;
                                }
                            }
                        } else {
                            warn!(acp_session_id, "prompt for unknown session");
                        }
                    }
                    AcpCommand::Cancel { acp_session_id } => {
                        match conn
                            .cancel(acp::CancelNotification::new(acp::SessionId::new(
                                acp_session_id.clone(),
                            )))
                            .await
                        {
                            Ok(()) => {
                                super::agent_trace::log_cancel(&acp_session_id, true, "");
                            }
                            Err(e) => {
                                let err = e.to_string();
                                super::agent_trace::log_cancel(&acp_session_id, false, &err);
                                warn!(acp_session_id = %acp_session_id, error = %err, "ACP cancel failed");
                            }
                        }
                    }
                    AcpCommand::ResolvePermission {
                        request_id,
                        granted,
                        option_id,
                    } => {
                        resolve_permission_in_registry(
                            &registry,
                            &request_id,
                            granted,
                            option_id,
                        );
                    }
                    AcpCommand::SetModel { acp_session_id, model_id } => {
                        let req = acp::SetSessionModelRequest::new(
                            acp::SessionId::new(acp_session_id.clone()),
                            acp::ModelId::new(model_id.clone()),
                        );
                        if let Err(e) = conn.set_session_model(req).await {
                            warn!(error = %e, model_id = %model_id, "set_session_model failed");
                        } else {
                            info!(model_id = %model_id, "set_session_model applied");
                        }
                    }
                    AcpCommand::DetachSession { acp_session_id } => {
                        active_sessions.remove(&acp_session_id);
                        registry.borrow_mut().detach_session(&acp_session_id);
                        info!(acp_session_id, "ACP session detached from host");
                    }
                    AcpCommand::Shutdown => {
                        info!("ACP host shutting down");
                        break;
                    }
                }
            }
            Some(message) = fatal_rx.recv() => {
                return Err(anyhow::anyhow!(message));
            }
            status = &mut child_wait => {
                let message = match status {
                    Ok(status) => format!("ACP host process exited: {status}"),
                    Err(e) => format!("ACP host process wait failed: {e}"),
                };
                return Err(anyhow::anyhow!(message));
            }
        }
    }

    info!(agent_type = ?agent_type, "ACP host thread exiting");
    Ok(())
}

/// Legacy single-session helper used by the `amuxd acp` debug CLI.
/// Production runtimes attach via [`AcpHostPool`] instead.
#[allow(clippy::too_many_arguments)]
pub fn spawn_acp_agent(
    binary: String,
    args: Vec<String>,
    worktree: String,
    initial_prompt: String,
    agent_type: amux::AgentType,
    event_tx: mpsc::Sender<AcpEventFrame>,
    resume_acp_session_id: Option<String>,
    startup_tx: oneshot::Sender<Result<AcpStartupMetadata, String>>,
    initial_model_override: Option<String>,
    mcp_config_path: Option<PathBuf>,
    extra_env: HashMap<String, String>,
) -> crate::error::Result<mpsc::Sender<AcpCommand>> {
    let (host_ready_tx, host_ready_rx) = oneshot::channel();
    let cmd_tx = spawn_acp_host(
        binary,
        args,
        agent_type,
        extra_env,
        false,
        Some(worktree.clone()),
        host_ready_tx,
    )?;
    let host_cmd = cmd_tx.clone();
    std::thread::Builder::new()
        .name("acp-cli-attach".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("cli attach runtime");
            rt.block_on(async move {
                if host_ready_rx.await.ok().and_then(|r| r.ok()).is_some() {
                    let _ = host_cmd
                        .send(AcpCommand::AttachSession {
                            worktree,
                            resume_acp_session_id,
                            mcp_config_path,
                            initial_model_override,
                            initial_prompt,
                            event_tx,
                            startup_tx,
                            is_gateway: false,
                            forbid_new_session_fallback: false,
                        })
                        .await;
                }
            });
        })
        .map_err(|e| {
            crate::error::AmuxError::Agent(format!("failed to spawn CLI attach thread: {}", e))
        })?;
    Ok(cmd_tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_progress_deduper_drops_identical_in_progress_updates_only() {
        let mut deduper = ToolProgressDeduper::default();
        let first = acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::InProgress)
                .title("long command")
                .content(vec!["No output".into()]),
        ));
        let duplicate = acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::InProgress)
                .title("long command")
                .content(vec!["No output".into()]),
        ));
        let changed = acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::InProgress)
                .title("long command")
                .content(vec!["1%".into()]),
        ));
        let completed = acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("long command")
                .content(vec!["done".into()]),
        ));

        assert!(!deduper.should_drop(&first));
        assert!(deduper.should_drop(&duplicate));
        assert!(!deduper.should_drop(&changed));
        assert!(!deduper.should_drop(&completed));
    }

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

    #[test]
    fn tool_use_wire_fields_preserves_glob_title_not_grep_canonical() {
        let (tool_name, params) = tool_use_wire_fields(
            "glob",
            Some(&serde_json::json!({ "pattern": "**/*.ts", "path": "." })),
        );
        assert_eq!(tool_name, "glob");
        assert_eq!(params.get("pattern"), Some(&"**/*.ts".to_string()));
        assert!(!params.contains_key("description"));
    }

    #[test]
    fn tool_use_wire_fields_preserves_acp_title_for_execute() {
        let (tool_name, params) = tool_use_wire_fields(
            "Execute ps command",
            Some(&serde_json::json!({ "command": "ps aux" })),
        );
        assert_eq!(tool_name, "Execute ps command");
        assert_eq!(params.get("command"), Some(&"ps aux".to_string()));
        assert!(!params.contains_key("description"));
    }

    #[test]
    fn codex_attach_gets_remote_tools_baseline_mcp() {
        let mut servers = Vec::new();

        ensure_remote_tools_baseline_mcp(amux::AgentType::Codex, &mut servers);

        assert!(
            servers
                .iter()
                .any(|server| { mcp_server_name(server) == REMOTE_TOOLS_MCP_SERVER_NAME })
        );
    }

    #[test]
    fn opencode_attach_strips_remote_tools_mcp() {
        let mut servers = vec![acp::McpServer::Stdio(acp::McpServerStdio::new(
            REMOTE_TOOLS_MCP_SERVER_NAME,
            "/bin/echo",
        ))];

        strip_remote_tools_mcp_for_opencode(amux::AgentType::Opencode, &mut servers);

        assert!(
            servers
                .iter()
                .all(|server| { mcp_server_name(server) != REMOTE_TOOLS_MCP_SERVER_NAME })
        );
    }

    #[test]
    fn opencode_desktop_attach_does_not_drop_plugin_remote_tools() {
        #[derive(Default)]
        struct FakeOpenCodeHost {
            global_tools: Vec<String>,
            next_remote_tools_registration_succeeds: bool,
        }

        impl FakeOpenCodeHost {
            fn seed_workspace_remote_tools(&mut self) {
                self.global_tools = vec![format!(
                    "{}_{}",
                    REMOTE_TOOLS_MCP_SERVER_NAME, "get_page_dom"
                )];
            }

            fn tools_list(&self) -> &[String] {
                &self.global_tools
            }

            fn attach(&mut self, agent_type: amux::AgentType, servers: &mut Vec<acp::McpServer>) {
                strip_remote_tools_mcp_for_opencode(agent_type, servers);
                ensure_remote_tools_baseline_mcp(agent_type, servers);

                if servers
                    .iter()
                    .any(|server| mcp_server_name(server) == REMOTE_TOOLS_MCP_SERVER_NAME)
                {
                    if self.next_remote_tools_registration_succeeds {
                        self.seed_workspace_remote_tools();
                    } else {
                        self.global_tools.clear();
                    }
                }
            }
        }

        let mut host = FakeOpenCodeHost {
            global_tools: Vec::new(),
            next_remote_tools_registration_succeeds: false,
        };
        host.seed_workspace_remote_tools();

        let mut plugin_attach_servers = Vec::new();
        host.attach(amux::AgentType::Opencode, &mut plugin_attach_servers);
        assert!(
            host.tools_list()
                .contains(&"amuxd-remote-tools_get_page_dom".to_string()),
            "plugin session tools/list starts with remote-tools from workspace opencode.json"
        );

        let mut desktop_attach_servers = vec![acp::McpServer::Stdio(acp::McpServerStdio::new(
            REMOTE_TOOLS_MCP_SERVER_NAME,
            "/bin/false",
        ))];
        host.attach(amux::AgentType::Opencode, &mut desktop_attach_servers);

        assert!(
            host.tools_list()
                .contains(&"amuxd-remote-tools_get_page_dom".to_string()),
            "desktop session attach must not re-register amuxd-remote-tools and clear plugin tools/list"
        );
        assert!(
            desktop_attach_servers
                .iter()
                .all(|server| mcp_server_name(server) != REMOTE_TOOLS_MCP_SERVER_NAME),
            "OpenCode receives no per-session amuxd-remote-tools MCP"
        );
    }

    #[test]
    fn translates_tool_call_update_raw_input_to_tool_use_update() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .kind(acp::ToolKind::Search)
                .title("grep")
                .raw_input(serde_json::json!({
                    "pattern": "MQTT",
                    "path": "apps/daemon/src"
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolUse(tool) => {
                assert_eq!(tool.tool_id, "tool-1");
                assert_eq!(tool.tool_name, "grep");
                assert_eq!(tool.params.get("pattern"), Some(&"MQTT".to_string()));
                assert_eq!(
                    tool.params.get("path"),
                    Some(&"apps/daemon/src".to_string())
                );
                assert!(tool.description.is_empty());
                assert!(!tool.params.contains_key("description"));
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn forwards_diff_content_in_tool_use_update() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .kind(acp::ToolKind::Edit)
                .status(acp::ToolCallStatus::InProgress)
                .content(vec![
                    acp::Diff::new("src/a.ts", "new\n").old_text("old\n").into(),
                ]),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolUse(tool) => {
                assert_eq!(tool.tool_id, "tool-1");
                assert_eq!(tool.content.len(), 1);
                match tool.content[0].payload.as_ref().expect("payload") {
                    amux::acp_tool_call_content::Payload::Diff(diff) => {
                        assert_eq!(diff.path, "src/a.ts");
                        assert_eq!(diff.old_text.as_deref(), Some("old\n"));
                        assert_eq!(diff.new_text, "new\n");
                    }
                    other => panic!("unexpected payload: {:?}", other),
                }
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn completed_tool_result_forwards_diff_content() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("Edit src/a.ts")
                .content(vec![
                    acp::Diff::new("src/a.ts", "new\n").old_text("old\n").into(),
                ]),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(result.success);
                assert_eq!(result.content.len(), 1);
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn tool_call_update_with_content_only_emits_tool_use_without_title() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .kind(acp::ToolKind::Edit)
                .status(acp::ToolCallStatus::InProgress)
                .content(vec![
                    acp::Diff::new("src/a.ts", "new\n").old_text("old\n").into(),
                ]),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolUse(tool) => {
                assert_eq!(tool.tool_id, "tool-1");
                assert!(tool.tool_name.is_empty());
                assert!(tool.description.is_empty());
                assert!(tool.params.is_empty());
                assert_eq!(tool.tool_kind, "edit");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_completed_tool_call_raw_output_to_result_summary() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("Execute ps command")
                .raw_output(serde_json::json!({
                    "output": "pid command\n1 launchd"
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(result.success);
                assert_eq!(result.summary, "pid command\n1 launchd");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_completed_tool_call_metadata_output_to_result_summary() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("List top processes")
                .raw_output(serde_json::json!({
                    "metadata": {
                        "output": "TC_STDOUT_MARKER_20260525\n",
                        "exit": 0,
                        "description": "List top processes",
                        "truncated": false
                    }
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(result.success);
                assert_eq!(result.summary, "TC_STDOUT_MARKER_20260525\n");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_opencode_completed_tool_call_output_to_result_summary() {
        let update = acp::ToolCallUpdate::new(
            "call_00_c8LarilfiBvzfOzS2oLQ3075",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("Top 10 processes by CPU")
                .content(vec!["PID %CPU COMM\n50369 opencode\n".into()])
                .raw_output(serde_json::json!({
                    "output": "PID %CPU COMM\n50369 opencode\n",
                    "metadata": {
                        "output": "PID %CPU COMM\n50369 opencode\n",
                        "exit": 0,
                        "description": "Top 10 processes by CPU",
                        "truncated": false
                    }
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "call_00_c8LarilfiBvzfOzS2oLQ3075");
                assert!(result.success);
                assert_eq!(result.summary, "PID %CPU COMM\n50369 opencode\n");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn completed_tool_call_empty_metadata_output_has_empty_result_summary() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("List top processes")
                .raw_output(serde_json::json!({
                    "metadata": {
                        "output": "",
                        "exit": 0,
                        "description": "List top processes",
                        "truncated": false
                    }
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(result.success);
                assert_eq!(result.summary, "");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_completed_tool_call_content_to_result_summary() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("Execute ps command")
                .content(vec!["pid command\n1 launchd".into()]),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(result.success);
                assert_eq!(result.summary, "pid command\n1 launchd");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_completed_tool_call_nested_raw_content_to_result_summary() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("Execute ps command")
                .raw_output(serde_json::json!({
                    "content": [
                        {
                            "type": "content",
                            "content": {
                                "type": "text",
                                "text": "pid command\n1 launchd"
                            }
                        }
                    ]
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(result.success);
                assert_eq!(result.summary, "pid command\n1 launchd");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_completed_tool_call_stdout_stderr_to_result_summary() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Failed)
                .title("Execute failing command")
                .raw_output(serde_json::json!({
                    "stdout": "before failure",
                    "stderr": "permission denied"
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(!result.success);
                assert_eq!(result.summary, "before failure\npermission denied");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn completed_tool_call_diff_content_does_not_use_full_replacement_as_summary() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("Edit src/main.rs")
                .content(vec![acp::Diff::new("src/main.rs", "fn main() {}\n").into()]),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(result.success);
                assert_eq!(result.summary, "Edit src/main.rs");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_task_in_progress_raw_output_metadata() {
        let update = acp::ToolCallUpdate::new(
            "task-us",
            acp::ToolCallUpdateFields::new()
                .kind(acp::ToolKind::Other)
                .status(acp::ToolCallStatus::InProgress)
                .title("US markets")
                .raw_output(serde_json::json!({
                    "metadata": {
                        "sessionId": "ses_child_us",
                        "parentSessionId": "ses_root"
                    }
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolUse(tool) => {
                assert_eq!(tool.tool_id, "task-us");
                assert!(tool.raw_output_json.contains("ses_child_us"));
                assert!(tool.raw_output_json.contains("ses_root"));
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn stamps_requester_actor_id_when_present() {
        let mut params = HashMap::from([("command".to_string(), "ls".to_string())]);
        stamp_requester_actor_id(&mut params, Some("actor-a"));
        assert_eq!(
            params.get("requester_actor_id").map(String::as_str),
            Some("actor-a")
        );
        assert_eq!(params.get("command").map(String::as_str), Some("ls"));
    }

    #[test]
    fn stamp_requester_skips_empty() {
        let mut params = HashMap::new();
        stamp_requester_actor_id(&mut params, Some(""));
        stamp_requester_actor_id(&mut params, None);
        assert!(!params.contains_key("requester_actor_id"));
    }

    #[test]
    fn detach_session_prunes_child_to_root_aliases() {
        let (event_tx, _rx) = mpsc::channel(1);
        let mut reg = SessionRegistry::default();
        reg.sessions.insert(
            "root-1".into(),
            SessionRoute {
                event_tx,
                is_gateway: false,
                pending_permissions: HashMap::new(),
                turn_requester_actor_id: None,
                turn_reply_to_message_id: None,
                tool_progress_deduper: RefCell::new(ToolProgressDeduper::default()),
                notif_inflight: Rc::new(Cell::new(0)),
                notif_finished: Rc::new(Cell::new(0)),
            },
        );
        reg.register_child_session("child-1".into(), "root-1".into());
        reg.register_child_session("child-2".into(), "root-2".into());
        assert!(reg.resolve_event_route("child-1").is_some());

        reg.detach_session("root-1");
        assert!(reg.resolve_event_route("child-1").is_none());
        assert!(reg.resolve_event_route("root-1").is_none());

        reg.detach_session("child-2");
        assert!(reg.resolve_event_route("child-2").is_none());
    }
}

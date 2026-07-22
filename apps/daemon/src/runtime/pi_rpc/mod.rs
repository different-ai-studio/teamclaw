//! pi coding-agent RPC backend (`pi --mode rpc`, badlogic/pi-mono).
//!
//! Peer of `runtime/opencode_http/` behind the [`AgentBackend`] trait: one pi
//! child per worktree (JSONL over stdin/stdout), sessions persisted under
//! `~/.amuxd/pi-sessions/<worktree-hash>/`, events translated into the same
//! `amux::AcpEvent` vocabulary. See `docs/architecture/pi-agent-backend.md`.
//!
//! Permission approvals ride the pi extension UI dialog channel: the TeamClaw
//! pi extension (separate deliverable) emits `extension_ui_request(confirm)`;
//! this backend surfaces those as `AcpPermissionRequest` and writes the
//! resolution back as `extension_ui_response`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::backend::{AcpCommand, AcpStartupMetadata, AgentBackend};
use crate::runtime::manager::AgentLaunchConfig;
use crate::runtime::opencode_http::translate::status_change;

pub mod client;
mod events;
pub mod process;
pub mod translate;

use process::PiProcessPool;
use translate::TranslateState;

/// Prefix for pi acp session ids; the remainder is the pi session file path
/// (self-contained, so resume after a daemon restart needs no extra state).
const SESSION_ID_PREFIX: &str = "pi:";

pub(crate) struct Route {
    pub(crate) event_tx: mpsc::Sender<AcpEventFrame>,
    pub(crate) is_gateway: bool,
    /// Canonical worktree the session's process runs in.
    pub(crate) worktree: String,
    /// pi session file path (switch_session target).
    pub(crate) session_path: String,
    pub(crate) turn_active: bool,
    pub(crate) turn_reply_to: Option<String>,
    pub(crate) turn_requester: Option<String>,
    pub(crate) translate: TranslateState,
}

/// Bookkeeping for a pending `extension_ui_request(confirm)`: enough to route
/// the reply and to persist an "always allow" grant.
pub(crate) struct PendingPermission {
    pub(crate) session_id: String,
    /// `teamclaw.always-pattern=` trailer from the confirm message; written to
    /// the worktree's rules file when the host resolves with option "always".
    pub(crate) always_pattern: Option<String>,
}

pub(crate) struct Shared {
    pub(crate) pool: PiProcessPool,
    /// acp session id → route.
    pub(crate) routes: parking_lot::Mutex<HashMap<String, Route>>,
    /// extension_ui_request id → pending permission bookkeeping.
    pub(crate) permissions: parking_lot::Mutex<HashMap<String, PendingPermission>>,
}

impl Shared {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            pool: PiProcessPool::new(),
            routes: parking_lot::Mutex::new(HashMap::new()),
            permissions: parking_lot::Mutex::new(HashMap::new()),
        })
    }
}

fn canonical_dir(worktree: &str) -> String {
    std::fs::canonicalize(worktree)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| worktree.to_string())
}

/// Flatten a `get_available_models` response into `amux::ModelInfo`s with
/// `provider/model` ids (the id shape clients and manager already use).
fn models_from_response(response: &serde_json::Value) -> Vec<amux::ModelInfo> {
    let Some(models) = response.pointer("/data/models").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|m| {
            let provider = m.get("provider").and_then(|v| v.as_str()).unwrap_or("");
            let model_id = m
                .get("id")
                .or_else(|| m.get("modelId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if model_id.is_empty() {
                return None;
            }
            let id = if provider.is_empty() {
                model_id.to_string()
            } else {
                format!("{provider}/{model_id}")
            };
            Some(amux::ModelInfo {
                display_name: m
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(model_id)
                    .to_string(),
                provider_name: provider.to_string(),
                id,
            })
        })
        .collect()
}

/// `provider/model` id → pi `set_model` fields (split at the first '/').
fn split_model_id(model_id: &str) -> Option<(String, String)> {
    let (provider, model) = model_id.split_once('/')?;
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    Some((provider.to_string(), model.to_string()))
}

/// Extract the `amuxd-remote-tools` server launch command from an amuxd MCP
/// config value (`{"mcpServers": {"amuxd-remote-tools": {"command", "args"}}}`,
/// the shape `remote_tools::mcp_config` writes). Returned as a JSON array
/// string, the `TEAMCLAW_REMOTE_TOOLS_CMD` contract of the pi extension.
fn remote_tools_cmd_from_value(root: &serde_json::Value) -> Option<String> {
    // Literal name (= remote_tools::REMOTE_TOOLS_MCP_SERVER_NAME); kept local
    // so the integration-test harness need not pull in the remote_tools tree.
    let server = root.get("mcpServers")?.get("amuxd-remote-tools")?;
    let command = server.get("command").and_then(|v| v.as_str())?;
    let mut cmd = vec![serde_json::json!(command)];
    if let Some(args) = server.get("args").and_then(|v| v.as_array()) {
        cmd.extend(args.iter().filter(|a| a.is_string()).cloned());
    }
    Some(serde_json::Value::Array(cmd).to_string())
}

fn remote_tools_cmd_from_mcp_config(path: &Path) -> Option<String> {
    let body = std::fs::read_to_string(path).ok()?;
    let root: serde_json::Value = serde_json::from_str(&body).ok()?;
    remote_tools_cmd_from_value(&root)
}

/// Current model id (`provider/model`) from a `get_state` response.
fn model_from_state(state: &serde_json::Value) -> Option<String> {
    let model = state.pointer("/data/model")?;
    let provider = model.get("provider").and_then(|v| v.as_str())?;
    let id = model
        .get("id")
        .or_else(|| model.get("modelId"))
        .and_then(|v| v.as_str())?;
    Some(format!("{provider}/{id}"))
}

// ---------------------------------------------------------------------------
// Attach / prompt / command loop
// ---------------------------------------------------------------------------

struct AttachArgs {
    worktree: String,
    resume_acp_session_id: Option<String>,
    mcp_config_path: Option<PathBuf>,
    initial_model_override: Option<String>,
    event_tx: mpsc::Sender<AcpEventFrame>,
    is_gateway: bool,
    forbid_new_session_fallback: bool,
}

async fn attach(shared: &Arc<Shared>, args: AttachArgs) -> Result<AcpStartupMetadata, String> {
    let worktree = canonical_dir(&args.worktree);
    // Export the remote-tools MCP bridge command to the TeamClaw extension
    // before (possibly) spawning; env is applied at spawn time.
    if let Some(cmd_json) = args
        .mcp_config_path
        .as_deref()
        .and_then(remote_tools_cmd_from_mcp_config)
    {
        shared.pool.set_remote_tools_cmd(cmd_json);
    }
    let proc = shared
        .pool
        .ensure(shared, &worktree)
        .map_err(|e| e.to_string())?;

    // Resume: acp session id encodes the pi session file path.
    let resume_path = args
        .resume_acp_session_id
        .as_deref()
        .and_then(|id| id.strip_prefix(SESSION_ID_PREFIX))
        .filter(|p| !p.is_empty())
        .map(str::to_string);

    let session_path = match resume_path {
        Some(path) => {
            let switch = proc
                .client
                .request(serde_json::json!({"type": "switch_session", "sessionPath": path}))
                .await;
            let cancelled = switch
                .as_ref()
                .map(|r| r.pointer("/data/cancelled").and_then(|v| v.as_bool()) == Some(true))
                .unwrap_or(false);
            match switch {
                Ok(_) if !cancelled => path,
                other => {
                    let reason = match other {
                        Err(e) => e.to_string(),
                        Ok(_) => "switch cancelled by extension".to_string(),
                    };
                    if args.forbid_new_session_fallback {
                        return Err(format!(
                            "pi session {path} not resumable (new-session fallback forbidden): {reason}"
                        ));
                    }
                    warn!(path, reason, "pi session not resumable; creating a new one");
                    new_session_path(&proc.client).await?
                }
            }
        }
        None => new_session_path(&proc.client).await?,
    };

    // Model catalog + initial model.
    let available_models = match proc
        .client
        .request(serde_json::json!({"type": "get_available_models"}))
        .await
    {
        Ok(resp) => models_from_response(&resp),
        Err(e) => {
            warn!(error = %e, "pi get_available_models failed");
            Vec::new()
        }
    };
    let mut initial_model = args.initial_model_override.filter(|m| !m.is_empty());
    if let Some((provider, model)) = initial_model.as_deref().and_then(split_model_id) {
        if let Err(e) = proc
            .client
            .request(serde_json::json!({
                "type": "set_model", "provider": provider, "modelId": model
            }))
            .await
        {
            warn!(error = %e, "pi initial set_model failed; keeping default");
            initial_model = None;
        }
    }
    if initial_model.is_none() {
        initial_model = proc
            .client
            .request(serde_json::json!({"type": "get_state"}))
            .await
            .ok()
            .and_then(|state| model_from_state(&state))
            .or_else(|| available_models.first().map(|m| m.id.clone()));
    }

    let acp_session_id = format!("{SESSION_ID_PREFIX}{session_path}");
    *proc.active_acp_session.lock() = Some(acp_session_id.clone());
    shared.routes.lock().insert(
        acp_session_id.clone(),
        Route {
            event_tx: args.event_tx,
            is_gateway: args.is_gateway,
            worktree: worktree.clone(),
            session_path,
            turn_active: false,
            turn_reply_to: None,
            turn_requester: None,
            translate: TranslateState::default(),
        },
    );

    info!(
        session_id = %acp_session_id,
        worktree = %worktree,
        models = available_models.len(),
        initial_model = initial_model.as_deref().unwrap_or(""),
        "pi session attached"
    );
    Ok(AcpStartupMetadata {
        available_models,
        initial_model,
        acp_session_id,
    })
}

async fn new_session_path(client: &client::PiClient) -> Result<String, String> {
    client
        .request(serde_json::json!({"type": "new_session"}))
        .await
        .map_err(|e| format!("pi new_session failed: {e}"))?;
    let state = client
        .request(serde_json::json!({"type": "get_state"}))
        .await
        .map_err(|e| format!("pi get_state failed: {e}"))?;
    state
        .pointer("/data/sessionFile")
        .and_then(|v| v.as_str())
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "pi get_state returned no sessionFile".to_string())
}

async fn emit_frame(
    event_tx: &mpsc::Sender<AcpEventFrame>,
    session_id: &str,
    event: amux::AcpEvent,
    reply_to: Option<String>,
) {
    crate::runtime::agent_trace::log_acp_event(session_id, &event);
    let _ = event_tx
        .send(AcpEventFrame::new(session_id, event).with_reply_to(reply_to))
        .await;
}

/// Ensure `session_id` is the process's active pi session (switch if another
/// runtime session on the same worktree prompted in between, or after a
/// respawn).
async fn ensure_active(
    shared: &Arc<Shared>,
    session_id: &str,
    worktree: &str,
    session_path: &str,
) -> crate::error::Result<Arc<process::PiProcess>> {
    let proc = shared.pool.ensure(shared, worktree)?;
    let is_active = proc.active_acp_session.lock().as_deref() == Some(session_id);
    if !is_active {
        proc.client
            .request(serde_json::json!({"type": "switch_session", "sessionPath": session_path}))
            .await?;
        *proc.active_acp_session.lock() = Some(session_id.to_string());
    }
    Ok(proc)
}

async fn do_prompt(
    shared: &Arc<Shared>,
    session_id: &str,
    text: String,
    attachment_urls: Vec<String>,
    requester_actor_id: Option<String>,
    reply_to_message_id: Option<String>,
) {
    let reply_to = reply_to_message_id.filter(|id| !id.is_empty());
    let (event_tx, worktree, session_path) = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(session_id) else {
            warn!(session_id, "prompt for unknown pi session");
            return;
        };
        route.turn_active = true;
        route.turn_reply_to = reply_to.clone();
        route.turn_requester = requester_actor_id.filter(|id| !id.is_empty());
        (
            route.event_tx.clone(),
            route.worktree.clone(),
            route.session_path.clone(),
        )
    };

    crate::runtime::agent_trace::log_prompt_begin(session_id, &text, attachment_urls.len());
    emit_frame(
        &event_tx,
        session_id,
        status_change(amux::AgentStatus::Idle, amux::AgentStatus::Active),
        reply_to.clone(),
    )
    .await;

    // pi's prompt takes inline base64 images only; attachment URLs are
    // appended to the message text for now.
    let mut message = text;
    if !attachment_urls.is_empty() {
        message.push_str("\n\nAttachments:\n");
        for url in &attachment_urls {
            message.push_str(url);
            message.push('\n');
        }
    }

    let result = match ensure_active(shared, session_id, &worktree, &session_path).await {
        Ok(proc) => {
            proc.client
                .request(serde_json::json!({"type": "prompt", "message": message}))
                .await
        }
        Err(e) => Err(e),
    };
    if let Err(e) = result {
        let details = e.to_string();
        crate::runtime::agent_trace::log_prompt_end(session_id, false, &details, 0);
        emit_frame(
            &event_tx,
            session_id,
            amux::AcpEvent {
                event: Some(amux::acp_event::Event::Error(amux::AcpError {
                    message: "pi prompt failed".to_string(),
                    details,
                })),
                model: String::new(),
            },
            reply_to.clone(),
        )
        .await;
        // Close the turn — no turn_end/agent_settled arrives for a failed submit.
        {
            let mut routes = shared.routes.lock();
            if let Some(route) = routes.get_mut(session_id) {
                route.turn_active = false;
                route.turn_reply_to = None;
                route.turn_requester = None;
            }
        }
        emit_frame(
            &event_tx,
            session_id,
            status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle),
            reply_to,
        )
        .await;
    }
}

async fn resolve_permission(
    shared: &Arc<Shared>,
    request_id: &str,
    granted: bool,
    option_id: Option<String>,
) {
    let Some(pending) = shared.permissions.lock().remove(request_id) else {
        warn!(request_id, "no pending pi permission request found");
        return;
    };
    let session_id = pending.session_id;
    let worktree = shared
        .routes
        .lock()
        .get(&session_id)
        .map(|r| r.worktree.clone())
        .unwrap_or_default();
    // The dialog channel only carries a confirmed boolean, so an "always"
    // grant is encoded by writing the pattern into the rules file the
    // extension re-reads per tool call.
    if granted && option_id.as_deref() == Some("always") {
        if let Some(pattern) = pending.always_pattern.as_deref() {
            let rules_file = process::permissions_file_for(&worktree);
            match process::append_always_pattern(&rules_file, pattern) {
                Ok(()) => info!(request_id, pattern, "pi always-allow pattern persisted"),
                Err(e) => warn!(request_id, pattern, error = %e,
                                "pi always-allow pattern write failed"),
            }
        }
    }
    let Some(proc) = shared.pool.get(&worktree) else {
        warn!(request_id, worktree, "permission respond: pi process gone");
        return;
    };
    if let Err(e) = proc
        .client
        .notify(serde_json::json!({
            "type": "extension_ui_response", "id": request_id, "confirmed": granted
        }))
        .await
    {
        warn!(request_id, session_id = %session_id, error = %e, "pi permission respond failed");
    }
}

async fn command_loop(shared: Arc<Shared>, mut cmd_rx: mpsc::Receiver<AcpCommand>) {
    while let Some(cmd) = cmd_rx.recv().await {
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
                let result = attach(
                    &shared,
                    AttachArgs {
                        worktree,
                        resume_acp_session_id,
                        mcp_config_path,
                        initial_model_override,
                        event_tx,
                        is_gateway,
                        forbid_new_session_fallback,
                    },
                )
                .await;
                let follow_up = result
                    .as_ref()
                    .ok()
                    .filter(|_| !initial_prompt.is_empty())
                    .map(|meta| meta.acp_session_id.clone());
                let _ = startup_tx.send(result);
                if let Some(session_id) = follow_up {
                    do_prompt(&shared, &session_id, initial_prompt, Vec::new(), None, None).await;
                }
            }
            AcpCommand::Prompt {
                acp_session_id,
                text,
                attachment_urls,
                requester_actor_id,
                reply_to_message_id,
            } => {
                do_prompt(
                    &shared,
                    &acp_session_id,
                    text,
                    attachment_urls,
                    requester_actor_id,
                    reply_to_message_id,
                )
                .await;
            }
            AcpCommand::Cancel { acp_session_id } => {
                let worktree = shared
                    .routes
                    .lock()
                    .get(&acp_session_id)
                    .map(|r| r.worktree.clone())
                    .unwrap_or_default();
                match shared.pool.get(&worktree) {
                    Some(proc) => {
                        match proc
                            .client
                            .request(serde_json::json!({"type": "abort"}))
                            .await
                        {
                            Ok(_) => {
                                crate::runtime::agent_trace::log_cancel(&acp_session_id, true, "")
                            }
                            Err(e) => {
                                let err = e.to_string();
                                crate::runtime::agent_trace::log_cancel(
                                    &acp_session_id,
                                    false,
                                    &err,
                                );
                                warn!(acp_session_id, error = %err, "pi abort failed");
                            }
                        }
                    }
                    None => warn!(acp_session_id, "cancel: pi process not running"),
                }
            }
            AcpCommand::ResolvePermission {
                request_id,
                granted,
                option_id,
            } => {
                resolve_permission(&shared, &request_id, granted, option_id).await;
            }
            AcpCommand::SetModel {
                acp_session_id,
                model_id,
            } => match split_model_id(&model_id) {
                Some((provider, model)) => {
                    let target = {
                        let routes = shared.routes.lock();
                        routes
                            .get(&acp_session_id)
                            .map(|r| (r.worktree.clone(), r.session_path.clone()))
                    };
                    let Some((worktree, session_path)) = target else {
                        warn!(acp_session_id, "set_model for unknown session");
                        continue;
                    };
                    // pi's model is session-level: switch to the session, then set.
                    let result =
                        match ensure_active(&shared, &acp_session_id, &worktree, &session_path)
                            .await
                        {
                            Ok(proc) => {
                                proc.client
                                    .request(serde_json::json!({
                                        "type": "set_model",
                                        "provider": provider,
                                        "modelId": model,
                                    }))
                                    .await
                            }
                            Err(e) => Err(e),
                        };
                    match result {
                        Ok(_) => info!(acp_session_id, model_id = %model_id, "pi model set"),
                        Err(e) => warn!(acp_session_id, error = %e, "pi set_model failed"),
                    }
                }
                None => warn!(model_id = %model_id, "set_model: expected provider/model id"),
            },
            AcpCommand::DetachSession { acp_session_id } => {
                shared.routes.lock().remove(&acp_session_id);
                shared
                    .permissions
                    .lock()
                    .retain(|_, p| p.session_id != acp_session_id);
                info!(acp_session_id, "pi session detached");
            }
            AcpCommand::AnswerQuestion { request_id, .. } => {
                // pi has no question tool; nothing to route.
                tracing::warn!(request_id, "pi backend: AnswerQuestion unsupported");
            }
            AcpCommand::Shutdown => {
                shared.pool.kill_all();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// PiRpcBackend
// ---------------------------------------------------------------------------

/// The pi RPC backend behind the backend-neutral [`AgentBackend`] trait.
pub struct PiRpcBackend {
    shared: Arc<Shared>,
    cmd_tx: std::sync::OnceLock<mpsc::Sender<AcpCommand>>,
}

impl PiRpcBackend {
    pub fn new() -> Self {
        Self {
            shared: Shared::new(),
            cmd_tx: std::sync::OnceLock::new(),
        }
    }

    fn command_sender(&self) -> mpsc::Sender<AcpCommand> {
        self.cmd_tx
            .get_or_init(|| {
                let (tx, rx) = mpsc::channel::<AcpCommand>(64);
                tokio::spawn(command_loop(Arc::clone(&self.shared), rx));
                tx
            })
            .clone()
    }

    fn apply_binary_hint(&self, launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>) {
        // Any configured non-default binary counts as the pi override (there
        // is no dedicated AgentType for pi; the local-agent switch is global).
        for launch in launch_configs.values() {
            self.shared.pool.set_binary_hint(&launch.binary);
        }
    }
}

impl Default for PiRpcBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentBackend for PiRpcBackend {
    async fn attach_session(
        &mut self,
        _agent_type: amux::AgentType,
        launch: &AgentLaunchConfig,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: String,
        resume_acp_session_id: Option<String>,
        mcp_config_path: Option<PathBuf>,
        initial_model_override: Option<String>,
        initial_prompt: String,
        event_tx: mpsc::Sender<AcpEventFrame>,
        is_gateway: bool,
        forbid_new_session_fallback: bool,
    ) -> crate::error::Result<(mpsc::Sender<AcpCommand>, AcpStartupMetadata)> {
        self.shared.pool.set_binary_hint(&launch.binary);
        self.shared
            .pool
            .merge_extra_env(&extra_env, force_env_override);
        let cmd_tx = self.command_sender();
        let startup = attach(
            &self.shared,
            AttachArgs {
                worktree,
                resume_acp_session_id,
                mcp_config_path,
                initial_model_override,
                event_tx,
                is_gateway,
                forbid_new_session_fallback,
            },
        )
        .await
        .map_err(crate::error::AmuxError::Agent)?;
        if !initial_prompt.is_empty() {
            let _ = cmd_tx
                .send(AcpCommand::Prompt {
                    acp_session_id: startup.acp_session_id.clone(),
                    text: initial_prompt,
                    attachment_urls: Vec::new(),
                    requester_actor_id: None,
                    reply_to_message_id: None,
                })
                .await;
        }
        Ok((cmd_tx, startup))
    }

    async fn prewarm(&mut self, launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>) {
        // Processes are per-worktree; nothing global to warm without one.
        self.apply_binary_hint(launch_configs);
    }

    async fn prewarm_with_env(
        &mut self,
        launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: Option<&str>,
    ) {
        self.apply_binary_hint(launch_configs);
        self.shared
            .pool
            .merge_extra_env(&extra_env, force_env_override);
        if let Some(worktree) = worktree.filter(|w| !w.is_empty()) {
            let worktree = canonical_dir(worktree);
            if let Err(e) = self.shared.pool.ensure(&self.shared, &worktree) {
                warn!(worktree, error = %e, "pi prewarm failed");
            } else {
                info!(worktree, "pi rpc prewarmed");
            }
        }
    }

    fn evict_agent_types(&mut self, _agent_types: &[amux::AgentType]) -> usize {
        self.shared.pool.kill_all()
    }

    fn host_count(&self) -> usize {
        self.shared.pool.live_count()
    }

    async fn model_catalog(
        &mut self,
        workspace_path: &Path,
    ) -> crate::error::Result<Vec<amux::ModelInfo>> {
        let worktree = canonical_dir(&workspace_path.to_string_lossy());
        // Prefer the workspace's own process, else any live one; never spawn
        // just for the catalog (no fallback const list).
        let proc = self
            .shared
            .pool
            .get(&worktree)
            .or_else(|| self.shared.pool.any_live());
        let Some(proc) = proc else {
            return Ok(Vec::new());
        };
        let resp = proc
            .client
            .request(serde_json::json!({"type": "get_available_models"}))
            .await?;
        Ok(models_from_response(&resp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_model_id_at_first_slash() {
        assert_eq!(
            split_model_id("anthropic/claude-sonnet-4-5"),
            Some(("anthropic".into(), "claude-sonnet-4-5".into()))
        );
        // model ids may themselves contain '/'
        assert_eq!(
            split_model_id("openrouter/meta/llama-3"),
            Some(("openrouter".into(), "meta/llama-3".into()))
        );
        assert_eq!(split_model_id("nomodel"), None);
        assert_eq!(split_model_id("/x"), None);
    }

    #[test]
    fn models_from_response_maps_provider_slash_id() {
        let resp = serde_json::json!({
            "type": "response", "command": "get_available_models", "success": true,
            "data": { "models": [
                {"provider": "anthropic", "id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5"},
                {"provider": "openai", "modelId": "gpt-5"},
                {"provider": "x"}
            ]}
        });
        let models = models_from_response(&resp);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "anthropic/claude-sonnet-4-5");
        assert_eq!(models[0].display_name, "Claude Sonnet 4.5");
        assert_eq!(models[0].provider_name, "anthropic");
        assert_eq!(models[1].id, "openai/gpt-5");
        assert_eq!(models[1].display_name, "gpt-5");
    }

    #[test]
    fn model_from_state_formats_provider_slash_id() {
        let state = serde_json::json!({
            "type": "response", "command": "get_state", "success": true,
            "data": { "model": {"provider": "anthropic", "id": "claude-sonnet-4-5"},
                      "sessionFile": "/tmp/s.jsonl", "sessionId": "abc" }
        });
        assert_eq!(
            model_from_state(&state),
            Some("anthropic/claude-sonnet-4-5".to_string())
        );
        assert_eq!(model_from_state(&serde_json::json!({"data": {}})), None);
    }

    #[test]
    fn remote_tools_cmd_extracted_from_mcp_config_shape() {
        let root = serde_json::json!({
            "mcpServers": {
                "amuxd-remote-tools": {
                    "command": "/usr/local/bin/amuxd",
                    "args": ["remote-tools-mcp", "--sock=/tmp/amuxd.sock"]
                }
            }
        });
        assert_eq!(
            remote_tools_cmd_from_value(&root).as_deref(),
            Some(r#"["/usr/local/bin/amuxd","remote-tools-mcp","--sock=/tmp/amuxd.sock"]"#)
        );
        // Other servers present but no amuxd-remote-tools → None.
        let other = serde_json::json!({"mcpServers": {"something-else": {"command": "x"}}});
        assert_eq!(remote_tools_cmd_from_value(&other), None);
        assert_eq!(remote_tools_cmd_from_value(&serde_json::json!({})), None);
        // Missing command → None.
        let no_cmd = serde_json::json!({"mcpServers": {"amuxd-remote-tools": {"args": ["a"]}}});
        assert_eq!(remote_tools_cmd_from_value(&no_cmd), None);
    }

    #[test]
    fn remote_tools_cmd_from_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote-tools-host.json");
        std::fs::write(
            &path,
            r#"{"mcpServers":{"amuxd-remote-tools":{"command":"amuxd","args":["remote-tools-mcp"]}}}"#,
        )
        .unwrap();
        assert_eq!(
            remote_tools_cmd_from_mcp_config(&path).as_deref(),
            Some(r#"["amuxd","remote-tools-mcp"]"#)
        );
        assert_eq!(
            remote_tools_cmd_from_mcp_config(&dir.path().join("missing.json")),
            None
        );
    }

    #[tokio::test]
    async fn host_count_zero_without_processes() {
        let backend = PiRpcBackend::new();
        assert_eq!(backend.host_count(), 0);
    }

    #[tokio::test]
    async fn evict_without_processes_is_zero() {
        let mut backend = PiRpcBackend::new();
        assert_eq!(backend.evict_agent_types(&[amux::AgentType::Opencode]), 0);
    }

    #[tokio::test]
    async fn model_catalog_empty_without_processes() {
        let mut backend = PiRpcBackend::new();
        let models = backend.model_catalog(Path::new("/tmp")).await.unwrap();
        assert!(models.is_empty());
    }
}

//! opencode serve HTTP runtime backend.
//!
//! Replaces the Zed-ACP integration (`adapter.rs` + `acp_host.rs`): amuxd now
//! drives a single global `opencode serve` HTTP instance (see
//! `docs/architecture/single-agent-opencode-http.md`). The manager-facing
//! surface (`AcpCommand`, `AcpStartupMetadata`, `AcpHostPool`) keeps the old
//! names and signatures so `RuntimeManager` / gateway plumbing is unchanged.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;

pub mod client;
mod envelope;
mod events;
pub mod supervisor;
pub mod translate;

pub use envelope::*;

use client::{PromptBody, PromptPart};
use supervisor::ServeSupervisor;
use translate::TranslateState;

// ---------------------------------------------------------------------------
// Manager-facing command surface (names preserved from the ACP adapter)
// ---------------------------------------------------------------------------

/// Commands the runtime manager sends to the opencode HTTP backend.
pub enum AcpCommand {
    /// Create or resume an opencode session for a worktree.
    AttachSession {
        worktree: String,
        resume_acp_session_id: Option<String>,
        mcp_config_path: Option<PathBuf>,
        initial_model_override: Option<String>,
        initial_prompt: String,
        event_tx: mpsc::Sender<AcpEventFrame>,
        startup_tx: oneshot::Sender<Result<AcpStartupMetadata, String>>,
        /// Gateway sessions auto-allow tool permissions.
        is_gateway: bool,
        /// When resuming, fail instead of falling back to a new session.
        forbid_new_session_fallback: bool,
    },
    /// Drop routing state for a session; the serve process keeps running.
    DetachSession { acp_session_id: String },
    /// Send a prompt to a bound session (async; turn ends on `session.idle`).
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
    /// Resolve a pending permission request (any session).
    ResolvePermission {
        request_id: String,
        granted: bool,
        /// "always" upgrades the grant; anything else (or None) means "once".
        option_id: Option<String>,
    },
    /// Switch the model used by a bound session (applied on the next prompt).
    SetModel {
        acp_session_id: String,
        model_id: String,
    },
    /// Shut down the serve process (it respawns lazily on next use).
    #[allow(dead_code)]
    Shutdown,
}

#[derive(Debug, Clone)]
pub struct AcpStartupMetadata {
    pub available_models: Vec<amux::ModelInfo>,
    pub initial_model: Option<String>,
    pub acp_session_id: String,
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

pub(crate) struct Route {
    pub(crate) event_tx: mpsc::Sender<AcpEventFrame>,
    pub(crate) is_gateway: bool,
    /// Canonicalized worktree the session was created in (`?directory=`).
    pub(crate) directory: String,
    /// Model applied on the next prompt (opencode model is per-message).
    pub(crate) model: Option<client::PromptModel>,
    pub(crate) turn_active: bool,
    pub(crate) turn_reply_to: Option<String>,
    pub(crate) turn_requester: Option<String>,
    pub(crate) translate: TranslateState,
}

pub(crate) struct Shared {
    pub(crate) serve: ServeSupervisor,
    /// opencode session id → route.
    pub(crate) routes: parking_lot::Mutex<HashMap<String, Route>>,
    /// permission id → opencode session id (for the reply endpoint path).
    pub(crate) permissions: parking_lot::Mutex<HashMap<String, String>>,
    /// canonical directory → SSE subscription task.
    pub(crate) sse_tasks: parking_lot::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}

impl Shared {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            serve: ServeSupervisor::new(),
            routes: parking_lot::Mutex::new(HashMap::new()),
            permissions: parking_lot::Mutex::new(HashMap::new()),
            sse_tasks: parking_lot::Mutex::new(HashMap::new()),
        })
    }
}

fn canonical_dir(worktree: &str) -> String {
    std::fs::canonicalize(worktree)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| worktree.to_string())
}

// ---------------------------------------------------------------------------
// AcpHostPool — same surface as the old ACP host pool
// ---------------------------------------------------------------------------

/// Pool facade over the single global `opencode serve` instance.
pub struct AcpHostPool {
    shared: Arc<Shared>,
    cmd_tx: std::sync::OnceLock<mpsc::Sender<AcpCommand>>,
}

impl AcpHostPool {
    pub fn new() -> Self {
        Self {
            shared: Shared::new(),
            cmd_tx: std::sync::OnceLock::new(),
        }
    }

    /// Global command sender; spawns the command loop on first use (requires a
    /// tokio runtime context, so this is only called from async paths).
    fn command_sender(&self) -> mpsc::Sender<AcpCommand> {
        self.cmd_tx
            .get_or_init(|| {
                let (tx, rx) = mpsc::channel::<AcpCommand>(64);
                tokio::spawn(command_loop(Arc::clone(&self.shared), rx));
                tx
            })
            .clone()
    }

    /// Number of live backend processes (0 or 1: the global serve instance).
    pub fn host_count(&self) -> usize {
        usize::from(self.shared.serve.is_running())
    }

    /// Restart the serve process so new sessions pick up provider auth/config
    /// changes. All agent types map to the single opencode backend now.
    pub fn evict_agent_types(&mut self, _agent_types: &[amux::AgentType]) -> usize {
        usize::from(self.shared.serve.shutdown())
    }

    /// Pre-warm: start the global serve process.
    pub async fn prewarm(
        &mut self,
        launch_configs: &HashMap<amux::AgentType, super::manager::AgentLaunchConfig>,
    ) {
        self.apply_binary_hint(launch_configs);
        if let Err(e) = self.shared.serve.ensure().await {
            warn!(error = %e, "opencode serve prewarm failed");
        } else {
            info!("opencode serve prewarmed");
        }
    }

    /// Pre-warm with a real session env (merged into the serve process env on
    /// its next spawn) and, when a worktree is known, its SSE subscription.
    pub async fn prewarm_with_env(
        &mut self,
        launch_configs: &HashMap<amux::AgentType, super::manager::AgentLaunchConfig>,
        extra_env: HashMap<String, String>,
        _force_env_override: bool,
        worktree: Option<&str>,
    ) {
        self.apply_binary_hint(launch_configs);
        self.shared.serve.merge_extra_env(&extra_env);
        if let Err(e) = self.shared.serve.ensure().await {
            warn!(error = %e, "opencode serve prewarm (session env) failed");
            return;
        }
        if let Some(worktree) = worktree.filter(|w| !w.is_empty()) {
            events::ensure_sse_task(&self.shared, &canonical_dir(worktree));
        }
        info!("opencode serve prewarmed (session env)");
    }

    fn apply_binary_hint(
        &self,
        launch_configs: &HashMap<amux::AgentType, super::manager::AgentLaunchConfig>,
    ) {
        if let Some(launch) = launch_configs.get(&amux::AgentType::Opencode) {
            self.shared.serve.set_binary_hint(&launch.binary);
        }
    }

    /// Model catalog for a workspace directory (cron catalog UI).
    pub async fn model_catalog(
        &mut self,
        workspace_path: &Path,
    ) -> crate::error::Result<Vec<amux::ModelInfo>> {
        let client = self.shared.serve.ensure().await?;
        client
            .model_catalog(&canonical_dir(&workspace_path.to_string_lossy()))
            .await
    }

    /// Bind a TeamClaw runtime to an opencode session (create or resume).
    #[allow(clippy::too_many_arguments)]
    pub async fn attach_session(
        &mut self,
        agent_type: amux::AgentType,
        launch: &super::manager::AgentLaunchConfig,
        extra_env: HashMap<String, String>,
        _force_env_override: bool,
        worktree: String,
        resume_acp_session_id: Option<String>,
        mcp_config_path: Option<PathBuf>,
        initial_model_override: Option<String>,
        initial_prompt: String,
        event_tx: mpsc::Sender<AcpEventFrame>,
        is_gateway: bool,
        forbid_new_session_fallback: bool,
    ) -> crate::error::Result<(mpsc::Sender<AcpCommand>, AcpStartupMetadata)> {
        if agent_type != amux::AgentType::Opencode {
            warn!(
                ?agent_type,
                "agent type mapped to the single opencode HTTP backend"
            );
        }
        self.shared.serve.set_binary_hint(&launch.binary);
        self.shared.serve.merge_extra_env(&extra_env);
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
}

impl Default for AcpHostPool {
    fn default() -> Self {
        Self::new()
    }
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

/// Merge a gateway `mcpServers` config file into the worktree's
/// `opencode.json` `mcp` map so serve-created sessions get the amuxd `send`
/// tool. (serve has no per-session MCP parameter; config is per-directory.)
fn merge_mcp_config_into_worktree(worktree: &str, mcp_config_path: &Path) {
    let merge = || -> anyhow::Result<()> {
        let body = std::fs::read_to_string(mcp_config_path)?;
        let root: serde_json::Value = serde_json::from_str(&body)?;
        let Some(servers) = root.get("mcpServers").and_then(|v| v.as_object()) else {
            return Ok(());
        };
        let config_path = Path::new(worktree).join("opencode.json");
        let mut config: serde_json::Value = if config_path.exists() {
            serde_json::from_str(&std::fs::read_to_string(&config_path)?)?
        } else {
            serde_json::json!({ "$schema": "https://opencode.ai/config.json" })
        };
        let mcp = config
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("opencode.json root is not an object"))?
            .entry("mcp")
            .or_insert_with(|| serde_json::json!({}));
        let mcp_obj = mcp
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("mcp is not an object"))?;
        let mut changed = false;
        for (name, def) in servers {
            let command = def
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("mcp server '{name}' missing command"))?;
            let mut cmd_vec = vec![serde_json::json!(command)];
            if let Some(args) = def.get("args").and_then(|v| v.as_array()) {
                cmd_vec.extend(args.iter().cloned());
            }
            let entry = serde_json::json!({
                "type": "local",
                "enabled": true,
                "command": cmd_vec,
            });
            if mcp_obj.get(name) != Some(&entry) {
                mcp_obj.insert(name.clone(), entry);
                changed = true;
            }
        }
        if changed {
            std::fs::write(&config_path, serde_json::to_string_pretty(&config)?)?;
        }
        Ok(())
    };
    if let Err(e) = merge() {
        warn!(worktree, mcp_config = %mcp_config_path.display(), error = %e,
              "failed to merge gateway MCP config into worktree opencode.json");
    }
}

async fn attach(shared: &Arc<Shared>, args: AttachArgs) -> Result<AcpStartupMetadata, String> {
    let directory = canonical_dir(&args.worktree);
    if let Some(mcp_path) = args.mcp_config_path.as_deref() {
        merge_mcp_config_into_worktree(&args.worktree, mcp_path);
    }
    let client = shared
        .serve
        .ensure()
        .await
        .map_err(|e| format!("opencode serve unavailable: {e}"))?;
    events::ensure_sse_task(shared, &directory);

    let session_id = match args.resume_acp_session_id.as_deref() {
        Some(resume_id) if !resume_id.is_empty() => {
            match client.session_exists(&directory, resume_id).await {
                Ok(true) => resume_id.to_string(),
                Ok(false) | Err(_) if args.forbid_new_session_fallback => {
                    return Err(format!(
                        "opencode session {resume_id} not resumable (new-session fallback forbidden)"
                    ));
                }
                Ok(false) => {
                    warn!(resume_id, "opencode session not found; creating a new one");
                    client
                        .create_session(&directory)
                        .await
                        .map_err(|e| e.to_string())?
                }
                Err(e) => {
                    warn!(resume_id, error = %e, "opencode resume check failed; creating a new session");
                    client
                        .create_session(&directory)
                        .await
                        .map_err(|e| e.to_string())?
                }
            }
        }
        _ => client
            .create_session(&directory)
            .await
            .map_err(|e| e.to_string())?,
    };

    let available_models = client.model_catalog(&directory).await.unwrap_or_else(|e| {
        warn!(error = %e, "opencode model catalog fetch failed");
        Vec::new()
    });
    let initial_model = args
        .initial_model_override
        .filter(|m| !m.is_empty())
        .or(client.config_default_model(&directory).await)
        .or_else(|| available_models.first().map(|m| m.id.clone()));
    let model = initial_model.as_deref().and_then(client::split_model_id);

    shared.routes.lock().insert(
        session_id.clone(),
        Route {
            event_tx: args.event_tx,
            is_gateway: args.is_gateway,
            directory: directory.clone(),
            model,
            turn_active: false,
            turn_reply_to: None,
            turn_requester: None,
            translate: TranslateState::default(),
        },
    );

    info!(
        session_id = %session_id,
        directory = %directory,
        models = available_models.len(),
        initial_model = initial_model.as_deref().unwrap_or(""),
        "opencode session attached"
    );

    Ok(AcpStartupMetadata {
        available_models,
        initial_model,
        acp_session_id: session_id,
    })
}

fn guess_mime(url: &str) -> &'static str {
    let path = url.split('?').next().unwrap_or(url);
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        _ => "application/octet-stream",
    }
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

async fn do_prompt(
    shared: &Arc<Shared>,
    session_id: &str,
    text: String,
    attachment_urls: Vec<String>,
    requester_actor_id: Option<String>,
    reply_to_message_id: Option<String>,
) {
    let reply_to = reply_to_message_id.filter(|id| !id.is_empty());
    let (event_tx, directory, model) = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(session_id) else {
            warn!(session_id, "prompt for unknown opencode session");
            return;
        };
        route.turn_active = true;
        route.turn_reply_to = reply_to.clone();
        route.turn_requester = requester_actor_id.filter(|id| !id.is_empty());
        (
            route.event_tx.clone(),
            route.directory.clone(),
            route.model.clone(),
        )
    };

    crate::runtime::agent_trace::log_prompt_begin(session_id, &text, attachment_urls.len());
    emit_frame(
        &event_tx,
        session_id,
        translate::status_change(amux::AgentStatus::Idle, amux::AgentStatus::Active),
        reply_to.clone(),
    )
    .await;

    let mut parts = vec![PromptPart::Text { text }];
    for url in &attachment_urls {
        let filename = url
            .split('?')
            .next()
            .unwrap_or(url)
            .rsplit('/')
            .next()
            .map(str::to_string);
        parts.push(PromptPart::File {
            mime: guess_mime(url).to_string(),
            url: url.clone(),
            filename,
        });
    }
    let body = PromptBody { model, parts };

    let result = match shared.serve.ensure().await {
        Ok(client) => client.prompt_async(&directory, session_id, &body).await,
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
                    message: "opencode prompt failed".to_string(),
                    details,
                })),
                model: String::new(),
            },
            reply_to.clone(),
        )
        .await;
        // Close the turn — no `session.idle` will arrive for a failed submit.
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
            translate::status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle),
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
    let Some(session_id) = shared.permissions.lock().remove(request_id) else {
        warn!(request_id, "no pending opencode permission request found");
        return;
    };
    let directory = shared
        .routes
        .lock()
        .get(&session_id)
        .map(|r| r.directory.clone())
        .unwrap_or_default();
    let response = translate::permission_response_for(granted, option_id.as_deref());
    match shared.serve.ensure().await {
        Ok(client) => {
            if let Err(e) = client
                .permission_respond(&directory, &session_id, request_id, response)
                .await
            {
                warn!(request_id, session_id = %session_id, error = %e, "permission respond failed");
            }
        }
        Err(e) => warn!(error = %e, "permission respond: serve unavailable"),
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
                let directory = shared
                    .routes
                    .lock()
                    .get(&acp_session_id)
                    .map(|r| r.directory.clone())
                    .unwrap_or_default();
                match shared.serve.ensure().await {
                    Ok(client) => match client.abort(&directory, &acp_session_id).await {
                        Ok(()) => {
                            crate::runtime::agent_trace::log_cancel(&acp_session_id, true, "")
                        }
                        Err(e) => {
                            let err = e.to_string();
                            crate::runtime::agent_trace::log_cancel(&acp_session_id, false, &err);
                            warn!(acp_session_id, error = %err, "opencode abort failed");
                        }
                    },
                    Err(e) => warn!(error = %e, "cancel: serve unavailable"),
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
            } => match client::split_model_id(&model_id) {
                Some(model) => {
                    let mut routes = shared.routes.lock();
                    if let Some(route) = routes.get_mut(&acp_session_id) {
                        route.model = Some(model);
                        info!(acp_session_id, model_id = %model_id, "opencode model recorded for next prompt");
                    } else {
                        warn!(acp_session_id, "set_model for unknown session");
                    }
                }
                None => warn!(model_id = %model_id, "set_model: expected provider/model id"),
            },
            AcpCommand::DetachSession { acp_session_id } => {
                shared.routes.lock().remove(&acp_session_id);
                shared
                    .permissions
                    .lock()
                    .retain(|_, sid| sid != &acp_session_id);
                info!(acp_session_id, "opencode session detached");
            }
            AcpCommand::Shutdown => {
                shared.serve.shutdown();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// CLI compat: `amuxd test-spawn`
// ---------------------------------------------------------------------------

/// Legacy single-session helper used by the `amuxd test-spawn` debug CLI.
/// Production runtimes attach via [`AcpHostPool`] instead.
#[allow(clippy::too_many_arguments)]
pub fn spawn_acp_agent(
    binary: String,
    _args: Vec<String>,
    worktree: String,
    initial_prompt: String,
    _agent_type: amux::AgentType,
    event_tx: mpsc::Sender<AcpEventFrame>,
    resume_acp_session_id: Option<String>,
    startup_tx: oneshot::Sender<Result<AcpStartupMetadata, String>>,
    initial_model_override: Option<String>,
    mcp_config_path: Option<PathBuf>,
    extra_env: HashMap<String, String>,
) -> crate::error::Result<mpsc::Sender<AcpCommand>> {
    let shared = Shared::new();
    shared.serve.set_binary_hint(&binary);
    shared.serve.merge_extra_env(&extra_env);
    let (cmd_tx, cmd_rx) = mpsc::channel::<AcpCommand>(64);
    tokio::spawn(command_loop(Arc::clone(&shared), cmd_rx));
    let attach_tx = cmd_tx.clone();
    tokio::spawn(async move {
        let _ = attach_tx
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
    });
    Ok(cmd_tx)
}

// ---------------------------------------------------------------------------
// PATH enrichment for spawned processes (kept from the ACP adapter; also used
// by mcp_probe / agent_discover)
// ---------------------------------------------------------------------------

#[cfg(windows)]
const PATH_SEP: char = ';';
#[cfg(not(windows))]
const PATH_SEP: char = ':';

/// Build a PATH for spawned agent runtimes that includes common user-level
/// binary directories.
///
/// amuxd is typically launched by launchd (macOS) or systemd (Linux) with a
/// minimal PATH that omits Homebrew, `~/.local/bin`, and the other locations
/// where runtimes like `opencode` and `npx` actually live. Inherited PATH
/// entries keep priority; the well-known directories are appended as
/// fallbacks, and duplicates are removed preserving first occurrence.
pub(crate) fn enriched_spawn_path(existing: Option<&str>, home: Option<&Path>) -> String {
    let mut candidates: Vec<String> = Vec::new();

    if let Some(existing) = existing {
        candidates.extend(existing.split(PATH_SEP).map(|s| s.to_string()));
    }

    if cfg!(windows) {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            candidates.push(format!("{pf}\\nodejs"));
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(format!("{appdata}\\npm"));
        }
    } else {
        if let Some(home) = home {
            for sub in [
                ".local/bin",
                ".npm-global/bin",
                ".bun/bin",
                ".cargo/bin",
                ".opencode/bin",
            ] {
                candidates.push(home.join(sub).to_string_lossy().into_owned());
            }
        }
        for dir in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] {
            candidates.push(dir.to_string());
        }
    }

    let mut seen = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|d| !d.is_empty() && seen.insert(d.clone()))
        .collect::<Vec<_>>()
        .join(&PATH_SEP.to_string())
}

#[cfg(test)]
mod spawn_path_tests {
    use super::{enriched_spawn_path, PATH_SEP};
    use std::path::Path;

    #[cfg(not(windows))]
    #[test]
    fn appends_homebrew_and_user_local_to_minimal_path() {
        let path = enriched_spawn_path(
            Some("/usr/bin:/bin:/usr/sbin:/sbin"),
            Some(Path::new("/Users/x")),
        );
        let dirs: Vec<&str> = path.split(':').collect();
        assert!(dirs.contains(&"/opt/homebrew/bin"), "{path}");
        assert!(dirs.contains(&"/Users/x/.local/bin"), "{path}");
        assert!(dirs.contains(&"/Users/x/.opencode/bin"), "{path}");
        assert!(path.starts_with("/usr/bin:/bin:/usr/sbin:/sbin"), "{path}");
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
        assert_eq!(count, 1, "{path}");
    }

    #[test]
    fn uses_platform_path_separator() {
        let sep = if cfg!(windows) { ';' } else { ':' };
        assert_eq!(PATH_SEP, sep);
    }
}

#[cfg(test)]
mod pool_tests {
    use super::*;

    #[test]
    fn split_and_mime_helpers() {
        assert_eq!(guess_mime("https://x/y/photo.PNG?token=e.y.j"), "image/png");
        assert_eq!(guess_mime("https://x/y/no-ext"), "application/octet-stream");
    }

    #[tokio::test]
    async fn host_count_zero_without_serve() {
        let pool = AcpHostPool::new();
        assert_eq!(pool.host_count(), 0);
    }

    #[tokio::test]
    async fn evict_without_serve_is_zero() {
        let mut pool = AcpHostPool::new();
        assert_eq!(pool.evict_agent_types(&[amux::AgentType::Opencode]), 0);
    }
}

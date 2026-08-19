//! pi coding-agent RPC backend (`pi --mode rpc`, badlogic/pi-mono).
//!
//! Peer of `runtime/opencode_http/` behind the [`AgentBackend`] trait: one pi
//! child per worktree (JSONL over stdin/stdout), sessions persisted under
//! `~/.amuxd/pi-sessions/<worktree-hash>/`, events translated into the same
//! `amux::AcpEvent` vocabulary. See `docs/architecture/pi-agent-backend.md`.
//!
//! Permission approvals ride the pi extension UI dialog channel: the TeamClu
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
use crate::runtime::permission_policy::PermissionPolicy;

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
    /// Permission handling for this session; `Full` (gateway / cron) means
    /// confirmation requests are auto-approved instead of waiting on a human.
    pub(crate) permission: PermissionPolicy,
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
    /// `teamclu.always-pattern=` trailer from the confirm message; written to
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
/// string, the `TEAMCLU_REMOTE_TOOLS_CMD` contract of the pi extension.
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

/// Build the `TEAMCLU_MCP_SERVERS` payload for the pi extension from a
/// workspace `opencode.json` (the MCP SSOT: team + inherent + user servers all
/// merge into its `mcp` map). pi has no native MCP, so the extension spawns each
/// enabled local server and proxies its tools. Returns `{ "<name>": { "command":
/// [...], "environment": {...} }, ... }` as a JSON string, or None when there is
/// nothing to bridge.
///
/// Excluded: disabled servers, non-`local` (remote/url) servers the stdio bridge
/// can't spawn, and `amuxd-remote-tools` (already bridged via
/// `TEAMCLU_REMOTE_TOOLS_CMD`).
fn mcp_servers_from_value(root: &serde_json::Value) -> Option<String> {
    let mcp = root.get("mcp")?.as_object()?;
    let mut out = serde_json::Map::new();
    for (name, server) in mcp {
        if name == "amuxd-remote-tools" {
            continue;
        }
        let obj = match server.as_object() {
            Some(o) => o,
            None => continue,
        };
        // Only stdio "local" servers with a command array can be bridged.
        if obj.get("type").and_then(|v| v.as_str()) == Some("remote") {
            continue;
        }
        if obj.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
            continue;
        }
        let command = match obj.get("command").and_then(|v| v.as_array()) {
            Some(c) if !c.is_empty() && c.iter().all(|a| a.is_string()) => c.clone(),
            _ => continue,
        };
        let mut entry = serde_json::Map::new();
        entry.insert("command".to_string(), serde_json::Value::Array(command));
        if let Some(env) = obj.get("environment").and_then(|v| v.as_object()) {
            entry.insert(
                "environment".to_string(),
                serde_json::Value::Object(env.clone()),
            );
        }
        out.insert(name.clone(), serde_json::Value::Object(entry));
    }
    if out.is_empty() {
        return None;
    }
    Some(serde_json::Value::Object(out).to_string())
}

fn mcp_servers_from_opencode_json(worktree: &str) -> Option<String> {
    let mut mcp = serde_json::Map::new();
    if let Some(team_id) = crate::config::team_mcp::onboarded_team_id() {
        let path = crate::runtime::team_cloud_config::team_cloud_mcp_file(&team_id);
        if let Ok(body) = std::fs::read_to_string(&path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                if let Some(servers) = json.get("mcpServers").and_then(|v| v.as_object()) {
                    for (name, raw) in servers {
                        let Ok(parsed) = serde_json::from_value::<
                            crate::config::team_mcp::CursorMcpServer,
                        >(raw.clone()) else {
                            continue;
                        };
                        let cfg = crate::config::team_mcp::convert_cursor_server(&parsed);
                        if let Ok(val) = serde_json::to_value(cfg) {
                            mcp.insert(name.clone(), val);
                        }
                    }
                }
            }
        }
    }
    let path = Path::new(worktree).join("opencode.json");
    if let Ok(body) = std::fs::read_to_string(&path) {
        if let Ok(root) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(ws) = root.get("mcp").and_then(|v| v.as_object()) {
                for (name, server) in ws {
                    mcp.insert(name.clone(), server.clone());
                }
            }
        }
    }
    mcp_servers_from_value(&serde_json::json!({ "mcp": mcp }))
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
    /// Daemon MRU, newest first. See `config::model_mru`.
    model_mru: Vec<String>,
    event_tx: mpsc::Sender<AcpEventFrame>,
    permission: PermissionPolicy,
    forbid_new_session_fallback: bool,
}

async fn attach(shared: &Arc<Shared>, args: AttachArgs) -> Result<AcpStartupMetadata, String> {
    let worktree = canonical_dir(&args.worktree);
    // Export the remote-tools MCP bridge command to the TeamClu extension
    // before (possibly) spawning; env is applied at spawn time.
    if let Some(cmd_json) = args
        .mcp_config_path
        .as_deref()
        .and_then(remote_tools_cmd_from_mcp_config)
    {
        shared.pool.set_remote_tools_cmd(cmd_json);
    }
    // Bridge the workspace's other MCP servers (opencode.json `mcp`) to the pi
    // extension. pi has no native MCP, so the extension spawns each and proxies
    // its tools — the same mechanism opencode gets natively from opencode.json.
    if let Some(servers_json) = mcp_servers_from_opencode_json(&worktree) {
        shared.pool.set_mcp_servers(servers_json);
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

    // Attaching replaces whatever session this child holds, so it is subject to
    // the same guard as a prompt-driven switch. This is the path a restart's
    // resume sweep takes, and resuming stored sessions one after another is how
    // a live turn got aborted out from under its sender.
    let _switching = proc.switch_lock.lock().await;
    let session_path = match resume_path {
        Some(path) => {
            guard_switch(&proc, &path).await.map_err(|e| e.to_string())?;
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
        // `new_session` replaces the held session too, so it needs the same
        // guard — a fresh chat must not abort a turn already running here.
        None => {
            guard_switch(&proc, "<new>").await.map_err(|e| e.to_string())?;
            new_session_path(&proc.client).await?
        }
    };

    // Model catalog + initial model.
    // A failed catalog read must not fail the attach: the list only populates a
    // picker, and the session is perfectly usable without it — `fill_catalog`
    // backfills from this device's persisted catalog, and `record_catalog`
    // ignores an empty result rather than overwriting a good list with it.
    //
    // Unlike the claude backend, this call is made AFTER a session exists (see
    // the session resolution just above), so an error here is a real failure
    // rather than "asked too early" — which is why it is logged at warn and the
    // HTTP catalog reports it separately as `probe_error`, instead of the empty
    // list reaching the user as "No model configured".
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
        // Same ordering as the opencode backend: pi's own current model (its
        // equivalent of a session's last-used), then the device MRU, then
        // nothing — pi keeps its default if we say nothing. Availability is
        // checked against pi's live catalog so a model it no longer offers
        // falls through instead of being set and failing on the first turn.
        //
        // The `available_models.first()` fallback this replaces picked
        // whatever happened to head the catalog, with no availability meaning
        // at all.
        let catalog: Vec<String> = available_models.iter().map(|m| m.id.clone()).collect();
        let pi_current = proc
            .client
            .request(serde_json::json!({"type": "get_state"}))
            .await
            .ok()
            .and_then(|state| model_from_state(&state));
        initial_model =
            crate::config::first_available(pi_current.into_iter().chain(args.model_mru), &catalog);
    }

    let acp_session_id = format!("{SESSION_ID_PREFIX}{session_path}");
    *proc.active_acp_session.lock() = Some(acp_session_id.clone());
    shared.routes.lock().insert(
        acp_session_id.clone(),
        Route {
            event_tx: args.event_tx,
            permission: args.permission,
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
        host_generation_id: String::new(),
        route_lease: None,
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
/// Is this pi child mid-turn right now?
///
/// Asked of pi rather than tracked locally: `Route::turn_active` is this
/// daemon's own bookkeeping and can disagree with the child (a turn started
/// through another path, a reply that landed between our reads). `get_state`
/// is the child's own answer.
///
/// A failed or malformed probe reports "busy". Refusing to switch costs a
/// retry; switching into a live turn destroys it (see `guard_switch`).
async fn pi_is_busy(proc: &process::PiProcess) -> bool {
    match proc
        .client
        .request(serde_json::json!({"type": "get_state"}))
        .await
    {
        Ok(state) => {
            let streaming = state
                .pointer("/data/isStreaming")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let compacting = state
                .pointer("/data/isCompacting")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            streaming || compacting
        }
        Err(e) => {
            warn!(error = %e, "pi get_state failed; treating the child as busy");
            true
        }
    }
}

/// Refuse to switch a pi child that is mid-turn.
///
/// pi's RPC channel carries one session at a time, and `switch_session` does
/// not park the outgoing session — `teardownCurrent` calls `session.abort()`
/// and disposes it, then re-subscribes to the new one. The aborted turn's
/// `agent_end` is therefore never emitted, so nothing closes the TeamClu turn
/// and the sender waits on a reply that no longer exists. Observed exactly
/// that: four sessions sharing one worktree, a resume of the others while one
/// was mid-turn, and a chat stuck on "replying" for good.
///
/// So a switch is only safe when the child is idle. Callers surface the error
/// rather than waiting, because the turn holding the child may run for minutes
/// and the caller (a prompt, a resume sweep) has its own retry.
async fn guard_switch(proc: &process::PiProcess, target: &str) -> crate::error::Result<()> {
    if pi_is_busy(proc).await {
        let holder = proc.active_acp_session.lock().clone().unwrap_or_default();
        warn!(
            target_session = target,
            holding_session = holder,
            "pi switch refused: child is mid-turn"
        );
        return Err(crate::error::AmuxError::Agent(format!(
            "pi is mid-turn on another session ({holder}); retry when it settles"
        )));
    }
    Ok(())
}

async fn ensure_active(
    shared: &Arc<Shared>,
    session_id: &str,
    worktree: &str,
    session_path: &str,
) -> crate::error::Result<Arc<process::PiProcess>> {
    let proc = shared.pool.ensure(shared, worktree)?;
    // The whole check-then-switch runs under the lock: two prompts for
    // different sessions could otherwise both see an idle child and both
    // switch, and the second one would abort the turn the first just started.
    let _switching = proc.switch_lock.lock().await;
    let is_active = proc.active_acp_session.lock().as_deref() == Some(session_id);
    if !is_active {
        guard_switch(&proc, session_id).await?;
        proc.client
            .request(serde_json::json!({"type": "switch_session", "sessionPath": session_path}))
            .await?;
        *proc.active_acp_session.lock() = Some(session_id.to_string());
    }
    // Released before handing the process back: the guard borrows `proc`, and
    // the switch it protects is already done.
    drop(_switching);
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
    let resolved =
        crate::runtime::prompt_attachments::resolve_all(&attachment_urls, session_id).await;
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

    let mut message = text;
    crate::runtime::prompt_attachments::substitute_in_message(&mut message, &resolved);
    crate::runtime::prompt_attachments::append_unreferenced(&mut message, &resolved, true);

    let result = match ensure_active(shared, session_id, &worktree, &session_path).await {
        Ok(proc) => {
            proc.client
                .request(serde_json::json!({
                    "type": "prompt",
                    "message": message,
                    // pi refuses a bare prompt while a turn is running:
                    // "Agent is already processing. Specify streamingBehavior
                    // ('steer' or 'followUp') to queue the message." Sending
                    // one anyway is how a message typed mid-reply was lost.
                    //
                    // `followUp` runs it after the current turn; `steer` folds
                    // it into the running one. followUp matches what TeamClu
                    // already promises elsewhere — a message is its own turn
                    // with its own reply, and the client's own queue holds
                    // messages until the stream ends rather than redirecting it.
                    //
                    // Always sent, not only when busy: pi reads the field only
                    // on the streaming branch, so an idle prompt is unaffected
                    // and no extra `get_state` round trip is needed to decide.
                    "streamingBehavior": "followUp"
                }))
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
                model_mru,
                initial_prompt,
                event_tx,
                startup_tx,
                permission,
                forbid_new_session_fallback,
            } => {
                let result = attach(
                    &shared,
                    AttachArgs {
                        worktree,
                        resume_acp_session_id,
                        mcp_config_path,
                        initial_model_override,
                        model_mru,
                        event_tx,
                        permission,
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
                                // `abort` is a request on the same stdin the
                                // turn is streaming over, and a mid-turn child
                                // does not answer it — which is precisely when
                                // someone asks to cancel. Nothing else can free
                                // the session: the wedged turn keeps refusing
                                // every switch ("child is mid-turn") until the
                                // daemon is restarted by hand.
                                //
                                // So take the child down. `pool.get` drops a
                                // dead process and the next message spawns a
                                // fresh one, which reloads the conversation
                                // from its jsonl — only in-flight work is lost.
                                // The blast radius is every session on this
                                // worktree, which is the same set the wedged
                                // child was already blocking.
                                proc.kill();
                                warn!(
                                    acp_session_id,
                                    "pi ignored abort while mid-turn; killed the child so the session is not wedged"
                                );
                            }
                        }
                    }
                    None => warn!(acp_session_id, "cancel: pi process not running"),
                }
                // Settle the turn ourselves rather than waiting for pi to emit a
                // post-abort `turn_end`/`agent_settled` — pi does not reliably
                // send one, which left the UI hanging in "replying" after an
                // interrupt. close_turn is idempotent (guards on turn_active) so
                // a later lifecycle event is a harmless no-op.
                events::close_turn(&shared, &acp_session_id).await;
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
            AcpCommand::DetachSession {
                acp_session_id,
                ack,
            } => {
                shared.routes.lock().remove(&acp_session_id);
                shared
                    .permissions
                    .lock()
                    .retain(|_, p| p.session_id != acp_session_id);
                info!(acp_session_id, "pi session detached");
                if let Some(ack) = ack {
                    let _ = ack.send(());
                }
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
        // Only the pi launch config may override the pi binary. Reading every
        // launch config (as before) picked up the claude/codex/opencode full
        // paths and made pi_rpc spawn the wrong binary. A plain "pi" here is
        // treated as unconfigured by `set_binary_hint`, so the override only
        // sticks for a genuine `[agents.pi].binary` path.
        if let Some(pi) = launch_configs.get(&amux::AgentType::Pi) {
            self.shared.pool.set_binary_hint(&pi.binary);
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
        _isolation_domain: crate::runtime::execution_context::IsolationDomainKey,
        _process_env_revision: crate::runtime::execution_context::ProcessEnvRevision,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: String,
        resume_acp_session_id: Option<String>,
        mcp_config_path: Option<PathBuf>,
        initial_model_override: Option<String>,
        model_mru: Vec<String>,
        initial_prompt: String,
        event_tx: mpsc::Sender<AcpEventFrame>,
        permission: PermissionPolicy,
        forbid_new_session_fallback: bool,
    ) -> crate::error::Result<(mpsc::Sender<AcpCommand>, AcpStartupMetadata)> {
        // NOTE: `launch` is `launch_config_for(agent_type)` for whatever agent
        // type the session carries (possibly a stored claude/codex/opencode
        // session), NOT necessarily pi. Its binary is an unrelated full path, so
        // it must NOT drive the pi binary — doing so made pi_rpc spawn
        // claude/codex and fail with "process exited before responding". The pi
        // binary is resolved independently via `resolve_binary` (PATH / ~/.pi).
        let _ = &launch;
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
                model_mru,
                event_tx,
                permission,
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
        // Prefer the workspace's own process, else any live one. If none is
        // live, spawn one for this worktree — pi models come from a running
        // `pi --mode rpc` child, and there is no static fallback table, so a
        // catalog request must be allowed to bring a process up (mirrors the
        // opencode backend's `serve.ensure()`).
        let proc = match self
            .shared
            .pool
            .get(&worktree)
            .or_else(|| self.shared.pool.any_live())
        {
            Some(proc) => proc,
            None => self.shared.pool.ensure(&self.shared, &worktree)?,
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
    async fn model_catalog_spawns_when_no_process_live() {
        // No static fallback: with no live process the catalog request must try
        // to bring a pi child up. Point the pool at a binary that cannot exist
        // so the spawn fails deterministically (instead of returning a phantom
        // empty list) — proving the code path attempts to spawn rather than
        // short-circuiting to `Ok(vec![])`.
        let mut backend = PiRpcBackend::new();
        backend
            .shared
            .pool
            .set_binary_hint("/nonexistent/teamclu-pi-does-not-exist");
        let result = backend.model_catalog(Path::new("/tmp")).await;
        assert!(
            result.is_err(),
            "expected spawn attempt to fail, got {result:?}"
        );
    }
}

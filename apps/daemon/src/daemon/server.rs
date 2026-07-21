use rumqttc::{Event, Packet};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use teamclaw_transport::MessagePublisher;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixListener;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};

use crate::backend::{
    credential_in_proactive_refresh_window, proactive_reconnect_delay, AgentRuntimeUpsert, Backend,
    WorkspaceUpsert,
};
use crate::channels::{AmuxdAcpHandle, AmuxdChannelStore, ChannelManager};
use crate::collab::{AuthManager, AuthResult, PeerState, PeerTracker, PermissionManager};
use crate::config::{DaemonConfig, SessionStore, StoredSession};
use crate::daemon::binding_target::parse_binding_to_target;
use crate::daemon::runtime_cursor::{
    compute_effective_cursor_from_messages, last_unanswered_mention_idx,
    messages_strictly_after_cursor, slice_has_actionable_inbound,
};
use crate::daemon::runtime_resolution::{
    agent_type_from_name, default_advertised_agent_type, resolve_requested_agent_type,
    runtime_start_initial_model_override, session_message_model_override,
    supported_agent_type_names,
};
use crate::daemon::session_events::{
    format_idea_prompt, message_attachment_urls, parse_mention_actor_ids, resolve_mention_actor_ids,
};
use crate::daemon::session_resume::resolve_backend_session_id;

#[path = "collab_runtime_ensure.rs"]
mod collab_runtime_ensure;
#[path = "cloud_token_file.rs"]
mod cloud_token_file;
#[path = "runtime_env.rs"]
mod runtime_env;
// Cron-style prompt-await handling (`handle_prompt_await` + the cron session
// cache) lives in `server/cron.rs` as a child module so it can reach the
// server's private fields directly.
mod channels;
mod cron;
mod messaging;
mod peers_workspaces;
mod remote_tools;
mod rpc;
mod runtime_lifecycle;
use crate::history::EventHistory;
use crate::mqtt::{publisher::Publisher, subscriber, MqttClient};
use crate::proto::amux;
use crate::provider_config::ProviderConfig;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::{apply_workspace_system_instructions, AgentLaunchConfig, RuntimeManager};
use crate::team_shared_git::TeamSharedGitConfig;
use teamclaw_gateway::{AcpHandle, ChannelStore};

/// Outcome of apply_start_runtime. Success path returns the allocated
/// runtime_id + the session_id (echoed from request or freshly created).
/// Failure path returns a (error_code, error_message, failed_stage) tuple
/// — the caller formats this into whatever wire envelope it emits
/// (legacy AgentStartResult or new RuntimeStartResult).
pub(crate) struct StartRuntimeOutcome {
    runtime_id: String,
    session_id: String,
}

pub(crate) struct StartRuntimeError {
    #[allow(dead_code)]
    error_code: String,
    error_message: String,
    failed_stage: String,
}

fn load_team_runtime_env(workspace_root: &Path, team_id: Option<&str>) -> HashMap<String, String> {
    crate::team_shared_env::load_team_env_for_workspace(workspace_root, team_id)
}

fn sync_team_shared_dir_for_workspace(workspace_root: &Path, config: &TeamSharedGitConfig) {
    match crate::team_shared_git::setup_or_sync_shared_dir(workspace_root, config) {
        Ok(status) => {
            if status.synced {
                info!(
                    shared_dir = %status.shared_dir_path.display(),
                    "team shared directory synced"
                );
            }
        }
        Err(e) => {
            warn!(
                workspace = %workspace_root.display(),
                shared_dir_name = %config.shared_dir_name,
                error = %e,
                "team shared directory sync failed"
            );
        }
    }
}

fn mark_mqtt_connected(flag: &Option<Arc<std::sync::atomic::AtomicBool>>, connected: bool) {
    if let Some(flag) = flag {
        flag.store(connected, std::sync::atomic::Ordering::Relaxed);
    }
}

/// After this long with `mqtt_connected == false`, tear down the rumqttc
/// client and rebuild via the outer loop (fresh JWT + new TCP/WSS session).
/// Backend/EMQX restarts can leave rumqttc auto-reconnect retrying with a
/// stale password indefinitely; a full rebuild matches what process restart
/// does. Three keepalive periods (30s each) gives the broker time to come
/// back before we escalate.
const MQTT_DISCONNECT_REBUILD: Duration = Duration::from_secs(90);

fn mqtt_disconnect_rebuild_due(
    disconnected_since: Option<std::time::Instant>,
    threshold: Duration,
) -> bool {
    disconnected_since.is_some_and(|since| since.elapsed() >= threshold)
}

fn load_team_shared_config_for_workspace(workspace_root: &Path) -> Option<TeamSharedGitConfig> {
    crate::team_shared_git::read_git_team_config(workspace_root)
}

pub(crate) use crate::config::workspace_path::is_linkable_workspace_path;

/// Filter cloud `workspaces` rows down to paths that (a) have a non-empty,
/// linkable path and (b) actually exist as a directory *on this machine*.
/// The cloud list spans every device on the team, so most rows will not
/// resolve locally — those are silently skipped, never symlinked.
pub(crate) fn cloud_rows_to_local_linkable_paths(
    rows: &[crate::backend::WorkspaceRow],
) -> Vec<String> {
    rows.iter()
        .filter_map(|row| {
            let path = row.path.as_deref()?.trim();
            if path.is_empty() || !is_linkable_workspace_path(path) {
                return None;
            }
            if !Path::new(path).is_dir() {
                return None;
            }
            Some(path.to_string())
        })
        .collect()
}

/// Per-session plan emitted by
/// [`DaemonServer::plan_auto_restart_offline_sessions`]. Sessions that pass
/// every filter (have a prior runtime, have unread from someone other than
/// this daemon, no live runtime currently serving them) end up in the
/// returned `Vec`.
pub(crate) struct OfflineRestartPlan {
    pub session_id: String,
    pub backend: amux::AgentType,
    pub local_workspace_id: String,
    pub unread_count: usize,
}

pub struct DaemonServer {
    config: DaemonConfig,
    /// Path the daemon's `daemon.toml` was loaded from. Stashed so
    /// `channel-reload` (over `amuxd.sock`) can re-read the latest config
    /// without callers having to thread the path through every helper.
    config_path: PathBuf,
    mqtt: MqttClient,
    /// Set when running on the NATS transport (`config.transport.kind = "nats"`).
    /// Mutually exclusive with the MQTT event loop in `mqtt`. On the MQTT path
    /// this stays `None` and `mqtt` is the live backend.
    nats: Option<crate::nats::NatsBackend>,
    /// Unified publisher handle. Set to `mqtt.client` on the MQTT path and
    /// to `nats.client` on the NATS path during connect. All publishing
    /// downstream (Publisher::new_from_handle, teamclaw, channels) reads
    /// this so the same handler code works for both backends.
    publisher_handle: Arc<dyn MessagePublisher>,
    /// Mirror of the active backend's `Topics`. Updated alongside
    /// `publisher_handle` during connect/reconnect.
    topics: crate::mqtt::Topics,
    agents: Arc<AsyncMutex<RuntimeManager>>,
    auth: AuthManager,
    peers: PeerTracker,
    permissions: PermissionManager,
    /// Cloud-backed workspace UUID -> {path, team_id} cache. Consumed by
    /// `apply_start_runtime` to resolve `workspace_id` to a filesystem path.
    workspace_resolver: Arc<crate::config::WorkspaceResolver>,
    /// Daemon-owned per-team sync engine (git/OSS). The 300s autonomous timer
    /// and the HTTP `/v1/team/sync` trigger both run through this dispatcher.
    sync_dispatcher: crate::sync::dispatch::SyncDispatcher,
    sessions: SessionStore,
    sessions_path: PathBuf,
    history: EventHistory,
    teamclaw: Option<crate::teamclaw::SessionManager>,
    backend: Arc<dyn Backend>,
    /// The same object as `backend`, typed concretely so the setup endpoint can
    /// install real credentials into an unclaimed daemon at runtime. Every other
    /// caller holds it as `Arc<dyn Backend>` and is unaware of the wrapper.
    deferred_backend: Arc<crate::backend::deferred::DeferredBackend>,
    actor_id: String,
    /// Channel manager (Discord/WeCom/Feishu/Kook/WeChat/Email gateways).
    /// `None` until `start_channels()` runs; held as `Option` so `shutdown(self)`
    /// can be `.take()`n on graceful exit.
    channel_mgr: Option<ChannelManager>,
    /// Maps cron's logical `session_key` (e.g. `"cron/<job_id>/<run_id>"`) to
    /// the acp_session_id of a live agent spawned for that key. With the
    /// current "per-run new session" cron semantics, every prompt-await call
    /// hits the "absent → create" branch, but the lookup-first shape stays
    /// so future code can adopt session reuse without changing the handler.
    cron_sessions: cron::CronSessionCache,
    refresh_watch_registry:
        Option<std::sync::Arc<crate::runtime::refresh::refresh_watch::RefreshWatchRegistry>>,
    refresh_coordinator: Option<Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
    /// Shared flag written by the MQTT event loop and read by `/v1/info`.
    mqtt_connected_flag: Option<Arc<std::sync::atomic::AtomicBool>>,
    /// Resolves the team's cloud-sourced managed (shared) LLM on a short TTL.
    /// Shared with the HTTP layer (`GET /v1/workspaces/:id/providers`) so a
    /// provider read can re-materialize `provider.team` off the same throttled
    /// fetch. Replaces the old disk-mirrored `_meta/provider.json`.
    managed_llm: Arc<crate::runtime::managed_llm::ManagedLlmResolver>,
    /// Local fast-path tee: every session/live publish (same bytes as MQTT,
    /// same event_id) is mirrored here for `GET /v1/live/events` SSE
    /// subscribers, so a same-machine UI is not gated on broker RTT. Held on
    /// the server so re-built `SessionManager`s (reconnect/re-onboard) can be
    /// re-attached via `set_local_tee`.
    live_tee: tokio::sync::broadcast::Sender<crate::teamclaw::live::LiveTeeEvent>,
    session_remote_targets: Arc<AsyncMutex<crate::remote_tools::SessionRemoteTargetStore>>,
    remote_tool_turn_contexts: Arc<AsyncMutex<crate::remote_tools::RemoteToolTurnContextStore>>,
    rpc_client: Arc<AsyncMutex<crate::teamclaw::rpc::RpcClient>>,
    /// Sender for completed cron turns. `handle_prompt_await` runs the (long)
    /// ACP turn on a background task; when it finishes the task sends the result
    /// here so the active run loop can persist the AgentReply and reply to the
    /// sock client. This keeps the main select loop from being blocked for the
    /// whole turn — otherwise a running cron turn stalls every other sock command
    /// (notably the next run's `cron-prepare-session`, delaying its session_id
    /// stamp and the desktop "Run Now" jump).
    cron_turn_done_tx: mpsc::Sender<cron::CronTurnDone>,
    /// Receiver half, `take()`n by whichever run loop (MQTT or NATS) is active.
    cron_turn_done_rx: Option<mpsc::Receiver<cron::CronTurnDone>>,
}

/// Single control command parsed off `amuxd.sock`. Variants correspond to the
/// `cmd` strings written by `cli::process::send_control`.
#[derive(Debug)]
pub(crate) enum SockCommand {
    /// Graceful daemon exit, requested over the control endpoint. This is the
    /// Windows substitute for SIGTERM (`amuxd stop` sends it); on unix it is
    /// an additional equivalent trigger.
    Shutdown,
    /// Tear down the running channel manager and rebuild from the latest
    /// `daemon.toml`. One-way (no reply).
    ChannelReload,
    /// Reply with a JSON `[{platform, enabled, connected, last_error}, ...]`
    /// snapshot of the six supported channels. `reply_tx` carries the JSON
    /// body back to the listener task so it can write it to the sock client.
    ChannelStatus {
        reply_tx: oneshot::Sender<String>,
    },
    /// Reply with a JSON `[{botId, connected, error}, ...]` snapshot of the
    /// per-bot WeCom gateway slots (one entry per `resolved_bots()`). `reply_tx`
    /// carries the JSON body back to the listener task.
    WecomBotsStatus {
        reply_tx: oneshot::Sender<String>,
    },
    /// Replace `daemon_config.channels.<platform>` with the JSON in `config_json`,
    /// persist to `daemon.toml`, and reload the channel manager so the change
    /// takes effect. One-way (no reply).
    ChannelSave {
        platform: String,
        config_json: String,
    },
    /// Proactive send request from the `amuxd mcp-server` bridge running
    /// as a child of an ACP agent. `payload` is the raw JSON envelope the
    /// bridge wrote to the sock; the daemon parses out binding + channel
    /// + target overrides + content. `reply_tx` receives a single line of
    ///   JSON (`{ "ok": true, "result": ... }` or
    ///   `{ "ok": false, "error": ... }`) the listener writes back.
    McpSend {
        payload: serde_json::Value,
        reply_tx: oneshot::Sender<String>,
    },
    /// Remote tool invoke from `amuxd remote-tools-mcp` stdio bridge.
    RemoteToolCall {
        payload: serde_json::Value,
        reply_tx: oneshot::Sender<String>,
    },
    /// Drive one ACP turn to completion for a cron-style logical session.
    /// `payload` is the raw JSON envelope; `handle_prompt_await` parses it
    /// and runs the turn against the local primary agent. `reply_tx`
    /// receives a single line of JSON (`{ "ok": true, "result": { "text": ..., "acp_session_id": ... }}` or
    /// `{ "ok": false, "error": ... }`).
    PromptAwait {
        payload: serde_json::Value,
        reply_tx: oneshot::Sender<String>,
    },
    /// Eagerly create the cloud session for a cron run (no ACP turn), so the
    /// desktop can stamp `session_id` into the run record and navigate to the
    /// session within seconds of "Run Now". Reply is
    /// `{ "ok": true, "result": { "session_id": ... } }` or `{ "ok": false, "error": ... }`.
    CronPrepareSession {
        payload: serde_json::Value,
        reply_tx: oneshot::Sender<String>,
    },
    /// Fetch a fresh WeChat (iLink) bot QR code. One-shot HTTP call to the
    /// ilink backend via `teamclaw_gateway::wechat::fetch_qr_code`. Reply is
    /// `{ok, result?, error?}` where result is the raw `WeChatQrLoginResponse`.
    WechatQrStart {
        reply_tx: oneshot::Sender<String>,
    },
    /// Poll the status of a previously-started WeChat QR code.
    /// Reply shape: `{ok, result?, error?}` with `WeChatQrStatusResponse`.
    WechatQrPoll {
        qrcode: String,
        reply_tx: oneshot::Sender<String>,
    },
    /// Generate a WeCom QR auth start payload (scode + auth_url).
    /// Reply shape: `{ok, result?, error?}` with `WeComQrAuthStart`.
    WecomQrStart {
        reply_tx: oneshot::Sender<String>,
    },
    /// Poll the status of a WeCom QR auth scode.
    /// Reply shape: `{ok, result?, error?}` with `WeComQrAuthPollResult`.
    WecomQrPoll {
        scode: String,
        reply_tx: oneshot::Sender<String>,
    },
    /// Register a workspace into the cloud `amux.workspaces` table,
    /// idempotently. Fed by the HTTP control plane (`POST /v1/workspaces`)
    /// via the register-workspace bridge — the actor command loop owns all
    /// cloud upserts, so the HTTP task cannot race a direct write. Reply is
    /// a single JSON line (`{ok, result?, error?}`) with
    /// `{workspace_id, path, display_name}`.
    AddWorkspace {
        path: String,
        reply_tx: oneshot::Sender<String>,
    },
    Unknown(String),
}

/// Load onboarding config, or `None` when this daemon has never been onboarded.
///
/// `None` is a first-run state, not a failure: the daemon starts unclaimed so
/// its HTTP control plane can serve the setup UI that performs the onboarding.
/// A *corrupt* config still errors — see [`ProviderConfig::exists_at`].
fn load_provider_config_from_default_paths() -> crate::error::Result<Option<ProviderConfig>> {
    let backend_path = ProviderConfig::default_path()
        .map_err(|e| crate::error::AmuxError::Config(format!("backend config path failed: {e}")))?;

    if !ProviderConfig::exists_at(&backend_path) {
        return Ok(None);
    }

    ProviderConfig::load_from_path(&backend_path)
        .map(Some)
        .map_err(|e| crate::error::AmuxError::Config(format!("backend config init failed: {e}")))
}

pub fn backend_from_provider_config(config: ProviderConfig) -> crate::error::Result<Arc<dyn Backend>> {
    match config {
        ProviderConfig::CloudApi(config) => {
            // Rotated refresh tokens are written back to the same backend.toml
            // we loaded from, so the daemon survives restarts.
            let persist_path = ProviderConfig::default_path().map_err(|e| {
                crate::error::AmuxError::Config(format!("backend config path failed: {e}"))
            })?;
            Ok(Arc::new(
                crate::backend::cloud_api::CloudApiBackend::with_persist_path(config, persist_path),
            ))
        }
    }
}

/// Resolve the MQTT broker from `/v1/config/bootstrap`. The Cloud API is the
/// authoritative source: a fetched value wins (so operators can rotate the
/// broker without redeploying daemons), and falls back only to an explicit
/// invite `?broker=` override already present in `config`.
///
/// Never fails: if neither yields a broker URL the daemon warns and continues
/// with an empty `broker_url`, which puts MQTT on a placeholder client while
/// the HTTP/local control plane stays up. That degraded mode is what lets an
/// un-onboarded daemon serve its own setup UI.
async fn apply_bootstrap_overrides(
    backend: &Arc<dyn Backend>,
    config: &mut DaemonConfig,
) -> crate::error::Result<()> {
    match backend.fetch_bootstrap_mqtt().await {
        Ok(Some(mqtt)) => {
            let previous = config.mqtt.broker_url.clone();
            config.mqtt.broker_url = mqtt.url;
            if mqtt.username.is_some() {
                config.mqtt.username = mqtt.username;
            }
            if mqtt.password.is_some() {
                config.mqtt.password = mqtt.password;
            }
            info!(
                previous_broker = %previous,
                broker = %config.mqtt.broker_url,
                "applied bootstrap mqtt override from cloud api"
            );
        }
        Ok(None) => {
            // Keep the invite `?broker=` override if one was supplied at init.
        }
        Err(e) => {
            // Keep the invite override (if any); the empty-check below decides.
            tracing::warn!(error = %e, "bootstrap mqtt fetch failed; relying on invite broker override if present");
        }
    }

    if config.mqtt.broker_url.trim().is_empty() {
        warn!(
            "no MQTT broker configured (bootstrap fetch failed or invite had no `?broker=`); \
             HTTP/local control plane will start and MQTT/collab will retry once a broker is known"
        );
    }
    Ok(())
}

/// The daemon's real onboarding, exposed to `/v1/setup/*`.
///
/// Lives here rather than in `http::setup` because it reaches into
/// `crate::onboarding` and `backend_from_provider_config`, which the
/// `#[path]`-included HTTP test crates do not have.
struct DaemonOnboarding {
    deferred: Arc<crate::backend::deferred::DeferredBackend>,
}

#[async_trait::async_trait]
impl crate::http::setup::OnboardingService for DaemonOnboarding {
    fn is_claimed(&self) -> bool {
        self.deferred.is_claimed()
    }

    fn identity(&self) -> Option<(String, String)> {
        self.deferred.is_claimed().then(|| {
            (
                self.deferred.actor_id().to_string(),
                self.deferred.team_id().to_string(),
            )
        })
    }

    async fn claim(
        &self,
        invite_url: &str,
    ) -> Result<crate::http::setup::ClaimOutcome, String> {
        // Same path `amuxd init` takes (writes backend.toml + daemon.toml), so
        // the CLI and the setup UI cannot drift on what onboarding means.
        let outcome = crate::onboarding::init::run(invite_url, None)
            .await
            .map_err(|e| e.to_string())?;

        // Build a real backend from the config just written and install it, so
        // the running daemon has credentials immediately: the run loop's
        // bootstrap re-fetch and token retry both go through this handle.
        let path = ProviderConfig::default_path().map_err(|e| format!("backend path: {e}"))?;
        let provider_config = ProviderConfig::load_from_path(&path)
            .map_err(|e| format!("read new backend.toml: {e}"))?;
        let backend =
            backend_from_provider_config(provider_config).map_err(|e| format!("build backend: {e}"))?;

        self.deferred.install(backend);

        Ok(crate::http::setup::ClaimOutcome {
            actor_id: outcome.actor_id,
            team_id: outcome.team_id,
            display_name: outcome.display_name,
        })
    }
}

/// Reject `daemon.toml` and `backend.toml` when they disagree on routing identity.
/// Auth always uses `backend.toml`; MQTT topics and session routing use
/// `daemon.toml` `[actor].id` — continuing with a mismatch authenticates as one
/// actor while publishing presence and commands under another actor's topics.
fn validate_config_identity(
    config: &DaemonConfig,
    backend: &dyn Backend,
) -> crate::error::Result<()> {
    let daemon_team_id = config.team_id.as_deref().unwrap_or("<none>");
    if daemon_team_id != backend.team_id() || config.actor.id != backend.actor_id() {
        return Err(crate::error::AmuxError::Config(format!(
            "daemon/backend identity mismatch: daemon.toml team_id={daemon_team_id}, actor_id={}; \
             backend.toml team_id={}, actor_id={}. Stop amuxd and run `amuxd init` to re-onboard",
            config.actor.id,
            backend.team_id(),
            backend.actor_id(),
        )));
    }
    Ok(())
}

/// Best-effort first access token. Failure must not block startup — `run()`
/// retries indefinitely before each MQTT connect.
async fn initial_access_token(backend: &Arc<dyn Backend>) -> String {
    match backend.auth_token().await {
        Ok(token) => token,
        Err(e) => {
            warn!(
                error = %e,
                "initial Cloud API token fetch failed; HTTP/local control plane will start \
                 and MQTT/collab will retry in the main loop (re-run `amuxd init` if the refresh \
                 token is invalid)"
            );
            String::new()
        }
    }
}

impl DaemonServer {
    pub async fn new(
        mut config: DaemonConfig,
        config_path: &std::path::Path,
    ) -> crate::error::Result<Self> {
        // Always wrap in a DeferredBackend so the daemon has one backend type
        // regardless of onboarding state, and so the setup endpoint can install
        // real credentials into a running daemon without a restart.
        let deferred_backend = Arc::new(match load_provider_config_from_default_paths()? {
            Some(provider_config) => {
                let provider_kind = provider_config.kind();
                let inner = backend_from_provider_config(provider_config)?;

                info!(
                    backend_kind = ?provider_kind,
                    actor_id = %inner.actor_id(),
                    team_id  = %inner.team_id(),
                    "backend client initialised"
                );

                crate::backend::deferred::DeferredBackend::claimed(inner)
            }
            None => {
                warn!(
                    "no backend.toml — starting unclaimed; the HTTP control plane will serve \
                     setup at /v1/setup (run `amuxd setup` for the URL), or run \
                     `amuxd init <invite-url>`"
                );
                crate::backend::deferred::DeferredBackend::unclaimed()
            }
        });
        let backend: Arc<dyn Backend> = deferred_backend.clone();

        let actor_id = backend.actor_id().to_string();

        // Identity can't disagree before onboarding writes it — an unclaimed
        // daemon reports an empty actor_id, which is not a mismatch worth
        // warning about.
        if deferred_backend.is_claimed() {
            validate_config_identity(&config, backend.as_ref())?;
        }

        // Best-effort token — `run()`'s outer loop retries before MQTT connect.
        let token = initial_access_token(&backend).await;

        // Authoritative: resolve the MQTT broker from /v1/config/bootstrap.
        // When bootstrap is unreachable, keep any invite `?broker=` override in
        // daemon.toml and continue in degraded mode (HTTP/local APIs stay up).
        apply_bootstrap_overrides(&backend, &mut config).await?;

        let mqtt = if config.mqtt.broker_url.trim().is_empty() {
            warn!("deferring MQTT client until broker URL is configured");
            MqttClient::new_placeholder(&config)?
        } else {
            MqttClient::new(&config, &actor_id, &token)?
        };

        let mut launch_configs = RuntimeManager::default_launch_configs();
        if let Some(claude) = config.agents.claude_code.as_ref() {
            launch_configs.insert(
                amux::AgentType::ClaudeCode,
                AgentLaunchConfig::new(
                    claude.binary.clone(),
                    claude.default_flags.clone(),
                    "claude",
                ),
            );
        }
        if let Some(opencode) = config.agents.opencode.as_ref() {
            launch_configs.insert(
                amux::AgentType::Opencode,
                AgentLaunchConfig::new(
                    opencode.binary.clone(),
                    opencode.default_flags.clone(),
                    "opencode",
                ),
            );
        }
        if let Some(codex) = config.agents.codex.as_ref() {
            launch_configs.insert(
                amux::AgentType::Codex,
                AgentLaunchConfig::new(codex.binary.clone(), codex.default_flags.clone(), "codex"),
            );
        }

        let members_path = config_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join("members.toml");
        let auth = AuthManager::new(members_path)?;
        let peers = PeerTracker::new();
        let permissions = PermissionManager::new();

        let workspace_resolver = Arc::new(crate::config::WorkspaceResolver::new(backend.clone()));

        let sessions_path = config_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join("sessions.toml");
        let sessions = SessionStore::load(&sessions_path)?;

        let history_dir = config_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join("history");
        let history = EventHistory::new(&history_dir);

        let agents = Arc::new(AsyncMutex::new(RuntimeManager::new(
            launch_configs,
            Some(backend.clone()),
        )));

        let publisher_handle: Arc<dyn MessagePublisher> = Arc::new(mqtt.client.clone());
        let topics = mqtt.topics.clone();

        // Local fast-path broadcast (SSE tee). Capacity sized for bursts of
        // coalesced deltas; a lagging subscriber skips events, which the MQTT
        // copy then backfills (frontend dedupes by event_id).
        let (live_tee, _) =
            tokio::sync::broadcast::channel::<crate::teamclaw::live::LiveTeeEvent>(1024);

        let team_id_for_rpc = config.team_id.clone().unwrap_or_default();
        let rpc_client = Arc::new(AsyncMutex::new(crate::teamclaw::rpc::RpcClient::new(
            publisher_handle.clone(),
            team_id_for_rpc,
            actor_id.clone(),
        )));

        let teamclaw = if let Some(team_id) = &config.team_id {
            let mut sm = crate::teamclaw::SessionManager::new(
                publisher_handle.clone(),
                team_id,
                &config.actor.id,
                Some(actor_id.clone()),
                crate::config::DaemonConfig::config_dir(),
            )?;
            sm.set_local_tee(live_tee.clone());
            Some(sm)
        } else {
            None
        };

        // Bounded queue of completed cron turns handed back to the run loop for
        // persistence + sock reply (see `cron_turn_done_tx`).
        let (cron_turn_done_tx, cron_turn_done_rx) = mpsc::channel(64);

        Ok(Self {
            config,
            config_path: config_path.to_path_buf(),
            mqtt,
            nats: None,
            publisher_handle,
            topics,
            agents,
            auth,
            peers,
            permissions,
            workspace_resolver,
            sync_dispatcher: crate::sync::dispatch::SyncDispatcher::new(
                crate::sync::secret_store::SecretStore::new(),
                Some(backend.clone()),
            ),
            sessions,
            sessions_path,
            history,
            teamclaw,
            backend: backend.clone(),
            deferred_backend,
            actor_id,
            channel_mgr: None,
            cron_sessions: cron::CronSessionCache::new(),
            refresh_watch_registry: None,
            refresh_coordinator: None,
            mqtt_connected_flag: None,
            managed_llm: Arc::new(crate::runtime::managed_llm::ManagedLlmResolver::new(
                backend,
            )),
            live_tee,
            session_remote_targets: Arc::new(AsyncMutex::new(
                crate::remote_tools::SessionRemoteTargetStore::default(),
            )),
            remote_tool_turn_contexts: Arc::new(AsyncMutex::new(
                crate::remote_tools::RemoteToolTurnContextStore::default(),
            )),
            rpc_client,
            cron_turn_done_tx,
            cron_turn_done_rx: Some(cron_turn_done_rx),
        })
    }

    fn refresh_rpc_client_publisher(&self) {
        if let Ok(mut rpc) = self.rpc_client.try_lock() {
            rpc.client = self.publisher_handle.clone();
        }
    }

    pub(crate) fn suppress_internal_opencode_writes(&self, worktree: &str) {
        if let Some(ref refresh) = self.refresh_coordinator {
            crate::runtime::refresh::refresh_watch::suppress_for_workspace_path(
                refresh,
                Path::new(worktree),
                &crate::runtime::refresh::INTERNAL_OPENCODE_KINDS,
                crate::runtime::refresh::INTERNAL_WRITE_SUPPRESS,
            );
        }
    }

    /// Team-link sweep: reads the cloud `workspaces` table (all of this
    /// team's workspaces, across every device — the sole source of truth),
    /// then filters to paths that exist on *this* machine before symlinking
    /// `<workspace>/teamclaw-team`. This is mandatory —
    /// the cloud list intentionally includes other devices' workspace paths,
    /// which must never be touched by a daemon that doesn't own them.
    pub(crate) async fn sync_team_shared_dirs_for_known_workspaces(&self) {
        let team_id = self.backend.team_id().to_string();
        if team_id.trim().is_empty() {
            return;
        }
        let rows = match self.backend.get_workspaces_by_team(&team_id).await {
            Ok(rows) => rows,
            Err(e) => {
                tracing::debug!(
                    team_id,
                    "team-link sweep: get_workspaces_by_team failed: {e}"
                );
                return;
            }
        };
        let workspace_paths = cloud_rows_to_local_linkable_paths(&rows);
        if workspace_paths.is_empty() {
            return;
        }
        let gate = crate::team_link::team_share_gate(self.backend.as_ref(), &team_id).await;
        for ws_path in &workspace_paths {
            crate::team_link::materialize_or_teardown(gate, &team_id, ws_path);
        }
    }

    /// Re-subscribe team topics and re-announce presence after MQTT CONNACK.
    /// Returns `Err(())` when the caller should break to the outer reconnect
    /// loop (same semantics as the first-connect path).
    async fn mqtt_resubscribe_after_connack(&mut self, context: &str) -> Result<(), ()> {
        mark_mqtt_connected(&self.mqtt_connected_flag, true);
        if let Err(e) = self.mqtt.subscribe_all().await {
            warn!(
                context,
                error = %e,
                "subscribe_all failed after CONNACK, reconnecting"
            );
            mark_mqtt_connected(&self.mqtt_connected_flag, false);
            return Err(());
        }
        if let Some(tc) = &mut self.teamclaw {
            if let Err(e) = tc.subscribe_all().await {
                warn!(
                    context,
                    error = %e,
                    "teamclaw subscribe failed after CONNACK, reconnecting"
                );
                mark_mqtt_connected(&self.mqtt_connected_flag, false);
                return Err(());
            }
        }
        if self.config.team_id.is_some() {
            let publisher =
                Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            if let Err(e) = publisher
                .publish_actor_presence(&crate::proto::amux::ActorPresence {
                    online: true,
                    display_name: self.config.actor.name.clone(),
                    timestamp: chrono::Utc::now().timestamp(),
                })
                .await
            {
                warn!(
                    context,
                    error = %e,
                    "publish_actor_presence failed after CONNACK, reconnecting"
                );
                mark_mqtt_connected(&self.mqtt_connected_flag, false);
                return Err(());
            }
        } else {
            warn!("no team_id yet; skipping presence announce until onboarding completes");
        }
        self.publish_all_agent_states().await;
        Ok(())
    }

    /// Run the daemon. When `shutdown` resolves, the inner loop exits
    /// gracefully — channels are shut down (consuming `shutdown(self)`) and
    /// `Ok(())` is returned. Without a shutdown signal the daemon runs
    /// forever; callers that want signal-based exit should pass
    /// `tokio::signal`-derived futures.
    pub async fn run<F>(mut self, shutdown: F) -> crate::error::Result<()>
    where
        F: Future<Output = ()>,
    {
        info!("amuxd v0.1.0 starting");

        // NOTE: channel-gateway start, team-shared-dir sync, and the sync-timer
        // seed (which each make serial, cloud-dependent calls) are deliberately
        // deferred until *after* the HTTP listener binds below. Running them here
        // gated `/v1/healthz` behind cloud latency, which tripped the desktop's
        // "failed to start the background service" health-poll timeout when FC
        // was slow. They still run before the MQTT reconnect loop, so collab
        // connectivity ordering is preserved.

        // NOTE: ACP host prewarming is deliberately deferred to a background
        // task spawned *after* the HTTP listener binds (see below). Prewarming
        // claude+opencode ACP hosts can take 20s+ on a cold start; doing it
        // synchronously here gated `/v1/healthz` (and MQTT) behind that delay,
        // which made the desktop's daemon-onboarding health poll time out and
        // report "failed to start the background service" even though the
        // daemon was seconds from being ready. Prewarm is a first-turn latency
        // optimization — it must not block readiness.

        // Browser-facing HTTP+SSE listener. Desktop TeamClaw requires this
        // control plane; when `[http]` is absent from daemon.toml we still
        // bind loopback with `HttpConfig::default()`. Failure to bind is
        // logged but does NOT abort the daemon — the Unix socket path remains
        // usable for legacy clients.
        let http_cfg = self.config.http.clone().unwrap_or_default();
        // Bridge: `POST /v1/workspaces` (HTTP) → the actor command loop, which
        // owns all cloud `amux.workspaces` upserts. The HTTP handler sends a
        // `RegisterWorkspaceRequest`; the forwarder task below (spawned once the
        // sock command channel exists) re-publishes it as
        // `SockCommand::AddWorkspace` so the existing main-loop handler runs it.
        // Bridge for `POST /v1/config/reload`. Created here (not at the sock
        // channel below) because `http::spawn` runs first and needs the sender;
        // the receiver is forwarded into the command loop alongside
        // register-workspace. Same shape, same reason: the actor loop owns the
        // channel manager, so the HTTP task cannot reload it directly.
        let (config_reload_tx, mut config_reload_rx) = mpsc::channel::<()>(4);

        let (register_workspace_tx, mut register_workspace_rx) =
            mpsc::channel::<crate::http::state::RegisterWorkspaceRequest>(16);
        // Shared status for the background agent_types advertise (below). Held
        // here so `/v1/info` (via `meta`) and the advertise task both reference
        // the same cell — a failed advertise surfaces instead of being swallowed.
        let agent_types_advertise = std::sync::Arc::new(parking_lot::Mutex::new(
            crate::http::state::AgentTypesAdvertise::default(),
        ));
        let mqtt_connected_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        self.mqtt_connected_flag = Some(mqtt_connected_flag.clone());
        let _http_handle = {
            let mut meta = crate::http::server::metadata(self.actor_id.clone(), "amuxd");
            // Expose configured backends so the model-catalog endpoint can
            // group models per backend (opencode providers vs claude/codex
            // static tables).
            meta.configured_agent_types = supported_agent_type_names(&self.config);
            meta.agent_types_advertise = agent_types_advertise.clone();
            meta.mqtt_connected = mqtt_connected_flag.clone();
            // The HTTP workspace runtime endpoints share this supervisor's
            // refresh coordinator for status + apply-intent semantics.
            let runtime_supervisor = crate::runtime::RuntimeSupervisor::new(self.agents.clone());
            runtime_supervisor.clone().start_refresh_auto_applier();
            let refresh_coordinator = runtime_supervisor.refresh_coordinator();
            self.refresh_coordinator = Some(refresh_coordinator.clone());
            {
                let mut manager = self.agents.lock().await;
                manager.attach_refresh_coordinator(refresh_coordinator.clone());
            }
            let runtime: Arc<dyn crate::http::runtime_adapter::RuntimeAdapter> =
                crate::http::runtime_adapter::RuntimeManagerAdapter::new(
                    self.agents.clone(),
                    http_cfg.max_event_backlog,
                    Some(refresh_coordinator),
                );
            // Start the refresh watchers with an empty workspace set so the
            // (cloud-dependent) `cloud_workspace_list()` fetch does not delay the
            // HTTP listener bind. The set is populated on a background task after
            // bind (see below), and the watcher poll loop reads the registry live.
            let refresh_watch_registry =
                crate::runtime::refresh::refresh_watch::start_refresh_watchers(
                    runtime_supervisor.refresh_coordinator(),
                    Vec::new(),
                    dirs::home_dir(),
                );
            self.refresh_watch_registry = Some(refresh_watch_registry);
            let workspace_control: Option<
                std::sync::Arc<dyn crate::config::WorkspaceControlStore>,
            > = Some(std::sync::Arc::new(
                crate::config::OpenCodeCompatStore::new(),
            ));
            let opencode_binary = crate::opencode_install::resolve_binary(
                self.config
                    .agents
                    .opencode
                    .as_ref()
                    .map(|c| c.binary.as_str()),
            );
            let opencode_settings = Some(std::sync::Arc::new(
                crate::opencode_settings::OpenCodeSettingsService::new(opencode_binary),
            ));
            match crate::http::spawn(
                http_cfg,
                meta,
                runtime,
                workspace_control,
                Some(runtime_supervisor),
                opencode_settings,
                self.sync_dispatcher.clone(),
                Some(register_workspace_tx),
                Some(self.backend.clone()),
                Some(self.live_tee.clone()),
                Some(self.config_path.clone()),
                Some(config_reload_tx),
                Some(Arc::new(DaemonOnboarding {
                    deferred: self.deferred_backend.clone(),
                })),
            )
            .await
            {
                Ok(h) => {
                    info!(addr = %h.local_addr, "http listener bound");
                    Some(h)
                }
                Err(e) => {
                    warn!("http listener failed to start: {e}");
                    None
                }
            }
        };

        // Prewarm ACP hosts in the background now that the HTTP control plane is
        // bound. This warms claude/opencode ACP hosts (20s+ cold) without gating
        // `/v1/healthz`, the Unix socket, or the MQTT loop on it — the daemon
        // reports healthy immediately while first-turn latency is still primed.
        // Spawned here (after the HTTP setup released its `self.agents` lock) so
        // the long-held prewarm lock can't stall the listener bind.
        {
            // Resolve the primary workspace's *real* spawn env up front (writes
            // provider.team, warms the managed-LLM cache, and yields the exact
            // extra_env the first session will use) so the prewarmed host's
            // env_fingerprint matches and is actually reused. The empty-env
            // prewarm never matched a team session, so the first opencode
            // session still paid the full 20s+ cold spawn. Falls back to
            // empty-env when no workspace exists yet (fresh install).
            let prewarm_env = self.resolve_primary_prewarm_env().await;
            let agents = self.agents.clone();
            tokio::spawn(async move {
                let mut mgr = agents.lock().await;
                match prewarm_env {
                    Some((worktree, extra_env, force_env_override)) => {
                        mgr.prewarm_acp_hosts_with_env(
                            extra_env,
                            force_env_override,
                            Some(worktree.as_str()),
                        )
                        .await;
                    }
                    None => mgr.prewarm_acp_hosts().await,
                }
            });
        }

        // Keep the cloud access-token file fresh for long-running agents. Only
        // cloud backends have an auth surface to source it from; the env
        // injection in `assemble_spawn_runtime_env_for_worktree` is gated the
        // same way, so `TC_ACCESS_TOKEN_FILE` is only advertised when this task
        // is actually maintaining the file.
        if self.backend.cloud_auth_health().is_some() {
            cloud_token_file::spawn(
                self.backend.clone(),
                crate::config::DaemonConfig::cloud_token_path(),
            );
        }

        // Deferred (post-bind) cloud-dependent startup, moved here so the HTTP
        // health endpoint bound promptly above. Channel gateways + shared-dir
        // sync + sync-timer seed each make serial cloud calls; running them now
        // keeps `/v1/healthz` responsive under FC latency while still preceding
        // the MQTT reconnect loop.
        self.start_channels().await;
        self.sync_team_shared_dirs_for_known_workspaces().await;
        {
            let team_id = self.backend.team_id().to_string();
            let grouped = if team_id.trim().is_empty() {
                Vec::new()
            } else {
                match self.backend.get_workspaces_by_team(&team_id).await {
                    Ok(rows) => {
                        let paths = cloud_rows_to_local_linkable_paths(&rows);
                        if paths.is_empty() {
                            Vec::new()
                        } else {
                            vec![(team_id, paths)]
                        }
                    }
                    Err(e) => {
                        tracing::debug!("sync timer: get_workspaces_by_team failed: {e}");
                        Vec::new()
                    }
                }
            };
            crate::sync::timer::spawn(self.sync_dispatcher.clone(), grouped);
        }

        // Populate the refresh watchers from the cloud workspace list on a
        // background task (moved off the pre-bind path above). The watcher poll
        // loop reads the registry live via `snapshot()`, so upserting here takes
        // effect on the next tick without a restart.
        if let Some(registry) = self.refresh_watch_registry.clone() {
            let workspaces = self.cloud_workspace_list().await;
            tokio::spawn(async move {
                for workspace in workspaces {
                    registry
                        .upsert_workspace(
                            crate::runtime::refresh::refresh_watch::WatchedWorkspace {
                                workspace_id:
                                    crate::runtime::refresh::refresh_watch::workspace_runtime_id(
                                        Path::new(&workspace.path),
                                    ),
                                workspace_path: PathBuf::from(&workspace.path),
                            },
                        )
                        .await;
                }
            });
        }

        // Bind the control socket and spawn a listener that funnels parsed
        // commands into the main loop via mpsc. Done after channel start so
        // any error in `start_channels` surfaces first; failure to bind the
        // sock is logged but does NOT abort the daemon — operators can still
        // use SIGTERM / signal handlers to stop it.
        let (sock_tx, mut sock_rx) = mpsc::channel::<SockCommand>(16);
        let sock_path = DaemonConfig::sock_path();
        spawn_sock_listener(sock_path.clone(), sock_tx.clone());

        // Forward HTTP register-workspace requests into the command loop. Runs
        // for the lifetime of the daemon; exits if either channel closes.
        {
            let bridge_tx = sock_tx.clone();
            tokio::spawn(async move {
                while let Some(req) = register_workspace_rx.recv().await {
                    if bridge_tx
                        .send(SockCommand::AddWorkspace {
                            path: req.path,
                            reply_tx: req.reply_tx,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }

        // Forward HTTP config-reload requests into the command loop, where they
        // land on the same handler as `amuxd channel reload`.
        {
            let bridge_tx = sock_tx.clone();
            tokio::spawn(async move {
                while config_reload_rx.recv().await.is_some() {
                    if bridge_tx.send(SockCommand::ChannelReload).await.is_err() {
                        break;
                    }
                }
            });
        }

        // One-time setup before the reconnect loop.
        // Heartbeat runs independently of MQTT session.
        {
            let sb = self.backend.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(60));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tick.tick().await;
                    if let Err(e) = sb.heartbeat().await {
                        warn!("cloud heartbeat error: {e}");
                    }
                }
            });
        }

        // Idle ACP runtime sweeper. Opt-in via DaemonConfig.idle_runtime_timeout_secs.
        // The sweeper holds an `Arc<AsyncMutex<RuntimeManager>>` clone and calls
        // `evict_idle` once a minute. The terminal MQTT publish is done by the
        // main event loop draining `mgr.drain_evicted()` per tick (see Task 7).
        if let Some(threshold_secs) = self.config.idle_runtime_timeout_secs {
            let mgr = self.agents.clone();
            info!(threshold_secs, "idle ACP eviction enabled");
            let threshold = i64::try_from(threshold_secs).unwrap_or(i64::MAX);
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(60));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tick.tick().await;
                    let _evicted = mgr.lock().await.evict_idle(threshold).await;
                    // No publish here — main loop drains mgr.evicted_pending_publish.
                }
            });
        } else {
            info!("idle_runtime_timeout_secs unset; idle ACP eviction disabled");
        }

        // Advertise supported agent backend types on the cloud `agents` row
        // (background, with retries). Routing identity is the actor_id; no
        // separate device-id upsert. Skip when daemon.toml has no `[agents.*]`
        // sections — do not invent a claude fallback.
        {
            let sb = self.backend.clone();
            let supported_agent_types = supported_agent_type_names(&self.config);
            let default_agent_type = default_advertised_agent_type(&supported_agent_types);
            let advertise_status = agent_types_advertise.clone();
            if default_agent_type.is_none() {
                info!("no configured agent backends; skipping cloud agent_types advertise");
            } else if let Some(default_agent_type) = default_agent_type {
                tokio::spawn(async move {
                    let mut delay = Duration::from_secs(2);
                    for attempt in 1..=12 {
                        match sb
                            .ensure_agent_types(&supported_agent_types, &default_agent_type)
                            .await
                        {
                            Ok(()) => {
                                info!(
                                    types = ?supported_agent_types,
                                    default = %default_agent_type,
                                    "advertised agent backend types to cloud"
                                );
                                let mut s = advertise_status.lock();
                                s.advertised = true;
                                s.last_error = None;
                                break;
                            }
                            Err(e) if attempt < 12 => {
                                warn!(
                                    attempt,
                                    error = %e,
                                    "cloud agents.agent_types advertise failed; retrying"
                                );
                                advertise_status.lock().last_error = Some(e.to_string());
                                tokio::time::sleep(delay).await;
                                delay = (delay * 2).min(Duration::from_secs(60));
                            }
                            Err(e) => {
                                // Terminal: don't swallow it. Record on the status
                                // cell (surfaced via /v1/info) and log at ERROR so
                                // an advertise that never lands is visible.
                                error!(
                                    error = %e,
                                    "cloud agents.agent_types advertise failed; giving up after retries"
                                );
                                advertise_status.lock().last_error = Some(e.to_string());
                            }
                        }
                    }
                });
            }
        }

        // Report daemon client version once at startup (ops telemetry; non-fatal).
        {
            let sb = self.backend.clone();
            let device_id = crate::device_id::daemon_device_id();
            tokio::spawn(async move {
                if let Err(e) = sb.report_client_version(&device_id).await {
                    warn!("failed to report daemon client version: {e}");
                }
            });
        }

        // Dispatch to the NATS transport when the operator opted in via
        // `[transport] kind = "nats"`. The MQTT path below is unchanged.
        if matches!(
            self.config.transport.as_ref().map(|t| t.kind),
            Some(crate::config::TransportKind::Nats)
        ) {
            return self.run_nats(shutdown, sock_rx, sock_path).await;
        }

        tokio::pin!(shutdown);
        let mut first_connect = true;

        // Owned for the whole run: the `finalize_cron_turn` select arm drains
        // completed background cron turns off it. Taken once here (before the
        // reconnect loop) so a reconnect never re-takes an already-moved value.
        let mut cron_done_rx = self
            .cron_turn_done_rx
            .take()
            .expect("cron_turn_done_rx already taken (MQTT run loop entered twice)");

        'outer: loop {
            // ── 0. Self-heal team_id from daemon.toml ──
            // A daemon that started before onboarding wrote the team keeps
            // `team_id = None` for its whole process lifetime. It would then
            // publish presence + LWT under the `"teamclaw"` fallback topic
            // (see mqtt/client.rs) that no subscriber listens on, so it appears
            // permanently OFFLINE until a full process restart re-reads config.
            // Re-read daemon.toml here so a running daemon adopts the team on
            // its next reconnect cycle and converges without a restart.
            if self.config.team_id.is_none() {
                if let Ok(fresh) =
                    crate::config::DaemonConfig::load(&crate::config::DaemonConfig::default_path())
                {
                    if let Some(team_id) = fresh.team_id {
                        info!(%team_id, "adopted team_id from daemon.toml (self-heal)");
                        self.config.team_id = Some(team_id);

                        // Onboarding rewrites actor.id too. A daemon that
                        // bootstrapped its own config booted with a locally
                        // minted placeholder, and EMQX keys its topic ACLs on
                        // the cloud actor_id — connecting under the placeholder
                        // is denied. Adopt it in the same pass so the reconnect
                        // below uses the identity the broker expects.
                        //
                        // Only the MQTT identity converges here: the topics and
                        // client are rebuilt each cycle. Startup-captured consumers
                        // (teamclaw::SessionManager) still hold the old id,
                        // which is why POST /v1/setup/claim reports
                        // requiresRestart for a daemon that booted unclaimed.
                        if fresh.actor.id != self.config.actor.id {
                            info!(
                                previous_actor_id = %self.config.actor.id,
                                actor_id = %fresh.actor.id,
                                "adopted actor.id from daemon.toml (self-heal)"
                            );
                            self.config.actor.id = fresh.actor.id;
                        }
                    }
                }
                // Still teamless: there is nothing team-scoped to do on MQTT
                // (no presence topic, no teamclaw command channel). Rather than
                // hold a connection open forever in a state onboarding can't
                // heal, back off and re-check daemon.toml on the next cycle.
                if self.config.team_id.is_none() {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                        _ = &mut shutdown => {
                            info!("shutdown signal received while awaiting team_id");
                            let _ = std::fs::remove_file(&sock_path);
                            return Ok(());
                        }
                    }
                    continue 'outer;
                }
            }

            // ── 0b. Self-heal MQTT broker from bootstrap ──
            // If FC was unreachable at startup and daemon.toml had no invite
            // `?broker=` override, `config.mqtt.broker_url` stays empty forever
            // and the client below is rebuilt from an unusable broker every tick.
            // Re-fetch the bootstrap broker here — but only when it is actually
            // missing, so we don't hammer FC every cycle once a broker is known.
            if self.config.mqtt.broker_url.trim().is_empty() {
                if let Err(e) = apply_bootstrap_overrides(&self.backend, &mut self.config).await {
                    warn!(error = %e, "bootstrap mqtt re-fetch failed; will retry next cycle");
                }
                if self.config.mqtt.broker_url.trim().is_empty() {
                    // Still no broker: back off (honoring shutdown) rather than
                    // spin rebuilding a placeholder client against an empty URL.
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                        _ = &mut shutdown => {
                            info!("shutdown signal received while awaiting MQTT broker");
                            let _ = std::fs::remove_file(&sock_path);
                            return Ok(());
                        }
                    }
                    continue 'outer;
                }
            }

            // ── 1. Get fresh access_token (retry indefinitely on cloud backend errors) ──
            let token = loop {
                match self.backend.auth_token().await {
                    Ok(t) => break t,
                    Err(e) => {
                        warn!("token fetch failed: {e}, retrying in 30s");
                        // Race the sleep against shutdown so SIGTERM is honored
                        // during a cloud outage instead of forcing SIGKILL.
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                            _ = &mut shutdown => {
                                info!("shutdown signal received while retrying token fetch");
                                let _ = std::fs::remove_file(&sock_path);
                                return Ok(());
                            }
                        }
                    }
                }
            };
            if credential_in_proactive_refresh_window(self.backend.cached_credential_expiry_epoch())
            {
                info!(
                    "cached JWT within proactive refresh window, forcing token refresh before MQTT connect"
                );
                self.backend.invalidate_cached_credential();
                continue 'outer;
            }

            // ── 2. Rebuild MqttClient ──
            let credential_mode =
                if self.config.mqtt.username.is_some() && self.config.mqtt.password.is_some() {
                    "configured"
                } else {
                    "backend_token"
                };
            info!(
                actor_id = %self.actor_id,
                broker   = %self.config.mqtt.broker_url,
                credential_mode,
                "MQTT connecting"
            );
            self.mqtt = match MqttClient::new(&self.config, &self.actor_id, &token) {
                Ok(c) => c,
                Err(e) => {
                    warn!("MqttClient build failed: {e}, retrying in 5s");
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                        _ = &mut shutdown => {
                            info!("shutdown signal received while rebuilding MQTT client");
                            let _ = std::fs::remove_file(&sock_path);
                            return Ok(());
                        }
                    }
                    continue 'outer;
                }
            };

            // ── 3. Rebuild teamclaw with new AsyncClient ──
            if let Some(team_id) = self.config.team_id.clone() {
                self.publisher_handle = Arc::new(self.mqtt.client.clone());
                self.topics = self.mqtt.topics.clone();
                self.refresh_rpc_client_publisher();
                self.teamclaw = match crate::teamclaw::SessionManager::new(
                    self.publisher_handle.clone(),
                    &team_id,
                    &self.config.actor.id,
                    Some(self.actor_id.clone()),
                    crate::config::DaemonConfig::config_dir(),
                ) {
                    Ok(mut tc) => {
                        tc.set_local_tee(self.live_tee.clone());
                        Some(tc)
                    }
                    Err(e) => {
                        warn!("teamclaw rebuild failed: {e}");
                        None
                    }
                };
            }

            // ── 4. Wait for CONNACK ──
            mark_mqtt_connected(&self.mqtt_connected_flag, false);
            loop {
                match self.mqtt.eventloop.poll().await {
                    Ok(Event::Incoming(Packet::ConnAck(_))) => {
                        info!("MQTT CONNACK received");
                        mark_mqtt_connected(&self.mqtt_connected_flag, true);
                        break;
                    }
                    Ok(_) => {}
                    Err(rumqttc::ConnectionError::ConnectionRefused(code)) => {
                        warn!(
                            reason = ?code,
                            "MQTT connection refused during connect, refreshing token"
                        );
                        self.backend.invalidate_cached_credential();
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                            _ = &mut shutdown => {
                                info!("shutdown signal received while awaiting MQTT CONNACK");
                                let _ = std::fs::remove_file(&sock_path);
                                return Ok(());
                            }
                        }
                        continue 'outer;
                    }
                    Err(e) => {
                        warn!("MQTT connect error: {e}, retrying...");
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                            _ = &mut shutdown => {
                                info!("shutdown signal received while awaiting MQTT CONNACK");
                                let _ = std::fs::remove_file(&sock_path);
                                return Ok(());
                            }
                        }
                    }
                }
            }

            // ── 5. Subscribe and announce ──
            if self.mqtt_resubscribe_after_connack("initial").await.is_err() {
                continue 'outer;
            }
            info!(actor_id = %self.config.actor.id, "MQTT connected, listening for commands");

            if first_connect {
                // Drain messages that landed in the cloud backend while the daemon
                // process was down. MQTT lives are dropped by the broker
                // when clean_session=true clients are offline, so anything
                // posted by desktop/iOS/expo between daemon stop and start
                // exists only in the `messages` table and would otherwise
                // never reach any agent.
                self.auto_restart_offline_sessions().await;
                first_connect = false;
            }

            // ── 6. Proactive reconnect timer ──
            //
            // Compute when to break the inner loop so we can fetch a fresh
            // access_token and re-CONNECT before the current JWT expires.
            // EMQX silently rejects PUB/SUB on a connection whose JWT exp
            // has passed (it doesn't always disconnect), so waiting for a
            // reactive ConnectionRefused leaves stale-ACL windows where
            // the daemon thinks everything's fine but messages are dropped.
            // Fire 5 min before the cached expiry; conservative 50 min
            // fallback if expiry isn't cached yet.
            let proactive_reconnect_in =
                proactive_reconnect_delay(self.backend.cached_credential_expiry_epoch());
            info!(
                reconnect_in_secs = proactive_reconnect_in.as_secs(),
                "scheduled proactive MQTT reconnect before token expiry"
            );
            let proactive_sleep = tokio::time::sleep(proactive_reconnect_in);
            tokio::pin!(proactive_sleep);

            // Track how long we've been disconnected so rumqttc auto-reconnect
            // cannot wedge the daemon after a backend/EMQX restart.
            let mut disconnected_since: Option<std::time::Instant> = None;

            // ── 7. Event loop ──
            //
            // We must NEVER preempt `eventloop.poll()` with a timeout. rumqttc's
            // poll() drives TLS handshake / TCP reconnect / packet IO inside one
            // future; if we drop the future mid-flight (which timeout() does),
            // the in-progress connection state is dropped, the underlying socket
            // is closed (broker sees `ssl_closed`), and the next poll() starts a
            // fresh reconnect — leading to a self-takeover loop where the
            // daemon opens 4-5 sockets per ~50 ms timeout cycle and broker
            // discards them. Use `tokio::select!` instead so the agent-event
            // pump runs alongside poll() without cancelling it.
            loop {
                tokio::select! {
                    biased;
                    _ = &mut shutdown => {
                        info!("shutdown signal received, draining channels");
                        self.shutdown_channels().await;
                        let _ = std::fs::remove_file(&sock_path);
                        return Ok(());
                    }
                    sock_cmd = sock_rx.recv() => {
                        match sock_cmd {
                            Some(SockCommand::Shutdown) => {
                                info!("shutdown control command received, draining channels");
                                self.shutdown_channels().await;
                                let _ = std::fs::remove_file(&sock_path);
                                return Ok(());
                            }
                            Some(SockCommand::ChannelReload) => {
                                self.reload_channels().await;
                            }
                            Some(SockCommand::ChannelStatus { reply_tx }) => {
                                let body = self.channel_status_payload().await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::WecomBotsStatus { reply_tx }) => {
                                let body = self.wecom_bots_status_payload().await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::ChannelSave { platform, config_json }) => {
                                self.save_channel_config(&platform, &config_json).await;
                            }
                            Some(SockCommand::McpSend { payload, reply_tx }) => {
                                let resp = match self.handle_mcp_send(&payload).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::RemoteToolCall { payload, reply_tx }) => {
                                self.spawn_remote_tool_sock_handler(payload, reply_tx)
                                    .await;
                            }
                            Some(SockCommand::PromptAwait { payload, reply_tx }) => {
                                // Fast setup inline; the turn runs on a task and
                                // its result comes back via `cron_turn_done_rx`
                                // (see the `finalize_cron_turn` select arm below).
                                self.handle_prompt_await(&payload, reply_tx).await;
                            }
                            Some(SockCommand::CronPrepareSession { payload, reply_tx }) => {
                                let resp = match self.handle_cron_prepare_session(&payload).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WechatQrStart { reply_tx }) => {
                                let base_url = teamclaw_gateway::wechat_config::default_ilink_base_url();
                                let resp = match teamclaw_gateway::wechat::fetch_qr_code(&base_url).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WechatQrPoll { qrcode, reply_tx }) => {
                                let base_url = teamclaw_gateway::wechat_config::default_ilink_base_url();
                                let resp = match teamclaw_gateway::wechat::poll_qr_status(&base_url, &qrcode).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WecomQrStart { reply_tx }) => {
                                let resp = match teamclaw_gateway::wecom::fetch_wecom_qr_code().await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WecomQrPoll { scode, reply_tx }) => {
                                let resp = match teamclaw_gateway::wecom::poll_wecom_qr_result(&scode).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::AddWorkspace { path, reply_tx }) => {
                                let body = self.handle_add_workspace_sock(&path).await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::Unknown(line)) => {
                                warn!("amuxd.sock: unknown control command: {line:?}");
                            }
                            None => {
                                // Sender dropped — listener task died. Log and
                                // keep running; we just lose the sock control
                                // path until next restart.
                                warn!("amuxd.sock: listener channel closed; control commands unavailable until restart");
                            }
                        }
                    }
                    done = cron_done_rx.recv() => {
                        // A background cron turn finished: persist its AgentReply
                        // and answer the waiting sock client. `None` only if all
                        // senders dropped (never — `self` holds the sender).
                        if let Some(done) = done {
                            self.finalize_cron_turn(done).await;
                        }
                    }
                    poll_result = self.mqtt.eventloop.poll() => {
                        match poll_result {
                            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                                // Network blip — rumqttc reconnected automatically.
                                info!("MQTT reconnected (network blip), re-publishing state");
                                disconnected_since = None;
                                if self
                                    .mqtt_resubscribe_after_connack("auto-reconnect")
                                    .await
                                    .is_err()
                                {
                                    self.backend.invalidate_cached_credential();
                                    break;
                                }
                            }
                            Ok(Event::Incoming(Packet::Publish(publish))) => {
                                if let Some(msg) = subscriber::parse_incoming(&publish) {
                                    self.handle_incoming(msg).await;
                                }
                            }
                            // EMQX rejected connection (JWT expired).
                            Err(rumqttc::ConnectionError::ConnectionRefused(code)) => {
                                mark_mqtt_connected(&self.mqtt_connected_flag, false);
                                warn!(reason = ?code, "MQTT connection refused (token expired), reconnecting");
                                self.backend.invalidate_cached_credential();
                                break; // outer loop gets fresh token
                            }
                            Err(e) => {
                                mark_mqtt_connected(&self.mqtt_connected_flag, false);
                                warn!("MQTT transient error: {e}, will retry (rumqttc auto-reconnects)");
                                tokio::time::sleep(Duration::from_secs(5)).await;
                            }
                            Ok(_) => {} // other events (Outgoing(...), PingResp, etc.)
                        }
                    }
                    _ = &mut proactive_sleep => {
                        info!(
                            expiry = ?self.backend.cached_credential_expiry_epoch(),
                            "JWT nearing expiry, proactively reconnecting MQTT before broker silently denies ACL"
                        );
                        mark_mqtt_connected(&self.mqtt_connected_flag, false);
                        self.backend.invalidate_cached_credential();
                        // Queue a graceful DISCONNECT so the broker sees an
                        // intentional close (no LWT blip) before we drop the
                        // eventloop. The drain loop below gives rumqttc a
                        // bounded chance to write the packet.
                        let _ = self.mqtt.client.disconnect().await;
                        for _ in 0..3 {
                            match tokio::time::timeout(
                                Duration::from_millis(50),
                                self.mqtt.eventloop.poll(),
                            ).await {
                                Ok(Err(_)) | Err(_) => break,
                                Ok(Ok(_)) => {}
                            }
                        }
                        break; // outer loop fetches fresh token + reconnects
                    }
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {
                        // FIX 8: gate the pump on the shared MQTT-connected flag.
                        // On a proactive reconnect / ConnectionRefused the old
                        // AsyncClient (and its queued QoS1 deltas) is dropped
                        // wholesale on rebuild, so publishing while the link is
                        // known-down silently loses live deltas. Rather than
                        // build a full outbox, we simply HOLD: skip draining
                        // `poll_events()` (events stay buffered in the
                        // RuntimeManager) until CONNACK re-sets the flag, so the
                        // deltas are forwarded intact after reconnect. `false`
                        // when the flag cell is absent (test/degraded) → treat as
                        // connected so behavior is unchanged there.
                        let mqtt_up = self
                            .mqtt_connected_flag
                            .as_ref()
                            .map(|f| f.load(std::sync::atomic::Ordering::Relaxed))
                            .unwrap_or(true);
                        if !mqtt_up {
                            if disconnected_since.is_none() {
                                disconnected_since = Some(std::time::Instant::now());
                            } else if mqtt_disconnect_rebuild_due(
                                disconnected_since,
                                MQTT_DISCONNECT_REBUILD,
                            ) {
                                warn!(
                                    threshold_secs = MQTT_DISCONNECT_REBUILD.as_secs(),
                                    "MQTT disconnected too long, forcing full reconnect with fresh credentials"
                                );
                                self.backend.invalidate_cached_credential();
                                break;
                            }
                        } else {
                            disconnected_since = None;
                        }
                        if mqtt_up {
                            // Drain queued runtime events without preempting poll().
                            let (agent_events, evicted_runtime_ids): (Vec<_>, Vec<String>) = {
                                let mut mgr = self.agents.lock().await;
                                (mgr.poll_events(), mgr.drain_evicted())
                            };
                            for runtime_id in evicted_runtime_ids {
                                self.publish_runtime_stopped(&runtime_id).await;
                            }
                            for (agent_id, acp_event) in coalesce_text_events(agent_events) {
                                self.forward_agent_event(&agent_id, acp_event).await;
                            }
                        }
                    }
                }
            }
            // loop exited → outer: get fresh token and reconnect
        }
    }

    /// NATS transport main loop. Parallel to the MQTT path in `run()` above —
    /// same token-refresh outer cadence, but the inner loop polls the NATS
    /// inbound channel (mpsc Receiver fed by per-subscription tasks inside
    /// `teamclaw_transport::nats::NatsClient`).
    ///
    /// Differences vs MQTT:
    /// - No CONNACK wait: async_nats returns from `connect` only after the
    ///   server has accepted the connection.
    /// - No LWT: graceful offline state is written to JetStream KV during
    ///   shutdown / reconnect; ungraceful disconnects are detected by the
    ///   server-side auth callout.
    /// - No `eventloop.poll()` to cancel — async_nats reconnects internally
    ///   on transport-level errors, so the proactive-reconnect path just
    ///   builds a fresh `NatsBackend` rather than draining a half-closed
    ///   socket.
    pub(crate) async fn run_nats<F>(
        mut self,
        shutdown: F,
        mut sock_rx: mpsc::Receiver<SockCommand>,
        sock_path: PathBuf,
    ) -> crate::error::Result<()>
    where
        F: Future<Output = ()>,
    {
        use teamclaw_transport::DeliveryGuarantee;
        tokio::pin!(shutdown);

        let url = self
            .config
            .transport
            .as_ref()
            .map(|t| t.url.clone())
            .ok_or_else(|| {
                crate::error::AmuxError::Config(
                    "[transport] section requires `url` when kind = nats".into(),
                )
            })?;

        let mut first_connect = true;

        // See the MQTT path: taken once before the reconnect loop so the
        // `finalize_cron_turn` select arm can drain completed cron turns.
        let mut cron_done_rx = self
            .cron_turn_done_rx
            .take()
            .expect("cron_turn_done_rx already taken (NATS run loop entered twice)");

        'outer: loop {
            // 1. Fresh backend access_token; same retry cadence as MQTT path.
            let token = loop {
                match self.backend.auth_token().await {
                    Ok(t) => break t,
                    Err(e) => {
                        warn!("token fetch failed: {e}, retrying in 30s");
                        // Race the sleep against shutdown so SIGTERM is honored
                        // during a cloud outage instead of forcing SIGKILL.
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                            _ = &mut shutdown => {
                                info!("shutdown signal received while retrying token fetch");
                                let _ = std::fs::remove_file(&sock_path);
                                return Ok(());
                            }
                        }
                    }
                }
            };
            if credential_in_proactive_refresh_window(self.backend.cached_credential_expiry_epoch())
            {
                info!(
                    "cached JWT within proactive refresh window, forcing token refresh before NATS connect"
                );
                self.backend.invalidate_cached_credential();
                continue 'outer;
            }

            // 2. Connect.
            info!(
                actor_id = %self.actor_id,
                %url,
                "NATS connecting with access_token"
            );
            let backend = match crate::nats::NatsBackend::connect(&self.config, &url, &token).await
            {
                Ok(b) => b,
                Err(e) => {
                    warn!("NATS connect failed: {e}, retrying in 5s");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue 'outer;
                }
            };

            // 3. Re-wire publisher_handle + topics so all downstream
            //    Publisher::new_from_handle / SessionManager publishes route
            //    through the NATS backend instead of the MQTT one.
            self.publisher_handle = Arc::new(backend.client.clone());
            self.topics = backend.topics.clone();
            self.refresh_rpc_client_publisher();
            if let Some(team_id) = self.config.team_id.clone() {
                self.teamclaw = match crate::teamclaw::SessionManager::new(
                    self.publisher_handle.clone(),
                    &team_id,
                    &self.config.actor.id,
                    Some(self.actor_id.clone()),
                    crate::config::DaemonConfig::config_dir(),
                ) {
                    Ok(mut tc) => {
                        tc.set_local_tee(self.live_tee.clone());
                        Some(tc)
                    }
                    Err(e) => {
                        warn!("teamclaw rebuild on NATS failed: {e}");
                        None
                    }
                };
            }
            self.nats = Some(backend);

            // 4. Subscribe + announce online.
            if let Err(e) = self.nats.as_ref().unwrap().subscribe_all().await {
                warn!("nats subscribe_all failed: {e}, reconnecting");
                continue 'outer;
            }
            if let Some(tc) = &mut self.teamclaw {
                if let Err(e) = tc.subscribe_all().await {
                    warn!("teamclaw subscribe failed on NATS: {e}, reconnecting");
                    continue 'outer;
                }
            }
            if let Err(e) = self
                .nats
                .as_ref()
                .unwrap()
                .announce_online(&self.config.actor.name)
                .await
            {
                warn!("nats announce_online failed: {e}, reconnecting");
                continue 'outer;
            }
            self.publish_all_agent_states().await;
            info!(actor_id = %self.config.actor.id, "NATS connected, listening for runtime commands");

            if first_connect {
                self.auto_restart_offline_sessions().await;
                first_connect = false;
            }

            // 5. Proactive reconnect timer (mirrors MQTT path: refresh ~5min
            //    before cached JWT expiry). On NATS this means tearing down
            //    the current client and reconnecting with the new token —
            //    async_nats keeps the auth token only at connect time, so an
            //    in-place refresh isn't possible without a fresh connection.
            let proactive_reconnect_in =
                proactive_reconnect_delay(self.backend.cached_credential_expiry_epoch());
            info!(
                reconnect_in_secs = proactive_reconnect_in.as_secs(),
                "scheduled proactive NATS reconnect before token expiry"
            );
            let proactive_sleep = tokio::time::sleep(proactive_reconnect_in);
            tokio::pin!(proactive_sleep);

            // 6. Inner select loop — three arms: shutdown, sock command,
            //    inbound NATS frame. The inbound receiver is moved out of
            //    `self.nats` once for the duration of this select cycle and
            //    re-attached on reconnect.
            //
            //    We can't borrow `&mut self.nats.inbound` *and* call
            //    `&mut self` methods inside the same select arm, so the
            //    receiver is owned locally and the backend reference goes
            //    along with it. SessionManager and Publisher reads happen
            //    via the cloned `publisher_handle`, which doesn't touch
            //    `self.nats`.
            let mut inbound = self.nats.as_mut().unwrap().inbound_take();
            loop {
                tokio::select! {
                    biased;
                    _ = &mut shutdown => {
                        info!("shutdown signal received, draining channels");
                        if let Some(nats) = &self.nats {
                            let _ = nats.announce_offline(&self.config.actor.name).await;
                        }
                        self.shutdown_channels().await;
                        let _ = std::fs::remove_file(&sock_path);
                        return Ok(());
                    }
                    sock_cmd = sock_rx.recv() => {
                        match sock_cmd {
                            Some(SockCommand::Shutdown) => {
                                info!("shutdown control command received, draining channels");
                                if let Some(nats) = &self.nats {
                                    let _ = nats.announce_offline(&self.config.actor.name).await;
                                }
                                self.shutdown_channels().await;
                                let _ = std::fs::remove_file(&sock_path);
                                return Ok(());
                            }
                            Some(SockCommand::ChannelReload) => self.reload_channels().await,
                            Some(SockCommand::ChannelStatus { reply_tx }) => {
                                let body = self.channel_status_payload().await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::WecomBotsStatus { reply_tx }) => {
                                let body = self.wecom_bots_status_payload().await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::ChannelSave { platform, config_json }) => {
                                self.save_channel_config(&platform, &config_json).await;
                            }
                            Some(SockCommand::McpSend { payload, reply_tx }) => {
                                let resp = match self.handle_mcp_send(&payload).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::RemoteToolCall { payload, reply_tx }) => {
                                self.spawn_remote_tool_sock_handler(payload, reply_tx)
                                    .await;
                            }
                            Some(SockCommand::PromptAwait { payload, reply_tx }) => {
                                // Fast setup inline; the turn runs on a task and
                                // its result comes back via `cron_turn_done_rx`
                                // (see the `finalize_cron_turn` select arm below).
                                self.handle_prompt_await(&payload, reply_tx).await;
                            }
                            Some(SockCommand::CronPrepareSession { payload, reply_tx }) => {
                                let resp = match self.handle_cron_prepare_session(&payload).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WechatQrStart { reply_tx }) => {
                                let base_url = teamclaw_gateway::wechat_config::default_ilink_base_url();
                                let resp = match teamclaw_gateway::wechat::fetch_qr_code(&base_url).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WechatQrPoll { qrcode, reply_tx }) => {
                                let base_url = teamclaw_gateway::wechat_config::default_ilink_base_url();
                                let resp = match teamclaw_gateway::wechat::poll_qr_status(&base_url, &qrcode).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WecomQrStart { reply_tx }) => {
                                let resp = match teamclaw_gateway::wecom::fetch_wecom_qr_code().await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WecomQrPoll { scode, reply_tx }) => {
                                let resp = match teamclaw_gateway::wecom::poll_wecom_qr_result(&scode).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::AddWorkspace { path, reply_tx }) => {
                                let body = self.handle_add_workspace_sock(&path).await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::Unknown(line)) => warn!("amuxd.sock: unknown control command: {line:?}"),
                            None => warn!("amuxd.sock: listener channel closed; control commands unavailable until restart"),
                        }
                    }
                    done = cron_done_rx.recv() => {
                        // Background cron turn finished — persist + reply. See the
                        // matching arm in the MQTT loop.
                        if let Some(done) = done {
                            self.finalize_cron_turn(done).await;
                        }
                    }
                    frame = inbound.recv() => {
                        match frame {
                            Some(f) => {
                                if let Some(msg) = crate::mqtt::subscriber::parse_frame(&f) {
                                    self.handle_incoming(msg).await;
                                }
                            }
                            None => {
                                warn!("NATS inbound channel closed, reconnecting");
                                break;
                            }
                        }
                    }
                    _ = &mut proactive_sleep => {
                        info!(
                            expiry = ?self.backend.cached_credential_expiry_epoch(),
                            "JWT nearing expiry, proactively reconnecting NATS"
                        );
                        self.backend.invalidate_cached_credential();
                        // Mark offline before tearing down so subscribers see
                        // the presence change immediately rather than waiting
                        // for the next online publish.
                        if let Some(nats) = &self.nats {
                            let _ = nats.announce_offline(&self.config.actor.name).await;
                        }
                        break;
                    }
                }
            }
            // Put the inbound receiver back so the next reconnect can take it.
            self.nats.as_mut().unwrap().inbound_put_back(inbound);
            // loop exited → outer: get fresh token and reconnect
            let _ = DeliveryGuarantee::AtLeastOnce; // touch import so it stays
        }
    }

    /// Re-engage with sessions that had a runtime before the daemon was
    /// last shut down so we can replay messages that landed in the cloud backend
    /// while the daemon was offline.
    ///
    /// Daemon-owned runtimes are subprocesses; they die when the daemon
    /// process exits. MQTT live publishes against those sessions are
    /// dropped by the broker (clean_session=true), so the only record of
    /// those messages is the `messages` table. The user-facing symptom is
    /// "messages I sent while the daemon was off never get a reply"
    /// (mentions go unanswered, silent messages never enter the runtime's
    /// pending_silent queue).
    ///
    /// Strategy: for each session this daemon is a member of, look up the
    /// most recent `agent_runtimes` row owned by this daemon. If the row
    /// has unread messages strictly after the row's
    /// `last_processed_message_id` cursor, spawn the runtime (reusing the
    /// row's `workspace_id` + `backend_type`). The existing
    /// `catchup_runtime` path then routes those messages through
    /// `route_session_message`, which sends `[Context]` prefixes for
    /// un-mentioned rows and a real prompt for mentions.
    ///
    /// Self-authored rows are filtered out — they are the daemon's own
    /// prior agent replies, not user input that needs processing.
    pub(crate) async fn auto_restart_offline_sessions(&mut self) {
        let plan = self.plan_auto_restart_offline_sessions().await;
        if plan.is_empty() {
            return;
        }
        info!(
            count = plan.len(),
            "auto_restart_offline_sessions: spawning {} runtime(s) for sessions with offline messages",
            plan.len()
        );
        for entry in plan {
            info!(
                session_id = %entry.session_id,
                workspace_id = %entry.local_workspace_id,
                backend = ?entry.backend,
                unread = entry.unread_count,
                "auto_restart_offline_sessions: spawning runtime to drain offline messages"
            );
            match self
                .apply_start_runtime(
                    entry.backend,
                    &entry.local_workspace_id,
                    "",
                    &entry.session_id,
                    "",
                    None,
                    "",
                )
                .await
            {
                Ok(outcome) => {
                    info!(
                        session_id = %entry.session_id,
                        runtime_id = %outcome.runtime_id,
                        "auto_restart_offline_sessions: runtime spawned, catchup_runtime engaged"
                    );
                }
                Err(err) => {
                    warn!(
                        session_id = %entry.session_id,
                        error = %err.error_message,
                        stage = %err.failed_stage,
                        "auto_restart_offline_sessions: apply_start_runtime failed"
                    );
                }
            }
        }
    }

    /// Pure-decision half of [`auto_restart_offline_sessions`]: walks
    /// membership sessions, queries the cloud backend, and returns the subset that
    /// should be re-spawned. Extracted so unit tests can drive the
    /// branching logic (no prior row → skip, only self-authored unread →
    /// skip, already-running runtime → skip, etc.) without booting a real
    /// ACP backend.
    pub(crate) async fn plan_auto_restart_offline_sessions(&self) -> Vec<OfflineRestartPlan> {
        let session_ids: Vec<String> = match self.teamclaw.as_ref() {
            Some(tc) => tc.membership_session_ids(),
            None => return Vec::new(),
        };
        if session_ids.is_empty() {
            return Vec::new();
        }
        info!(
            count = session_ids.len(),
            "plan_auto_restart_offline_sessions: scanning membership sessions for offline messages"
        );

        let mut plan = Vec::new();
        let my_actor = self.actor_id.clone();
        for session_id in session_ids {
            let prior = match self
                .backend
                .fetch_latest_runtime_for_session(&my_actor, &session_id)
                .await
            {
                Ok(Some(row)) => row,
                Ok(None) => continue,
                Err(e) => {
                    warn!(
                        ?e,
                        session_id = %session_id,
                        "plan_auto_restart_offline_sessions: fetch_latest_runtime_for_session failed"
                    );
                    continue;
                }
            };

            // If a live runtime is already serving this session (e.g. a
            // network blip rather than a full daemon restart), skip — the
            // live MQTT path will deliver the messages directly.
            let already_running = !self
                .agents
                .lock()
                .await
                .runtime_ids_for_session(&session_id)
                .is_empty();
            if already_running {
                continue;
            }

            let cursor = prior
                .last_processed_message_id
                .as_deref()
                .filter(|s| !s.is_empty());
            let messages = match self
                .backend
                .messages_after_cursor(&session_id, cursor)
                .await
            {
                Ok(m) => m,
                Err(e) => {
                    warn!(
                        ?e,
                        session_id = %session_id,
                        "plan_auto_restart_offline_sessions: messages_after_cursor failed"
                    );
                    continue;
                }
            };

            if !slice_has_actionable_inbound(&messages, &my_actor) {
                continue;
            }

            let unread_count = messages
                .iter()
                .filter(|m| m.sender_actor_id != my_actor)
                .count();

            let backend_requested = match prior.backend_type.as_str() {
                "claude" | "claude_code" => amux::AgentType::ClaudeCode,
                "opencode" => amux::AgentType::Opencode,
                "codex" => amux::AgentType::Codex,
                _ => amux::AgentType::Unknown,
            };
            let backend = resolve_requested_agent_type(&self.config, backend_requested);

            // `amux.workspaces` is the sole source of truth: the cloud
            // workspace id IS the workspace id — no more local-id
            // translation via a `remote_workspace_id` mapping.
            let local_workspace_id = prior.workspace_id.clone().unwrap_or_default();

            plan.push(OfflineRestartPlan {
                session_id,
                backend,
                local_workspace_id,
                unread_count,
            });
        }
        plan
    }
}

fn reject_stop(
    request: &crate::proto::teamclaw::RpcRequest,
    reason: &str,
) -> crate::proto::teamclaw::RpcResponse {
    use crate::proto::teamclaw::{rpc_response, RpcResponse, RuntimeStopResult};
    RpcResponse {
        request_id: request.request_id.clone(),
        success: false,
        error: reason.to_string(),
        requester_client_id: request.requester_client_id.clone(),
        requester_actor_id: request.requester_actor_id.clone(),
        result: Some(rpc_response::Result::RuntimeStopResult(RuntimeStopResult {
            accepted: false,
            rejected_reason: reason.to_string(),
        })),
    }
}

fn reject_set_model(
    request: &crate::proto::teamclaw::RpcRequest,
    reason: &str,
) -> crate::proto::teamclaw::RpcResponse {
    use crate::proto::teamclaw::{rpc_response, RpcResponse, SetModelResult};
    RpcResponse {
        request_id: request.request_id.clone(),
        success: false,
        error: reason.to_string(),
        requester_client_id: request.requester_client_id.clone(),
        requester_actor_id: request.requester_actor_id.clone(),
        result: Some(rpc_response::Result::SetModelResult(SetModelResult {
            success: false,
            error: reason.to_string(),
        })),
    }
}

/// Shrinks an `AcpAvailableCommands` list in place so the serialized message
/// stays under the broker's per-packet cap. Strategy: walk the description
/// length down (80 → 40 → 20 → 0) until the encoded size fits; if stripping
/// descriptions is still not enough, drop commands from the tail.
///
/// The budget is deliberately well under the 10 240-byte broker limit to
/// leave headroom for the envelope wrapper (actor_id, agent_id, sequence,
/// etc.) and the MQTT topic name / fixed header.
fn fit_available_commands_in_budget(ac: &mut crate::proto::amux::AcpAvailableCommands) {
    use prost::Message;
    const BUDGET: usize = 8_500;

    if ac.encoded_len() <= BUDGET {
        return;
    }

    for &limit in &[80usize, 40, 20, 0] {
        for cmd in &mut ac.commands {
            if cmd.description.chars().count() > limit {
                cmd.description = cmd.description.chars().take(limit).collect();
            }
        }
        if ac.encoded_len() <= BUDGET {
            return;
        }
    }

    while ac.encoded_len() > BUDGET && !ac.commands.is_empty() {
        ac.commands.pop();
    }
}

/// Handle one control connection: read a newline-terminated command (line
/// protocol or `{`-sniffed JSON envelope) and forward it to the main loop.
/// Generic over the transport: UnixStream on unix, NamedPipeServer on Windows.
async fn handle_control_conn<S>(stream: S, tx: mpsc::Sender<SockCommand>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(stream);
    let mut first_line = String::new();
    match reader.read_line(&mut first_line).await {
        Ok(0) => {}
        Ok(_) => {
            let head = first_line.trim();

            // JSON envelopes (currently just `mcp-send`)
            // are framed differently from the legacy
            // line-based control protocol — sniff the
            // first byte and branch.
            if head.starts_with('{') {
                let parsed: Result<serde_json::Value, _> = serde_json::from_str(head);
                match parsed {
                    Ok(v) => {
                        let cmd = v.get("cmd").and_then(|c| c.as_str()).unwrap_or("");
                        if cmd == "mcp-send" {
                            let (reply_tx, reply_rx) = oneshot::channel();
                            if tx
                                .send(SockCommand::McpSend {
                                    payload: v,
                                    reply_tx,
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                            match reply_rx.await {
                                Ok(body) => {
                                    let mut stream = reader.into_inner();
                                    if let Err(e) = stream.write_all(body.as_bytes()).await {
                                        warn!("amuxd.sock: mcp-send write failed: {e}");
                                        return;
                                    }
                                    let _ = stream.write_all(b"\n").await;
                                    let _ = stream.shutdown().await;
                                }
                                Err(_) => {
                                    warn!("amuxd.sock: mcp-send reply dropped");
                                }
                            }
                        } else if cmd == "remote-tool-call" {
                            let (reply_tx, reply_rx) = oneshot::channel();
                            if tx
                                .send(SockCommand::RemoteToolCall {
                                    payload: v,
                                    reply_tx,
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                            match reply_rx.await {
                                Ok(body) => {
                                    let mut stream = reader.into_inner();
                                    if let Err(e) = stream.write_all(body.as_bytes()).await {
                                        warn!("amuxd.sock: remote-tool-call write failed: {e}");
                                        return;
                                    }
                                    let _ = stream.write_all(b"\n").await;
                                    let _ = stream.shutdown().await;
                                }
                                Err(_) => {
                                    warn!("amuxd.sock: remote-tool-call reply dropped");
                                }
                            }
                        } else if cmd == "prompt-await" {
                            let (reply_tx, reply_rx) = oneshot::channel();
                            if tx
                                .send(SockCommand::PromptAwait {
                                    payload: v,
                                    reply_tx,
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                            match reply_rx.await {
                                Ok(body) => {
                                    let mut stream = reader.into_inner();
                                    if let Err(e) = stream.write_all(body.as_bytes()).await {
                                        warn!("amuxd.sock: prompt-await write failed: {e}");
                                        return;
                                    }
                                    let _ = stream.write_all(b"\n").await;
                                    let _ = stream.shutdown().await;
                                }
                                Err(_) => {
                                    warn!("amuxd.sock: prompt-await reply dropped");
                                }
                            }
                        } else if cmd == "cron-prepare-session" {
                            let (reply_tx, reply_rx) = oneshot::channel();
                            if tx
                                .send(SockCommand::CronPrepareSession {
                                    payload: v,
                                    reply_tx,
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                            match reply_rx.await {
                                Ok(body) => {
                                    let mut stream = reader.into_inner();
                                    if let Err(e) = stream.write_all(body.as_bytes()).await {
                                        warn!("amuxd.sock: cron-prepare-session write failed: {e}");
                                        return;
                                    }
                                    let _ = stream.write_all(b"\n").await;
                                    let _ = stream.shutdown().await;
                                }
                                Err(_) => {
                                    warn!("amuxd.sock: cron-prepare-session reply dropped");
                                }
                            }
                        } else {
                            warn!("amuxd.sock: unknown JSON cmd: {cmd:?}");
                        }
                    }
                    Err(e) => {
                        warn!("amuxd.sock: JSON parse failed: {e}");
                    }
                }
                return;
            }

            match head {
                "channel-reload" => {
                    let _ = tx.send(SockCommand::ChannelReload).await;
                }
                "channel-status" => {
                    // Round-trip: ask the main loop to build a
                    // status snapshot, then write the JSON body
                    // back to the connected client.
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if tx
                        .send(SockCommand::ChannelStatus { reply_tx })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    match reply_rx.await {
                        Ok(body) => {
                            let mut stream = reader.into_inner();
                            if let Err(e) = stream.write_all(body.as_bytes()).await {
                                warn!("amuxd.sock: channel-status write failed: {e}");
                                return;
                            }
                            let _ = stream.write_all(b"\n").await;
                            let _ = stream.shutdown().await;
                        }
                        Err(_) => {
                            warn!("amuxd.sock: channel-status reply dropped");
                        }
                    }
                }
                "wecom-bots-status" => {
                    // Round-trip: ask the main loop to build a
                    // per-bot WeCom status snapshot, then write the
                    // JSON body back to the connected client.
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if tx
                        .send(SockCommand::WecomBotsStatus { reply_tx })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    match reply_rx.await {
                        Ok(body) => {
                            let mut stream = reader.into_inner();
                            if let Err(e) = stream.write_all(body.as_bytes()).await {
                                warn!("amuxd.sock: wecom-bots-status write failed: {e}");
                                return;
                            }
                            let _ = stream.write_all(b"\n").await;
                            let _ = stream.shutdown().await;
                        }
                        Err(_) => {
                            warn!("amuxd.sock: wecom-bots-status reply dropped");
                        }
                    }
                }
                "wechat-qr-start" => {
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if tx
                        .send(SockCommand::WechatQrStart { reply_tx })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    if let Ok(body) = reply_rx.await {
                        let mut stream = reader.into_inner();
                        let _ = stream.write_all(body.as_bytes()).await;
                        let _ = stream.write_all(b"\n").await;
                        let _ = stream.shutdown().await;
                    }
                }
                "wechat-qr-poll" => {
                    let mut qrcode = String::new();
                    if reader.read_line(&mut qrcode).await.is_err() {
                        warn!("amuxd.sock: wechat-qr-poll missing qrcode");
                        return;
                    }
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if tx
                        .send(SockCommand::WechatQrPoll {
                            qrcode: qrcode.trim().to_string(),
                            reply_tx,
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    if let Ok(body) = reply_rx.await {
                        let mut stream = reader.into_inner();
                        let _ = stream.write_all(body.as_bytes()).await;
                        let _ = stream.write_all(b"\n").await;
                        let _ = stream.shutdown().await;
                    }
                }
                "wecom-qr-start" => {
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if tx
                        .send(SockCommand::WecomQrStart { reply_tx })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    if let Ok(body) = reply_rx.await {
                        let mut stream = reader.into_inner();
                        let _ = stream.write_all(body.as_bytes()).await;
                        let _ = stream.write_all(b"\n").await;
                        let _ = stream.shutdown().await;
                    }
                }
                "wecom-qr-poll" => {
                    let mut scode = String::new();
                    if reader.read_line(&mut scode).await.is_err() {
                        warn!("amuxd.sock: wecom-qr-poll missing scode");
                        return;
                    }
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if tx
                        .send(SockCommand::WecomQrPoll {
                            scode: scode.trim().to_string(),
                            reply_tx,
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    if let Ok(body) = reply_rx.await {
                        let mut stream = reader.into_inner();
                        let _ = stream.write_all(body.as_bytes()).await;
                        let _ = stream.write_all(b"\n").await;
                        let _ = stream.shutdown().await;
                    }
                }
                "channel-save" => {
                    // Wire format: line 1 = "channel-save",
                    // line 2 = platform, line 3+ = JSON
                    // (single line — JSON has no embedded \n
                    // after `to_string()` serialization).
                    let mut platform = String::new();
                    if reader.read_line(&mut platform).await.is_err() {
                        warn!("amuxd.sock: channel-save missing platform");
                        return;
                    }
                    let mut config_json = String::new();
                    if reader.read_line(&mut config_json).await.is_err() {
                        warn!("amuxd.sock: channel-save missing config json");
                        return;
                    }
                    let _ = tx
                        .send(SockCommand::ChannelSave {
                            platform: platform.trim().to_string(),
                            config_json: config_json.trim().to_string(),
                        })
                        .await;
                }
                "shutdown" => {
                    let _ = tx.send(SockCommand::Shutdown).await;
                }
                other => {
                    let _ = tx.send(SockCommand::Unknown(other.to_string())).await;
                }
            }
        }
        Err(e) => {
            warn!("amuxd.sock: read_line failed: {e}");
        }
    }
}

/// Bind `amuxd.sock` and spawn a task that accepts connections, reads a
/// single newline-terminated control command per connection, and forwards
/// the parsed `SockCommand` to the daemon's main loop via `tx`. Stale
/// socket files left over from a crashed previous run are removed before
/// bind. Errors are logged and swallowed — the daemon must keep running
/// even if the sock can't be set up (operators can still kill it via
/// SIGTERM).
#[cfg(unix)]
fn spawn_sock_listener(sock_path: PathBuf, tx: mpsc::Sender<SockCommand>) {
    // Make sure the parent directory exists (e.g. on first run).
    if let Some(parent) = sock_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            error!(
                "amuxd.sock: failed to create parent dir {}: {e}",
                parent.display()
            );
            return;
        }
    }
    // Remove a stale socket left by an earlier crash; `bind` returns
    // AddrInUse otherwise.
    let _ = std::fs::remove_file(&sock_path);

    let listener = match UnixListener::bind(&sock_path) {
        Ok(l) => l,
        Err(e) => {
            error!("amuxd.sock: bind {} failed: {e}", sock_path.display());
            return;
        }
    };
    info!("amuxd.sock: listening on {}", sock_path.display());

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    tokio::spawn(handle_control_conn(stream, tx.clone()));
                }
                Err(e) => {
                    warn!("amuxd.sock: accept error: {e}");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    });
}

/// Windows: serve the same line/JSON control protocol over a named pipe.
/// `sock_path` carries the pipe name (`\\.\pipe\amuxd-<user>`, from
/// `DaemonConfig::sock_path()`). Errors are logged and swallowed — the
/// daemon must keep running even if the pipe can't be set up.
#[cfg(windows)]
fn spawn_sock_listener(sock_path: PathBuf, tx: mpsc::Sender<SockCommand>) {
    use tokio::net::windows::named_pipe::ServerOptions;
    let pipe_name = sock_path.to_string_lossy().into_owned();
    let mut server = match ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_name)
    {
        Ok(s) => s,
        Err(e) => {
            error!("amuxd control pipe: create {pipe_name} failed: {e}");
            return;
        }
    };
    info!("amuxd control pipe: listening on {pipe_name}");
    tokio::spawn(async move {
        loop {
            // A connect() error is typically transient (client vanished mid-
            // handshake, spurious OS error). Mirror the unix accept loop's
            // policy: log and keep serving rather than killing the control
            // channel for the daemon's lifetime.
            if let Err(e) = server.connect().await {
                error!("amuxd control pipe: connect failed: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            // Re-creating the next instance failing is unrecoverable (the pipe
            // name itself is unusable), so the listener task exits here.
            let next = match ServerOptions::new().create(&pipe_name) {
                Ok(s) => s,
                Err(e) => {
                    error!("amuxd control pipe: re-create failed: {e}");
                    return;
                }
            };
            let stream = std::mem::replace(&mut server, next);
            tokio::spawn(handle_control_conn(stream, tx.clone()));
        }
    });
}

fn not_yet_implemented(
    request: &crate::proto::teamclaw::RpcRequest,
    method_name: &str,
) -> crate::proto::teamclaw::RpcResponse {
    crate::proto::teamclaw::RpcResponse {
        request_id: request.request_id.clone(),
        success: false,
        error: format!("{} not yet implemented", method_name),
        requester_client_id: request.requester_client_id.clone(),
        requester_actor_id: request.requester_actor_id.clone(),
        result: None,
    }
}

/// Merge runs of consecutive Output (resp. Thinking) events from the SAME
/// agent within one 50ms drain batch into a single event. The drain loop in
/// `run()` already collects these together, so merging adds zero latency
/// while cutting MQTT publish count (one QoS round-trip + ~220B envelope
/// overhead saved per eliminated packet) during fast streaming.
///
/// Boundaries that STOP a merge: different agent, different event kind,
/// any non-text event, or an Output already marked `is_complete` (a finalized
/// reply must not absorb the next turn's first delta). Non-text events
/// (tool_use, status_change, …) pass through untouched, preserving order.
fn coalesce_text_events(events: Vec<(String, AcpEventFrame)>) -> Vec<(String, AcpEventFrame)> {
    let mut out: Vec<(String, AcpEventFrame)> = Vec::with_capacity(events.len());
    for (agent_id, frame) in events {
        if let Some((last_id, last_frame)) = out.last_mut() {
            if *last_id == agent_id && last_frame.acp_session_id == frame.acp_session_id {
                match (&mut last_frame.event.event, &frame.event.event) {
                    (
                        Some(amux::acp_event::Event::Output(prev)),
                        Some(amux::acp_event::Event::Output(next)),
                    ) if !prev.is_complete => {
                        prev.text.push_str(&next.text);
                        prev.is_complete = next.is_complete;
                        continue;
                    }
                    (
                        Some(amux::acp_event::Event::Thinking(prev)),
                        Some(amux::acp_event::Event::Thinking(next)),
                    ) => {
                        prev.text.push_str(&next.text);
                        continue;
                    }
                    _ => {}
                }
            }
        }
        out.push((agent_id, frame));
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::runtime::acp_event_frame::AcpEventFrame;
    use crate::team_link::ensure_team_link;
    use rumqttc::{AsyncClient, MqttOptions};
    use std::io;
    use tempfile::TempDir;

    #[test]
    pub(crate) fn cloud_rows_to_local_linkable_paths_filters_missing_fs_paths() {
        let existing = tempfile::tempdir().unwrap();
        let rows = vec![
            crate::backend::WorkspaceRow {
                id: "ws-exists".into(),
                team_id: "team-1".into(),
                path: Some(existing.path().to_string_lossy().to_string()),
            },
            crate::backend::WorkspaceRow {
                id: "ws-missing".into(),
                team_id: "team-1".into(),
                path: Some("/definitely/not/on/this/machine/team-link-test".into()),
            },
            crate::backend::WorkspaceRow {
                id: "ws-no-path".into(),
                team_id: "team-1".into(),
                path: None,
            },
        ];
        let linkable = cloud_rows_to_local_linkable_paths(&rows);
        assert_eq!(
            linkable,
            vec![existing.path().to_string_lossy().to_string()]
        );
    }

    #[tokio::test]
    pub(crate) async fn sync_team_shared_dirs_sources_from_cloud_and_skips_missing_paths() {
        let _lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap();
        let home = tempfile::tempdir().unwrap();
        // SAFETY: serialized by TEST_HOME_LOCK.
        unsafe { std::env::set_var("HOME", home.path()) };

        let team_id = "team-test";
        let existing = tempfile::tempdir().unwrap();
        let existing_path = existing.path().to_string_lossy().to_string();

        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            team_id,
            "agent-actor",
        ));
        {
            let mut st = mock.state();
            st.team_share_configs.insert(
                team_id.to_string(),
                crate::backend::ShareModeConfig {
                    mode: Some("oss".to_string()),
                    ..Default::default()
                },
            );
            st.workspaces_by_id.insert(
                "ws-exists".to_string(),
                crate::backend::WorkspaceRow {
                    id: "ws-exists".to_string(),
                    team_id: team_id.to_string(),
                    path: Some(existing_path.clone()),
                },
            );
            st.workspaces_by_id.insert(
                "ws-missing".to_string(),
                crate::backend::WorkspaceRow {
                    id: "ws-missing".to_string(),
                    team_id: team_id.to_string(),
                    path: Some("/definitely/not/on/this/machine/team-link-test".to_string()),
                },
            );
        }

        let ts = test_server_with_cloud_api(mock.clone());
        ts.server.sync_team_shared_dirs_for_known_workspaces().await;

        assert!(
            existing
                .path()
                .join(crate::config::global_team_store::TEAM_LINK_NAME)
                .exists(),
            "existing on-disk path should get a teamclaw-team link"
        );
    }

    #[cfg(unix)]
    #[test]
    pub(crate) fn ensure_team_link_creates_global_dir_and_workspace_symlink() {
        // Serializes with other HOME-mutating tests (config_dir reads $HOME).
        let _guard = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", home.path());
        let ws = tempfile::tempdir().unwrap();
        let ws_path = ws.path().to_str().unwrap();

        ensure_team_link("team-ondemand", ws_path);

        // Global dir + scaffold created under ~/.amuxd/teams/<id>/teamclaw-team.
        let global = crate::config::global_team_store::global_team_dir("team-ondemand");
        assert!(global.is_dir(), "global team dir should be created");
        assert!(global.join("skills").is_dir());

        // Workspace exposes it via a teamclaw-team symlink to that global dir.
        let link = ws.path().join("teamclaw-team");
        let meta = std::fs::symlink_metadata(&link).unwrap();
        assert!(
            meta.file_type().is_symlink(),
            "workspace entry should be a symlink"
        );
        assert_eq!(std::fs::read_link(&link).unwrap(), global);

        // Idempotent: a second call must not error or change the target.
        ensure_team_link("team-ondemand", ws_path);
        assert_eq!(std::fs::read_link(&link).unwrap(), global);

        // Empty team_id is a no-op (no stray dir/link).
        let ws2 = tempfile::tempdir().unwrap();
        ensure_team_link("", ws2.path().to_str().unwrap());
        assert!(std::fs::symlink_metadata(ws2.path().join("teamclaw-team")).is_err());
    }

    pub(crate) struct TestServer {
        pub(crate) server: DaemonServer,
        _tmp: TempDir,
    }

    #[derive(Clone, Default)]
    struct LogCapture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    struct CapturedLogWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogCapture {
        type Writer = CapturedLogWriter;

        fn make_writer(&'a self) -> Self::Writer {
            CapturedLogWriter(self.0.clone())
        }
    }

    impl io::Write for CapturedLogWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl LogCapture {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    pub(crate) fn test_config() -> DaemonConfig {
        DaemonConfig {
            actor: crate::config::ActorConfig {
                id: "actor-config-test".to_string(),
                name: "test-host".to_string(),
            },
            mqtt: crate::config::MqttConfig {
                broker_url: "mqtt://localhost:1883".to_string(),
                username: None,
                password: None,
            },
            agents: crate::config::AgentsConfig::default(),
            transport: None,
            team_id: Some("team-test".to_string()),
            channels: crate::config::ChannelsConfig::default(),
            idle_runtime_timeout_secs: None,
            http: None,
        }
    }

    pub(crate) fn test_cloud_api() -> Arc<dyn Backend> {
        test_cloud_api_with_url("http://localhost".to_string())
    }

    pub(crate) fn test_cloud_api_with_url(url: String) -> Arc<dyn Backend> {
        Arc::new(crate::backend::cloud_api::CloudApiBackend::new(
            crate::provider_config::CloudApiConfig {
                url,
                refresh_token: "refresh".to_string(),
                team_id: "team-test".to_string(),
                actor_id: "agent-actor".to_string(),
            },
        ))
    }

    #[test]
    pub(crate) fn backend_from_provider_config_initializes_cloud_api_backend() {
        let config = crate::provider_config::ProviderConfig::CloudApi(
            crate::provider_config::CloudApiConfig {
                url: "http://localhost".to_string(),
                refresh_token: "refresh".to_string(),
                team_id: "team-test".to_string(),
                actor_id: "agent-actor".to_string(),
            },
        );

        let backend = backend_from_provider_config(config).unwrap();

        assert_eq!(backend.team_id(), "team-test");
        assert_eq!(backend.actor_id(), "agent-actor");
    }

    #[test]
    fn config_identity_validation_rejects_split_team_and_actor() {
        let mut config = test_config();
        config.team_id = Some("team-config-test".to_string());
        let backend = test_cloud_api();

        let error = validate_config_identity(&config, backend.as_ref()).unwrap_err();

        let message = error.to_string();
        assert!(message.contains("daemon.toml team_id=team-config-test"), "{message}");
        assert!(message.contains("backend.toml team_id=team-test"), "{message}");
        assert!(message.contains("actor_id=actor-config-test"), "{message}");
        assert!(message.contains("actor_id=agent-actor"), "{message}");
    }

    #[test]
    pub(crate) fn mark_mqtt_connected_updates_shared_flag() {
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));

        mark_mqtt_connected(&Some(flag.clone()), false);

        assert!(!flag.load(std::sync::atomic::Ordering::Relaxed));
        mark_mqtt_connected(&Some(flag.clone()), true);
        assert!(flag.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn mqtt_disconnect_rebuild_due_after_threshold() {
        use std::time::{Duration, Instant};

        let since = Instant::now() - Duration::from_secs(91);
        assert!(super::mqtt_disconnect_rebuild_due(
            Some(since),
            Duration::from_secs(90)
        ));
        assert!(!super::mqtt_disconnect_rebuild_due(
            Some(Instant::now()),
            Duration::from_secs(90)
        ));
        assert!(!super::mqtt_disconnect_rebuild_due(None, Duration::from_secs(90)));
    }

    pub(crate) fn test_mqtt(actor_id: &str) -> MqttClient {
        let mut opts = MqttOptions::new("daemon-server-test", "localhost", 1883);
        opts.set_clean_session(true);
        let (client, eventloop) = AsyncClient::new(opts, 10);
        MqttClient {
            client,
            eventloop,
            topics: crate::mqtt::Topics::new("team-test", actor_id),
        }
    }

    pub(crate) fn test_server() -> TestServer {
        test_server_with_cloud_api(test_cloud_api())
    }

    pub(crate) fn test_server_with_cloud_api(backend: Arc<dyn Backend>) -> TestServer {
        let tmp = TempDir::new().unwrap();
        let config = test_config();
        let mqtt = test_mqtt(&config.actor.id);
        let teamclaw = crate::teamclaw::SessionManager::new(
            Arc::new(mqtt.client.clone()) as Arc<dyn MessagePublisher>,
            "team-test",
            &config.actor.id,
            Some("agent-actor".to_string()),
            tmp.path().to_path_buf(),
        )
        .unwrap();

        let mut agents = RuntimeManager::new(RuntimeManager::default_launch_configs(), None);
        agents.add_test_runtime("rt1", "runtime-agent", "session-1");

        let publisher_handle: Arc<dyn MessagePublisher> = Arc::new(mqtt.client.clone());
        let topics = mqtt.topics.clone();
        let workspace_resolver = Arc::new(crate::config::WorkspaceResolver::new(backend.clone()));
        let deferred_backend = Arc::new(
            crate::backend::deferred::DeferredBackend::claimed(backend.clone()),
        );
        let (cron_turn_done_tx, cron_turn_done_rx) = mpsc::channel(64);
        TestServer {
            server: DaemonServer {
                config,
                config_path: tmp.path().join("daemon.toml"),
                mqtt,
                nats: None,
                publisher_handle: publisher_handle.clone(),
                topics,
                agents: Arc::new(AsyncMutex::new(agents)),
                auth: AuthManager::new(tmp.path().join("members.toml")).unwrap(),
                peers: PeerTracker::new(),
                permissions: PermissionManager::new(),
                workspace_resolver,
                sync_dispatcher: crate::sync::dispatch::SyncDispatcher::new(
                    crate::sync::secret_store::SecretStore::new(),
                    None,
                ),
                sessions: SessionStore::default(),
                sessions_path: tmp.path().join("sessions.toml"),
                history: EventHistory::new(&tmp.path().join("history")),
                teamclaw: Some(teamclaw),
                backend: backend.clone(),
                deferred_backend,
                actor_id: "agent-actor".to_string(),
                channel_mgr: None,
                cron_sessions: cron::CronSessionCache::new(),
                refresh_watch_registry: None,
                refresh_coordinator: None,
                mqtt_connected_flag: None,
                managed_llm: Arc::new(crate::runtime::managed_llm::ManagedLlmResolver::new(
                    backend,
                )),
                live_tee: tokio::sync::broadcast::channel(64).0,
                session_remote_targets: Arc::new(AsyncMutex::new(
                    crate::remote_tools::SessionRemoteTargetStore::default(),
                )),
                remote_tool_turn_contexts: Arc::new(AsyncMutex::new(
                    crate::remote_tools::RemoteToolTurnContextStore::default(),
                )),
                rpc_client: Arc::new(AsyncMutex::new(crate::teamclaw::rpc::RpcClient::new(
                    publisher_handle.clone(),
                    "team-1".to_string(),
                    "agent-actor".to_string(),
                ))),
                cron_turn_done_tx,
                cron_turn_done_rx: Some(cron_turn_done_rx),
            },
            _tmp: tmp,
        }
    }

    pub(crate) fn live_message(
        session_id: &str,
        message_id: &str,
        content: &str,
    ) -> subscriber::IncomingMessage {
        let msg = crate::proto::teamclaw::Message {
            message_id: message_id.to_string(),
            session_id: session_id.to_string(),
            sender_actor_id: "human-actor".to_string(),
            kind: 0,
            content: content.to_string(),
            created_at: 1,
            ..Default::default()
        };
        let msg_env = crate::proto::teamclaw::SessionMessageEnvelope {
            message: Some(msg),
            mention_actor_ids: vec!["agent-actor".to_string()],
            ..Default::default()
        };
        let live = crate::proto::teamclaw::LiveEventEnvelope {
            event_id: format!("event-{message_id}-{content}"),
            event_type: "message.created".to_string(),
            session_id: session_id.to_string(),
            actor_id: "human-actor".to_string(),
            sent_at: 1,
            body: msg_env.encode_to_vec(),
        };
        subscriber::IncomingMessage::TeamclawSessionLive {
            session_id: session_id.to_string(),
            payload: live.encode_to_vec(),
        }
    }

    #[test]
    pub(crate) fn loads_team_shared_config_from_workspace_file() {
        let tmp = TempDir::new().unwrap();
        let config_dir = tmp.path().join(".teamclaw");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("teamclaw.json"),
            serde_json::json!({
                "team": {
                    "gitUrl": "https://example.com/shared.git",
                    "gitBranch": "main",
                    "gitToken": "token",
                    "sharedDirName": "teamclaw",
                    "envSecret": "secret",
                    "enabled": true
                }
            })
            .to_string(),
        )
        .unwrap();

        let config = load_team_shared_config_for_workspace(tmp.path()).unwrap();

        assert_eq!(
            config.git_url.as_deref(),
            Some("https://example.com/shared.git")
        );
        assert_eq!(config.git_branch.as_deref(), Some("main"));
        assert_eq!(config.git_token.as_deref(), Some("token"));
        assert_eq!(config.shared_dir_name, "teamclaw");
        assert_eq!(config.env_secret.as_deref(), Some("secret"));
        assert!(config.enabled);
    }

    #[test]
    pub(crate) fn ignores_disabled_or_unconfigured_team_shared_config() {
        for team in [
            serde_json::json!({
                "gitUrl": "https://example.com/shared.git",
                "enabled": false
            }),
            serde_json::json!({
                "gitUrl": "",
                "enabled": true
            }),
            serde_json::json!({
                "enabled": true
            }),
        ] {
            let tmp = TempDir::new().unwrap();
            let config_dir = tmp.path().join(".teamclaw");
            std::fs::create_dir_all(&config_dir).unwrap();
            std::fs::write(
                config_dir.join("teamclaw.json"),
                serde_json::json!({ "team": team }).to_string(),
            )
            .unwrap();

            assert!(load_team_shared_config_for_workspace(tmp.path()).is_none());
        }
    }

    pub(crate) fn seed_teamclaw_session(server: &mut DaemonServer, session_id: &str, title: &str) {
        let session = crate::teamclaw::StoredSession {
            session_id: session_id.to_string(),
            team_id: "team-test".to_string(),
            title: title.to_string(),
            created_by: "human-actor".to_string(),
            created_at: chrono::Utc::now(),
            summary: String::new(),
            idea_id: String::new(),
            participants: vec![],
            primary_agent_id: String::new(),
        };
        server.teamclaw.as_mut().unwrap().sessions.upsert(session);
    }

    #[tokio::test]
    pub(crate) async fn incoming_live_event_log_includes_cached_session_and_daemon_info() {
        let mut fixture = test_server();
        seed_teamclaw_session(&mut fixture.server, "session-title-test", "Launch Plan");

        let live = crate::proto::teamclaw::LiveEventEnvelope {
            event_id: "event-session-title".to_string(),
            event_type: "unknown.test".to_string(),
            session_id: "session-title-test".to_string(),
            actor_id: "human-actor".to_string(),
            sent_at: 1,
            body: vec![],
        };
        let capture = LogCapture::default();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_writer(capture.clone())
            .with_ansi(false)
            .without_time()
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);

        fixture
            .server
            .handle_incoming(subscriber::IncomingMessage::TeamclawSessionLive {
                session_id: "session-title-test".to_string(),
                payload: live.encode_to_vec(),
            })
            .await;

        let logs = capture.text();
        assert!(logs.contains("LiveEventEnvelope decoded"), "{logs}");
        assert!(logs.contains("session_title=Launch Plan"), "{logs}");
        assert!(
            logs.contains("daemon_config_actor_id=actor-config-test"),
            "{logs}"
        );
        assert!(logs.contains("daemon_actor_id=agent-actor"), "{logs}");
        assert!(logs.contains("daemon_team_id=team-test"), "{logs}");
    }

    #[tokio::test]
    pub(crate) async fn auto_restart_offline_sessions_is_noop_without_membership() {
        // The default test fixture has no teamclaw memberships (no
        // sessions.toml entries the actor is a participant in), so the
        // method must return early before touching the Cloud API. A real
        // request would fail because `test_cloud_api()` points at
        // http://localhost with no server running, so a successful return
        // here implies the early-exit guard fired.
        let mut fixture = test_server();
        fixture.server.auto_restart_offline_sessions().await;
        // No runtimes added beyond the fixture's seeded "rt1".
        let agents = fixture.server.agents.lock().await;
        assert!(
            agents.get_handle("rt1").is_some(),
            "fixture runtime should be untouched"
        );
    }

    #[tokio::test]
    pub(crate) async fn runtime_start_with_session_id_fails_when_cloud_api_lookup_fails() {
        let mut fixture =
            test_server_with_cloud_api(test_cloud_api_with_url("http://127.0.0.1:1".into()));

        let result = fixture
            .server
            .apply_start_runtime(
                amux::AgentType::ClaudeCode,
                "",
                ".",
                "session-missing",
                "",
                None,
                "",
            )
            .await;
        let err = match result {
            Ok(_) => panic!("session-bound RuntimeStart must fail before spawning"),
            Err(err) => err,
        };

        assert_eq!(err.error_code, "SESSION_LOOKUP_FAILED");
        assert_eq!(err.failed_stage, "session_lookup");
    }

    #[tokio::test]
    pub(crate) async fn apply_start_runtime_resolves_cloud_workspace_uuid_via_resolver() {
        // A cloud workspace UUID must resolve through `WorkspaceResolver`
        // (backed by `GET /v1/workspaces/by-ids`). Proof: resolution
        // succeeds (no WORKSPACE_NOT_FOUND) and control reaches the session
        // lookup stage, which then fails against the unmocked
        // `/v1/sessions/...` route — demonstrating the resolver supplied
        // the path.
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        Mock::given(method("POST"))
            .and(path("/v1/workspaces/by-ids"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [
                    { "id": "ws-cloud-uuid", "name": "Cloud WS", "path": "/tmp/cloud-ws", "slug": null }
                ]
            })))
            .mount(&srv)
            .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));

        let result = fixture
            .server
            .apply_start_runtime(
                amux::AgentType::ClaudeCode,
                "ws-cloud-uuid",
                "",
                "session-missing",
                "",
                None,
                "",
            )
            .await;

        let err = match result {
            Ok(_) => panic!("session-bound RuntimeStart must fail before spawning"),
            Err(err) => err,
        };
        assert_eq!(
            err.error_code, "SESSION_LOOKUP_FAILED",
            "workspace resolve must have succeeded to reach session lookup: {} / {}",
            err.error_code, err.error_message
        );
    }

    #[tokio::test]
    pub(crate) async fn apply_start_runtime_returns_workspace_not_found_when_resolve_fails_and_no_worktree(
    ) {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        Mock::given(method("POST"))
            .and(path("/v1/workspaces/by-ids"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "items": [] })),
            )
            .mount(&srv)
            .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));

        let result = fixture
            .server
            .apply_start_runtime(
                amux::AgentType::ClaudeCode,
                "ws-missing-in-cloud",
                "",
                "",
                "",
                None,
                "",
            )
            .await;

        let err = match result {
            Ok(_) => panic!("unresolvable workspace with no worktree fallback must fail"),
            Err(err) => err,
        };
        assert_eq!(err.error_code, "WORKSPACE_NOT_FOUND");
        assert_eq!(err.failed_stage, "validation");
    }

    #[tokio::test]
    pub(crate) async fn apply_start_runtime_stamps_workspace_id_on_resolve_fail_worktree_fallback()
    {
        // Mirrors the design decision documented at the resolve-failure
        // fallback branch in `apply_start_runtime`: when resolve() fails
        // (cloud unreachable / workspace not yet visible) but the caller
        // supplied a worktree path, we deliberately keep the client-given
        // `workspace_id` (a real cloud UUID) rather than discarding it, so
        // the runtime/session keep the workspace association and self-heal
        // once the cloud is reachable again. Proof here: resolution fails
        // (empty `by-ids` response) yet start succeeds using the supplied
        // worktree, and the spawned runtime carries the supplied
        // `workspace_id` verbatim.
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        Mock::given(method("POST"))
            .and(path("/v1/workspaces/by-ids"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "items": [] })),
            )
            .mount(&srv)
            .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        let worktree_dir = TempDir::new().unwrap();
        let worktree_path = worktree_dir.path().to_string_lossy().to_string();

        let result = fixture
            .server
            .apply_start_runtime(
                amux::AgentType::ClaudeCode,
                "ws-cloud-uuid-offline",
                &worktree_path,
                "",
                "",
                None,
                "",
            )
            .await;

        let outcome = match result {
            Ok(outcome) => outcome,
            Err(err) => panic!(
                "resolve-fail-with-worktree fallback must still start the runtime: {} / {}",
                err.error_code, err.error_message
            ),
        };
        assert_ne!(outcome.runtime_id, "");

        let agents = fixture.server.agents.lock().await;
        let handle = agents
            .get_handle(&outcome.runtime_id)
            .expect("spawned runtime handle must exist");
        assert_eq!(
            handle.workspace_id, "ws-cloud-uuid-offline",
            "runtime must carry the client-supplied cloud UUID even though resolve() failed"
        );
        assert_eq!(
            handle.worktree, worktree_path,
            "runtime must run in the caller-supplied worktree, not the (unresolved) cloud path"
        );
    }

    // ── plan_auto_restart_offline_sessions branch coverage ─────────────────
    //
    // The pure-decision half of `auto_restart_offline_sessions` is exposed
    // as `plan_auto_restart_offline_sessions` so we can verify every
    // skip/keep branch without actually booting an ACP backend. The tests
    // below cover:
    //
    //   - membership session has no prior agent_runtimes row → skip
    //   - prior row exists, but no messages newer than cursor → skip
    //   - prior row exists, unread messages are all self-authored → skip
    //   - prior row exists, unread from someone else, no live runtime →
    //     keep with backend/workspace_id resolved from the prior row
    //   - prior row exists, but a live runtime is already serving → skip
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Cloud API `/v1/auth/refresh` mock — every test calls
    /// `access_token()` before any business request.
    pub(crate) async fn auth_token_mock(srv: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "at",
                "refreshToken": "rt",
                "expiresAt": 9999999999_i64
            })))
            .mount(srv)
            .await;
    }

    /// `fetch_latest_runtime_for_session` hits
    /// `GET /v1/agents/runtimes/latest?agentId=...&sessionId=...` and expects
    /// a single object (404 → None). Map the legacy PostgREST signature
    /// onto the cloud_api shape.
    pub(crate) async fn mock_agent_runtime_row(
        srv: &MockServer,
        session_id: &str,
        last_processed_message_id: Option<&str>,
        _workspace_id: Option<&str>,
        _backend_type: &str,
    ) {
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes/latest"))
            .and(query_param("sessionId", session_id))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": format!("row-{session_id}"),
                "backendSessionId": format!("acp-{session_id}"),
                "lastProcessedMessageId": last_processed_message_id,
            })))
            .mount(srv)
            .await;
    }

    /// `messages_after_cursor` hits `GET /v1/sessions/{id}/messages`. The
    /// legacy PostgREST mocks returned a top-level array of rows in
    /// snake_case; convert each row to the cloud_api camelCase envelope.
    pub(crate) async fn mock_messages_response(
        srv: &MockServer,
        session_id: &str,
        rows: serde_json::Value,
    ) {
        let items: Vec<serde_json::Value> = rows
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(to_cloud_message)
            .collect();
        Mock::given(method("GET"))
            .and(path(format!("/v1/sessions/{session_id}/messages")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": items,
                "nextCursor": null,
            })))
            .mount(srv)
            .await;
    }

    pub(crate) fn to_cloud_message(row: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "id": row.get("id").cloned().unwrap_or_default(),
            "sessionId": row.get("session_id").cloned().unwrap_or_default(),
            "senderActorId": row.get("sender_actor_id").cloned().unwrap_or_default(),
            "kind": row.get("kind").cloned().unwrap_or(serde_json::json!("text")),
            "content": row.get("content").cloned().unwrap_or_default(),
            "metadata": row.get("metadata").cloned().unwrap_or(serde_json::json!({})),
            "createdAt": row.get("created_at").cloned().unwrap_or_default(),
        })
    }

    pub(crate) async fn add_membership(fixture: &mut TestServer, session_id: &str) {
        let tc = fixture.server.teamclaw.as_mut().expect("teamclaw set");
        tc.insert_session_from_backend_for_test(
            session_id,
            "team-test",
            None,
            &[("agent-actor", "owner")],
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    pub(crate) async fn plan_skips_session_with_no_prior_runtime_row() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        // No prior row — Cloud API returns 404 for the "latest" lookup.
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes/latest"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "no runtime row" }
            })))
            .mount(&srv)
            .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-no-row").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(plan.is_empty(), "no prior row should produce empty plan");
    }

    #[tokio::test]
    pub(crate) async fn plan_skips_when_no_unread_messages_after_cursor() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_agent_runtime_row(&srv, "sess-empty", Some("msg-9"), None, "claude").await;
        // Cloud API honours `messages_after_cursor` by returning an empty
        // list (the drain-through-cursor logic happens client-side, but
        // here we simulate "no messages newer than the cursor").
        mock_messages_response(&srv, "sess-empty", serde_json::json!([])).await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-empty").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(
            plan.is_empty(),
            "no unread messages should produce empty plan"
        );
    }

    #[tokio::test]
    pub(crate) async fn plan_skips_when_unread_messages_are_all_self_authored() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_agent_runtime_row(&srv, "sess-self", None, None, "claude").await;
        // Two messages, both sent by the daemon's own actor (e.g. prior
        // agent replies we already emitted). Auto-restart must NOT fire
        // for these — there is no user input to process.
        mock_messages_response(
            &srv,
            "sess-self",
            serde_json::json!([
                {
                    "id": "msg-1",
                    "session_id": "sess-self",
                    "sender_actor_id": "agent-actor",
                    "kind": "agent_reply",
                    "content": "ok",
                    "metadata": {},
                    "created_at": "2025-05-22T01:00:00Z"
                }
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-self").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(
            plan.is_empty(),
            "self-authored unread should not trigger restart"
        );
    }

    #[tokio::test]
    pub(crate) async fn plan_keeps_session_with_unread_from_someone_else() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_agent_runtime_row(
            &srv,
            "sess-mention",
            Some("msg-9"),
            Some("ws-cloud-uuid"),
            "claude_code",
        )
        .await;
        // Cloud API's `messages_after_cursor` trims past `after_id`
        // client-side, so include msg-9 (the cursor) at the head of the
        // response. After trimming: msg-10 (self-authored, filtered) +
        // msg-11 (human, kept).
        mock_messages_response(
            &srv,
            "sess-mention",
            serde_json::json!([
                {
                    "id": "msg-9",
                    "session_id": "sess-mention",
                    "sender_actor_id": "agent-actor",
                    "kind": "agent_reply",
                    "content": "cursor row",
                    "metadata": {},
                    "created_at": "2025-05-22T00:29:00Z"
                },
                {
                    "id": "msg-10",
                    "session_id": "sess-mention",
                    "sender_actor_id": "agent-actor",
                    "kind": "agent_reply",
                    "content": "prior reply",
                    "metadata": {},
                    "created_at": "2025-05-22T00:30:00Z"
                },
                {
                    "id": "msg-11",
                    "session_id": "sess-mention",
                    "sender_actor_id": "human-actor",
                    "kind": "text",
                    "content": "are you there?",
                    "metadata": { "mention_actor_ids": ["agent-actor"] },
                    "created_at": "2025-05-22T01:00:00Z"
                }
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-mention").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert_eq!(plan.len(), 1, "one session should need restart");
        assert_eq!(plan[0].session_id, "sess-mention");
        assert_eq!(plan[0].unread_count, 1, "self-authored msg-10 was filtered");
        // No local workspace is registered for "ws-cloud-uuid", so the
        // helper falls back to empty (apply_start_runtime will then
        // resolve via the registered workspace lookup or current dir).
        assert!(plan[0].local_workspace_id.is_empty());
    }

    #[tokio::test]
    pub(crate) async fn plan_skips_session_with_live_runtime_already_running() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        // The fixture seeds a runtime "rt1" bound to session_id
        // "session-1" via add_test_runtime. Make that the membership
        // session and confirm the planner refuses to schedule a second
        // spawn for the same session.
        mock_agent_runtime_row(&srv, "session-1", None, None, "claude").await;
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([
                {
                    "id": "msg-50",
                    "session_id": "session-1",
                    "sender_actor_id": "human-actor",
                    "kind": "text",
                    "content": "hi",
                    "metadata": {},
                    "created_at": "2025-05-22T01:00:00Z"
                }
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "session-1").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(
            plan.is_empty(),
            "existing live runtime should suppress auto-restart for the same session"
        );
    }

    // ── catchup_runtime stale-mention compaction ──────────────────────────
    //
    // When the daemon comes back online and replays the cursor → now slice
    // through catchup_runtime, only the most recent `@daemon` mention should
    // trigger a real ACP prompt. Earlier @-mentions are demoted to silent
    // context (pending_silent prefix on the eventual prompt) because the
    // conversation already moved past them — firing a fresh turn on those
    // stale mentions would emit out-of-date replies.

    pub(crate) fn make_message_row(
        id: &str,
        session_id: &str,
        sender_actor_id: &str,
        mentions: &[&str],
        content: &str,
        created_at: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "session_id": session_id,
            "sender_actor_id": sender_actor_id,
            "kind": "text",
            "content": content,
            "metadata": { "mention_actor_ids": mentions },
            "created_at": created_at,
        })
    }

    #[tokio::test]
    pub(crate) async fn catchup_runtime_prompts_only_on_last_mention_compacting_stale_ones() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        // 3-message replay: @daemon, @daemon, plain. The latest @daemon is
        // msg-b; msg-a is stale (a later @daemon came in). msg-c is a
        // non-mention follow-up and should also land as silent context.
        // Expected outcome:
        //   - send_prompt fires exactly once, carrying "ask B" (the last
        //     @-mention's content)
        //   - the silent queue holds msg-a only (msg-b is consumed by the
        //     real prompt; msg-c never @-mentions us, hence silent)
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([
                make_message_row(
                    "msg-a",
                    "session-1",
                    "human-1",
                    &["agent-actor"],
                    "ask A",
                    "2025-05-22T01:00:01Z",
                ),
                make_message_row(
                    "msg-b",
                    "session-1",
                    "human-1",
                    &["agent-actor"],
                    "ask B",
                    "2025-05-22T01:00:02Z",
                ),
                make_message_row(
                    "msg-c",
                    "session-1",
                    "human-2",
                    &[],
                    "drive-by chatter",
                    "2025-05-22T01:00:03Z",
                ),
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        fixture.server.catchup_runtime("rt1").await;

        // `send_prompt` (not raw) auto-drains the silent queue via
        // `flush_pending_silent`, so by the time msg-b's prompt fires the
        // stale msg-a is woven into a `[Context — …]` prefix. msg-c is
        // routed AFTER msg-b, so it stays in the silent queue waiting for
        // the next real prompt.
        let agents = fixture.server.agents.lock().await;
        let last = agents
            .last_sent_to("rt1")
            .expect("the last @-mention should trigger send_prompt");
        assert!(
            last.contains("ask B"),
            "send_prompt body should carry the latest @-mention content; got: {last}"
        );
        assert!(
            last.contains("ask A"),
            "the stale @-mention should be folded into the [Context …] prefix; got: {last}"
        );
        assert!(
            !last.contains("drive-by chatter"),
            "msg-c (routed after msg-b) must stay queued for the next turn; got: {last}"
        );

        // After the prompt fires, msg-c sits alone in the silent queue —
        // msg-a was already drained into the prefix above.
        let pending = &agents.get_handle("rt1").unwrap().pending_silent;
        assert_eq!(
            pending
                .iter()
                .map(|p| p.message_id.as_str())
                .collect::<Vec<_>>(),
            vec!["msg-c"],
            "only msg-c (post-prompt drive-by) should remain silent"
        );
    }

    #[tokio::test]
    pub(crate) async fn catchup_runtime_does_not_replay_after_cursor_advanced_in_memory() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([make_message_row(
                "msg-a",
                "session-1",
                "human-1",
                &["agent-actor"],
                "ask once",
                "2025-05-22T01:00:01Z",
            ),]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        assert!(fixture.server.catchup_runtime("rt1").await);
        {
            let agents = fixture.server.agents.lock().await;
            assert_eq!(agents.last_sent_to("rt1").as_deref(), Some("ask once"),);
            assert_eq!(
                agents
                    .get_handle("rt1")
                    .unwrap()
                    .last_processed_message_id
                    .as_deref(),
                Some("msg-a"),
            );
        }

        // Session refresh → runtimeStart dedup → catchup must not re-prompt.
        assert!(!fixture.server.catchup_runtime("rt1").await);
        let agents = fixture.server.agents.lock().await;
        assert_eq!(agents.last_sent_to("rt1").as_deref(), Some("ask once"));
    }

    #[tokio::test]
    pub(crate) async fn catchup_runtime_skips_prompt_when_last_mention_already_answered() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([
                make_message_row(
                    "msg-user",
                    "session-1",
                    "human-1",
                    &["agent-actor"],
                    "please review",
                    "2025-05-22T01:00:01Z",
                ),
                make_message_row(
                    "msg-agent",
                    "session-1",
                    "agent-actor",
                    &[],
                    "done reviewing",
                    "2025-05-22T01:00:02Z",
                ),
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        fixture.server.catchup_runtime("rt1").await;

        let agents = fixture.server.agents.lock().await;
        assert!(
            agents.last_sent_to("rt1").is_none(),
            "answered @mention must not trigger send_prompt on catchup"
        );
        assert_eq!(
            agents
                .get_handle("rt1")
                .unwrap()
                .last_processed_message_id
                .as_deref(),
            Some("msg-user"),
        );
    }

    #[tokio::test]
    pub(crate) async fn plan_skips_when_last_mention_already_answered() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_agent_runtime_row(&srv, "sess-answered", None, None, "claude").await;
        mock_messages_response(
            &srv,
            "sess-answered",
            serde_json::json!([
                make_message_row(
                    "msg-user",
                    "sess-answered",
                    "human-1",
                    &["agent-actor"],
                    "ping",
                    "2025-05-22T01:00:01Z",
                ),
                make_message_row(
                    "msg-agent",
                    "sess-answered",
                    "agent-actor",
                    &[],
                    "pong",
                    "2025-05-22T01:00:02Z",
                ),
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-answered").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(
            plan.is_empty(),
            "already-answered @mention should not schedule auto_restart"
        );
    }

    #[tokio::test]
    pub(crate) async fn catchup_runtime_with_no_mentions_routes_everything_silent() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([
                make_message_row(
                    "msg-a",
                    "session-1",
                    "human-1",
                    &[],
                    "first chatter",
                    "2025-05-22T01:00:01Z",
                ),
                make_message_row(
                    "msg-b",
                    "session-1",
                    "human-2",
                    &[],
                    "second chatter",
                    "2025-05-22T01:00:02Z",
                ),
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        fixture.server.catchup_runtime("rt1").await;

        let agents = fixture.server.agents.lock().await;
        assert!(
            agents.last_sent_to("rt1").is_none(),
            "no @-mention → no send_prompt"
        );
        assert_eq!(
            agents.get_handle("rt1").unwrap().pending_silent.len(),
            2,
            "both messages should land in silent context"
        );
    }

    pub(crate) fn make_stored_session(
        runtime_id: &str,
        session_id: &str,
        agent_type: amux::AgentType,
        workspace_id: &str,
        created_at: i64,
    ) -> StoredSession {
        StoredSession {
            runtime_id: runtime_id.to_string(),
            acp_session_id: format!("acp-{runtime_id}"),
            session_id: session_id.to_string(),
            agent_type: agent_type as i32,
            workspace_id: workspace_id.to_string(),
            worktree: "/tmp/wt".to_string(),
            status: amux::AgentStatus::Active as i32,
            created_at,
            last_prompt: String::new(),
            last_output_summary: String::new(),
            tool_use_count: 0,
        }
    }

    #[test]
    pub(crate) fn dedup_resumable_runtimes_keeps_only_newest_for_session() {
        // Same conversation accumulated several historical runtimes across
        // restarts / model-switches / workspace-changes. The daemon is one
        // participant, so only the single newest may resume; everything else
        // is superseded — including runtimes for other agent_types/workspaces.
        let stored = vec![
            make_stored_session("rt-old", "s1", amux::AgentType::ClaudeCode, "ws-1", 100),
            make_stored_session("rt-mid", "s1", amux::AgentType::ClaudeCode, "ws-1", 200),
            make_stored_session("rt-new", "s1", amux::AgentType::ClaudeCode, "ws-1", 300),
            make_stored_session("rt-other", "s1", amux::AgentType::Codex, "ws-1", 150),
        ];

        let (keep, mut superseded) =
            crate::daemon::session_resume::dedup_resumable_runtimes(stored);
        superseded.sort();

        assert_eq!(
            keep.iter()
                .map(|s| s.runtime_id.as_str())
                .collect::<Vec<_>>(),
            vec!["rt-new"],
            "keep only the single newest runtime for the session"
        );
        assert_eq!(
            superseded,
            vec![
                "rt-mid".to_string(),
                "rt-old".to_string(),
                "rt-other".to_string()
            ],
            "every other runtime is superseded regardless of agent_type/workspace"
        );
    }

    #[test]
    pub(crate) fn dedup_resumable_runtimes_collapses_across_workspaces() {
        // Two live runtimes in different workspaces for the same conversation
        // each answered the same @mention (the duplicate-reply bug). Only the
        // newest survives; the cross-workspace duplicate is superseded.
        let stored = vec![
            make_stored_session("rt-a", "s1", amux::AgentType::ClaudeCode, "ws-1", 100),
            make_stored_session("rt-b", "s1", amux::AgentType::ClaudeCode, "ws-2", 50),
        ];

        let (keep, superseded) = crate::daemon::session_resume::dedup_resumable_runtimes(stored);
        assert_eq!(
            keep.iter()
                .map(|s| s.runtime_id.as_str())
                .collect::<Vec<_>>(),
            vec!["rt-a"],
            "newest runtime wins across workspaces"
        );
        assert_eq!(
            superseded,
            vec!["rt-b".to_string()],
            "older cross-workspace duplicate is superseded"
        );
    }

    #[tokio::test]
    pub(crate) async fn duplicate_live_message_id_is_not_sent_to_runtime_twice() {
        let mut fixture = test_server();

        fixture
            .server
            .handle_incoming(live_message("session-1", "msg-1", "first"))
            .await;
        fixture
            .server
            .handle_incoming(live_message("session-1", "msg-1", "second"))
            .await;

        let agents = fixture.server.agents.lock().await;
        assert_eq!(agents.last_sent_to("rt1").as_deref(), Some("first"));
    }

    #[tokio::test]
    pub(crate) async fn live_message_model_override_is_applied_before_prompt_routing() {
        let mut fixture = test_server();

        let msg = crate::proto::teamclaw::Message {
            message_id: "msg-model-1".to_string(),
            session_id: "session-1".to_string(),
            sender_actor_id: "human-actor".to_string(),
            kind: 0,
            content: "which model?".to_string(),
            created_at: 1,
            model: "opencode/deepseek-v4-flash-free".to_string(),
            ..Default::default()
        };
        let msg_env = crate::proto::teamclaw::SessionMessageEnvelope {
            message: Some(msg),
            mention_actor_ids: vec!["agent-actor".to_string()],
            ..Default::default()
        };
        let live = crate::proto::teamclaw::LiveEventEnvelope {
            event_id: "event-model-1".to_string(),
            event_type: "message.created".to_string(),
            session_id: "session-1".to_string(),
            actor_id: "human-actor".to_string(),
            sent_at: 1,
            body: msg_env.encode_to_vec(),
        };

        fixture
            .server
            .handle_incoming(subscriber::IncomingMessage::TeamclawSessionLive {
                session_id: "session-1".to_string(),
                payload: live.encode_to_vec(),
            })
            .await;

        let agents = fixture.server.agents.lock().await;
        assert_eq!(
            agents.current_model("rt1").map(|s| s.as_str()),
            Some("opencode/deepseek-v4-flash-free")
        );
        assert_eq!(agents.last_sent_to("rt1").as_deref(), Some("which model?"));
    }

    pub(crate) fn seed_startup_workspace_sync(
        mock: &Arc<crate::backend::mock::MockBackend>,
        display_name: &str,
        remote_id: &str,
    ) {
        mock.state().workspace_results.insert(
            (
                "team-test".to_string(),
                "agent-actor".to_string(),
                display_name.to_string(),
            ),
            crate::backend::WorkspaceRow {
                id: remote_id.to_string(),
                team_id: "team-test".to_string(),
                path: None,
            },
        );
    }

    #[tokio::test]
    pub(crate) async fn apply_add_workspace_calls_cloud_upsert_and_sets_default() {
        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        let mut ts = test_server_with_cloud_api(mock.clone());
        let workspace_dir = ts._tmp.path().to_path_buf();
        let display_name = workspace_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        seed_startup_workspace_sync(&mock, &display_name, "remote-ws-1");

        let add = amux::AddWorkspace {
            path: workspace_dir.to_string_lossy().to_string(),
        };
        let (accepted, error, workspace) = ts.server.apply_add_workspace(&add).await;

        assert!(accepted, "add workspace failed: {error}");
        assert!(workspace.is_some());
        assert_eq!(
            mock.state().default_workspace_ids,
            vec!["remote-ws-1".to_string()]
        );
        // apply_add_workspace must call backend.upsert_workspace directly
        // and use the returned cloud row's id as the workspace_id — there
        // is no more local WorkspaceStore mirror.
        let snap = mock.state();
        assert_eq!(snap.upserted_workspaces.len(), 1);
        assert_eq!(snap.upserted_workspaces[0].team_id, "team-test");
        assert_eq!(snap.upserted_workspaces[0].agent_id, "agent-actor");
        assert_eq!(workspace.unwrap().workspace_id, "remote-ws-1");
    }

    #[tokio::test]
    pub(crate) async fn handle_add_workspace_sock_registers_and_is_idempotent() {
        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        let mut ts = test_server_with_cloud_api(mock.clone());
        let workspace_dir = ts._tmp.path().to_path_buf();
        let display_name = workspace_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        seed_startup_workspace_sync(&mock, &display_name, "remote-ws-1");

        let reply = ts
            .server
            .handle_add_workspace_sock(&workspace_dir.to_string_lossy())
            .await;
        let value: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(value["ok"], serde_json::json!(true), "reply: {reply}");
        assert_eq!(
            value["result"]["path"].as_str().unwrap(),
            workspace_dir.canonicalize().unwrap().to_str().unwrap()
        );
        assert!(!value["result"]["workspace_id"].as_str().unwrap().is_empty());

        // Re-registering the same path is idempotent: still ok. The mock
        // backend dedups by (team_id, path) the same way the real FC
        // `upsertWorkspace` does.
        let reply2 = ts
            .server
            .handle_add_workspace_sock(&workspace_dir.to_string_lossy())
            .await;
        let value2: serde_json::Value = serde_json::from_str(&reply2).unwrap();
        assert_eq!(value2["ok"], serde_json::json!(true));
    }

    #[tokio::test]
    pub(crate) async fn apply_add_workspace_updates_refresh_watch_registry() {
        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        let mut ts = test_server_with_cloud_api(mock.clone());
        let registry =
            crate::runtime::refresh::refresh_watch::RefreshWatchRegistry::new(Vec::new());
        ts.server.refresh_watch_registry = Some(registry.clone());

        let workspace_dir = ts._tmp.path().join("watch-me");
        std::fs::create_dir_all(&workspace_dir).unwrap();
        seed_startup_workspace_sync(&mock, "watch-me", "remote-watch-me");

        let add = amux::AddWorkspace {
            path: workspace_dir.to_string_lossy().to_string(),
        };
        let (accepted, error, _workspace) = ts.server.apply_add_workspace(&add).await;
        assert!(accepted, "add workspace failed: {error}");

        assert_eq!(
            registry.workspace_paths().await,
            vec![workspace_dir.canonicalize().unwrap()]
        );
    }

    #[test]
    pub(crate) fn coalesce_merges_adjacent_output_runs() {
        let ev = |text: &str| amux::AcpEvent {
            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.to_string(),
                is_complete: false,
            })),
            model: String::new(),
        };
        let frame = |text: &str| AcpEventFrame::new("sid", ev(text));
        let merged = coalesce_text_events(vec![
            ("a".into(), frame("Hel")),
            ("a".into(), frame("lo")),
            ("a".into(), frame(" world")),
        ]);
        assert_eq!(merged.len(), 1);
        match &merged[0].1.event.event {
            Some(amux::acp_event::Event::Output(o)) => assert_eq!(o.text, "Hello world"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    pub(crate) fn coalesce_respects_agent_and_kind_boundaries() {
        let out = |text: &str| amux::AcpEvent {
            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.to_string(),
                is_complete: false,
            })),
            model: String::new(),
        };
        let think = |text: &str| amux::AcpEvent {
            event: Some(amux::acp_event::Event::Thinking(amux::AcpThinking {
                text: text.to_string(),
            })),
            model: String::new(),
        };
        let frame = |event: amux::AcpEvent| AcpEventFrame::new("sid", event);
        // different agents never merge
        let merged = coalesce_text_events(vec![
            ("a".into(), frame(out("x"))),
            ("b".into(), frame(out("y"))),
        ]);
        assert_eq!(merged.len(), 2);
        // thinking→output boundary preserved
        let merged = coalesce_text_events(vec![
            ("a".into(), frame(think("t1"))),
            ("a".into(), frame(think("t2"))),
            ("a".into(), frame(out("o1"))),
        ]);
        assert_eq!(merged.len(), 2);
        match &merged[0].1.event.event {
            Some(amux::acp_event::Event::Thinking(t)) => assert_eq!(t.text, "t1t2"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    pub(crate) fn coalesce_never_merges_past_is_complete() {
        let out = |text: &str, complete: bool| amux::AcpEvent {
            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.to_string(),
                is_complete: complete,
            })),
            model: String::new(),
        };
        let frame = |event: amux::AcpEvent| AcpEventFrame::new("sid", event);
        let merged = coalesce_text_events(vec![
            ("a".into(), frame(out("final", true))),
            ("a".into(), frame(out("next-turn", false))),
        ]);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    pub(crate) fn coalesce_preserves_non_text_events() {
        // tool_use and other non-text events pass through unmerged, order kept
        let out = |text: &str| amux::AcpEvent {
            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.to_string(),
                is_complete: false,
            })),
            model: String::new(),
        };
        let status = amux::AcpEvent {
            event: Some(amux::acp_event::Event::StatusChange(Default::default())),
            model: String::new(),
        };
        let frame = |event: amux::AcpEvent| AcpEventFrame::new("sid", event);
        let merged = coalesce_text_events(vec![
            ("a".into(), frame(out("x"))),
            ("a".into(), frame(status.clone())),
            ("a".into(), frame(out("y"))),
        ]);
        // x | status | y  → 3 (the two outputs are NOT adjacent)
        assert_eq!(merged.len(), 3);
    }

    #[test]
    pub(crate) fn coalesce_propagates_is_complete_and_splits_after() {
        let out = |text: &str, complete: bool| amux::AcpEvent {
            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.to_string(),
                is_complete: complete,
            })),
            model: String::new(),
        };
        let frame = |event: amux::AcpEvent| AcpEventFrame::new("sid", event);
        // a(false) + b(true) merge → "ab" complete; c(false) cannot merge into
        // a completed output → separate event.
        let merged = coalesce_text_events(vec![
            ("a".into(), frame(out("a", false))),
            ("a".into(), frame(out("b", true))),
            ("a".into(), frame(out("c", false))),
        ]);
        assert_eq!(merged.len(), 2);
        match &merged[0].1.event.event {
            Some(amux::acp_event::Event::Output(o)) => {
                assert_eq!(o.text, "ab");
                assert!(o.is_complete);
            }
            other => panic!("unexpected: {other:?}"),
        }
        match &merged[1].1.event.event {
            Some(amux::acp_event::Event::Output(o)) => {
                assert_eq!(o.text, "c");
                assert!(!o.is_complete);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }
}

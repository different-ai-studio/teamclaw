use rumqttc::{Event, Packet};
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;
use tracing::{error, info, warn};

use crate::channels::{AmuxdAcpHandle, AmuxdChannelStore, ChannelManager};
use crate::collab::{AuthManager, AuthResult, PeerState, PeerTracker, PermissionManager};
use crate::config::{DaemonConfig, SessionStore, StoredSession, WorkspaceStore};
use crate::history::EventHistory;
use crate::mqtt::{publisher::Publisher, subscriber, MqttClient};
use crate::proto::amux;
use crate::runtime::RuntimeManager;
use crate::supabase::{SupabaseClient, SupabaseConfig};
use std::path::PathBuf;
use teamclaw_gateway::{AcpHandle, ChannelStore};

/// Outcome of apply_start_runtime. Success path returns the allocated
/// runtime_id + the session_id (echoed from request or freshly created).
/// Failure path returns a (error_code, error_message, failed_stage) tuple
/// — the caller formats this into whatever wire envelope it emits
/// (legacy AgentStartResult or new RuntimeStartResult).
struct StartRuntimeOutcome {
    runtime_id: String,
    session_id: String,
}

struct StartRuntimeError {
    error_code: String,
    error_message: String,
    failed_stage: String,
}

pub struct DaemonServer {
    config: DaemonConfig,
    mqtt: MqttClient,
    agents: Arc<AsyncMutex<RuntimeManager>>,
    auth: AuthManager,
    peers: PeerTracker,
    permissions: PermissionManager,
    workspaces: WorkspaceStore,
    workspaces_path: PathBuf,
    sessions: SessionStore,
    sessions_path: PathBuf,
    history: EventHistory,
    teamclaw: Option<crate::teamclaw::SessionManager>,
    supabase: SupabaseClient,
    actor_id: String,
    /// Channel manager (Discord/WeCom/Feishu/Kook/WeChat/Email gateways).
    /// `None` until `start_channels()` runs; held as `Option` so `shutdown(self)`
    /// can be `.take()`n on graceful exit.
    channel_mgr: Option<ChannelManager>,
}

impl DaemonServer {
    pub async fn new(
        config: DaemonConfig,
        config_path: &std::path::Path,
    ) -> crate::error::Result<Self> {
        // Supabase is required — fail fast with a clear message if absent.
        let supabase = match SupabaseConfig::default_path() {
            Ok(path) if path.exists() => SupabaseConfig::load(&path)
                .and_then(SupabaseClient::new)
                .map_err(|e| {
                    crate::error::AmuxError::Config(format!("supabase init failed: {e}"))
                })?,
            _ => {
                return Err(crate::error::AmuxError::Config(
                    "supabase.toml not found — run `amuxd init` to configure".into(),
                ))
            }
        };

        info!(
            actor_id = %supabase.config().actor_id,
            team_id  = %supabase.config().team_id,
            "Supabase client initialised"
        );

        let actor_id = supabase.config().actor_id.clone();

        // Fetch first token — fails fast if Supabase is unreachable at startup.
        // Idea 5's outer loop handles retries on every subsequent reconnect.
        let token = supabase.access_token().await.map_err(|e| {
            crate::error::AmuxError::Config(format!("initial token fetch failed: {e}"))
        })?;

        let mqtt = MqttClient::new(&config, &actor_id, &token)?;

        let binary = config
            .agents
            .claude_code
            .as_ref()
            .map(|c| c.binary.clone())
            .unwrap_or_else(|| "claude".into());
        let flags = config
            .agents
            .claude_code
            .as_ref()
            .map(|c| c.default_flags.clone())
            .unwrap_or_default();

        let members_path = config_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join("members.toml");
        let auth = AuthManager::new(members_path)?;
        let peers = PeerTracker::new();
        let permissions = PermissionManager::new();

        let workspaces_path = config_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join("workspaces.toml");
        let workspaces = WorkspaceStore::load(&workspaces_path)?;

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
            binary,
            flags,
            Some(supabase.clone()),
        )));

        let teamclaw = if let Some(team_id) = &config.team_id {
            Some(crate::teamclaw::SessionManager::new(
                mqtt.client.clone(),
                team_id,
                &config.device.id,
                Some(actor_id.clone()),
                crate::config::DaemonConfig::config_dir(),
            )?)
        } else {
            None
        };

        Ok(Self {
            config,
            mqtt,
            agents,
            auth,
            peers,
            permissions,
            workspaces,
            workspaces_path,
            sessions,
            sessions_path,
            history,
            teamclaw,
            supabase,
            actor_id,
            channel_mgr: None,
        })
    }

    /// Construct the channel manager from `[channels.*]` entries in
    /// `daemon.toml` and call `start_enabled()` so every gateway whose
    /// section has `enabled = true` boots alongside the daemon. Best-effort:
    /// missing team_id (daemon not yet onboarded) or per-channel start
    /// failures are logged but do NOT abort daemon startup.
    async fn start_channels(&mut self) {
        let Some(team_id) = self.config.team_id.clone() else {
            info!("channels: daemon has no team_id (run `amuxd init`); skipping channel start");
            return;
        };

        // The daemon's own actor_id (persisted in supabase.toml during `init`)
        // is the agent participant the gateway-port channels speak as. Owner
        // ids would be looked up via agent_member_access; we don't yet ship a
        // helper, so leave the owner list empty — channels treat that as "no
        // human participants" and still function for the agent-only path.
        let primary_agent_actor_id = self.actor_id.clone();
        let agent_owner_actor_ids: Vec<String> = Vec::new();

        let acp_handle: Arc<dyn AcpHandle> = Arc::new(AmuxdAcpHandle {
            manager: self.agents.clone(),
            logical_to_acp: Arc::new(AsyncMutex::new(HashMap::new())),
            team_id: team_id.clone(),
        });
        let store: Arc<dyn ChannelStore> = Arc::new(AmuxdChannelStore {
            client: Arc::new(self.supabase.clone()),
        });

        let mgr = ChannelManager::new(
            self.config.clone(),
            acp_handle,
            store,
            team_id,
            primary_agent_actor_id,
            agent_owner_actor_ids,
        );
        match mgr.start_enabled().await {
            Ok(()) => info!("channel manager: start_enabled() completed"),
            Err(e) => warn!("channel manager: start_enabled() failed: {e:?}"),
        }
        self.channel_mgr = Some(mgr);
    }

    /// Tear down any running channels. Idempotent — safe to call when
    /// `channel_mgr` is `None`.
    async fn shutdown_channels(&mut self) {
        if let Some(mgr) = self.channel_mgr.take() {
            info!("shutting down channels...");
            mgr.shutdown().await;
        }
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

        // Start channel gateways. Best-effort: missing team_id (daemon not yet
        // onboarded) or per-channel boot failures are logged but do not abort
        // daemon startup. This runs before the MQTT loop so a misconfigured
        // channel doesn't delay collab connectivity.
        self.start_channels().await;

        tokio::pin!(shutdown);

        // One-time setup before the reconnect loop.
        // Heartbeat runs independently of MQTT session.
        {
            let sb = self.supabase.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(60));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tick.tick().await;
                    if let Err(e) = sb.heartbeat().await {
                        warn!("supabase heartbeat error: {e}");
                    }
                }
            });
        }

        // Register device_id in Supabase once (background).
        {
            let sb = self.supabase.clone();
            let device_id = self.config.device.id.clone();
            tokio::spawn(async move {
                if let Err(e) = sb.set_agent_device_id(&device_id).await {
                    warn!("supabase agents.device_id upsert failed: {e}");
                }
            });
        }

        let mut first_connect = true;

        'outer: loop {
            // ── 1. Get fresh access_token (retry indefinitely on Supabase errors) ──
            let token = loop {
                match self.supabase.access_token().await {
                    Ok(t) => break t,
                    Err(e) => {
                        warn!("token fetch failed: {e}, retrying in 30s");
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    }
                }
            };

            // ── 2. Rebuild MqttClient ──
            info!(
                actor_id = %self.actor_id,
                broker   = %self.config.mqtt.broker_url,
                "MQTT connecting with access_token"
            );
            self.mqtt = match MqttClient::new(&self.config, &self.actor_id, &token) {
                Ok(c) => c,
                Err(e) => {
                    warn!("MqttClient build failed: {e}, retrying in 5s");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue 'outer;
                }
            };

            // ── 3. Rebuild teamclaw with new AsyncClient ──
            if let Some(team_id) = self.config.team_id.clone() {
                self.teamclaw = match crate::teamclaw::SessionManager::new(
                    self.mqtt.client.clone(),
                    &team_id,
                    &self.config.device.id,
                    Some(self.actor_id.clone()),
                    crate::config::DaemonConfig::config_dir(),
                ) {
                    Ok(tc) => Some(tc),
                    Err(e) => {
                        warn!("teamclaw rebuild failed: {e}");
                        None
                    }
                };
            }

            // ── 4. Wait for CONNACK ──
            loop {
                match self.mqtt.eventloop.poll().await {
                    Ok(Event::Incoming(Packet::ConnAck(_))) => {
                        info!("MQTT CONNACK received");
                        break;
                    }
                    Ok(_) => {}
                    Err(rumqttc::ConnectionError::ConnectionRefused(code)) => {
                        warn!(
                            reason = ?code,
                            "MQTT connection refused during connect, refreshing token"
                        );
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        continue 'outer;
                    }
                    Err(e) => {
                        warn!("MQTT connect error: {e}, retrying...");
                        tokio::time::sleep(Duration::from_secs(3)).await;
                    }
                }
            }

            // ── 5. Subscribe and announce ──
            if let Err(e) = self.mqtt.subscribe_all().await {
                warn!("subscribe_all failed after CONNACK: {e}, reconnecting");
                continue 'outer;
            }
            if let Some(tc) = &mut self.teamclaw {
                if let Err(e) = tc.subscribe_all().await {
                    warn!("teamclaw subscribe failed: {e}, reconnecting");
                    continue 'outer;
                }
            }
            {
                let publisher = Publisher::new(&self.mqtt);
                if let Err(e) = publisher
                    .publish_device_state(&crate::proto::amux::DeviceState {
                        online: true,
                        device_name: self.config.device.name.clone(),
                        timestamp: chrono::Utc::now().timestamp(),
                    })
                    .await
                {
                    warn!("publish_device_state failed after CONNACK: {e}, reconnecting");
                    continue 'outer;
                }
            }
            self.publish_all_agent_states().await;
            info!(device_id = %self.config.device.id, "MQTT connected, listening for commands");

            if first_connect {
                self.register_startup_workspace().await;
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
            let proactive_reconnect_in: Duration = {
                let buffer = Duration::from_secs(5 * 60);
                match self.supabase.cached_token_expiry() {
                    Some(t) => t
                        .checked_duration_since(Instant::now())
                        .and_then(|d| d.checked_sub(buffer))
                        .unwrap_or(Duration::ZERO),
                    None => Duration::from_secs(50 * 60),
                }
            };
            info!(
                reconnect_in_secs = proactive_reconnect_in.as_secs(),
                "scheduled proactive MQTT reconnect before token expiry"
            );
            let proactive_sleep = tokio::time::sleep(proactive_reconnect_in);
            tokio::pin!(proactive_sleep);

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
                        return Ok(());
                    }
                    poll_result = self.mqtt.eventloop.poll() => {
                        match poll_result {
                            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                                // Network blip — rumqttc reconnected automatically.
                                info!("MQTT reconnected (network blip), re-publishing state");
                                let _ = self.mqtt.subscribe_all().await;
                                if let Some(tc) = &mut self.teamclaw {
                                    let _ = tc.subscribe_all().await;
                                }
                                let publisher = Publisher::new(&self.mqtt);
                                let _ = publisher.publish_device_state(&crate::proto::amux::DeviceState {
                                    online: true,
                                    device_name: self.config.device.name.clone(),
                                    timestamp: chrono::Utc::now().timestamp(),
                                }).await;
                                self.publish_all_agent_states().await;
                            }
                            Ok(Event::Incoming(Packet::Publish(publish))) => {
                                if let Some(msg) = subscriber::parse_incoming(&publish) {
                                    self.handle_incoming(msg).await;
                                }
                            }
                            // EMQX rejected connection (JWT expired).
                            Err(rumqttc::ConnectionError::ConnectionRefused(code)) => {
                                warn!(reason = ?code, "MQTT connection refused (token expired), reconnecting");
                                break; // outer loop gets fresh token
                            }
                            Err(e) => {
                                warn!("MQTT transient error: {e}, will retry (rumqttc auto-reconnects)");
                                tokio::time::sleep(Duration::from_secs(5)).await;
                            }
                            Ok(_) => {} // other events (Outgoing(...), PingResp, etc.)
                        }
                    }
                    _ = &mut proactive_sleep => {
                        info!(
                            expiry = ?self.supabase.cached_token_expiry(),
                            "JWT nearing expiry, proactively reconnecting MQTT before broker silently denies ACL"
                        );
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
                        // Drain queued runtime events without preempting poll().
                        let agent_events = self.agents.lock().await.poll_events();
                        for (agent_id, acp_event) in agent_events {
                            self.forward_agent_event(&agent_id, acp_event).await;
                        }
                    }
                }
            }
            // loop exited → outer: get fresh token and reconnect
        }
    }

    async fn register_startup_workspace(&mut self) {
        let current_dir = match std::env::current_dir() {
            Ok(path) => path,
            Err(e) => {
                warn!(
                    "workspace auto-registration skipped: current_dir failed: {}",
                    e
                );
                return;
            }
        };

        let startup_path = current_dir.to_string_lossy().to_string();
        match self.workspaces.add(&startup_path) {
            Ok(outcome) => {
                let mut workspace = outcome.workspace;
                let mut should_save = outcome.inserted;

                if self.sync_workspace_to_supabase(&mut workspace).await {
                    should_save = true;
                }

                if let Some(existing) = self
                    .workspaces
                    .workspaces
                    .iter_mut()
                    .find(|w| w.workspace_id == workspace.workspace_id)
                {
                    *existing = workspace.clone();
                }

                if !should_save {
                    return;
                }

                if let Err(e) = self.workspaces.save(&self.workspaces_path) {
                    warn!(path = %startup_path, "workspace auto-registration save failed: {}", e);
                    return;
                }

                info!(
                    workspace_id = %workspace.workspace_id,
                    path = %workspace.path,
                    "startup workspace registered"
                );
            }
            Err(e) => {
                warn!(path = %startup_path, "workspace auto-registration failed: {}", e);
            }
        }
    }

    async fn sync_workspace_to_supabase(
        &self,
        workspace: &mut crate::config::StoredWorkspace,
    ) -> bool {
        let sb = &self.supabase;

        let row = crate::supabase::WorkspaceUpsert {
            team_id: &sb.config().team_id,
            agent_id: &sb.config().actor_id,
            name: &workspace.display_name,
            path: if workspace.path.is_empty() {
                None
            } else {
                Some(workspace.path.as_str())
            },
            archived: false,
        };

        match sb.upsert_workspace(&row).await {
            Ok(remote) => {
                if workspace.supabase_workspace_id == remote.id {
                    return false;
                }
                workspace.supabase_workspace_id = remote.id;
                true
            }
            Err(e) => {
                warn!(path = %workspace.path, "workspace supabase sync failed: {}", e);
                false
            }
        }
    }

    /// Build merged agent list: active agents + historical (non-active) sessions.
    /// Now only used by `publish_all_agent_states` to iterate startup/reconnect state.
    /// Per-agent updates should go through `publish_runtime_state_by_id`.
    async fn merged_agent_list(&self) -> amux::AgentList {
        let mut agent_list = self.agents.lock().await.to_proto_agent_list();
        let active_ids: std::collections::HashSet<String> = agent_list
            .runtimes
            .iter()
            .map(|a| a.runtime_id.clone())
            .collect();
        for session_info in self.sessions.to_proto_agent_list() {
            if !active_ids.contains(&session_info.runtime_id) {
                agent_list.runtimes.push(session_info);
            }
        }
        agent_list
    }

    /// Look up a single agent's current RuntimeInfo — live adapter first, then
    /// the historical session store. Returns `None` if unknown.
    async fn agent_info_by_id(&self, agent_id: &str) -> Option<amux::RuntimeInfo> {
        match self.agents.lock().await.to_proto_info(agent_id) {
            Some(info) => Some(info),
            None => self.sessions.to_proto_agent_info(agent_id),
        }
    }

    /// Publish retained RuntimeInfo for a single agent on its per-agent state
    /// topic. Swallows errors (same convention as other publish helpers).
    async fn publish_runtime_state_by_id(&self, agent_id: &str) {
        if let Some(info) = self.agent_info_by_id(agent_id).await {
            let publisher = Publisher::new(&self.mqtt);
            let _ = publisher.publish_runtime_state(agent_id, &info).await;
        }
    }

    /// Publish every known agent (active + historical) individually. Used on
    /// startup and after MQTT reconnect so clients subscribing to the wildcard
    /// `agent/+/state` topic receive one retained message per agent — keeping
    /// each publish small instead of relying on a large broker packet limit,
    /// which the old single-list publish would blow past once the session
    /// count grew.
    async fn publish_all_agent_states(&self) {
        let publisher = Publisher::new(&self.mqtt);
        for info in self.merged_agent_list().await.runtimes {
            let _ = publisher
                .publish_runtime_state(&info.runtime_id, &info)
                .await;
        }
    }

    /// Returns the single collab session_id this runtime should publish
    /// ACP events to. Each runtime is bound at spawn time to one session
    /// via `RuntimeHandle.session_id` (set from
    /// `apply_start_runtime`'s supabase_session_id), so fanout has to be
    /// scoped to that one session.
    ///
    /// Earlier versions of this function unioned in
    /// `teamclaw.sessions_for_agent(daemon_actor_id)` — the set of
    /// sessions where the daemon (as agent participant) lives. That set
    /// is "all collab sessions this daemon serves," not "the session
    /// this turn belongs to," so every agent event got fanned out to
    /// every session — bug observed 2026-04-27 where one user message
    /// in session A produced agent reply copies in 8 unrelated sessions
    /// (and 9× the broker traffic on every turn). The runtime's own
    /// `session_id` is the only correct destination.
    ///
    /// Returns an empty vec for ambient/bare-agent spawns where
    /// `session_id` was never set; callers fall back to the
    /// legacy per-runtime events topic in that case.
    fn target_sessions(&self, agent_id: &str) -> Vec<String> {
        self.sessions
            .find_by_id(agent_id)
            .map(|s| s.session_id.clone())
            .filter(|s| !s.is_empty())
            .map(|sid| vec![sid])
            .unwrap_or_default()
    }

    async fn forward_agent_event(&mut self, agent_id: &str, mut acp_event: amux::AcpEvent) {
        // Stamp the current model on agent-reply events (Output, Thinking) so iOS
        // bubbles can show which model produced the response. Other event types
        // (status changes, tool calls, permission requests, raw control messages)
        // are not model-attributable and stay empty. Safe to read current_model
        // here for the same reason as the collab publish path: the daemon event
        // loop is single-threaded, so no SetModel can interleave between the
        // agent's reply and this lookup.
        if matches!(
            acp_event.event,
            Some(amux::acp_event::Event::Output(_)) | Some(amux::acp_event::Event::Thinking(_))
        ) {
            if let Some(model) = self.agents.lock().await.current_model(agent_id).cloned() {
                acp_event.model = model;
            }
        }

        // Register permission requests for later resolution
        if let Some(amux::acp_event::Event::PermissionRequest(ref pr)) = acp_event.event {
            self.permissions.register_pending(&pr.request_id);
        }

        // Handle internal RawJson events (session_title, tool_title_update)
        if let Some(amux::acp_event::Event::Raw(ref raw)) = acp_event.event {
            if raw.method == "session_title" {
                let title = String::from_utf8_lossy(&raw.json_payload).to_string();
                let updated = {
                    let mut agents = self.agents.lock().await;
                    if let Some(handle) = agents.get_handle_mut(agent_id) {
                        handle.session_title = title;
                        true
                    } else {
                        false
                    }
                };
                if updated {
                    self.publish_runtime_state_by_id(agent_id).await;
                }
                return;
            }
            if raw.method == "tool_title_update" {
                // Format: "tool_id|new_title"
                let payload = String::from_utf8_lossy(&raw.json_payload);
                if let Some((tool_id, new_title)) = payload.split_once('|') {
                    // Forward as a ToolUse event so iOS updates the tool name
                    let update_event = amux::AcpEvent {
                        event: Some(amux::acp_event::Event::Raw(amux::AcpRawJson {
                            method: "tool_title_update".into(),
                            json_payload: raw.json_payload.clone(),
                        })),
                        model: String::new(),
                    };
                    let seq = self
                        .agents
                        .lock()
                        .await
                        .get_handle_mut(agent_id)
                        .map(|h| h.next_sequence())
                        .unwrap_or(0);
                    let envelope = amux::Envelope {
                        runtime_id: agent_id.into(),
                        device_id: self.config.device.id.clone(),
                        source_peer_id: String::new(),
                        timestamp: chrono::Utc::now().timestamp(),
                        sequence: seq,
                        payload: Some(amux::envelope::Payload::AcpEvent(update_event)),
                    };
                    self.history.append(agent_id, &envelope);
                    self.publish_envelope_to_sessions(agent_id, &envelope).await;
                }
                return;
            }
        }

        // Update agent status if this is a status change event
        if let Some(amux::acp_event::Event::StatusChange(ref sc)) = acp_event.event {
            {
                let mut agents = self.agents.lock().await;
                if let Some(handle) = agents.get_handle_mut(agent_id) {
                    handle.status = amux::AgentStatus::try_from(sc.new_status)
                        .unwrap_or(amux::AgentStatus::Unknown);
                }
            }
            if let Some(session) = self.sessions.find_by_id_mut(agent_id) {
                session.status = sc.new_status;
                let _ = self.sessions.save(&self.sessions_path);
            }
            self.publish_runtime_state_by_id(agent_id).await;

            // Upsert agent_runtimes on status transitions
            {
                let sb = &self.supabase;
                let new_status = amux::AgentStatus::try_from(sc.new_status)
                    .unwrap_or(amux::AgentStatus::Unknown);
                let supabase_status: &'static str = match new_status {
                    amux::AgentStatus::Active => "running",
                    amux::AgentStatus::Idle => "idle",
                    amux::AgentStatus::Stopped => "stopped",
                    _ => "unknown",
                };
                let (acp_sid, session_id, ws_id, current_model) = {
                    let agents = self.agents.lock().await;
                    let h = agents.get_handle(agent_id);
                    (
                        h.map(|h| h.acp_session_id.clone()).unwrap_or_default(),
                        h.map(|h| h.session_id.clone()).unwrap_or_default(),
                        h.map(|h| h.workspace_id.clone()).unwrap_or_default(),
                        agents.current_model(agent_id).cloned(),
                    )
                };
                let supabase_ws_id = self.workspaces.find_by_id(&ws_id).and_then(|w| {
                    (!w.supabase_workspace_id.is_empty()).then_some(w.supabase_workspace_id.clone())
                });
                let team_id = sb.config().team_id.clone();
                let actor_id = sb.config().actor_id.clone();
                let runtime_id_owned = agent_id.to_string();
                let sb_clone = sb.clone();
                let now = chrono::Utc::now();
                tokio::spawn(async move {
                    let row = crate::supabase::AgentRuntimeUpsert {
                        team_id: &team_id,
                        agent_id: &actor_id,
                        session_id: (!session_id.is_empty()).then_some(session_id.as_str()),
                        workspace_id: supabase_ws_id.as_deref(),
                        backend_type: "claude",
                        backend_session_id: if acp_sid.is_empty() {
                            None
                        } else {
                            Some(acp_sid.as_str())
                        },
                        runtime_id: Some(runtime_id_owned.as_str()),
                        status: supabase_status,
                        current_model: current_model.as_deref(),
                        last_seen_at: now,
                    };
                    if let Err(e) = sb_clone.upsert_agent_runtime(&row).await {
                        warn!("agent_runtimes upsert ({supabase_status}): {e}");
                    }
                });
            }
        }

        // Update session on tool use
        if let Some(amux::acp_event::Event::ToolUse(_)) = acp_event.event {
            {
                let mut agents = self.agents.lock().await;
                if let Some(handle) = agents.get_handle_mut(agent_id) {
                    handle.tool_use_count += 1;
                }
            }
            if let Some(session) = self.sessions.find_by_id_mut(agent_id) {
                session.tool_use_count += 1;
                let _ = self.sessions.save(&self.sessions_path);
            }
        }

        // Drive the per-agent TurnAggregator. Emitted logical messages are
        // appended to local TOML, published to session/live as
        // `message.created`, and (for AGENT_REPLY only) persisted to
        // Supabase `messages`. ACP `acp.event` envelopes still flow through
        // the unchanged publish path below for streaming UI.
        let collab_sessions = self.target_sessions(agent_id);
        if !collab_sessions.is_empty() {
            let emitted = {
                let mut agents = self.agents.lock().await;
                agents
                    .aggregator_mut(agent_id)
                    .map(|agg| agg.ingest(&acp_event))
                    .unwrap_or_default()
            };

            if !emitted.is_empty() {
                if let Some(tc) = self.teamclaw.as_ref() {
                    let actor_id = self.actor_id.clone();
                    let model = self
                        .agents
                        .lock()
                        .await
                        .current_model(agent_id)
                        .cloned()
                        .unwrap_or_default();
                    for msg in emitted {
                        let persist =
                            crate::runtime::turn_aggregator::TurnAggregator::supabase_persistent(
                                &msg,
                            );
                        // Non-persistent kinds (AgentThinking / AgentToolCall /
                        // AgentToolResult) are already fully covered by the
                        // acp.event stream below — re-publishing them as
                        // message.created on session/live just makes iOS
                        // render the same content twice (folded thinking card
                        // + plain bubble via handleIncomingChatMessage). Only
                        // AgentReply needs message.created, since that is the
                        // turn-finalized form persisted to Supabase and used
                        // by historical replay / other collaborators.
                        if !persist {
                            continue;
                        }
                        let kind = msg.kind;
                        let content = msg.content;
                        let metadata_json = msg.metadata_json;
                        let turn_id = msg.turn_id;
                        for sid in &collab_sessions {
                            tc.emit_agent_message(
                                sid,
                                &actor_id,
                                kind,
                                &content,
                                &metadata_json,
                                &model,
                                &turn_id,
                                persist,
                                Some(&self.supabase),
                            )
                            .await;
                        }
                    }
                }
            }
        }

        let seq = self
            .agents
            .lock()
            .await
            .get_handle_mut(agent_id)
            .map(|h| h.next_sequence())
            .unwrap_or(0);

        // Ambient state variants (replaced wholesale on each push) should not
        // be persisted into the history buffer — replaying stale lists on
        // reconnect wastes bandwidth and contradicts the "in-memory only"
        // contract iOS assumes.
        let is_ambient = matches!(
            acp_event.event,
            Some(amux::acp_event::Event::AvailableCommands(_))
        );

        // Keep publishes under a conservative 10 KB budget. Claude Code's
        // AvailableCommands list with full descriptions routinely lands at
        // ~12 KB, which can trip broker packet limits and knock the daemon's
        // MQTT session offline mid-session-start. Trim descriptions (and as a
        // last resort commands themselves) in-place until the envelope fits.
        if let Some(amux::acp_event::Event::AvailableCommands(ref mut ac)) = acp_event.event {
            fit_available_commands_in_budget(ac);
            // Cache the trimmed list so the retained `runtime/{id}/state`
            // publish carries the same commands a fresh subscriber would
            // otherwise miss (events stream is not retained). Republish
            // immediately — ACP's AvailableCommandsUpdate fires after spawn
            // but typically before any status transition, so without this
            // bump the retained state would stay empty until the next
            // unrelated transition.
            self.agents
                .lock()
                .await
                .set_available_commands(agent_id, ac.commands.clone());
            self.publish_runtime_state_by_id(agent_id).await;
        }

        let envelope = amux::Envelope {
            runtime_id: agent_id.into(),
            device_id: self.config.device.id.clone(),
            source_peer_id: String::new(), // agent-initiated
            timestamp: chrono::Utc::now().timestamp(),
            sequence: seq,
            payload: Some(amux::envelope::Payload::AcpEvent(acp_event)),
        };

        if !is_ambient {
            self.history.append(agent_id, &envelope);
        }
        self.publish_envelope_to_sessions(agent_id, &envelope).await;
    }

    /// Route an inbound `message.created` from `session/{sid}/live` to the
    /// appropriate runtimes: mentioned runtimes receive a real prompt (which
    /// flushes any queued silent context first); un-mentioned runtimes have
    /// the message appended to `pending_silent` for delivery on next mention.
    ///
    /// Self-authored messages (i.e. sent by this daemon's own actor_id) are
    /// silently dropped to prevent feedback loops.
    async fn route_session_message(
        &mut self,
        session_id: &str,
        message: &crate::proto::teamclaw::Message,
        mention_actor_ids: &[String],
    ) {
        use crate::runtime::PendingMessage;

        // Skip messages this daemon authored — those are the agent reply we
        // just emitted; routing them back into our own runtimes would loop.
        if message.sender_actor_id == self.actor_id {
            return;
        }

        // Resolve sender display name once (cheap; in-memory).
        let sender_display = self
            .display_name_for_actor(&message.sender_actor_id)
            .unwrap_or_else(|| message.sender_actor_id.chars().take(8).collect());

        let runtime_ids = self.agents.lock().await.runtime_ids_for_session(session_id);
        if runtime_ids.is_empty() {
            // We're subscribed to session/{sid}/live but have no runtime
            // for it — typically the runtime exited (or never spawned in
            // this daemon process) while the subscription persisted. The
            // message is dropped here; iOS will see no agent reply.
            warn!(
                session_id = %session_id,
                message_id = %message.message_id,
                sender_actor_id = %message.sender_actor_id,
                "route_session_message: no runtime for session; dropping message"
            );
            return;
        }
        // Each runtime in this list belongs to this daemon, so a mention of
        // this daemon's actor engages the runtime. The handle's `agent_id`
        // is the 8-char runtime key (per CLAUDE.md glossary), NOT the actor
        // id that mention_actor_ids encodes — matching against it would
        // never hit and every message would fall through to silent queue.
        let mentioned_actor = mention_actor_ids.iter().any(|m| m == &self.actor_id);
        for runtime_id in runtime_ids {
            if self.agents.lock().await.agent_id_of(&runtime_id).is_none() {
                continue;
            }
            let mentioned = mentioned_actor;

            if mentioned {
                // Real prompt — flush_pending_silent inside send_prompt does the prefix work.
                let send_res = self
                    .agents
                    .lock()
                    .await
                    .send_prompt(&runtime_id, &message.content)
                    .await;
                let _drained = match send_res {
                    Ok(d) => d,
                    Err(e) => {
                        warn!(runtime_id = %runtime_id, err = ?e, "send_prompt failed");
                        continue;
                    }
                };

                // Cursor advances to this message id.
                let row_id_opt = self
                    .agents
                    .lock()
                    .await
                    .supabase_runtime_row_id(&runtime_id);
                if let Some(row_id) = row_id_opt {
                    let sb = self.supabase.clone();
                    let row = row_id.clone();
                    let last = message.message_id.clone();
                    tokio::spawn(async move {
                        if let Err(e) = sb.update_runtime_cursor(&row, &last).await {
                            warn!(?e, "update_runtime_cursor failed (mentioned)");
                        }
                    });
                }
            } else {
                // Silent: queue for next real prompt.
                {
                    let mut agents = self.agents.lock().await;
                    if let Some(handle) = agents.get_handle_mut(&runtime_id) {
                        handle.pending_silent.push(PendingMessage {
                            message_id: message.message_id.clone(),
                            sender_display: sender_display.clone(),
                            content: message.content.clone(),
                            created_at: message.created_at,
                        });
                    }
                }
                let row_id_opt = self
                    .agents
                    .lock()
                    .await
                    .supabase_runtime_row_id(&runtime_id);
                if let Some(row_id) = row_id_opt {
                    let sb = self.supabase.clone();
                    let row = row_id.clone();
                    let last = message.message_id.clone();
                    tokio::spawn(async move {
                        if let Err(e) = sb.update_runtime_cursor(&row, &last).await {
                            warn!(?e, "update_runtime_cursor failed (silent)");
                        }
                    });
                }
            }
        }
    }

    /// Replay any session messages that arrived before this runtime was spawned.
    ///
    /// Fetches all messages after the runtime's `last_processed_message_id`
    /// cursor (None → fetch all) and routes each through `route_session_message`
    /// so live and catchup share identical semantics (mentioned → real prompt,
    /// un-mentioned → pending_silent queue).
    pub async fn catchup_runtime(&mut self, runtime_id: &str) {
        let (session_id, last_processed_message_id) = {
            let agents = self.agents.lock().await;
            let Some(h) = agents.get_handle(runtime_id) else {
                return;
            };
            (h.session_id.clone(), h.last_processed_message_id.clone())
        };
        if session_id.is_empty() {
            return;
        }

        let messages = match self
            .supabase
            .messages_after_cursor(&session_id, last_processed_message_id.as_deref())
            .await
        {
            Ok(m) => m,
            Err(e) => {
                warn!(?e, runtime_id, "catchup messages_after_cursor failed");
                return;
            }
        };
        if messages.is_empty() {
            return;
        }

        info!(runtime_id, count = messages.len(), "catching up runtime");

        for m in messages {
            let mention_ids = parse_mention_actor_ids(&m.metadata_json);
            let proto = crate::proto::teamclaw::Message {
                message_id: m.id.clone(),
                session_id: m.session_id.clone(),
                sender_actor_id: m.sender_actor_id.clone(),
                kind: 0,
                content: m.content.clone(),
                created_at: m.created_at,
                ..Default::default()
            };
            self.route_session_message(&session_id, &proto, &mention_ids)
                .await;
        }
    }

    /// Look up a display name for an actor_id from the in-memory peer tracker.
    /// Returns `None` if the actor is unknown; the caller falls back to the
    /// first 8 chars of the actor_id.
    fn display_name_for_actor(&self, actor_id: &str) -> Option<String> {
        // PeerTracker is keyed by peer_id (session-scoped), not actor_id.
        // Search linearly for a matching member_id / peer entry.
        // If no match is found, return None and let the caller use the fallback.
        self.peers
            .get_peer(actor_id)
            .map(|p| p.display_name.clone())
    }

    /// Single sink for agent-originated envelopes. Fans out to
    /// `session/{sid}/live` for every session the agent is bound to.
    /// Returns silently when the agent has no session — every iOS
    /// session is session-backed today, so a bound-less agent is a
    /// legacy bare-runtime spawn whose `runtime/{rid}/events` topic
    /// has no subscriber. Logs a warn so it shows up if regression
    /// reintroduces session-less spawns.
    async fn publish_envelope_to_sessions(&self, agent_id: &str, envelope: &amux::Envelope) {
        let Some(tc) = self.teamclaw.as_ref() else {
            warn!(agent_id, "no teamclaw client; dropping envelope");
            return;
        };
        let sessions = self.target_sessions(agent_id);
        if sessions.is_empty() {
            warn!(agent_id, "agent has no bound session; dropping envelope");
            return;
        }
        let actor_id = self.actor_id.clone();
        for sid in &sessions {
            tc.publish_agent_acp_event(sid, &actor_id, envelope).await;
        }
    }

    /// Returns the primary (first running) agent ID for this daemon.
    /// Used to stamp new sessions with the host's agent without passing
    /// RuntimeManager into SessionManager.
    async fn primary_agent_id(&self) -> Option<String> {
        self.agents.lock().await.first_running_agent_id()
    }

    async fn runtime_id_for_agent_actor_in_session(
        &self,
        agent_actor_id: &str,
        session_id: &str,
    ) -> Option<String> {
        let agents = self.agents.lock().await;
        if agents.get_handle(agent_actor_id).is_some() {
            return Some(agent_actor_id.to_string());
        }
        if agent_actor_id == self.supabase.config().actor_id {
            return agents.running_agent_id_for_collab_session(session_id);
        }
        None
    }

    /// Server-level RPC dispatch. Decodes the wire payload, matches on Method,
    /// delegates session/idea methods to SessionManager, and handles non-session
    /// methods locally. Publishes the response to the sender's rpc/res topic.
    async fn handle_rpc_request(&mut self, topic: &str, payload: &[u8]) {
        use crate::proto::teamclaw::{rpc_request::Method, RpcRequest, RpcResponse};
        use prost::Message as ProstMessage;

        let request = match RpcRequest::decode(payload) {
            Ok(r) => r,
            Err(e) => {
                warn!(%topic, "failed to decode RpcRequest: {}", e);
                return;
            }
        };

        let response: RpcResponse = match &request.method {
            // ─── Session/idea methods — delegate to SessionManager ───
            Some(Method::CreateSession(_))
            | Some(Method::FetchSession(_))
            | Some(Method::FetchSessionMessages(_))
            | Some(Method::JoinSession(_))
            | Some(Method::AddParticipant(_))
            | Some(Method::RemoveParticipant(_))
            | Some(Method::CreateIdea(_))
            | Some(Method::ClaimIdea(_))
            | Some(Method::SubmitIdea(_))
            | Some(Method::UpdateIdea(_)) => {
                // Pre-compute primary before the mutable borrow of self.teamclaw.
                let primary = self.primary_agent_id().await;
                if let Some(tc) = self.teamclaw.as_mut() {
                    tc.handle_rpc_method(request.clone(), primary).await
                } else {
                    not_yet_implemented(&request, "session_manager not initialized")
                }
            }
            // ─── Non-session methods — handle locally ───
            // Phase 1b Ideas 3-9 replace these stubs with real handlers.
            Some(Method::FetchPeers(_)) => self.handle_fetch_peers(&request).await,
            Some(Method::FetchWorkspaces(_)) => self.handle_fetch_workspaces(&request).await,
            Some(Method::AnnouncePeer(ann)) => self.handle_announce_peer(&request, ann).await,
            Some(Method::DisconnectPeer(d)) => self.handle_disconnect_peer(&request, d).await,
            Some(Method::AddWorkspace(a)) => self.handle_add_workspace(&request, a).await,
            Some(Method::RemoveWorkspace(r)) => self.handle_remove_workspace(&request, r).await,
            Some(Method::RemoveMember(r)) => self.handle_remove_member(&request, r).await,
            Some(Method::RuntimeStop(s)) => self.handle_stop_runtime(&request, s).await,
            Some(Method::RuntimeStart(s)) => self.handle_start_runtime(&request, s).await,
            Some(Method::SetModel(s)) => self.handle_set_model(&request, s).await,
            None => RpcResponse {
                request_id: request.request_id.clone(),
                success: false,
                error: "no method".to_string(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                requester_device_id: request.requester_device_id.clone(),
                result: None,
            },
        };

        // Publish response on the sender's rpc/res topic (mirrors RpcServer::respond).
        let res_topic = self.mqtt.topics.rpc_res_for(&request.sender_device_id);
        let bytes = response.encode_to_vec();
        info!(
            request_id = %request.request_id,
            res_topic = %res_topic,
            success = response.success,
            "publishing RpcResponse"
        );
        if let Err(e) = self
            .mqtt
            .client
            .publish(res_topic, rumqttc::QoS::AtLeastOnce, false, bytes)
            .await
        {
            warn!("failed to publish RpcResponse: {}", e);
        }
    }

    async fn handle_incoming(&mut self, msg: subscriber::IncomingMessage) {
        use prost::Message as ProstMessage;
        match msg {
            subscriber::IncomingMessage::RuntimeCommand {
                runtime_id,
                envelope,
            } => {
                self.handle_agent_command(&runtime_id, envelope).await;
            }
            subscriber::IncomingMessage::TeamclawRpc { topic, payload } => {
                self.handle_rpc_request(&topic, &payload).await;
            }
            subscriber::IncomingMessage::TeamclawSessionLive {
                session_id,
                payload,
            } => {
                info!(
                    session_id = %session_id,
                    payload_bytes = payload.len(),
                    "session/live message received"
                );
                let envelope_res =
                    crate::proto::teamclaw::LiveEventEnvelope::decode(payload.as_slice());
                if let Err(e) = &envelope_res {
                    warn!(session_id = %session_id, err = %e, "LiveEventEnvelope decode FAILED");
                }
                if let Ok(envelope) = envelope_res {
                    info!(
                        session_id = %session_id,
                        event_type = %envelope.event_type,
                        event_id = %envelope.event_id,
                        body_bytes = envelope.body.len(),
                        "LiveEventEnvelope decoded"
                    );
                    match envelope.event_type.as_str() {
                        "message.created" => {
                            let env = match crate::proto::teamclaw::SessionMessageEnvelope::decode(
                                envelope.body.as_slice(),
                            ) {
                                Ok(e) => e,
                                Err(e) => {
                                    warn!(session_id = %session_id, err = %e, "SessionMessageEnvelope decode failed");
                                    return;
                                }
                            };
                            let Some(msg) = env.message.as_ref() else {
                                warn!(session_id = %session_id, "SessionMessageEnvelope without inner message; dropping");
                                return;
                            };
                            self.route_session_message(&session_id, msg, &env.mention_actor_ids)
                                .await;
                        }
                        "idea.created" | "idea.updated" => {
                            if let Ok(event) =
                                crate::proto::teamclaw::IdeaEvent::decode(envelope.body.as_slice())
                            {
                                if let Some(tc) = &mut self.teamclaw {
                                    if !tc.should_process_idea_event(&session_id, &event) {
                                        return;
                                    }
                                }
                                if let Some(tc) = &self.teamclaw {
                                    let activated =
                                        tc.agents_to_activate_for_idea(&session_id, &event);
                                    for agent_actor_id in activated {
                                        if let Some(runtime_id) = self
                                            .runtime_id_for_agent_actor_in_session(
                                                &agent_actor_id,
                                                &session_id,
                                            )
                                            .await
                                        {
                                            let prompt = format_idea_prompt(&session_id, &event);
                                            if !prompt.is_empty() {
                                                let send_res = self
                                                    .agents
                                                    .lock()
                                                    .await
                                                    .send_prompt(&runtime_id, &prompt)
                                                    .await;
                                                if let Err(e) = send_res {
                                                    warn!(
                                                        "Failed to route live idea to agent {} runtime {}: {}",
                                                        agent_actor_id, runtime_id, e
                                                    );
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            subscriber::IncomingMessage::TeamclawNotify {
                device_id: _,
                payload,
            } => match crate::proto::teamclaw::Notify::decode(payload.as_slice()) {
                Ok(n) => {
                    if n.event_type == "membership.refresh" && !n.refresh_hint.is_empty() {
                        if let Some(tc) = &mut self.teamclaw {
                            if let Err(err) = tc.refresh_membership_subscriptions().await {
                                warn!(?err, session_id = %n.refresh_hint, "failed to refresh membership subscriptions after notify");
                            }
                        }
                    }
                }
                Err(err) => {
                    warn!(?err, "failed to decode device/notify payload as Notify");
                }
            },
        }
    }

    /// Derive the caller's MemberRole via a Supabase `agent_member_access`
    /// lookup keyed on (our own agent actor id, envelope's sender_actor_id).
    /// Supabase is the sole source of truth — on any failure (RPC error,
    /// missing sender_actor_id) the caller is denied (`Member` is the safe
    /// no-op level). Previous versions fell back to a `peer_id` token-prefix
    /// scrape against members.toml, which let anyone who guessed a 6-char
    /// prefix masquerade as a member during a Supabase outage; that path
    /// is gone.
    async fn resolve_role(&mut self, sender_actor_id: &str, _peer_id: &str) -> amux::MemberRole {
        if sender_actor_id.is_empty() {
            warn!("resolve_role: empty sender_actor_id, denying as Member");
            return amux::MemberRole::Member;
        }
        let sb = &self.supabase;
        let my_agent_id = sb.config().actor_id.clone();
        match sb
            .check_agent_permission(&my_agent_id, sender_actor_id)
            .await
        {
            Ok(Some(level)) => match level.as_str() {
                "admin" => amux::MemberRole::Owner,
                "write" | _ => amux::MemberRole::Member,
            },
            Ok(None) => {
                warn!(actor_id = %sender_actor_id, "no agent_member_access grant");
                amux::MemberRole::Member
            }
            Err(e) => {
                warn!(%e, actor_id = %sender_actor_id, "supabase permission check failed; denying");
                amux::MemberRole::Member
            }
        }
    }

    async fn handle_agent_command(
        &mut self,
        agent_id: &str,
        envelope: amux::RuntimeCommandEnvelope,
    ) {
        let peer_id = envelope.peer_id.clone();
        let command_id = envelope.command_id.clone();
        let sender_actor_id = envelope.sender_actor_id.clone();
        let reply_device_id = if envelope.reply_to_device_id.is_empty() {
            envelope.device_id.clone()
        } else {
            envelope.reply_to_device_id.clone()
        };

        let acp_command = match envelope.acp_command {
            Some(c) => c,
            None => return,
        };
        let cmd = match acp_command.command {
            Some(c) => c,
            None => return,
        };

        // Permission check.
        // Preferred path: iOS sets `sender_actor_id` on the envelope, daemon
        // looks up `agent_member_access.permission_level` in Supabase and
        // reduces that to a MemberRole. Legacy path: fall back to the
        // peer's MQTT-era role when the Supabase lookup is unavailable.
        let role = self.resolve_role(&sender_actor_id, &peer_id).await;

        if let Err(reason) = self.permissions.check_command_permission(role, &cmd) {
            warn!(
                peer_id,
                reply_device_id = %reply_device_id,
                command_id = %command_id,
                %reason,
                "command rejected; legacy collab NACK no longer published"
            );
            return;
        }

        match cmd {
            amux::acp_command::Command::StartAgent(start) => {
                let at = amux::AgentType::try_from(start.agent_type)
                    .unwrap_or(amux::AgentType::ClaudeCode);

                info!(
                    workspace_id = %start.workspace_id,
                    worktree = %start.worktree,
                    peer_id,
                    "received startAgent envelope"
                );

                let outcome = self
                    .apply_start_runtime(
                        at,
                        &start.workspace_id,
                        &start.worktree,
                        &start.session_id,
                        &start.initial_prompt,
                    )
                    .await;

                match outcome {
                    Ok(res) => {
                        info!(
                            agent_id = %res.runtime_id,
                            peer_id,
                            reply_device_id = %reply_device_id,
                            command_id = %command_id,
                            session_id = %res.session_id,
                            "agent started; legacy collab AgentStartResult no longer published"
                        );
                    }
                    Err(err) => {
                        let reason = err.error_message.clone();
                        error!(
                            peer_id,
                            reply_device_id = %reply_device_id,
                            command_id = %command_id,
                            session_id = %start.session_id,
                            "startAgent failed: {}; legacy collab AgentStartResult no longer published",
                            reason
                        );
                    }
                }
            }

            amux::acp_command::Command::StopAgent(_) => {
                let stopped = self
                    .agents
                    .lock()
                    .await
                    .stop_agent(agent_id)
                    .await
                    .is_some();
                if stopped {
                    if let Some(session) = self.sessions.find_by_id_mut(agent_id) {
                        session.status = amux::AgentStatus::Stopped as i32;
                        let _ = self.sessions.save(&self.sessions_path);
                    }
                    self.publish_runtime_state_by_id(agent_id).await;
                    info!(agent_id, peer_id, "agent stopped");
                }
            }

            amux::acp_command::Command::SendPrompt(prompt) => {
                // Lazy resume: if agent is not live but exists in session store,
                // spawn a new ACP process and resume the session.
                let needs_resume = self.agents.lock().await.get_handle(agent_id).is_none();
                if needs_resume {
                    if let Some(stored) = self.sessions.find_by_id(agent_id) {
                        let at = amux::AgentType::try_from(stored.agent_type)
                            .unwrap_or(amux::AgentType::ClaudeCode);
                        let worktree = stored.worktree.clone();
                        let ws_id = stored.workspace_id.clone();
                        let acp_sid = stored.acp_session_id.clone();
                        let session_id = stored.session_id.clone();
                        info!(agent_id, "lazy-resuming historical session");
                        let supabase_ws_id = self.workspaces.find_by_id(&ws_id).and_then(|w| {
                            (!w.supabase_workspace_id.is_empty())
                                .then_some(w.supabase_workspace_id.clone())
                        });
                        let resume_res = self
                            .agents
                            .lock()
                            .await
                            .resume_agent(
                                agent_id,
                                &acp_sid,
                                at,
                                &worktree,
                                &ws_id,
                                supabase_ws_id.as_deref(),
                                (!session_id.is_empty()).then_some(session_id.as_str()),
                                &prompt.text,
                            )
                            .await;
                        match resume_res {
                            Ok(new_acp_sid) => {
                                // Forward model_id if the client requested one
                                let desired_model = prompt.model_id.clone();
                                if !desired_model.is_empty() {
                                    let mut agents = self.agents.lock().await;
                                    match agents.send_set_model(agent_id, &desired_model).await {
                                        Ok(()) => {
                                            agents.set_current_model(agent_id, &desired_model);
                                        }
                                        Err(e) => {
                                            warn!(agent_id, model_id = %desired_model, "set_model after resume failed: {}", e);
                                        }
                                    }
                                }
                                // Update stored session with potentially new acp_session_id
                                if let Some(s) = self.sessions.find_by_id_mut(agent_id) {
                                    s.acp_session_id = new_acp_sid;
                                    s.session_id = session_id.clone();
                                    s.status = amux::AgentStatus::Active as i32;
                                    s.last_prompt = prompt.text.clone();
                                }
                                let _ = self.sessions.save(&self.sessions_path);
                                info!(agent_id, peer_id, "session resumed, prompt sent");
                                self.publish_session_event(
                                    agent_id,
                                    amux::SessionEvent {
                                        event: Some(amux::session_event::Event::PromptAccepted(
                                            amux::PromptAccepted { command_id },
                                        )),
                                    },
                                )
                                .await;
                                self.publish_runtime_state_by_id(agent_id).await;
                            }
                            Err(e) => {
                                warn!(agent_id, "lazy resume failed: {}", e);
                                self.publish_session_event(
                                    agent_id,
                                    amux::SessionEvent {
                                        event: Some(amux::session_event::Event::PromptRejected(
                                            amux::PromptRejected {
                                                command_id,
                                                reason: format!("session resume failed: {}", e),
                                            },
                                        )),
                                    },
                                )
                                .await;
                            }
                        }
                        return;
                    }
                }

                // Check busy
                let busy_reject: Option<String> = {
                    let agents = self.agents.lock().await;
                    if let Some(handle) = agents.get_handle(agent_id) {
                        self.permissions.check_agent_busy(handle.status).err()
                    } else {
                        None
                    }
                };
                if let Some(reason) = busy_reject {
                    self.publish_session_event(
                        agent_id,
                        amux::SessionEvent {
                            event: Some(amux::session_event::Event::PromptRejected(
                                amux::PromptRejected { command_id, reason },
                            )),
                        },
                    )
                    .await;
                    return;
                }

                // If the client requested a specific model and it differs from
                // the one we last applied, forward a SetModel command before
                // the prompt so the new turn runs on the requested model.
                let desired_model = prompt.model_id.clone();
                let mut model_changed = false;
                if !desired_model.is_empty() {
                    let current = self
                        .agents
                        .lock()
                        .await
                        .current_model(agent_id)
                        .cloned()
                        .unwrap_or_default();
                    if desired_model != current {
                        let mut agents = self.agents.lock().await;
                        match agents.send_set_model(agent_id, &desired_model).await {
                            Ok(()) => {
                                agents.set_current_model(agent_id, &desired_model);
                                model_changed = true;
                            }
                            Err(e) => {
                                warn!(agent_id, model_id = %desired_model, "send_set_model failed: {}", e);
                            }
                        }
                    }
                }
                if model_changed {
                    self.publish_runtime_state_by_id(agent_id).await;
                }

                // Send prompt to agent (respawns if process exited)
                let send_res = self
                    .agents
                    .lock()
                    .await
                    .send_prompt(agent_id, &prompt.text)
                    .await;
                match send_res {
                    Ok(_drained) => {
                        {
                            let mut agents = self.agents.lock().await;
                            if let Some(handle) = agents.get_handle_mut(agent_id) {
                                handle.status = amux::AgentStatus::Active;
                                handle.current_prompt = prompt.text.clone();
                            }
                        }
                        if let Some(session) = self.sessions.find_by_id_mut(agent_id) {
                            session.last_prompt = prompt.text.clone();
                            let _ = self.sessions.save(&self.sessions_path);
                        }
                        info!(agent_id, peer_id, "prompt sent to agent");
                        self.publish_session_event(
                            agent_id,
                            amux::SessionEvent {
                                event: Some(amux::session_event::Event::PromptAccepted(
                                    amux::PromptAccepted { command_id },
                                )),
                            },
                        )
                        .await;
                        self.publish_runtime_state_by_id(agent_id).await;
                    }
                    Err(e) => {
                        warn!(agent_id, "failed to send prompt: {}", e);
                    }
                }
            }

            amux::acp_command::Command::Cancel(_) => {
                let cancel_res = self.agents.lock().await.cancel_agent(agent_id).await;
                match cancel_res {
                    Ok(()) => {
                        {
                            let mut agents = self.agents.lock().await;
                            if let Some(handle) = agents.get_handle_mut(agent_id) {
                                handle.status = amux::AgentStatus::Idle;
                            }
                        }
                        info!(agent_id, peer_id, "agent cancelled via ACP");
                        self.publish_runtime_state_by_id(agent_id).await;
                    }
                    Err(e) => {
                        warn!(agent_id, "failed to cancel agent: {}", e);
                    }
                }
            }

            amux::acp_command::Command::GrantPermission(grant) => {
                if self.permissions.try_resolve_permission(&grant.request_id) {
                    // Resolve via ACP permission response
                    let _ = self
                        .agents
                        .lock()
                        .await
                        .resolve_permission(agent_id, &grant.request_id, true)
                        .await;
                    info!(request_id = %grant.request_id, peer_id, "permission granted via ACP");
                    self.publish_session_event(
                        agent_id,
                        amux::SessionEvent {
                            event: Some(amux::session_event::Event::PermissionResolved(
                                amux::PermissionResolved {
                                    request_id: grant.request_id,
                                    resolved_by_peer_id: peer_id,
                                    granted: true,
                                },
                            )),
                        },
                    )
                    .await;
                }
            }

            amux::acp_command::Command::DenyPermission(deny) => {
                if self.permissions.try_resolve_permission(&deny.request_id) {
                    // Resolve via ACP permission response
                    let _ = self
                        .agents
                        .lock()
                        .await
                        .resolve_permission(agent_id, &deny.request_id, false)
                        .await;
                    info!(request_id = %deny.request_id, peer_id, "permission denied via ACP");
                    self.publish_session_event(
                        agent_id,
                        amux::SessionEvent {
                            event: Some(amux::session_event::Event::PermissionResolved(
                                amux::PermissionResolved {
                                    request_id: deny.request_id,
                                    resolved_by_peer_id: peer_id,
                                    granted: false,
                                },
                            )),
                        },
                    )
                    .await;
                }
            }

            amux::acp_command::Command::RequestHistory(req) => {
                use prost::Message;
                let page_size = if req.page_size == 0 {
                    50
                } else {
                    req.page_size
                };
                let (mut events, mut has_more) =
                    self.history
                        .read_page(agent_id, req.after_sequence, page_size);

                // Keep history replies under a conservative 10 KB publish
                // budget. Trim the batch by estimated encoded length so we never
                // produce a publish the broker will reject (which otherwise
                // forces the daemon's MQTT client to reconnect and knocks
                // every iOS peer offline in a loop).
                const HISTORY_BATCH_BUDGET: usize = 9500;
                while events.len() > 1 {
                    let estimate: usize = events
                        .iter()
                        .map(|e| {
                            let n = e.encoded_len();
                            1 + prost::encoding::encoded_len_varint(n as u64) + n
                        })
                        .sum::<usize>()
                        + req.request_id.len()
                        + 32;
                    if estimate < HISTORY_BATCH_BUDGET {
                        break;
                    }
                    events.pop();
                    has_more = true;
                }

                let next_seq = events
                    .last()
                    .map(|e| e.sequence)
                    .unwrap_or(req.after_sequence);
                info!(
                    agent_id,
                    peer_id,
                    after_seq = req.after_sequence,
                    count = events.len(),
                    has_more,
                    "history requested"
                );
                let batch = amux::HistoryBatch {
                    request_id: req.request_id,
                    events,
                    has_more,
                    next_after_sequence: next_seq,
                };
                self.publish_session_event(
                    agent_id,
                    amux::SessionEvent {
                        event: Some(amux::session_event::Event::HistoryBatch(batch)),
                    },
                )
                .await;
            }
        }
    }

    /// Publish a session event (e.g. HistoryBatch reply) onto the same
    /// canonical sink as agent-originated envelopes. Reuses
    /// `publish_envelope_to_sessions` so HistoryBatch responses land on
    /// `session/{sid}/live` next to the streaming output that triggered
    /// them — iOS subscribes there exclusively.
    async fn publish_session_event(&self, agent_id: &str, event: amux::SessionEvent) {
        let envelope = amux::Envelope {
            runtime_id: agent_id.into(),
            device_id: self.config.device.id.clone(),
            source_peer_id: String::new(),
            timestamp: chrono::Utc::now().timestamp(),
            sequence: 0,
            payload: Some(amux::envelope::Payload::SessionEvent(event)),
        };
        self.publish_envelope_to_sessions(agent_id, &envelope).await;
    }

    // ─── Non-session RPC handlers ───

    async fn handle_fetch_peers(
        &self,
        request: &crate::proto::teamclaw::RpcRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, FetchPeersResult, RpcResponse};

        let peers = self.peers.to_proto_peer_list().peers;
        RpcResponse {
            request_id: request.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            requester_device_id: request.requester_device_id.clone(),
            result: Some(rpc_response::Result::FetchPeersResult(FetchPeersResult {
                peers,
            })),
        }
    }

    async fn handle_fetch_workspaces(
        &self,
        request: &crate::proto::teamclaw::RpcRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, FetchWorkspacesResult, RpcResponse};

        let workspaces = self.workspaces.to_proto_list().workspaces;
        RpcResponse {
            request_id: request.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            requester_device_id: request.requester_device_id.clone(),
            result: Some(rpc_response::Result::FetchWorkspacesResult(
                FetchWorkspacesResult { workspaces },
            )),
        }
    }

    // ─── Peer mutation helpers (shared by legacy collab path + RPC handlers) ───

    /// Authenticates and adds a peer. Returns (accepted, error_text, assigned_role).
    /// Does NOT publish anything — the caller is responsible for any broadcasts
    /// (legacy collab arm republishes peer_list + workspace_list; RPC handler
    /// publishes Notify "peers.changed").
    async fn apply_peer_announce(
        &mut self,
        announce: &amux::PeerAnnounce,
    ) -> (bool, String, amux::MemberRole) {
        match self.auth.authenticate(&announce.auth_token) {
            AuthResult::Accepted { member } => {
                let role = if member.is_owner() {
                    amux::MemberRole::Owner
                } else {
                    amux::MemberRole::Member
                };
                let pi = announce.peer.as_ref();
                let peer_id_str = pi.map(|p| p.peer_id.clone()).unwrap_or_default();
                info!(peer_id = %peer_id_str, member_id = %member.member_id, "peer authenticated");
                self.peers.add_peer(PeerState {
                    peer_id: peer_id_str,
                    member_id: member.member_id.clone(),
                    display_name: member.display_name.clone(),
                    device_type: pi.map(|p| p.device_type.clone()).unwrap_or_default(),
                    role,
                    connected_at: chrono::Utc::now().timestamp(),
                });
                (true, String::new(), role)
            }
            AuthResult::Rejected { reason } => {
                warn!(%reason, "peer rejected");
                (false, reason, amux::MemberRole::Member)
            }
        }
    }

    /// Removes a peer by peer_id. Returns (accepted, error_text).
    /// Does NOT publish anything — the caller is responsible for any broadcasts.
    async fn apply_peer_disconnect(&mut self, peer_id: &str) -> (bool, String) {
        if self.peers.remove_peer(peer_id).is_some() {
            info!(peer_id, "peer disconnected");
            (true, String::new())
        } else {
            (false, format!("unknown peer_id: {}", peer_id))
        }
    }

    // ─── AnnouncePeer / DisconnectPeer RPC handlers ───

    async fn handle_announce_peer(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        announce: &crate::proto::teamclaw::AnnouncePeerRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, AnnouncePeerResult, RpcResponse};

        // Construct amux::PeerAnnounce that apply_peer_announce expects.
        let amux_announce = amux::PeerAnnounce {
            peer: announce.peer.clone(),
            auth_token: announce.auth_token.clone(),
        };
        let (accepted, error, assigned_role) = self.apply_peer_announce(&amux_announce).await;

        // Hint subscribers to re-fetch peers.
        if accepted {
            let publisher = Publisher::new(&self.mqtt);
            let _ = publisher.publish_notify("peers.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            requester_device_id: request.requester_device_id.clone(),
            result: Some(rpc_response::Result::AnnouncePeerResult(
                AnnouncePeerResult {
                    accepted,
                    error,
                    assigned_role: assigned_role as i32,
                },
            )),
        }
    }

    async fn handle_disconnect_peer(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        disconnect: &crate::proto::teamclaw::DisconnectPeerRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, DisconnectPeerResult, RpcResponse};

        let (accepted, error) = self.apply_peer_disconnect(&disconnect.peer_id).await;

        if accepted {
            let publisher = Publisher::new(&self.mqtt);
            let _ = publisher.publish_notify("peers.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            requester_device_id: request.requester_device_id.clone(),
            result: Some(rpc_response::Result::DisconnectPeerResult(
                DisconnectPeerResult { accepted, error },
            )),
        }
    }

    /// Applies a workspace add. Returns (success, error_text, resulting_workspace_if_any).
    /// Caller publishes any collab event or Notify hint.
    async fn apply_add_workspace(
        &mut self,
        add: &amux::AddWorkspace,
    ) -> (bool, String, Option<amux::WorkspaceInfo>) {
        match self.workspaces.add(&add.path) {
            Ok(outcome) => {
                let mut ws = outcome.workspace;
                let mut should_save = outcome.inserted;
                if self.sync_workspace_to_supabase(&mut ws).await {
                    should_save = true;
                }
                if let Some(existing) = self
                    .workspaces
                    .workspaces
                    .iter_mut()
                    .find(|w| w.workspace_id == ws.workspace_id)
                {
                    *existing = ws.clone();
                }
                if should_save {
                    let _ = self.workspaces.save(&self.workspaces_path);
                }
                info!(workspace_id = %ws.workspace_id, path = %ws.path, "workspace added");
                let info = amux::WorkspaceInfo {
                    workspace_id: ws.workspace_id,
                    path: ws.path,
                    display_name: ws.display_name,
                };
                (true, String::new(), Some(info))
            }
            Err(e) => {
                warn!(path = %add.path, "add workspace failed: {}", e);
                (false, e.to_string(), None)
            }
        }
    }

    /// Applies a workspace remove. Returns (success, error_text).
    async fn apply_remove_workspace(&mut self, remove: &amux::RemoveWorkspace) -> (bool, String) {
        if self.workspaces.remove(&remove.workspace_id) {
            let _ = self.workspaces.save(&self.workspaces_path);
            info!(workspace_id = %remove.workspace_id, "workspace removed");
            (true, String::new())
        } else {
            (
                false,
                format!("unknown workspace_id: {}", remove.workspace_id),
            )
        }
    }

    async fn handle_add_workspace(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        add: &crate::proto::teamclaw::AddWorkspaceRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, AddWorkspaceResult, RpcResponse};

        let amux_add = amux::AddWorkspace {
            path: add.path.clone(),
        };
        let (accepted, error, workspace) = self.apply_add_workspace(&amux_add).await;

        if accepted {
            let publisher = Publisher::new(&self.mqtt);
            let _ = publisher.publish_notify("workspaces.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            requester_device_id: request.requester_device_id.clone(),
            result: Some(rpc_response::Result::AddWorkspaceResult(
                AddWorkspaceResult {
                    accepted,
                    error,
                    workspace,
                },
            )),
        }
    }

    async fn handle_remove_workspace(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        remove: &crate::proto::teamclaw::RemoveWorkspaceRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, RemoveWorkspaceResult, RpcResponse};

        let amux_remove = amux::RemoveWorkspace {
            workspace_id: remove.workspace_id.clone(),
        };
        let (accepted, error) = self.apply_remove_workspace(&amux_remove).await;

        if accepted {
            let publisher = Publisher::new(&self.mqtt);
            let _ = publisher.publish_notify("workspaces.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            requester_device_id: request.requester_device_id.clone(),
            result: Some(rpc_response::Result::RemoveWorkspaceResult(
                RemoveWorkspaceResult { accepted, error },
            )),
        }
    }

    /// Applies a member removal. Returns (success, error_text).
    /// Caller passes `requester_is_owner` because the two callers have
    /// different ways to establish it: legacy collab path looks up the
    /// peer's role via PeerTracker; RPC path looks up the requester_actor_id
    /// through AuthManager::is_owner.
    async fn apply_remove_member(
        &mut self,
        remove: &amux::RemoveMember,
        requester_is_owner: bool,
    ) -> (bool, String) {
        if !requester_is_owner {
            warn!(member_id = %remove.member_id, "remove rejected: not owner");
            return (false, "not owner".to_string());
        }
        match self.auth.remove_member(&remove.member_id) {
            Ok(true) => {
                let kicked = self.peers.remove_by_member_id(&remove.member_id);
                for p in &kicked {
                    info!(peer_id = %p.peer_id, "peer kicked");
                }
                (true, String::new())
            }
            Ok(false) => (false, format!("member not found: {}", remove.member_id)),
            Err(e) => (false, e.to_string()),
        }
    }

    async fn handle_remove_member(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        remove: &crate::proto::teamclaw::RemoveMemberRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, RemoveMemberResult, RpcResponse};

        let amux_remove = amux::RemoveMember {
            member_id: remove.member_id.clone(),
        };
        // RPC carries requester identity in payload; resolve is_owner via
        // AuthManager, which is the source of truth for member roles.
        let is_owner = self.auth.is_owner(&request.requester_actor_id);
        let (accepted, error) = self.apply_remove_member(&amux_remove, is_owner).await;

        if accepted {
            let publisher = Publisher::new(&self.mqtt);
            let _ = publisher.publish_notify("members.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            requester_device_id: request.requester_device_id.clone(),
            result: Some(rpc_response::Result::RemoveMemberResult(
                RemoveMemberResult { accepted, error },
            )),
        }
    }

    /// Spawns a Claude Code subprocess and publishes lifecycle state
    /// transitions on the retained runtime state topic. Shared by legacy
    /// AcpCommand::StartAgent and RPC RuntimeStart handlers.
    ///
    /// Lifecycle publishes:
    ///   - STARTING (stage "spawning_process") published retained right after
    ///     spawn_agent returns the new runtime_id, before StoredSession upsert.
    ///   - ACTIVE published retained via publish_runtime_state_by_id after
    ///     StoredSession upsert (that call reads the now-populated RuntimeHandle).
    ///   - No FAILED publish here — spawn_agent error path returns before any
    ///     runtime_id is allocated, so there is no retained topic to write to.
    ///     Callers may surface the error via their wire envelope.
    async fn apply_start_runtime(
        &mut self,
        agent_type: amux::AgentType,
        workspace_id: &str,
        worktree: &str,
        session_id: &str,
        initial_prompt: &str,
    ) -> Result<StartRuntimeOutcome, StartRuntimeError> {
        info!(workspace_id, worktree, session_id, "apply_start_runtime");

        // Resolve workspace + worktree. Same 4-branch logic as the legacy
        // AcpCommand::StartAgent arm (see server.rs ~800-836 pre-refactor).
        let (mut resolved_worktree, mut ws_id, mut supabase_ws_id_owned): (
            String,
            String,
            Option<String>,
        ) = if !workspace_id.is_empty() {
            if let Some(ws) = self.workspaces.find_by_id(workspace_id) {
                (
                    ws.path.clone(),
                    ws.workspace_id.clone(),
                    (!ws.supabase_workspace_id.is_empty())
                        .then_some(ws.supabase_workspace_id.clone()),
                )
            } else if !worktree.is_empty() {
                (
                    worktree.to_string(),
                    String::new(),
                    Some(workspace_id.to_string()),
                )
            } else {
                return Err(StartRuntimeError {
                    error_code: "WORKSPACE_NOT_FOUND".to_string(),
                    error_message: format!(
                        "workspace {} not found and no worktree path provided",
                        workspace_id
                    ),
                    failed_stage: "validation".to_string(),
                });
            }
        } else {
            // Bare-agent spawn: empty workspace_id. Use worktree if
            // provided, else "." (today's legacy default).
            let wt = if worktree.is_empty() {
                ".".to_string()
            } else {
                worktree.to_string()
            };
            (wt, String::new(), None)
        };

        // Fallback: when ws_id stayed empty (bare-agent spawn or
        // workspace_id-not-found-with-worktree branch), try to match
        // resolved_worktree against a registered workspace path so the
        // runtime row, persisted session, and downstream agent_runtimes
        // upsert all carry the right workspace_id instead of stomping it
        // null on idle transitions.
        if ws_id.is_empty() {
            if let Some(ws) = self
                .workspaces
                .workspaces
                .iter()
                .find(|w| w.path == resolved_worktree)
            {
                ws_id = ws.workspace_id.clone();
                if supabase_ws_id_owned.is_none() && !ws.supabase_workspace_id.is_empty() {
                    supabase_ws_id_owned = Some(ws.supabase_workspace_id.clone());
                }
                resolved_worktree = ws.path.clone();
            }
        }

        let supabase_ws_id = supabase_ws_id_owned.as_deref();

        // Idempotency: if a live runtime already exists for the same
        // (session_id, agent_type, workspace_id) tuple, return its id
        // instead of spawning a duplicate. Protects against misbehaving
        // clients that fire RuntimeStart twice (e.g. picker + inline
        // mention race on the desktop client pre-4210aad8).
        let existing_runtime = self
            .agents
            .lock()
            .await
            .find_active_runtime_for(session_id, agent_type, &ws_id);
        if let Some(existing) = existing_runtime {
            info!(
                session_id,
                workspace_id = %ws_id,
                runtime_id = %existing,
                "apply_start_runtime: dedup hit; reusing existing runtime"
            );
            return Ok(StartRuntimeOutcome {
                runtime_id: existing,
                session_id: session_id.to_string(),
            });
        }

        // If iOS handed us a Supabase session_id, pull the row + participants
        // so we (a) populate the teamclaw cache that `agents_to_activate`
        // reads, and (b) subscribe to `session/{sid}/live` so inbound
        // `message.created` events from iOS actually reach us.
        // iOS creates these sessions directly in Supabase, so this is the
        // only place the daemon learns about them.
        if !session_id.is_empty() {
            match self
                .supabase
                .fetch_session_with_participants(session_id)
                .await
            {
                Ok(snap) => {
                    if let Some(tc) = self.teamclaw.as_mut() {
                        if let Err(e) = tc
                            .insert_session_from_supabase(&snap.session, &snap.participants)
                            .await
                        {
                            warn!(session_id, "insert_session_from_supabase failed: {}", e);
                        }
                    }
                }
                Err(e) => {
                    warn!(
                        session_id,
                        "fetch_session_with_participants failed; inbound session/live messages will be dropped: {}",
                        e
                    );
                }
            }
        }

        let session_id_opt = (!session_id.is_empty()).then_some(session_id);

        // Spawn.
        let spawn_res = self
            .agents
            .lock()
            .await
            .spawn_agent(
                agent_type,
                &resolved_worktree,
                initial_prompt,
                &ws_id,
                supabase_ws_id,
                session_id_opt,
            )
            .await;
        let new_id = match spawn_res {
            Ok(id) => id,
            Err(e) => {
                error!("spawn_agent failed: {}", e);
                // We never allocated a retained topic (spawn_agent failed before
                // returning an id), so there's no retain to publish FAILED to.
                // The caller formats the error into its wire envelope; no state
                // topic is involved.
                return Err(StartRuntimeError {
                    error_code: "SPAWN_FAILED".to_string(),
                    error_message: format!("spawn_agent failed: {}", e),
                    failed_stage: "spawning_process".to_string(),
                });
            }
        };

        // STARTING retain — fleeting but observable by mid-spawn reconnects.
        let publisher = Publisher::new(&self.mqtt);
        let starting_info = amux::RuntimeInfo {
            runtime_id: new_id.clone(),
            agent_type: agent_type as i32,
            worktree: resolved_worktree.clone(),
            workspace_id: ws_id.clone(),
            state: amux::RuntimeLifecycle::Starting as i32,
            stage: "spawning_process".to_string(),
            started_at: chrono::Utc::now().timestamp(),
            ..Default::default()
        };
        let _ = publisher
            .publish_runtime_state(&new_id, &starting_info)
            .await;

        // Persist session + transition to ACTIVE.
        let acp_sid = self
            .agents
            .lock()
            .await
            .get_handle(&new_id)
            .map(|h| h.acp_session_id.clone())
            .unwrap_or_default();
        let stored = StoredSession {
            runtime_id: new_id.clone(),
            acp_session_id: acp_sid,
            session_id: session_id.to_string(),
            agent_type: agent_type as i32,
            workspace_id: ws_id,
            worktree: resolved_worktree,
            status: amux::AgentStatus::Active as i32,
            created_at: chrono::Utc::now().timestamp(),
            last_prompt: initial_prompt.to_string(),
            last_output_summary: String::new(),
            tool_use_count: 0,
        };
        self.sessions.upsert(stored);
        let _ = self.sessions.save(&self.sessions_path);

        // ACTIVE — publish_runtime_state_by_id reads the live RuntimeHandle and
        // dual-publishes to agent/{id}/state + runtime/{id}/state. The handle
        // today encodes state=ACTIVE (Phase 1a Idea 4).
        self.publish_runtime_state_by_id(&new_id).await;

        // Replay any messages the runtime missed before it was spawned.
        // Uses Option B (event loop hook is not needed here because
        // apply_start_runtime already has `&mut self` access and runs
        // synchronously after spawn_agent returns). This is the cleanest
        // insertion point — the handle is fully populated (session_id,
        // supabase_runtime_row_id) and state is ACTIVE.
        self.catchup_runtime(&new_id).await;

        Ok(StartRuntimeOutcome {
            runtime_id: new_id,
            session_id: session_id.to_string(),
        })
    }

    async fn handle_stop_runtime(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        stop: &crate::proto::teamclaw::RuntimeStopRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, RpcResponse, RuntimeStopResult};

        let runtime_id = stop.runtime_id.clone();
        if runtime_id.is_empty() {
            return reject_stop(request, "runtime_id required");
        }

        // Reject if runtime is not known.
        if self.agents.lock().await.get_handle(&runtime_id).is_none() {
            return reject_stop(request, &format!("unknown runtime_id: {}", runtime_id));
        }

        // Terminate via RuntimeManager (same path as AcpCommand::StopAgent).
        if self
            .agents
            .lock()
            .await
            .stop_agent(&runtime_id)
            .await
            .is_none()
        {
            return reject_stop(
                request,
                &format!("stop failed for runtime_id: {}", runtime_id),
            );
        }

        // Update session store to reflect stopped status (mirrors StopAgent side-effect).
        if let Some(session) = self.sessions.find_by_id_mut(&runtime_id) {
            session.status = amux::AgentStatus::Stopped as i32;
            let _ = self.sessions.save(&self.sessions_path);
        }

        // Publish terminal RuntimeInfo to both retained state topics, then clear.
        let stopped_info = amux::RuntimeInfo {
            runtime_id: runtime_id.clone(),
            state: amux::RuntimeLifecycle::Stopped as i32,
            ..Default::default()
        };
        let publisher = Publisher::new(&self.mqtt);
        let _ = publisher
            .publish_runtime_state(&runtime_id, &stopped_info)
            .await;
        let _ = publisher.clear_runtime_state(&runtime_id).await;

        RpcResponse {
            request_id: request.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            requester_device_id: request.requester_device_id.clone(),
            result: Some(rpc_response::Result::RuntimeStopResult(RuntimeStopResult {
                accepted: true,
                rejected_reason: String::new(),
            })),
        }
    }

    async fn handle_start_runtime(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        start: &crate::proto::teamclaw::RuntimeStartRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, RpcResponse, RuntimeStartResult};

        let at = amux::AgentType::try_from(start.agent_type).unwrap_or(amux::AgentType::ClaudeCode);

        // Note: start.model_id is accepted for wire compatibility but not yet
        // threaded through apply_start_runtime — the legacy AcpStartAgent path
        // doesn't carry it either. Future work (Phase 1c+).

        let outcome = self
            .apply_start_runtime(
                at,
                &start.workspace_id,
                &start.worktree,
                &start.session_id,
                &start.initial_prompt,
            )
            .await;

        match outcome {
            Ok(res) => RpcResponse {
                request_id: request.request_id.clone(),
                success: true,
                error: String::new(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                requester_device_id: request.requester_device_id.clone(),
                result: Some(rpc_response::Result::RuntimeStartResult(
                    RuntimeStartResult {
                        accepted: true,
                        runtime_id: res.runtime_id,
                        session_id: res.session_id,
                        rejected_reason: String::new(),
                    },
                )),
            },
            Err(err) => RpcResponse {
                request_id: request.request_id.clone(),
                success: false,
                error: err.error_message.clone(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                requester_device_id: request.requester_device_id.clone(),
                result: Some(rpc_response::Result::RuntimeStartResult(
                    RuntimeStartResult {
                        accepted: false,
                        runtime_id: String::new(),
                        session_id: String::new(),
                        rejected_reason: err.error_message,
                    },
                )),
            },
        }
    }

    /// Forward a SetModel request to the matching runtime via ACP. On success
    /// the daemon's `current_model_per_agent` is bumped synchronously inside
    /// `RuntimeManager::set_model`, so we re-publish the runtime's retained
    /// state to fan the new `current_model` out to every subscriber.
    async fn handle_set_model(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        set: &crate::proto::teamclaw::SetModelRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, RpcResponse, SetModelResult};

        let runtime_id = set.runtime_id.clone();
        let model_id = set.model_id.clone();
        if runtime_id.is_empty() {
            return reject_set_model(request, "runtime_id required");
        }
        if model_id.is_empty() {
            return reject_set_model(request, "model_id required");
        }

        let result = self
            .agents
            .lock()
            .await
            .set_model(&runtime_id, &model_id)
            .await;
        let (success, error) = match result {
            Ok(()) => (true, String::new()),
            Err(e) => (false, e.to_string()),
        };

        // On success, fan the new current_model out via the retained per-runtime
        // state topic so iOS subscribers see the change immediately.
        if success {
            self.publish_runtime_state_by_id(&runtime_id).await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            requester_device_id: request.requester_device_id.clone(),
            result: Some(rpc_response::Result::SetModelResult(SetModelResult {
                success,
                error,
            })),
        }
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
        requester_device_id: request.requester_device_id.clone(),
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
        requester_device_id: request.requester_device_id.clone(),
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
/// leave headroom for the envelope wrapper (device_id, agent_id, sequence,
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

fn format_idea_prompt(session_id: &str, event: &crate::proto::teamclaw::IdeaEvent) -> String {
    use crate::proto::teamclaw::idea_event::Event;
    match &event.event {
        Some(Event::Created(item)) => format!(
            "[Collab session: {}] New idea: {} - {}",
            session_id, item.title, item.description
        ),
        Some(Event::Updated(item)) => format!(
            "[Collab session: {}] Idea updated: {}",
            session_id, item.title
        ),
        Some(Event::Claimed(claim)) => format!(
            "[Collab session: {}] Idea {} claimed by {}",
            session_id, claim.idea_id, claim.actor_id
        ),
        Some(Event::Submitted(sub)) => format!(
            "[Collab session: {}] Submission for {}: {}",
            session_id, sub.idea_id, sub.content
        ),
        None => String::new(),
    }
}

/// Extract the `mention_actor_ids` array from a Supabase `messages.metadata`
/// JSON string. Returns an empty Vec when the field is absent or malformed.
///
/// Extracted as a free function so it can be unit-tested without any I/O.
pub fn parse_mention_actor_ids(metadata_json: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(metadata_json)
        .ok()
        .and_then(|v| v.get("mention_actor_ids").cloned())
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default()
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
        requester_device_id: request.requester_device_id.clone(),
        result: None,
    }
}

#[cfg(test)]
mod tests {
    use super::parse_mention_actor_ids;

    #[test]
    fn parse_mention_actor_ids_returns_empty_for_empty_object() {
        assert!(parse_mention_actor_ids("{}").is_empty());
    }

    #[test]
    fn parse_mention_actor_ids_extracts_ids() {
        let json = r#"{"mention_actor_ids":["agent_X","agent_Y"]}"#;
        assert_eq!(
            parse_mention_actor_ids(json),
            vec!["agent_X".to_string(), "agent_Y".to_string()]
        );
    }

    #[test]
    fn parse_mention_actor_ids_returns_empty_for_invalid_json() {
        assert!(parse_mention_actor_ids("not json").is_empty());
    }

    #[test]
    fn parse_mention_actor_ids_returns_empty_when_field_absent() {
        assert!(parse_mention_actor_ids(r#"{"other":"value"}"#).is_empty());
    }

    #[test]
    fn parse_mention_actor_ids_handles_empty_array() {
        assert!(parse_mention_actor_ids(r#"{"mention_actor_ids":[]}"#).is_empty());
    }
}

use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

use super::blackboard::Blackboard;
use super::heartbeat::spawn_heartbeat_loop;
use super::nerve::NerveChannel;
use super::registry::AgentRegistry;
use super::types::{AgentProfile, AgentStatus, HeartbeatPayload, NerveMessage, NervePayload};

// ─── Public node struct ───────────────────────────────────────────────────────

pub struct SuperAgentNode {
    pub registry: Arc<Mutex<AgentRegistry>>,
    pub nerve: Arc<NerveChannel>,
    pub blackboard: Arc<Mutex<Blackboard>>,
    pub local_node_id: String,
    shutdown_tx: tokio::sync::watch::Sender<bool>,
    _heartbeat_handle: tokio::task::JoinHandle<()>,
    _listener_handle: tokio::task::JoinHandle<()>,
}

/// The Tauri managed state type: an optional node wrapped in Arc<Mutex<>>.
pub type SuperAgentState = Arc<Mutex<Option<SuperAgentNode>>>;

// ─── SuperAgentNode ───────────────────────────────────────────────────────────

impl SuperAgentNode {
    /// Start the super-agent node:
    /// - Creates NerveChannel, Blackboard, AgentRegistry.
    /// - Registers the local agent profile.
    /// - Broadcasts an initial heartbeat.
    /// - Spawns the heartbeat loop and the gossip listener.
    #[cfg(feature = "p2p")]
    pub async fn start(
        gossip: iroh_gossip::net::Gossip,
        team_namespace: String,
        local_node_id: String,
        local_profile: AgentProfile,
        storage_path: &std::path::Path,
        app_handle: Option<tauri::AppHandle>,
    ) -> Result<Self, String> {
        let nerve = Arc::new(NerveChannel::new(gossip, team_namespace));
        let blackboard = Arc::new(Mutex::new(Blackboard::new(storage_path.to_path_buf())));
        let registry = Arc::new(Mutex::new(AgentRegistry::new()));

        // Register local profile.
        {
            let mut reg = registry.lock().await;
            let mut bb = blackboard.lock().await;
            reg.register_local(&mut bb, local_profile);
        }

        // Broadcast initial heartbeat.
        {
            let reg = registry.lock().await;
            let profile = reg.local_profile().cloned();
            drop(reg);
            if let Some(p) = profile {
                let payload = HeartbeatPayload {
                    status: p.status,
                    current_task: p.current_task,
                    load: 0.0,
                };
                let msg = NerveMessage::new_heartbeat(local_node_id.clone(), payload);
                nerve.broadcast(msg).await;
            }
        }

        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

        // Spawn gossip listener.
        let listener_handle = spawn_gossip_listener(
            Arc::clone(&nerve),
            Arc::clone(&registry),
            Arc::clone(&blackboard),
            shutdown_rx.clone(),
        );

        // Spawn heartbeat loop.
        let heartbeat_handle = spawn_heartbeat_loop(
            Arc::clone(&nerve),
            Arc::clone(&registry),
            Arc::clone(&blackboard),
            local_node_id.clone(),
            app_handle,
            shutdown_rx,
        );

        info!("SuperAgentNode started for node_id={}", local_node_id);

        Ok(Self {
            registry,
            nerve,
            blackboard,
            local_node_id,
            shutdown_tx,
            _heartbeat_handle: heartbeat_handle,
            _listener_handle: listener_handle,
        })
    }

    /// Signal all background tasks to shut down.
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
        info!("SuperAgentNode: shutdown signal sent");
    }
}

// ─── Gossip listener ─────────────────────────────────────────────────────────

/// Subscribe to `NerveChannel` and handle incoming messages:
/// - `Heartbeat`: write the remote agent's profile into the registry.
/// - `Emergency*`: log a warning.
pub fn spawn_gossip_listener(
    nerve: Arc<NerveChannel>,
    registry: Arc<Mutex<AgentRegistry>>,
    blackboard: Arc<Mutex<Blackboard>>,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = nerve.subscribe();

        loop {
            tokio::select! {
                biased;

                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        info!("gossip_listener: shutdown signal received, exiting");
                        return;
                    }
                }

                result = rx.recv() => {
                    match result {
                        Ok(msg) => handle_nerve_message(msg, &registry, &blackboard).await,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            warn!("gossip_listener: receiver lagged, {} messages skipped", n);
                            // Continue; the next recv() will succeed.
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            info!("gossip_listener: NerveChannel closed, exiting");
                            return;
                        }
                    }
                }
            }
        }
    })
}

async fn handle_nerve_message(
    msg: NerveMessage,
    registry: &Arc<Mutex<AgentRegistry>>,
    blackboard: &Arc<Mutex<Blackboard>>,
) {
    use super::types::NerveTopic;

    match &msg.topic {
        NerveTopic::Heartbeat => {
            if let NervePayload::Heartbeat(hb) = &msg.payload {
                // Build a minimal profile update from the heartbeat data.
                let profile = AgentProfile {
                    node_id: msg.from.clone(),
                    name: msg.from.clone(),
                    owner: String::new(),
                    capabilities: vec![],
                    status: hb.status.clone(),
                    current_task: hb.current_task.clone(),
                    last_heartbeat: msg.timestamp,
                    version: String::new(),
                    model_id: String::new(),
                    joined_at: msg.timestamp,
                };
                let reg = registry.lock().await;
                let mut bb = blackboard.lock().await;
                reg.write_remote_profile(&mut bb, &profile);
                info!("gossip_listener: updated remote agent profile for {}", msg.from);
            }
        }
        NerveTopic::Emergency => {
            warn!("gossip_listener: EMERGENCY message from {}: {:?}", msg.from, msg.payload);
        }
        other => {
            info!("gossip_listener: received {:?} message from {} (not handled)", other, msg.from);
        }
    }
}

use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

use super::blackboard::Blackboard;
use super::deliberation::DeliberationEngine;
use super::experience_collector::ExperienceCollector;
use super::heartbeat::spawn_heartbeat_loop;
use super::knowledge_board::KnowledgeBoard;
use super::nerve::NerveChannel;
use super::orchestrator::TaskOrchestrator;
use super::registry::AgentRegistry;
use super::strategy_engine::StrategyEngine;
use super::types::{AgentProfile, HeartbeatPayload, NerveMessage, NervePayload};

// ─── Public node struct ───────────────────────────────────────────────────────

pub struct SuperAgentNode {
    pub registry: Arc<Mutex<AgentRegistry>>,
    pub nerve: Arc<NerveChannel>,
    pub blackboard: Arc<Mutex<Blackboard>>,
    pub local_node_id: String,
    pub orchestrator: Arc<Mutex<TaskOrchestrator>>,
    pub knowledge_board: KnowledgeBoard,
    pub experience_collector: ExperienceCollector,
    pub strategy_engine: StrategyEngine,
    pub deliberation_engine: Arc<Mutex<DeliberationEngine>>,
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

        use super::types::BiddingConfig;
        let orchestrator = TaskOrchestrator::new(local_node_id.clone(), BiddingConfig::default());
        let orchestrator = Arc::new(Mutex::new(orchestrator));

        let knowledge_board = KnowledgeBoard::new();
        let experience_collector = ExperienceCollector::new(local_node_id.clone());
        let strategy_engine = StrategyEngine::new();
        let deliberation_engine = DeliberationEngine::new(local_node_id.clone());

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

        let deliberation_engine = Arc::new(Mutex::new(deliberation_engine));

        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

        // Spawn gossip listener.
        let listener_handle = spawn_gossip_listener(
            Arc::clone(&nerve),
            Arc::clone(&registry),
            Arc::clone(&blackboard),
            Arc::clone(&orchestrator),
            Arc::clone(&deliberation_engine),
            local_node_id.clone(),
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
            orchestrator,
            knowledge_board,
            experience_collector,
            strategy_engine,
            deliberation_engine,
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
/// - `Task*`: route task payloads through the orchestrator.
pub fn spawn_gossip_listener(
    nerve: Arc<NerveChannel>,
    registry: Arc<Mutex<AgentRegistry>>,
    blackboard: Arc<Mutex<Blackboard>>,
    orchestrator: Arc<Mutex<TaskOrchestrator>>,
    deliberation_engine: Arc<Mutex<DeliberationEngine>>,
    local_node_id: String,
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
                        Ok(msg) => handle_nerve_message(msg, &registry, &blackboard, &orchestrator, &deliberation_engine, &nerve, &local_node_id).await,
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
    orchestrator: &Arc<Mutex<TaskOrchestrator>>,
    deliberation_engine: &Arc<Mutex<DeliberationEngine>>,
    nerve: &Arc<NerveChannel>,
    local_node_id: &str,
) {
    use super::types::{Bid, NerveTopic};

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
        NerveTopic::Task => {
            match msg.payload.clone() {
                NervePayload::TaskBroadcast { task_id, description: _, required_capabilities, urgency: _ } => {
                    // Check if we can bid on this task.
                    let reg = registry.lock().await;
                    if let Some(profile) = reg.local_profile() {
                        let has_capability = required_capabilities.is_empty()
                            || required_capabilities.iter().any(|cap| {
                                profile.capabilities.iter().any(|c| c.domain == *cap)
                            });

                        if has_capability {
                            let best_cap_score = required_capabilities.iter()
                                .filter_map(|cap| profile.capabilities.iter().find(|c| c.domain == *cap))
                                .map(|c| c.confidence * c.avg_score)
                                .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                                .unwrap_or(0.5);

                            drop(reg);

                            let bid_msg = NerveMessage::new_task(
                                local_node_id.to_string(),
                                NervePayload::TaskBid {
                                    task_id,
                                    confidence: best_cap_score,
                                    estimated_tokens: 1000,
                                },
                            );
                            nerve.broadcast(bid_msg).await;
                        }
                    }
                }
                NervePayload::TaskBid { task_id, confidence, estimated_tokens } => {
                    let mut bb = blackboard.lock().await;
                    let orch = orchestrator.lock().await;
                    let bid = Bid {
                        node_id: msg.from.clone(),
                        confidence,
                        estimated_tokens,
                        capability_score: confidence,
                        current_load: 0.0,
                        timestamp: msg.timestamp,
                    };
                    if let Err(e) = orch.add_bid(&mut bb, &task_id, bid) {
                        warn!("Failed to add bid for task {task_id}: {e}");
                    }
                }
                NervePayload::TaskAssign { task_id, assignee } => {
                    info!("Task {task_id} assigned to {assignee}");
                    let mut bb = blackboard.lock().await;
                    let orch = orchestrator.lock().await;
                    let _ = orch.assign_task(&mut bb, &task_id, assignee);
                }
                NervePayload::TaskProgress { task_id, progress, message } => {
                    info!("Task {task_id}: {progress}% - {message}");
                }
                NervePayload::ExperienceNew { experience_id, domain, summary: _ } => {
                    info!("Experience shared: {experience_id} in {domain}");
                }
                other => {
                    info!("gossip_listener: unhandled Task payload from {}: {:?}", msg.from, other);
                }
            }
        }
        NerveTopic::Debate => {
            match msg.payload.clone() {
                NervePayload::DebatePropose { debate_id, question, .. } => {
                    // Auto-perspective generation is future work; just log for now.
                    info!("gossip_listener: debate:propose debate_id={debate_id} question={question:?} from={}", msg.from);
                }
                NervePayload::DebatePerspective { debate_id, agent_id, angle, position, confidence } => {
                    info!("gossip_listener: debate:perspective debate_id={debate_id} agent_id={agent_id} from={}", msg.from);
                    use super::types::Perspective;
                    let perspective = Perspective {
                        debate_id: debate_id.clone(),
                        agent_id: agent_id.clone(),
                        angle,
                        position,
                        reasoning: String::new(),
                        evidence: vec![],
                        risks: vec![],
                        preferred_option: String::new(),
                        option_ranking: vec![],
                        confidence,
                    };
                    let engine = deliberation_engine.lock().await;
                    let mut bb = blackboard.lock().await;
                    if let Err(e) = engine.add_perspective(&mut bb, &debate_id, perspective) {
                        warn!("gossip_listener: failed to add remote perspective for debate {debate_id}: {e}");
                    }
                }
                NervePayload::DebateRebuttal { debate_id, round, agent_id, .. } => {
                    info!("gossip_listener: debate:rebuttal debate_id={debate_id} round={round} agent_id={agent_id} from={}", msg.from);
                }
                NervePayload::DebateVote { debate_id } => {
                    info!("gossip_listener: debate:vote debate_id={debate_id} from={}", msg.from);
                }
                NervePayload::DebateConclude { debate_id, winning_option, margin } => {
                    info!("gossip_listener: debate:conclude debate_id={debate_id} winning_option={winning_option} margin={margin} from={}", msg.from);
                }
                other => {
                    info!("gossip_listener: unhandled Debate payload from {}: {:?}", msg.from, other);
                }
            }
        }
        other => {
            info!("gossip_listener: received {:?} message from {} (not handled)", other, msg.from);
        }
    }
}

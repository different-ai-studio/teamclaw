use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio::time::{interval, Duration};
use tracing::{info, warn};

use super::blackboard::Blackboard;
use super::nerve::NerveChannel;
use super::registry::AgentRegistry;
use super::types::{AgentStatus, HeartbeatPayload, NerveMessage, SuperAgentSnapshot};

/// Spawn the heartbeat loop.
///
/// Every 15 seconds the loop:
/// 1. Updates the local agent's heartbeat timestamp in the registry.
/// 2. Marks stale agents (>120s no heartbeat) as offline.
/// 3. Broadcasts a heartbeat via `NerveChannel`.
/// 4. Saves blackboard snapshots to disk.
/// 5. Emits a `super-agent:snapshot` event to the frontend.
///
/// The loop respects `shutdown_rx`: when the watched value becomes `true` the
/// task exits cleanly.
pub fn spawn_heartbeat_loop(
    nerve: Arc<NerveChannel>,
    registry: Arc<Mutex<AgentRegistry>>,
    blackboard: Arc<Mutex<Blackboard>>,
    local_node_id: String,
    app_handle: Option<tauri::AppHandle>,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_secs(15));
        // Skip the immediate first tick so the loop waits 15s before the first
        // heartbeat (the caller typically does an initial broadcast on start).
        ticker.tick().await;

        loop {
            tokio::select! {
                biased;

                // Shutdown signal takes priority.
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        info!("heartbeat_loop: shutdown signal received, exiting");
                        return;
                    }
                }

                _ = ticker.tick() => {
                    tick_heartbeat(
                        &nerve,
                        &registry,
                        &blackboard,
                        &local_node_id,
                        &app_handle,
                    ).await;
                }
            }
        }
    })
}

async fn tick_heartbeat(
    nerve: &Arc<NerveChannel>,
    registry: &Arc<Mutex<AgentRegistry>>,
    blackboard: &Arc<Mutex<Blackboard>>,
    local_node_id: &str,
    app_handle: &Option<tauri::AppHandle>,
) {
    // 1. Update local heartbeat and collect load / task info for the broadcast.
    let (status, current_task) = {
        let mut reg = registry.lock().await;
        let mut bb = blackboard.lock().await;
        // Refresh the heartbeat timestamp without changing status / task.
        let (s, t) = reg
            .local_profile()
            .map(|p| (p.status.clone(), p.current_task.clone()))
            .unwrap_or((AgentStatus::Online, None));
        reg.update_local_status(&mut bb, s.clone(), t.clone());
        (s, t)
    };

    // 2. Mark stale agents offline (>120 000 ms).
    {
        let reg = registry.lock().await;
        let mut bb = blackboard.lock().await;
        match reg.mark_stale_agents_offline(&mut bb, 120_000) {
            Ok(marked) if !marked.is_empty() => {
                info!("heartbeat_loop: marked offline: {:?}", marked);
            }
            Err(e) => warn!("heartbeat_loop: mark_stale_agents_offline error: {e}"),
            _ => {}
        }
    }

    // 3. Broadcast heartbeat over NerveChannel.
    let payload = HeartbeatPayload {
        status,
        current_task,
        load: current_load(),
    };
    let msg = NerveMessage::new_heartbeat(local_node_id.to_string(), payload);
    nerve.broadcast(msg).await;

    // 4. Save blackboard snapshots.
    {
        let bb = blackboard.lock().await;
        if let Err(e) = bb.save_snapshots() {
            warn!("heartbeat_loop: failed to save blackboard snapshots: {e}");
        }
    }

    // 5. Emit snapshot event to frontend.
    if let Some(handle) = app_handle {
        let snapshot = build_snapshot(&registry, &blackboard).await;
        if let Err(e) = handle.emit("super-agent:snapshot", &snapshot) {
            warn!("heartbeat_loop: failed to emit snapshot event: {e}");
        }
    }
}

async fn build_snapshot(
    registry: &Arc<Mutex<AgentRegistry>>,
    blackboard: &Arc<Mutex<Blackboard>>,
) -> SuperAgentSnapshot {
    let reg = registry.lock().await;
    let bb = blackboard.lock().await;
    SuperAgentSnapshot {
        local_agent: reg.local_profile().cloned(),
        agents: reg.get_all_agents(&bb),
        connected: true,
    }
}

/// Cheap heuristic for the current CPU load (always 0.0 when unavailable).
fn current_load() -> f64 {
    0.0
}

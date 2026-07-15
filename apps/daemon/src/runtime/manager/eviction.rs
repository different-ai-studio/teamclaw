//! Idle-runtime eviction, extracted from `manager.rs`.
//!
//! The daemon's idle sweeper stops runtimes that have been quiet past a
//! threshold, buffering their ids on `evicted_pending_publish` so the main
//! event loop can clear the retained `runtime/{id}/state` MQTT topic on its
//! next tick.
//!
//! Child module of `runtime::manager`, so the `impl RuntimeManager` block
//! reaches the private `agents` map and `evicted_pending_publish` buffer.

use tracing::info;

use super::RuntimeManager;

impl RuntimeManager {
    /// Stop every runtime whose `last_active_at` is older than
    /// `now - threshold_secs`. Skips runtimes whose `event_rx` is currently
    /// checked out (a gateway turn is in flight). Returns the list of
    /// agent_ids that were stopped — and also buffers them on
    /// `evicted_pending_publish` so the daemon main loop can clear retained
    /// state. Called by the daemon's idle sweeper task.
    pub async fn evict_idle(&mut self, threshold_secs: i64) -> Vec<String> {
        let now = chrono::Utc::now().timestamp();
        let cutoff = now - threshold_secs;
        let stale: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, h)| h.event_rx.is_some() && h.last_active_at <= cutoff)
            .map(|(id, _)| id.clone())
            .collect();
        let mut evicted = Vec::with_capacity(stale.len());
        for id in stale {
            if self.stop_agent(&id).await.is_some() {
                info!(
                    agent_id = %id,
                    threshold_secs,
                    "idle sweeper: evicted runtime"
                );
                evicted.push(id);
            }
        }
        self.evicted_pending_publish.extend(evicted.iter().cloned());
        evicted
    }

    /// Drain the buffer of idle-evicted agent_ids whose terminal MQTT state
    /// still needs publishing. Called once per main-loop tick.
    pub fn drain_evicted(&mut self) -> Vec<String> {
        std::mem::take(&mut self.evicted_pending_publish)
    }
}

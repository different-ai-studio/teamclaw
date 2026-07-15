//! Autonomous 300s sync loop: covers the app-closed / headless case. The
//! desktop's HTTP trigger handles instant sync while the app is open.
//!
//! The workspace list is captured at spawn time. Teams added later are covered
//! immediately by the HTTP /v1/team/sync path, and re-captured on the next
//! daemon restart. (A live-refreshing timer is intentionally out of scope.)

use std::time::Duration;

use crate::sync::dispatch::{SyncDispatcher, SyncOptions};

pub fn spawn(dispatcher: SyncDispatcher, workspaces: Vec<(String, Vec<String>)>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(300));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            for (team_id, paths) in &workspaces {
                if let Some(ws) = paths.first() {
                    if dispatcher.status(team_id).await.syncing {
                        tracing::debug!(team_id, "timer sync skipped: sync already in progress");
                        continue;
                    }
                    let st = dispatcher
                        .sync_team(team_id, ws, SyncOptions::default())
                        .await;
                    if let Some(err) = &st.last_error {
                        tracing::warn!(team_id, "timer sync error: {err}");
                    }
                }
            }
        }
    });
}

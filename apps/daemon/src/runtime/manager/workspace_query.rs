//! Workspace-scoped runtime queries, extracted from `manager.rs`.
//!
//! Find or stop the runtimes bound to a given workspace (matched by either the
//! worktree path or the workspace id). Used by the supervisor after a settings
//! reload. Pure reads of the manager's private `agents` map plus `stop_agent`.
//!
//! Child module of `runtime::manager`, so the `impl RuntimeManager` block
//! reaches `agents` directly.

use crate::proto::amux;
use crate::runtime::handle::RuntimeHandle;

use super::RuntimeManager;

impl RuntimeManager {
    fn workspace_runtime_matches(
        handle: &RuntimeHandle,
        workspace_path: &str,
        workspace_id: &str,
    ) -> bool {
        handle.worktree == workspace_path
            || handle.workspace_id == workspace_path
            || handle.workspace_id == workspace_id
    }

    /// Active runtimes bound to a workspace path or id.
    pub fn active_handles_for_workspace<'a>(
        &'a self,
        workspace_path: &'a str,
        workspace_id: &'a str,
    ) -> impl Iterator<Item = (&'a String, &'a RuntimeHandle)> + 'a {
        self.agents.iter().filter(move |(_, handle)| {
            Self::workspace_runtime_matches(handle, workspace_path, workspace_id)
                && matches!(
                    handle.status,
                    amux::AgentStatus::Starting
                        | amux::AgentStatus::Active
                        | amux::AgentStatus::Idle
                )
        })
    }

    /// True while any runtime in this workspace is currently executing a turn.
    ///
    /// `Active` is the normal ACP status during a turn. `event_rx == None`
    /// covers the checkout path used by HTTP/gateway/cron turn drivers; while
    /// checked out, the owner is awaiting the turn and `poll_events` must not
    /// drain that channel.
    pub fn workspace_has_active_turn(&self, workspace_path: &str, workspace_id: &str) -> bool {
        self.agents.iter().any(|(_, handle)| {
            Self::workspace_runtime_matches(handle, workspace_path, workspace_id)
                && (matches!(handle.status, amux::AgentStatus::Active) || handle.event_rx.is_none())
        })
    }

    /// Stop all runtimes for a workspace (used after settings reload).
    pub async fn stop_runtimes_for_workspace(
        &mut self,
        workspace_path: &str,
        workspace_id: &str,
    ) -> usize {
        let ids: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, handle)| {
                Self::workspace_runtime_matches(handle, workspace_path, workspace_id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut stopped = 0usize;
        for id in ids {
            if self.stop_agent(&id).await.is_some() {
                stopped += 1;
            }
        }
        stopped
    }
}

//! Resolve and reuse ACP `backend_session_id` across daemon restarts.
//! Agent backends (OpenCode, Claude Code, …) retain turn memory inside the
//! ACP session; TeamClaw only needs to attach/resume the same id.

use std::sync::Arc;

use tracing::warn;

use crate::backend::Backend;
use crate::config::{SessionStore, StoredSession};
use crate::proto::amux;

/// Given every resumable `StoredSession` for one conversation, keep only the
/// single most-recent (`created_at`) row and report the rest as superseded.
pub(crate) fn dedup_resumable_runtimes(
    stored_sessions: Vec<StoredSession>,
) -> (Vec<StoredSession>, Vec<String>) {
    let mut keep: Option<StoredSession> = None;
    let mut superseded: Vec<String> = Vec::new();
    for stored in stored_sessions {
        match keep.take() {
            Some(existing) if existing.created_at >= stored.created_at => {
                superseded.push(stored.runtime_id.clone());
                keep = Some(existing);
            }
            Some(existing) => {
                superseded.push(existing.runtime_id.clone());
                keep = Some(stored);
            }
            None => keep = Some(stored),
        }
    }
    (keep.into_iter().collect(), superseded)
}

/// How [`stored_sessions_for_collab_resume`] narrows `sessions.toml` rows.
pub(crate) enum CollabResumeFilter<'a> {
    /// `runtimeStart`: same agent type + workspace as the client request.
    MatchAgentWorkspace {
        agent_type: amux::AgentType,
        workspace_id: &'a str,
    },
    /// MQTT lazy path: any resumable row for the session (dedup picks newest).
    SessionOnly,
}

/// Select stored sessions to pass to the shared resume implementation.
pub(crate) fn stored_sessions_for_collab_resume(
    store: &SessionStore,
    cloud_session_id: &str,
    filter: CollabResumeFilter<'_>,
) -> Vec<StoredSession> {
    match filter {
        CollabResumeFilter::MatchAgentWorkspace {
            agent_type,
            workspace_id,
        } => matching_stored_sessions(store, cloud_session_id, agent_type, workspace_id),
        CollabResumeFilter::SessionOnly => store.resumable_sessions_for_session(cloud_session_id),
    }
}

/// Stored rows for a cloud session that match the requested agent + workspace.
pub(crate) fn matching_stored_sessions(
    store: &SessionStore,
    cloud_session_id: &str,
    agent_type: amux::AgentType,
    workspace_id: &str,
) -> Vec<StoredSession> {
    let agent_type = agent_type as i32;
    store
        .resumable_sessions_for_session(cloud_session_id)
        .into_iter()
        .filter(|s| s.agent_type == agent_type && s.workspace_id == workspace_id)
        .collect()
}

fn acp_sid_from_stored_sessions(sessions: &[StoredSession]) -> Option<String> {
    let mut best: Option<&StoredSession> = None;
    for stored in sessions {
        if stored.acp_session_id.is_empty() {
            continue;
        }
        match best {
            Some(existing) if existing.created_at >= stored.created_at => {}
            _ => best = Some(stored),
        }
    }
    best.map(|s| s.acp_session_id.clone())
}

/// Canonical ACP session id to pass to `resume_session` / `attach_session`.
///
/// 1. Cloud `agent_runtimes.backend_session_id` for this daemon actor + session.
/// 2. Newest non-empty `acp_session_id` on matching `sessions.toml` rows.
pub(crate) async fn resolve_backend_session_id(
    backend: &Arc<dyn Backend>,
    daemon_actor_id: &str,
    cloud_session_id: &str,
    store: &SessionStore,
    agent_type: amux::AgentType,
    workspace_id: &str,
) -> Option<String> {
    if !cloud_session_id.is_empty() {
        match backend
            .fetch_latest_runtime_for_session(daemon_actor_id, cloud_session_id)
            .await
        {
            Ok(Some(row)) => {
                if let Some(sid) = row.backend_session_id.filter(|s| !s.is_empty()) {
                    return Some(sid);
                }
            }
            Ok(None) => {}
            Err(e) => {
                warn!(
                    cloud_session_id,
                    error = %e,
                    "resolve_backend_session_id: fetch_latest_runtime_for_session failed"
                );
            }
        }
    }

    acp_sid_from_stored_sessions(&matching_stored_sessions(
        store,
        cloud_session_id,
        agent_type,
        workspace_id,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::StoredSession;

    #[test]
    fn stored_sessions_filter_match_vs_session_only() {
        let mut store = SessionStore::default();
        store.upsert(stored("rt-a", "cloud-1", 1, "acp-a", amux::AgentType::Opencode, "ws-a"));
        store.upsert(stored(
            "rt-b",
            "cloud-1",
            2,
            "acp-b",
            amux::AgentType::ClaudeCode,
            "ws-a",
        ));

        let matched = stored_sessions_for_collab_resume(
            &store,
            "cloud-1",
            CollabResumeFilter::MatchAgentWorkspace {
                agent_type: amux::AgentType::Opencode,
                workspace_id: "ws-a",
            },
        );
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].runtime_id, "rt-a");

        let all = stored_sessions_for_collab_resume(
            &store,
            "cloud-1",
            CollabResumeFilter::SessionOnly,
        );
        assert_eq!(all.len(), 2);
    }

    fn stored(
        runtime_id: &str,
        session_id: &str,
        created_at: i64,
        acp: &str,
        agent_type: amux::AgentType,
        workspace_id: &str,
    ) -> StoredSession {
        StoredSession {
            runtime_id: runtime_id.to_string(),
            acp_session_id: acp.to_string(),
            session_id: session_id.to_string(),
            agent_type: agent_type as i32,
            workspace_id: workspace_id.to_string(),
            worktree: "/tmp/ws".to_string(),
            status: amux::AgentStatus::Active as i32,
            created_at,
            last_prompt: String::new(),
            last_output_summary: String::new(),
            tool_use_count: 0,
        }
    }

    #[test]
    fn dedup_keeps_newest_runtime_id() {
        let stored = vec![
            stored(
                "old",
                "s1",
                1,
                "acp-old",
                amux::AgentType::Opencode,
                "ws-1",
            ),
            stored(
                "new",
                "s1",
                2,
                "acp-new",
                amux::AgentType::Opencode,
                "ws-1",
            ),
        ];
        let (keep, superseded) = dedup_resumable_runtimes(stored);
        assert_eq!(keep.len(), 1);
        assert_eq!(keep[0].runtime_id, "new");
        assert_eq!(superseded, vec!["old".to_string()]);
    }

    #[test]
    fn matching_filters_agent_type_and_workspace() {
        let mut store = SessionStore::default();
        store.upsert(StoredSession {
            runtime_id: "rt-1".into(),
            acp_session_id: "acp-1".into(),
            session_id: "cloud-1".into(),
            agent_type: amux::AgentType::Opencode as i32,
            workspace_id: "ws-a".into(),
            worktree: "/tmp".into(),
            status: amux::AgentStatus::Active as i32,
            created_at: 1,
            last_prompt: String::new(),
            last_output_summary: String::new(),
            tool_use_count: 0,
        });
        store.upsert(StoredSession {
            runtime_id: "rt-2".into(),
            acp_session_id: "acp-2".into(),
            session_id: "cloud-1".into(),
            agent_type: amux::AgentType::ClaudeCode as i32,
            workspace_id: "ws-a".into(),
            worktree: "/tmp".into(),
            status: amux::AgentStatus::Active as i32,
            created_at: 2,
            last_prompt: String::new(),
            last_output_summary: String::new(),
            tool_use_count: 0,
        });

        let matched =
            matching_stored_sessions(&store, "cloud-1", amux::AgentType::Opencode, "ws-a");
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].runtime_id, "rt-1");
    }

    #[test]
    fn acp_sid_from_stored_picks_newest_non_empty() {
        let sessions = vec![
            stored("a", "s1", 1, "", amux::AgentType::Opencode, "ws-1"),
            stored("b", "s1", 3, "acp-b", amux::AgentType::Opencode, "ws-1"),
            stored("c", "s1", 2, "acp-c", amux::AgentType::Opencode, "ws-1"),
        ];
        assert_eq!(
            acp_sid_from_stored_sessions(&sessions).as_deref(),
            Some("acp-b")
        );
    }
}

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::proto::amux;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SessionStore {
    #[serde(default)]
    pub sessions: Vec<StoredSession>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_session(
        runtime_id: &str,
        session_id: &str,
        status: amux::AgentStatus,
    ) -> StoredSession {
        StoredSession {
            runtime_id: runtime_id.to_string(),
            acp_session_id: format!("acp-{runtime_id}"),
            session_id: session_id.to_string(),
            agent_type: amux::AgentType::ClaudeCode as i32,
            workspace_id: "workspace-1".to_string(),
            worktree: "/tmp/workspace-1".to_string(),
            status: status as i32,
            created_at: 1,
            last_prompt: String::new(),
            last_output_summary: String::new(),
            tool_use_count: 0,
        }
    }

    #[test]
    fn resumable_for_collab_session_returns_non_stopped_runtime_ids() {
        let mut store = SessionStore::default();
        store.upsert(make_session(
            "rt-active",
            "session-1",
            amux::AgentStatus::Active,
        ));
        store.upsert(make_session(
            "rt-stopped",
            "session-1",
            amux::AgentStatus::Stopped,
        ));
        store.upsert(make_session(
            "rt-other",
            "session-2",
            amux::AgentStatus::Active,
        ));

        let ids: Vec<String> = store
            .resumable_sessions_for_session("session-1")
            .into_iter()
            .map(|s| s.runtime_id)
            .collect();

        assert_eq!(ids, vec!["rt-active".to_string()]);
    }

    #[test]
    fn supersede_stale_for_session_marks_older_rows_stopped() {
        let mut store = SessionStore::default();
        store.upsert(make_session(
            "rt-old",
            "session-1",
            amux::AgentStatus::Active,
        ));
        store.upsert(make_session(
            "rt-keep",
            "session-1",
            amux::AgentStatus::Active,
        ));

        let superseded = store.supersede_stale_for_session(
            "session-1",
            "workspace-1",
            amux::AgentType::ClaudeCode as i32,
            "rt-keep",
        );

        assert_eq!(superseded.len(), 1);
        assert_eq!(superseded[0], "rt-old");
        assert_eq!(
            store.find_by_id("rt-old").unwrap().status,
            amux::AgentStatus::Stopped as i32
        );
        assert_eq!(
            store.find_by_id("rt-keep").unwrap().status,
            amux::AgentStatus::Active as i32
        );
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    /// Daemon's 8-char runtime/spawn id. Pre-rename TOML files used
    /// `session_id` for this slot, but post-rename TOML carries both
    /// `runtime_id` (the 8-char) and `session_id` (the cloud session UUID),
    /// so a `session_id` alias here would collide with the real
    /// `session_id` field below. Old single-field TOML files now need
    /// a one-time migration if they exist; in practice the dual-field
    /// schema has been on disk for everyone.
    pub runtime_id: String,
    #[serde(default)]
    pub acp_session_id: String,
    /// Cloud `sessions.id` UUID this runtime is bound to. Old TOML used
    /// `collab_session_id`; alias preserves back-compat. Empty when the
    /// runtime is session-less (legacy bare-agent spawn).
    #[serde(default, alias = "collab_session_id")]
    pub session_id: String,
    pub agent_type: i32,
    pub workspace_id: String,
    pub worktree: String,
    pub status: i32,
    pub created_at: i64,
    pub last_prompt: String,
    pub last_output_summary: String,
    pub tool_use_count: i32,
}

impl SessionStore {
    #[allow(dead_code)]
    pub fn default_path() -> PathBuf {
        super::DaemonConfig::migrate_legacy_file("sessions.toml")
    }

    pub fn load(path: &Path) -> crate::error::Result<Self> {
        if !path.exists() {
            return Ok(Self { sessions: vec![] });
        }
        let content = std::fs::read_to_string(path).map_err(|e| {
            crate::error::AmuxError::Config(format!("read {}: {}", path.display(), e))
        })?;
        toml::from_str(&content).map_err(|e| {
            crate::error::AmuxError::Config(format!("parse {}: {}", path.display(), e))
        })
    }

    pub fn save(&self, path: &Path) -> crate::error::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(self)
            .map_err(|e| crate::error::AmuxError::Config(e.to_string()))?;
        std::fs::write(path, content)?;
        Ok(())
    }

    pub fn upsert(&mut self, session: StoredSession) {
        if let Some(existing) = self
            .sessions
            .iter_mut()
            .find(|s| s.runtime_id == session.runtime_id)
        {
            *existing = session;
        } else {
            self.sessions.push(session);
        }
    }

    /// Mark older rows for the same `(session_id, workspace_id, agent_type)`
    /// as Stopped, keeping `keep_runtime_id` as the sole resumable row.
    pub fn supersede_stale_for_session(
        &mut self,
        session_id: &str,
        workspace_id: &str,
        agent_type: i32,
        keep_runtime_id: &str,
    ) -> Vec<String> {
        let mut superseded = Vec::new();
        for stored in &mut self.sessions {
            if stored.session_id != session_id
                || stored.workspace_id != workspace_id
                || stored.agent_type != agent_type
                || stored.runtime_id == keep_runtime_id
            {
                continue;
            }
            if amux::AgentStatus::try_from(stored.status) == Ok(amux::AgentStatus::Stopped) {
                continue;
            }
            stored.status = amux::AgentStatus::Stopped as i32;
            superseded.push(stored.runtime_id.clone());
        }
        superseded
    }

    pub fn find_by_id(&self, runtime_id: &str) -> Option<&StoredSession> {
        self.sessions.iter().find(|s| s.runtime_id == runtime_id)
    }

    pub fn find_by_id_mut(&mut self, runtime_id: &str) -> Option<&mut StoredSession> {
        self.sessions
            .iter_mut()
            .find(|s| s.runtime_id == runtime_id)
    }

    pub fn resumable_sessions_for_session(&self, session_id: &str) -> Vec<StoredSession> {
        self.sessions
            .iter()
            .filter(|s| {
                s.session_id == session_id
                    && amux::AgentStatus::try_from(s.status) != Ok(amux::AgentStatus::Stopped)
            })
            .cloned()
            .collect()
    }

    pub fn to_proto_agent_list(&self) -> Vec<amux::RuntimeInfo> {
        self.sessions.iter().map(Self::session_to_info).collect()
    }

    pub fn to_proto_agent_info(&self, runtime_id: &str) -> Option<amux::RuntimeInfo> {
        self.find_by_id(runtime_id).map(Self::session_to_info)
    }

    fn session_to_info(s: &StoredSession) -> amux::RuntimeInfo {
        amux::RuntimeInfo {
            runtime_id: s.runtime_id.clone(),
            agent_type: s.agent_type,
            worktree: s.worktree.clone(),
            branch: String::new(),
            status: s.status,
            started_at: s.created_at,
            current_prompt: s.last_prompt.clone(),
            workspace_id: s.workspace_id.clone(),
            session_title: String::new(),
            last_output_summary: s.last_output_summary.clone(),
            tool_use_count: s.tool_use_count,
            // Available models is a per-agent-type constant, not live state,
            // so populate it for historical sessions too — otherwise iOS
            // hides the model picker on resumed/non-running sessions.
            // Live agents still get merged in by `DaemonServer::merged_agent_list`
            // from `RuntimeManager::to_proto_agent_list`, which overrides
            // current_model from the running adapter.
            available_models: crate::runtime::models::available_models_for(
                amux::AgentType::try_from(s.agent_type).unwrap_or(amux::AgentType::ClaudeCode),
            ),
            current_model: String::new(),
            // Stored sessions represent runtimes the daemon will re-spawn.
            // ACTIVE is a steady-state assumption; Phase 1b will wire proper
            // state transitions (STARTING while spawn is in flight, FAILED
            // if spawn fails).
            state: amux::RuntimeLifecycle::Active as i32,
            stage: String::new(),
            error_code: String::new(),
            error_message: String::new(),
            failed_stage: String::new(),
            // Slash commands are reported by ACP at runtime — historical
            // sessions don't have any cached until the agent boots and
            // emits AvailableCommandsUpdate.
            available_commands: vec![],
        }
    }
}

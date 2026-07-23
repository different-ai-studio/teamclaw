//! In-memory `Backend` implementation for tests.
//!
//! Callers wired through `Arc<dyn Backend>` can be exercised against
//! `MockBackend` without going through HTTP. The backend's writes
//! accumulate on a shared `MockState`; queries return seeded responses
//! you stage on that same state before exercising the caller.
//!
//! Typical usage:
//!
//! ```ignore
//! let mock = MockBackend::with_identity("team-x", "actor-x");
//! let state = mock.state.clone();
//! let backend: Arc<dyn Backend> = Arc::new(mock);
//! // hand `backend` to the system under test
//! caller.do_work(backend).await?;
//! // inspect what the caller did
//! assert_eq!(state.lock().unwrap().heartbeats, 1);
//! ```

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;

use crate::backend::{
    AgentDefaults, AgentRuntimeRow, AgentRuntimeUpsert, Backend, BackendError, BackendResult,
    BackendSessionAndParticipants, ClaimResult, ManagedGitCredential, ManagedLlmConfig,
    ShareModeConfig, StoredMessage, WorkspaceRow, WorkspaceUpsert,
};

/// Owned snapshot of an `AgentRuntimeUpsert` so tests can assert without
/// worrying about the borrowed lifetimes on the trait input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedRuntimeUpsert {
    pub team_id: String,
    pub agent_id: String,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub backend_type: String,
    pub backend_session_id: Option<String>,
    pub runtime_id: Option<String>,
    pub status: String,
    pub current_model: Option<String>,
}

impl RecordedRuntimeUpsert {
    fn from_upsert(row: &AgentRuntimeUpsert<'_>) -> Self {
        Self {
            team_id: row.team_id.to_string(),
            agent_id: row.agent_id.to_string(),
            session_id: row.session_id.map(str::to_string),
            workspace_id: row.workspace_id.map(str::to_string),
            backend_type: row.backend_type.to_string(),
            backend_session_id: row.backend_session_id.map(str::to_string),
            runtime_id: row.runtime_id.map(str::to_string),
            status: row.status.to_string(),
            current_model: row.current_model.map(str::to_string),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedMessageInsert {
    pub id: String,
    pub team_id: String,
    pub session_id: String,
    pub sender_actor_id: String,
    pub kind: String,
    pub content: String,
    pub metadata_json: String,
    pub model: String,
    pub turn_id: String,
    pub reply_to_message_id: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedGatewayMessage {
    pub session_id: String,
    pub sender_actor_id: String,
    pub content: String,
    pub external_id: Option<String>,
    pub attachments: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedExternalActor {
    pub team_id: String,
    pub source: String,
    pub source_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedGatewayEnsure {
    pub team_id: String,
    pub binding: String,
    pub title: String,
    pub primary_agent_actor_id: String,
    pub owner_member_actor_ids: Vec<String>,
    pub participant_actor_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedAttachment {
    pub path: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedCronSession {
    pub team_id: String,
    pub primary_agent_actor_id: String,
    pub title: String,
    pub cron_job_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedWorkspaceUpsert {
    pub team_id: String,
    pub agent_id: String,
    pub name: String,
    pub path: Option<String>,
    pub archived: bool,
}

/// Shared, mutable state observed by `MockBackend` impls. Tests stage
/// responses on the read-side fields before calling, and inspect the
/// write-side fields after.
#[derive(Default, Debug)]
pub struct MockState {
    // ── Recorded writes ────────────────────────────────────────────────
    pub upserted_runtimes: Vec<RecordedRuntimeUpsert>,
    pub heartbeats: usize,
    pub upserted_workspaces: Vec<RecordedWorkspaceUpsert>,
    pub session_participants_upserted: Vec<(String, String)>,
    pub messages_inserted: Vec<RecordedMessageInsert>,
    pub gateway_messages_inserted: Vec<RecordedGatewayMessage>,
    pub external_actors_upserted: Vec<RecordedExternalActor>,
    pub runtime_cursors_updated: Vec<(String, String)>,
    pub attachments_uploaded: Vec<RecordedAttachment>,
    pub gateway_sessions_ensured: Vec<RecordedGatewayEnsure>,
    pub cron_sessions: Vec<RecordedCronSession>,

    // ── Pre-seeded responses for reads ─────────────────────────────────
    pub claim_result: Option<ClaimResult>,
    pub sessions: HashMap<String, BackendSessionAndParticipants>,
    pub messages_by_session: HashMap<String, Vec<StoredMessage>>,
    pub gateway_session_index: HashMap<String, (String, Option<String>)>,
    pub admin_member_actor_ids: HashMap<String, Vec<String>>,
    pub agent_permissions: HashMap<(String, String), Option<String>>,
    pub external_actor_results: HashMap<(String, String, String), String>,
    pub ensure_gateway_session_result: Option<(String, String, bool)>,
    pub workspace_results: HashMap<(String, String, String), WorkspaceRow>,
    /// Rows recorded by `upsert_workspace`, keyed by the returned canonical id
    /// — lets `get_workspaces_by_ids` resolve ids seeded via `upsert_workspace`
    /// without a separate seeding step.
    pub workspaces_by_id: HashMap<String, WorkspaceRow>,
    pub runtime_upsert_row_ids: HashMap<(String, Option<String>), String>,
    pub runtime_rows_by_session_runtime: HashMap<(String, String, String), AgentRuntimeRow>,
    pub latest_runtime_rows: HashMap<(String, String), AgentRuntimeRow>,
    pub ensured_agent_types: Vec<(Vec<String>, String)>,
    pub default_workspace_ids: Vec<String>,
    pub set_default_workspace_error: Option<String>,
    /// Per-team `team_share_config` overrides. Missing entries fall back to
    /// `ShareModeConfig::default()` (i.e. team-share disabled).
    pub team_share_configs: HashMap<String, ShareModeConfig>,
    /// Per-agent `get_agent_defaults` overrides. Missing entries fall back to
    /// `AgentDefaults::default()` (all `None`).
    pub agent_defaults: HashMap<String, AgentDefaults>,
    /// Per-team `managed_llm_config` overrides. Missing entries fall back to
    /// `ManagedLlmConfig::default()` (i.e. managed LLM disabled).
    pub managed_llm_configs: HashMap<String, ManagedLlmConfig>,
    /// Per-team `managed_git_credential` overrides. A missing entry errors,
    /// mirroring a cloud API that has no credential to hand out.
    pub managed_git_credentials: HashMap<String, ManagedGitCredential>,
}

#[derive(Clone, Debug)]
pub struct MockBackend {
    team_id: String,
    actor_id: String,
    auth_token: String,
    pub state: Arc<Mutex<MockState>>,
}

impl Default for MockBackend {
    fn default() -> Self {
        Self::with_identity("team-mock", "actor-mock")
    }
}

impl MockBackend {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_identity(team_id: impl Into<String>, actor_id: impl Into<String>) -> Self {
        Self {
            team_id: team_id.into(),
            actor_id: actor_id.into(),
            auth_token: "mock-token".into(),
            state: Arc::new(Mutex::new(MockState::default())),
        }
    }

    pub fn state(&self) -> MutexGuard<'_, MockState> {
        self.state.lock().unwrap()
    }
}

#[async_trait]
impl Backend for MockBackend {
    fn team_id(&self) -> &str {
        &self.team_id
    }

    fn actor_id(&self) -> &str {
        &self.actor_id
    }

    async fn auth_token(&self) -> BackendResult<String> {
        Ok(self.auth_token.clone())
    }

    async fn team_share_config(&self, team_id: &str) -> BackendResult<ShareModeConfig> {
        // No team-share configured by default; tests that need a populated
        // config can seed `state().team_share_configs`.
        Ok(self
            .state
            .lock()
            .unwrap()
            .team_share_configs
            .get(team_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn managed_llm_config(&self, team_id: &str) -> BackendResult<ManagedLlmConfig> {
        // Managed LLM disabled by default; tests that need a populated config
        // can seed `state().managed_llm_configs`.
        Ok(self
            .state
            .lock()
            .unwrap()
            .managed_llm_configs
            .get(team_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn managed_git_credential(&self, team_id: &str) -> BackendResult<ManagedGitCredential> {
        // Tests that need a credential seed `state().managed_git_credentials`.
        // An unseeded team errors rather than panicking, so an accidental
        // caller fails its own assertion instead of the test process.
        self.state
            .lock()
            .unwrap()
            .managed_git_credentials
            .get(team_id)
            .cloned()
            .ok_or_else(|| BackendError::Provider {
                provider: "mock",
                code: None,
                message: format!("no managed-git credential seeded for {team_id}"),
            })
    }

    async fn get_effective_default_agent(&self, _team_id: &str) -> BackendResult<Option<String>> {
        Ok(None)
    }

    async fn claim_team_invite(&self, _token: &str) -> BackendResult<ClaimResult> {
        self.state
            .lock()
            .unwrap()
            .claim_result
            .clone()
            .ok_or_else(|| BackendError::Validation("invite invalid or expired".into()))
    }

    async fn upsert_agent_runtime(
        &self,
        row: &AgentRuntimeUpsert<'_>,
    ) -> BackendResult<Option<String>> {
        let mut st = self.state.lock().unwrap();
        st.upserted_runtimes
            .push(RecordedRuntimeUpsert::from_upsert(row));
        let key = (
            row.agent_id.to_string(),
            row.backend_session_id.map(str::to_string),
        );
        Ok(st.runtime_upsert_row_ids.get(&key).cloned())
    }

    async fn fetch_agent_runtime_for_session(
        &self,
        session_id: &str,
        runtime_id: &str,
        backend_session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .runtime_rows_by_session_runtime
            .get(&(
                session_id.to_string(),
                runtime_id.to_string(),
                backend_session_id.to_string(),
            ))
            .cloned())
    }

    async fn fetch_latest_runtime_for_session(
        &self,
        agent_id: &str,
        session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .latest_runtime_rows
            .get(&(agent_id.to_string(), session_id.to_string()))
            .cloned())
    }

    async fn ensure_agent_types(
        &self,
        supported_types: &[String],
        default_agent_type: &str,
    ) -> BackendResult<()> {
        self.state
            .lock()
            .unwrap()
            .ensured_agent_types
            .push((supported_types.to_vec(), default_agent_type.to_string()));
        Ok(())
    }

    async fn check_agent_permission(
        &self,
        agent_id: &str,
        actor_id: &str,
    ) -> BackendResult<Option<String>> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .agent_permissions
            .get(&(agent_id.to_string(), actor_id.to_string()))
            .cloned()
            .unwrap_or(None))
    }

    async fn heartbeat(&self) -> BackendResult<()> {
        self.state.lock().unwrap().heartbeats += 1;
        Ok(())
    }

    async fn report_client_version(&self, _device_id: &str) -> BackendResult<()> {
        Ok(())
    }

    async fn set_agent_default_workspace(&self, workspace_id: &str) -> BackendResult<()> {
        let mut st = self.state.lock().unwrap();
        if let Some(message) = &st.set_default_workspace_error {
            return Err(BackendError::Provider {
                provider: "mock",
                code: None,
                message: message.clone(),
            });
        }
        st.default_workspace_ids.push(workspace_id.to_string());
        Ok(())
    }

    async fn upsert_workspace(&self, row: &WorkspaceUpsert<'_>) -> BackendResult<WorkspaceRow> {
        let mut st = self.state.lock().unwrap();
        st.upserted_workspaces.push(RecordedWorkspaceUpsert {
            team_id: row.team_id.to_string(),
            agent_id: row.agent_id.to_string(),
            name: row.name.to_string(),
            path: row.path.map(str::to_string),
            archived: row.archived,
        });
        let key = (
            row.team_id.to_string(),
            row.agent_id.to_string(),
            row.name.to_string(),
        );
        let result =
            st.workspace_results
                .get(&key)
                .cloned()
                .ok_or_else(|| BackendError::Provider {
                    provider: "mock",
                    code: None,
                    message: format!("MockBackend: no workspace_result seeded for {key:?}"),
                })?;
        st.workspaces_by_id
            .insert(result.id.clone(), result.clone());
        Ok(result)
    }

    async fn get_workspaces_by_ids(&self, ids: &[String]) -> BackendResult<Vec<WorkspaceRow>> {
        let st = self.state.lock().unwrap();
        Ok(ids
            .iter()
            .filter_map(|id| st.workspaces_by_id.get(id).cloned())
            .collect())
    }

    async fn get_workspaces_by_team(&self, team_id: &str) -> BackendResult<Vec<WorkspaceRow>> {
        let st = self.state.lock().unwrap();
        Ok(st
            .workspaces_by_id
            .values()
            .filter(|row| row.team_id == team_id)
            .cloned()
            .collect())
    }

    async fn get_agent_defaults(&self, agent_id: &str) -> BackendResult<AgentDefaults> {
        let st = self.state.lock().unwrap();
        Ok(st.agent_defaults.get(agent_id).cloned().unwrap_or_default())
    }

    async fn fetch_session_with_participants(
        &self,
        session_id: &str,
    ) -> BackendResult<BackendSessionAndParticipants> {
        self.state
            .lock()
            .unwrap()
            .sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| BackendError::Provider {
                provider: "mock",
                code: Some("404".into()),
                message: format!("MockBackend: session {session_id} not seeded"),
            })
    }

    async fn messages_after_cursor(
        &self,
        session_id: &str,
        after_id: Option<&str>,
    ) -> BackendResult<Vec<StoredMessage>> {
        let st = self.state.lock().unwrap();
        let mut msgs = st
            .messages_by_session
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        msgs.sort_by_key(|m| m.created_at);
        if let Some(after) = after_id {
            if let Some(pos) = msgs.iter().position(|m| m.id == after) {
                msgs.drain(0..=pos);
            }
        }
        Ok(msgs)
    }

    async fn update_runtime_cursor(
        &self,
        runtime_row_id: &str,
        last_processed_message_id: &str,
    ) -> BackendResult<()> {
        self.state.lock().unwrap().runtime_cursors_updated.push((
            runtime_row_id.to_string(),
            last_processed_message_id.to_string(),
        ));
        Ok(())
    }

    async fn rpc_upsert_external_actor(
        &self,
        team_id: &str,
        source: &str,
        source_id: &str,
        display_name: &str,
    ) -> BackendResult<String> {
        let mut st = self.state.lock().unwrap();
        st.external_actors_upserted.push(RecordedExternalActor {
            team_id: team_id.to_string(),
            source: source.to_string(),
            source_id: source_id.to_string(),
            display_name: display_name.to_string(),
        });
        let key = (
            team_id.to_string(),
            source.to_string(),
            source_id.to_string(),
        );
        Ok(st
            .external_actor_results
            .get(&key)
            .cloned()
            .unwrap_or_else(|| format!("external-{source}-{source_id}")))
    }

    async fn get_gateway_session_by_acp_id(
        &self,
        acp_session_id: &str,
    ) -> BackendResult<Option<(String, Option<String>)>> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .gateway_session_index
            .get(acp_session_id)
            .cloned())
    }

    async fn rpc_ensure_gateway_session(
        &self,
        team_id: &str,
        binding: &str,
        title: &str,
        primary_agent_actor_id: &str,
        owner_member_actor_ids: &[String],
        participant_actor_ids: &[String],
    ) -> BackendResult<(String, String, bool)> {
        let mut st = self.state.lock().unwrap();
        st.gateway_sessions_ensured.push(RecordedGatewayEnsure {
            team_id: team_id.to_string(),
            binding: binding.to_string(),
            title: title.to_string(),
            primary_agent_actor_id: primary_agent_actor_id.to_string(),
            owner_member_actor_ids: owner_member_actor_ids.to_vec(),
            participant_actor_ids: participant_actor_ids.to_vec(),
        });
        st.ensure_gateway_session_result
            .clone()
            .ok_or_else(|| BackendError::Provider {
                provider: "mock",
                code: None,
                message: "MockBackend: ensure_gateway_session_result not seeded".into(),
            })
    }

    async fn insert_gateway_message(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        self.insert_gateway_message_with_attachments(
            session_id,
            sender_actor_id,
            content,
            external_message_id,
            serde_json::Value::Array(vec![]),
        )
        .await
    }

    async fn insert_gateway_message_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: serde_json::Value,
    ) -> BackendResult<String> {
        let mut st = self.state.lock().unwrap();
        let id = format!("mock-msg-{}", st.gateway_messages_inserted.len() + 1);
        st.gateway_messages_inserted.push(RecordedGatewayMessage {
            session_id: session_id.to_string(),
            sender_actor_id: sender_actor_id.to_string(),
            content: content.to_string(),
            external_id: external_message_id.map(str::to_string),
            attachments,
        });
        Ok(id)
    }

    async fn upload_attachment_bytes(
        &self,
        path: &str,
        bytes: Vec<u8>,
        mime: &str,
    ) -> BackendResult<String> {
        self.state
            .lock()
            .unwrap()
            .attachments_uploaded
            .push(RecordedAttachment {
                path: path.to_string(),
                mime: mime.to_string(),
                bytes,
            });
        Ok(path.to_string())
    }

    async fn list_agent_admin_member_actor_ids(
        &self,
        agent_actor_id: &str,
    ) -> BackendResult<Vec<String>> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .admin_member_actor_ids
            .get(agent_actor_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn upsert_session_participant(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> BackendResult<()> {
        self.state
            .lock()
            .unwrap()
            .session_participants_upserted
            .push((session_id.to_string(), actor_id.to_string()));
        Ok(())
    }

    async fn create_cron_session(
        &self,
        team_id: &str,
        primary_agent_actor_id: &str,
        title: &str,
        cron_job_id: Option<&str>,
    ) -> BackendResult<String> {
        let mut st = self.state.lock().unwrap();
        let sid = format!("mock-cron-sess-{}", st.cron_sessions.len() + 1);
        st.cron_sessions.push(RecordedCronSession {
            team_id: team_id.to_string(),
            primary_agent_actor_id: primary_agent_actor_id.to_string(),
            title: title.to_string(),
            cron_job_id: cron_job_id.map(|s| s.to_string()),
        });
        st.session_participants_upserted
            .push((sid.clone(), primary_agent_actor_id.to_string()));
        let admins = st
            .admin_member_actor_ids
            .get(primary_agent_actor_id)
            .cloned()
            .unwrap_or_default();
        for actor in admins {
            st.session_participants_upserted.push((sid.clone(), actor));
        }
        Ok(sid)
    }

    async fn insert_message(
        &self,
        id: &str,
        team_id: &str,
        session_id: &str,
        sender_actor_id: &str,
        kind: &str,
        content: &str,
        metadata_json: &str,
        model: &str,
        turn_id: &str,
        reply_to_message_id: &str,
        sequence: u64,
    ) -> BackendResult<()> {
        self.state
            .lock()
            .unwrap()
            .messages_inserted
            .push(RecordedMessageInsert {
                id: id.to_string(),
                team_id: team_id.to_string(),
                session_id: session_id.to_string(),
                sender_actor_id: sender_actor_id.to_string(),
                kind: kind.to_string(),
                content: content.to_string(),
                metadata_json: metadata_json.to_string(),
                model: model.to_string(),
                turn_id: turn_id.to_string(),
                reply_to_message_id: reply_to_message_id.to_string(),
                sequence,
            });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_session_records_are_provider_neutral() {
        use crate::backend::{BackendParticipantRow, BackendSessionRow};

        let session = BackendSessionRow {
            id: "session-1".into(),
            team_id: "team-1".into(),
            created_by_actor_id: Some("member-1".into()),
            primary_agent_id: None,
            mode: "collab".into(),
            title: "Title".into(),
            summary: String::new(),
            idea_id: None,
            created_at: chrono::Utc::now(),
        };
        let participant = BackendParticipantRow {
            session_id: "session-1".into(),
            actor_id: "member-1".into(),
            role: Some("owner".into()),
            joined_at: chrono::Utc::now(),
        };

        assert_eq!(session.id, participant.session_id);
    }

    fn dyn_backend() -> (Arc<dyn Backend>, Arc<Mutex<MockState>>) {
        let mock = MockBackend::with_identity("team-x", "actor-x");
        let state = mock.state.clone();
        (Arc::new(mock) as Arc<dyn Backend>, state)
    }

    #[tokio::test]
    async fn identity_and_auth_token_exposed_through_dyn() {
        let (be, _) = dyn_backend();
        assert_eq!(be.team_id(), "team-x");
        assert_eq!(be.actor_id(), "actor-x");
        assert_eq!(be.auth_token().await.unwrap(), "mock-token");
        assert_eq!(be.cached_credential_expiry_epoch(), None);
    }

    #[tokio::test]
    async fn set_agent_default_workspace_records_workspace_id() {
        let (be, state) = dyn_backend();
        be.set_agent_default_workspace("ws-remote-42")
            .await
            .unwrap();
        assert_eq!(
            state.lock().unwrap().default_workspace_ids,
            vec!["ws-remote-42".to_string()]
        );
    }

    #[tokio::test]
    async fn set_agent_default_workspace_returns_configured_error() {
        let mock = MockBackend::with_identity("team-x", "actor-x");
        mock.state.lock().unwrap().set_default_workspace_error =
            Some("permission denied".to_string());
        let be: Arc<dyn Backend> = Arc::new(mock);
        let err = be
            .set_agent_default_workspace("ws-remote-42")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("permission denied"));
    }

    #[tokio::test]
    async fn get_workspaces_by_ids_returns_seeded_rows() {
        let (be, state) = dyn_backend();
        state.lock().unwrap().workspace_results.insert(
            (
                "team-x".to_string(),
                "actor-x".to_string(),
                "ws-a".to_string(),
            ),
            WorkspaceRow {
                id: "ws-remote-1".to_string(),
                team_id: "team-x".to_string(),
                path: Some("/tmp/ws-a".to_string()),
            },
        );
        be.upsert_workspace(&WorkspaceUpsert {
            team_id: "team-x",
            agent_id: "actor-x",
            name: "ws-a",
            path: Some("/tmp/ws-a"),
            archived: false,
            cloud_id: None,
        })
        .await
        .unwrap();

        let rows = be
            .get_workspaces_by_ids(&["ws-remote-1".to_string()])
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path.as_deref(), Some("/tmp/ws-a"));
        assert_eq!(rows[0].team_id, "team-x");
    }

    #[tokio::test]
    async fn get_workspaces_by_team_filters_to_the_requested_team() {
        let (be, state) = dyn_backend();
        {
            let mut st = state.lock().unwrap();
            st.workspaces_by_id.insert(
                "ws-1".to_string(),
                WorkspaceRow {
                    id: "ws-1".to_string(),
                    team_id: "team-a".to_string(),
                    path: Some("/tmp/a1".to_string()),
                },
            );
            st.workspaces_by_id.insert(
                "ws-2".to_string(),
                WorkspaceRow {
                    id: "ws-2".to_string(),
                    team_id: "team-a".to_string(),
                    path: Some("/tmp/a2".to_string()),
                },
            );
            st.workspaces_by_id.insert(
                "ws-3".to_string(),
                WorkspaceRow {
                    id: "ws-3".to_string(),
                    team_id: "team-b".to_string(),
                    path: Some("/tmp/b1".to_string()),
                },
            );
        }

        let mut rows = be.get_workspaces_by_team("team-a").await.unwrap();
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "ws-1");
        assert_eq!(rows[1].id, "ws-2");
        assert!(rows.iter().all(|r| r.team_id == "team-a"));

        let rows_b = be.get_workspaces_by_team("team-b").await.unwrap();
        assert_eq!(rows_b.len(), 1);
        assert_eq!(rows_b[0].id, "ws-3");

        let rows_none = be.get_workspaces_by_team("team-c").await.unwrap();
        assert!(rows_none.is_empty());
    }

    #[tokio::test]
    async fn heartbeat_increments_shared_state() {
        let (be, state) = dyn_backend();
        be.heartbeat().await.unwrap();
        be.heartbeat().await.unwrap();
        be.heartbeat().await.unwrap();
        assert_eq!(state.lock().unwrap().heartbeats, 3);
    }

    #[tokio::test]
    async fn insert_message_records_each_call_with_metadata() {
        let (be, state) = dyn_backend();
        be.insert_message(
            "msg-1", "team-x", "sess-1", "actor-y", "text", "hi", "{}", "model-z", "turn-1",
            "user-1", 42,
        )
        .await
        .unwrap();
        be.insert_message(
            "msg-2", "team-x", "sess-1", "actor-y", "text", "again", "{}", "", "", "", 43,
        )
        .await
        .unwrap();
        let snap = state.lock().unwrap();
        assert_eq!(snap.messages_inserted.len(), 2);
        assert_eq!(snap.messages_inserted[0].id, "msg-1");
        assert_eq!(snap.messages_inserted[0].content, "hi");
        assert_eq!(snap.messages_inserted[0].model, "model-z");
        assert_eq!(snap.messages_inserted[0].reply_to_message_id, "user-1");
        assert_eq!(snap.messages_inserted[0].sequence, 42);
        assert_eq!(snap.messages_inserted[1].id, "msg-2");
        assert_eq!(snap.messages_inserted[1].content, "again");
        assert!(snap.messages_inserted[1].model.is_empty());
        assert!(snap.messages_inserted[1].reply_to_message_id.is_empty());
    }

    #[tokio::test]
    async fn upsert_agent_runtime_records_input_and_returns_seeded_row_id() {
        let (be, state) = dyn_backend();
        state.lock().unwrap().runtime_upsert_row_ids.insert(
            ("agent-a".to_string(), Some("acp-sid".to_string())),
            "runtime-row-uuid".to_string(),
        );

        let row = AgentRuntimeUpsert {
            team_id: "t",
            agent_id: "agent-a",
            session_id: None,
            workspace_id: None,
            backend_type: "claude",
            backend_session_id: Some("acp-sid"),
            runtime_id: Some("rt-1"),
            status: "starting",
            current_model: None,
            last_seen_at: chrono::Utc::now(),
        };
        let id = be.upsert_agent_runtime(&row).await.unwrap();
        assert_eq!(id.as_deref(), Some("runtime-row-uuid"));

        let snap = state.lock().unwrap();
        assert_eq!(snap.upserted_runtimes.len(), 1);
        assert_eq!(snap.upserted_runtimes[0].agent_id, "agent-a");
        assert_eq!(snap.upserted_runtimes[0].status, "starting");
        assert_eq!(
            snap.upserted_runtimes[0].backend_session_id.as_deref(),
            Some("acp-sid")
        );
    }

    #[tokio::test]
    async fn create_cron_session_seeds_primary_agent_and_admin_participants() {
        let (be, state) = dyn_backend();
        state
            .lock()
            .unwrap()
            .admin_member_actor_ids
            .insert("agent-1".into(), vec!["admin-1".into(), "admin-2".into()]);

        let sid = be
            .create_cron_session("team-x", "agent-1", "Cron job", Some("job-x"))
            .await
            .unwrap();
        assert!(sid.starts_with("mock-cron-sess-"));

        let snap = state.lock().unwrap();
        assert_eq!(snap.cron_sessions.len(), 1);
        // Primary agent + 2 admins → 3 participant upserts.
        assert_eq!(snap.session_participants_upserted.len(), 3);
        assert_eq!(snap.session_participants_upserted[0].1, "agent-1");
        assert_eq!(snap.session_participants_upserted[1].1, "admin-1");
        assert_eq!(snap.session_participants_upserted[2].1, "admin-2");
    }

    #[tokio::test]
    async fn messages_after_cursor_drains_seed_and_earlier_from_seeded_state() {
        let (be, state) = dyn_backend();
        state.lock().unwrap().messages_by_session.insert(
            "sess-1".into(),
            vec![
                StoredMessage {
                    id: "m-1".into(),
                    session_id: "sess-1".into(),
                    sender_actor_id: "a-1".into(),
                    kind: "text".into(),
                    content: "first".into(),
                    metadata_json: "{}".into(),
                    created_at: 100,
                },
                StoredMessage {
                    id: "m-2".into(),
                    session_id: "sess-1".into(),
                    sender_actor_id: "a-1".into(),
                    kind: "text".into(),
                    content: "second".into(),
                    metadata_json: "{}".into(),
                    created_at: 200,
                },
            ],
        );

        let after = be
            .messages_after_cursor("sess-1", Some("m-1"))
            .await
            .unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, "m-2");
    }

    #[tokio::test]
    async fn upsert_session_participant_appends_recorded_pair() {
        let (be, state) = dyn_backend();
        be.upsert_session_participant("sess-1", "actor-1")
            .await
            .unwrap();
        be.upsert_session_participant("sess-1", "actor-2")
            .await
            .unwrap();
        let snap = state.lock().unwrap();
        assert_eq!(
            snap.session_participants_upserted,
            vec![
                ("sess-1".to_string(), "actor-1".to_string()),
                ("sess-1".to_string(), "actor-2".to_string()),
            ]
        );
    }
}

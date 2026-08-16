//! Single implementation for resuming collab runtimes from `sessions.toml` /
//! Cloud `backend_session_id`. `runtimeStart` and MQTT `session/live` are thin
//! wrappers that differ only in how they select stored rows.

use tracing::{info, warn};

use crate::proto::amux;

use crate::daemon::session_resume::{
    dedup_resumable_runtimes, resolve_backend_session_id, stored_sessions_for_collab_resume,
    CollabResumeFilter,
};

use super::{DaemonServer, StartRuntimeOutcome};

/// Outcome of [`DaemonServer::resume_stored_collab_runtimes`].
pub(super) struct ResumeStoredResult {
    /// Runtimes that were cold-started via `resume_agent` in this call.
    pub resumed_runtime_ids: Vec<String>,
    /// First deduped row that was already live in memory (no resume attempted).
    pub already_live_first: Option<String>,
}

impl DaemonServer {
    /// Resume zero or more stored rows for one cloud session.
    ///
    /// - `MatchAgentWorkspace`: `runtimeStart` — only rows for the requested agent/workspace.
    /// - `SessionOnly`: MQTT lazy path — all resumable rows, then global dedup to one.
    pub(super) async fn resume_stored_collab_runtimes(
        &mut self,
        cloud_session_id: &str,
        filter: CollabResumeFilter<'_>,
        initial_prompt: &str,
        initial_model_override: Option<&str>,
        log_label: &'static str,
        mcp_config_path: Option<std::path::PathBuf>,
        bind_member_actor_id: Option<&str>,
    ) -> ResumeStoredResult {
        let mut out = ResumeStoredResult {
            resumed_runtime_ids: Vec::new(),
            already_live_first: None,
        };

        if cloud_session_id.is_empty() {
            return out;
        }

        let stored_sessions =
            stored_sessions_for_collab_resume(&self.sessions, cloud_session_id, filter);
        if stored_sessions.is_empty() {
            return out;
        }

        let (keep, superseded) = dedup_resumable_runtimes(stored_sessions);
        if !superseded.is_empty() {
            self.mark_superseded_runtime_rows_stopped(&superseded);
            info!(
                session_id = %cloud_session_id,
                superseded = ?superseded,
                log_label,
                "resume_stored_collab_runtimes: marked superseded duplicate runtimes Stopped"
            );
        }

        for stored in keep {
            if self
                .agents
                .lock()
                .await
                .get_handle(&stored.runtime_id)
                .is_some()
            {
                if out.already_live_first.is_none() {
                    out.already_live_first = Some(stored.runtime_id.clone());
                }
                continue;
            }

            let at =
                amux::AgentType::try_from(stored.agent_type).unwrap_or(amux::AgentType::ClaudeCode);
            let remote_workspace_id =
                (!stored.workspace_id.is_empty()).then_some(stored.workspace_id.clone());

            let acp_resume = resolve_backend_session_id(
                &self.sessions,
                cloud_session_id,
                at,
                &stored.workspace_id,
            )
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| stored.acp_session_id.clone());
            if acp_resume.is_empty() {
                continue;
            }

            info!(
                runtime_id = %stored.runtime_id,
                session_id = %cloud_session_id,
                backend_session_id = %acp_resume,
                log_label,
                "resume_stored_collab_runtimes: resuming stored runtime with prior ACP session"
            );

            let context = match self
                .assemble_stored_execution_context(&stored.worktree, &stored.workspace_id)
                .await
            {
                Ok(context) => context,
                Err(e) => {
                    warn!(
                        runtime_id = %stored.runtime_id,
                        worktree = %stored.worktree,
                        error = %e,
                        log_label,
                        "resume_stored_collab_runtimes: assemble execution context failed"
                    );
                    continue;
                }
            };

            let resume_res = self
                .agents
                .lock()
                .await
                .resume_agent(
                    cloud_session_id,
                    &acp_resume,
                    at,
                    &stored.workspace_id,
                    remote_workspace_id.as_deref(),
                    initial_prompt,
                    mcp_config_path.clone(),
                    context,
                )
                .await;

            let new_acp_sid = match resume_res {
                Ok(sid) => sid,
                Err(e) => {
                    warn!(
                        runtime_id = %stored.runtime_id,
                        session_id = %cloud_session_id,
                        log_label,
                        "resume_stored_collab_runtimes: resume_agent failed: {}",
                        e
                    );
                    continue;
                }
            };

            self.finalize_stored_runtime_resume(
                &stored.runtime_id,
                cloud_session_id,
                &new_acp_sid,
                initial_model_override,
            )
            .await;
            if let Some(member) = bind_member_actor_id.filter(|s| !s.is_empty()) {
                let team_id = self.config.team_id.clone().unwrap_or_default();
                self.ensure_live_runtime_remote_tools(
                    &stored.runtime_id,
                    cloud_session_id,
                    member,
                    &team_id,
                )
                .await;
            }
            out.resumed_runtime_ids.push(stored.runtime_id);
        }

        if let Some(member) = bind_member_actor_id.filter(|s| !s.is_empty()) {
            if let Some(runtime_id) = &out.already_live_first {
                let team_id = self.config.team_id.clone().unwrap_or_default();
                self.ensure_live_runtime_remote_tools(
                    runtime_id,
                    cloud_session_id,
                    member,
                    &team_id,
                )
                .await;
            }
        }

        out
    }

    /// `runtimeStart` after daemon restart: reuse stored runtime_id + ACP session.
    pub(super) async fn try_resume_runtime_for_start(
        &mut self,
        cloud_session_id: &str,
        agent_type: amux::AgentType,
        workspace_id: &str,
        initial_prompt: &str,
        initial_model_override: Option<&str>,
        requester_actor_id: &str,
    ) -> Option<StartRuntimeOutcome> {
        if cloud_session_id.is_empty() || workspace_id.is_empty() {
            return None;
        }

        let team_id = self.config.team_id.clone().unwrap_or_default();
        let bind_member = (!requester_actor_id.is_empty()).then_some(requester_actor_id);

        let result = self
            .resume_stored_collab_runtimes(
                cloud_session_id,
                CollabResumeFilter::MatchAgentWorkspace {
                    agent_type,
                    workspace_id,
                },
                initial_prompt,
                initial_model_override,
                "runtime_start",
                None,
                bind_member,
            )
            .await;

        let runtime_id = result
            .already_live_first
            .or_else(|| result.resumed_runtime_ids.into_iter().next())?;

        if !requester_actor_id.is_empty() {
            self.ensure_live_runtime_remote_tools(
                &runtime_id,
                cloud_session_id,
                requester_actor_id,
                &team_id,
            )
            .await;
        }

        Some(StartRuntimeOutcome {
            runtime_id,
            session_id: cloud_session_id.to_string(),
        })
    }

    /// MQTT `session/live`: no in-memory runtime — resume from disk if possible.
    pub(super) async fn resume_historical_runtimes_for_session(
        &mut self,
        session_id: &str,
        requester_actor_id: Option<&str>,
    ) -> bool {
        let result = self
            .resume_stored_collab_runtimes(
                session_id,
                CollabResumeFilter::SessionOnly,
                "",
                None,
                "session_live",
                None,
                requester_actor_id,
            )
            .await;

        !result.resumed_runtime_ids.is_empty() || result.already_live_first.is_some()
    }

    pub(super) async fn finalize_stored_runtime_resume(
        &mut self,
        runtime_id: &str,
        cloud_session_id: &str,
        new_acp_sid: &str,
        initial_model_override: Option<&str>,
    ) {
        // The catch-up cursor lives on the participant row now, addressed by
        // (session, actor) — a resumed attachment has no runtime row to look up.
        match self
            .backend
            .fetch_session_cursor(cloud_session_id, self.backend.actor_id())
            .await
        {
            Ok(cursor) => {
                self.agents
                    .lock()
                    .await
                    .set_session_cursor(runtime_id, cursor);
            }
            Err(e) => {
                warn!(
                    runtime_id,
                    session_id = %cloud_session_id,
                    "fetch_session_cursor failed after resume: {}",
                    e
                );
            }
        }

        if let Some(s) = self.sessions.find_by_id_mut(runtime_id) {
            s.acp_session_id = new_acp_sid.to_string();
            s.status = amux::AgentStatus::Active as i32;
        }
        let _ = self.sessions.save(&self.sessions_path);

        if let Some(model_id) = initial_model_override.filter(|m| !m.is_empty()) {
            let mut agents = self.agents.lock().await;
            if let Err(e) = agents.send_set_model(runtime_id, model_id).await {
                warn!(
                    runtime_id,
                    model_id, "set_model after stored resume failed: {}", e
                );
            } else {
                agents.set_current_model(runtime_id, model_id);
            }
        }

        self.publish_runtime_state_by_id(runtime_id).await;
        self.catchup_runtime(runtime_id).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::backend::mock::MockBackend;
    use crate::backend::{Backend, WorkspaceRow};
    use crate::daemon::server::tests::{make_stored_session, test_server_with_cloud_api};
    use crate::proto::amux;
    use crate::runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};

    #[tokio::test]
    async fn collab_runtime_ensure_resume_propagates_workspace_attach_context() {
        let workspace = tempfile::tempdir().unwrap();
        let mock = MockBackend::with_identity("team-test", "agent-actor");
        mock.state().workspaces_by_id.insert(
            "ws-a".into(),
            WorkspaceRow {
                id: "ws-a".into(),
                team_id: "team-test".into(),
                path: Some(workspace.path().to_string_lossy().into_owned()),
                archived: false,
                agent_id: None,
            },
        );
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let mut fixture = test_server_with_cloud_api(backend);
        let captures = {
            let mut manager = fixture.server.agents.lock().await;
            crate::runtime::test_support::install_capturing_backend(&mut manager)
        };
        let mut stored = make_stored_session(
            "runtime-a",
            "session-a",
            amux::AgentType::Opencode,
            "ws-a",
            1,
        );
        stored.worktree = workspace.path().to_string_lossy().into_owned();
        fixture.server.sessions.upsert(stored);

        assert!(
            fixture
                .server
                .resume_historical_runtimes_for_session("session-a", None)
                .await
        );

        let captures = captures.lock().unwrap();
        assert_eq!(captures.len(), 1);
        assert_eq!(
            captures[0].domain,
            IsolationDomainKey::Workspace("ws-a".into())
        );
        assert_eq!(captures[0].working_directory, workspace.path());
        assert_eq!(
            captures[0].process_env_revision,
            ProcessEnvRevision::from_bindings(&captures[0].extra_env)
        );
    }

    #[tokio::test]
    async fn stored_workspace_scoped_gateway_resume_lookup_failure_does_not_attach_bare_env() {
        let workspace = tempfile::tempdir().unwrap();
        let backend: Arc<dyn Backend> =
            Arc::new(MockBackend::with_identity("team-test", "agent-actor"));
        let mut fixture = test_server_with_cloud_api(backend);
        let captures = {
            let mut manager = fixture.server.agents.lock().await;
            crate::runtime::test_support::install_capturing_backend(&mut manager)
        };
        let mut stored = make_stored_session(
            "runtime-gateway",
            "session-gateway",
            amux::AgentType::Opencode,
            "gateway:wecom://bot/chat",
            1,
        );
        stored.worktree = workspace.path().to_string_lossy().into_owned();
        fixture.server.sessions.upsert(stored);

        assert!(
            !fixture
                .server
                .resume_historical_runtimes_for_session("session-gateway", None)
                .await,
            "workspace-scoped stored gateway must fail closed when identity lookup fails"
        );
        assert!(
            captures.lock().unwrap().is_empty(),
            "failed workspace lookup must not attach with UnscopedAgent and bare env"
        );
    }
}

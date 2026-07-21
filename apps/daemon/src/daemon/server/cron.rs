//! Cron-style prompt-await handling, extracted from `server.rs`.
//!
//! A "cron turn" is one ACP turn driven to completion for a logical
//! `session_key` (e.g. `"cron/<job_id>/<run_id>"`). The first turn for a key
//! creates a real cloud `sessions` row + spawns the ACP runtime; subsequent
//! turns reuse the cached `(cloud_session_id, acp_session_id)` pair.
//!
//! This is a child module of `daemon::server`, so the `impl DaemonServer`
//! block below can reach the server's private fields directly.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;
use tracing::{info, warn};

use crate::daemon::prompt_await::parse_prompt_await_payload;
use crate::daemon::runtime_resolution::{agent_type_from_name, resolve_requested_agent_type};
use crate::runtime::RuntimeManager;

use super::DaemonServer;

/// Result of a background cron turn, sent from the spawned turn task back to the
/// active run loop for AgentReply persistence + sock reply. `reply_tx` rides
/// along because the reply is written by the loop (which owns `&self.teamclaw`,
/// a non-`Send` field the persist step needs), not by the task.
pub(crate) struct CronTurnDone {
    pub(crate) turn_result: anyhow::Result<crate::runtime::turn_aggregator::EmittedMessage>,
    /// acp_session_id of the agent that ran the turn (for reply metadata lookup).
    pub(crate) acp_sid: String,
    /// Cloud `sessions.id` the reply is persisted against and returned to the client.
    pub(crate) remote_session_id: String,
    pub(crate) reply_tx: oneshot::Sender<String>,
}

/// Caches the `(cloud_session_id, acp_session_id)` pair for each cron logical
/// `session_key`.
///
/// `cloud_session_id` is what we return to the client and stamp into cron run
/// records; `acp_session_id` is what `RuntimeManager` needs to drive the turn.
/// Previously both were packed into a single `"<sb>|<acp>"` string inside a raw
/// `HashMap<String, String>`; storing the pair directly removes that fragile
/// encoding (and the "malformed entry" error path that came with it).
#[derive(Debug, Default)]
pub(crate) struct CronSessionCache {
    inner: HashMap<String, (String, String)>,
    /// Cloud `sessions.id` created eagerly by `cron-prepare-session`, before the
    /// (slow) ACP runtime spawn. Keyed by `session_key`. `handle_prompt_await`
    /// consumes this so it reuses the already-created cloud session instead of
    /// creating a second one. Lets the desktop stamp `session_id` into the run
    /// record — and navigate — seconds after "Run Now", without waiting for the
    /// runtime to cold-start.
    prepared: HashMap<String, String>,
}

impl CronSessionCache {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Returns the cached `(cloud_session_id, acp_session_id)` for `key`.
    pub(crate) fn get_pair(&self, key: &str) -> Option<(String, String)> {
        self.inner.get(key).cloned()
    }

    /// Caches the `(cloud_session_id, acp_session_id)` pair for `key`.
    pub(crate) fn insert_pair(
        &mut self,
        key: impl Into<String>,
        cloud_session_id: impl Into<String>,
        acp_session_id: impl Into<String>,
    ) {
        self.inner
            .insert(key.into(), (cloud_session_id.into(), acp_session_id.into()));
    }

    /// Records a pre-created cloud session id for `key` (see `prepared`).
    pub(crate) fn insert_prepared(
        &mut self,
        key: impl Into<String>,
        cloud_session_id: impl Into<String>,
    ) {
        self.prepared.insert(key.into(), cloud_session_id.into());
    }

    /// Returns the pre-created cloud session id for `key` without consuming it.
    pub(crate) fn get_prepared(&self, key: &str) -> Option<String> {
        self.prepared.get(key).cloned()
    }

    /// Removes and returns the pre-created cloud session id for `key`.
    pub(crate) fn take_prepared(&mut self, key: &str) -> Option<String> {
        self.prepared.remove(key)
    }
}

impl DaemonServer {
    /// Drive one ACP turn to completion for a cron-style session_key.
    ///
    /// On first hit for a session_key the daemon creates a real cloud
    /// `sessions` row (so AgentReply messages land somewhere the desktop UI's
    /// "view session" button can resolve), adds the daemon's primary agent +
    /// admin members as `session_participants`, then spawns the ACP runtime
    /// bound to that cloud session id. `cron_sessions` caches a
    /// `(remote_session_id, acp_session_id)` pair so subsequent turns reuse
    /// the same chat thread AND reach the same agent process.
    ///
    /// Returns `{text, session_id}` where `session_id` is the cloud session UUID —
    /// the client (cron scheduler) stores it in `CronRunRecord.session_id` so
    /// the desktop UI's "view session" button resolves to a real chat session.
    /// Set up a cron turn: resolve workspace/team, create-or-reuse the cloud
    /// session + spawn the ACP runtime, and persist the user prompt. Returns
    /// `(acp_session_id, cloud_session_id, prompt, timeout)` for the caller to
    /// drive. Split out of `handle_prompt_await` so the (fast, `&mut self`) setup
    /// runs on the main loop while the (slow) turn runs on a background task.
    async fn prepare_cron_turn(
        &mut self,
        payload: &serde_json::Value,
    ) -> anyhow::Result<(String, String, String, Duration)> {
        let parsed = parse_prompt_await_payload(payload)?;

        let working_directory = match parsed.working_directory.filter(|s| !s.is_empty()) {
            Some(dir) => dir.to_string(),
            None => self.resolve_cron_default_workspace().await.ok_or_else(|| {
                anyhow::anyhow!(
                    "no working directory: configure a default workspace in Daemon > Workspace settings"
                )
            })?,
        };

        // The daemon must have been onboarded (team_id present) before any
        // cron prompt can be honored — the gateway-session model expects a
        // team. Surface a clean error rather than panicking inside the
        // RuntimeManager call.
        let team_id = self
            .config
            .team_id
            .clone()
            .ok_or_else(|| anyhow::anyhow!("daemon has no team_id; run `amuxd init` first"))?;

        // Look up or create the per-session_key binding (cloud + acp session
        // ids). With the current "per-run new session" cron semantics every
        // call hits the create branch, but the lookup-first shape stays so
        // future code can adopt session reuse without changing the handler.
        let (remote_session_id, acp_sid): (String, String) =
            if let Some(pair) = self.cron_sessions.get_pair(parsed.session_key) {
                pair
            } else {
                // Confirm we have a local primary agent runtime.
                let runtime_count = self.agents.lock().await.agent_count();
                if runtime_count == 0 {
                    anyhow::bail!("no local agent runtime");
                }

                // Reuse the cloud session `cron-prepare-session` already created
                // for this run (the common path when Run Now goes through the
                // scheduler); otherwise create it now (e.g. scheduled runs).
                let sb_sid = match self.cron_sessions.take_prepared(parsed.session_key) {
                    Some(prepared) => prepared,
                    None => {
                        self.create_cron_cloud_session(&team_id, parsed.job_name)
                            .await?
                    }
                };

                // Resolve the job's pinned backend (if any) against the
                // daemon's configured agents. `None` (no agent_type on the
                // wire) keeps the "auto" behavior: RuntimeManager falls back to
                // default_agent_type. An explicit-but-unconfigured backend is
                // rerouted by resolve_requested_agent_type rather than failing.
                let agent_type_override = parsed
                    .agent_type
                    .and_then(agent_type_from_name)
                    .map(|requested| resolve_requested_agent_type(&self.config, requested));

                let mut mgr = self.agents.lock().await;
                let acp_sid = mgr
                    .create_gateway_session_with_model(
                        &team_id,
                        parsed.session_key,                        // logical id
                        &format!("cron://{}", parsed.session_key), // binding
                        "cron",                                    // title (display only)
                        parsed.model_override.clone(),
                        Some(&sb_sid), // bind AgentReply to the cloud session
                        Some(working_directory.as_str()),
                        agent_type_override,
                    )
                    .await
                    .map_err(|e| anyhow::anyhow!("spawn failed: {e}"))?;
                drop(mgr);

                tracing::debug!(
                    session_key = %parsed.session_key,
                    remote_session_id = %sb_sid,
                    acp_session_id = %acp_sid,
                    "cron: created cloud session + spawned ACP runtime"
                );

                self.cron_sessions
                    .insert_pair(parsed.session_key, &sb_sid, &acp_sid);
                (sb_sid, acp_sid)
            };

        // Cron drives the ACP turn directly (bypassing session/live routing),
        // so the job prompt never lands in Cloud the way a desktop-typed
        // message would. Persist it before the turn so "view session" shows
        // both sides of the exchange.
        self.persist_cron_user_prompt(&team_id, &remote_session_id, parsed.message)
            .await;

        Ok((
            acp_sid,
            remote_session_id,
            parsed.message.to_string(),
            Duration::from_secs(parsed.timeout_secs),
        ))
    }

    /// Handle a `prompt-await` sock command. Runs the (fast) setup inline, then
    /// spawns the (slow) ACP turn onto a background task so the main run loop is
    /// free to service other sock commands meanwhile. The task hands its result
    /// back via `cron_turn_done_tx`; `finalize_cron_turn` (on the loop) persists
    /// the reply and answers `reply_tx`. Owns `reply_tx` so setup failures still
    /// get an `{ ok: false, error }` reply instead of a dropped connection.
    pub(super) async fn handle_prompt_await(
        &mut self,
        payload: &serde_json::Value,
        reply_tx: oneshot::Sender<String>,
    ) {
        let (acp_sid, remote_session_id, message, timeout) =
            match self.prepare_cron_turn(payload).await {
                Ok(v) => v,
                Err(e) => {
                    let _ = reply_tx.send(
                        serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
                    );
                    return;
                }
            };

        // Drive the turn off the run loop. `drive_cron_turn` uses the checkout
        // pattern (manager mutex free while awaiting the model), so concurrent
        // cron turns still progress; spawning it additionally frees the run loop
        // itself for the whole turn duration.
        let agents = self.agents.clone();
        let done_tx = self.cron_turn_done_tx.clone();
        tokio::spawn(async move {
            let turn_result = Self::drive_cron_turn(&agents, &acp_sid, &message, timeout).await;
            let _ = done_tx
                .send(CronTurnDone {
                    turn_result,
                    acp_sid,
                    remote_session_id,
                    reply_tx,
                })
                .await;
        });
    }

    /// Persist a finished cron turn's AgentReply and answer the sock client.
    /// Runs on the active run loop (not the turn task) because persistence needs
    /// `&self.teamclaw`, which is not `Send`. Always returns the cloud
    /// `session_id` so the desktop stamps it into the run record even when the
    /// turn failed (ACP timeout, etc.); the reply is wrapped `{ ok: true, result }`
    /// to match the pre-refactor sock contract (`agent_error` still rides inside
    /// `result`, so setup-only failures remain the sole `ok: false` case).
    pub(super) async fn finalize_cron_turn(&self, done: CronTurnDone) {
        let CronTurnDone {
            turn_result,
            acp_sid,
            remote_session_id,
            reply_tx,
        } = done;

        let result = match turn_result {
            Ok(reply) => {
                // `send_prompt_and_await_reply` drains the ACP channel directly,
                // bypassing `forward_agent_event`, so we must persist the finalized
                // AgentReply here — same path as collab chat (TOML + live + cloud).
                if !reply.content.is_empty() {
                    if let Some(tc) = self.teamclaw.as_ref() {
                        let actor_id = self.actor_id.clone();
                        let (model, seq, reply_to) = {
                            let mut mgr = self.agents.lock().await;
                            let agent_id =
                                mgr.agent_id_by_acp_session(&acp_sid).unwrap_or_default();
                            let model = mgr.current_model(&agent_id).cloned().unwrap_or_default();
                            let seq = mgr
                                .get_handle_mut(&agent_id)
                                .map(|h| h.next_sequence())
                                .unwrap_or(0);
                            let reply_to = mgr
                                .get_handle(&agent_id)
                                .and_then(|h| h.pending_reply_to_message_id.clone())
                                .unwrap_or_default();
                            (model, seq, reply_to)
                        };
                        tc.emit_agent_message(
                            &remote_session_id,
                            &actor_id,
                            crate::proto::teamclaw::MessageKind::AgentReply,
                            &reply.content,
                            &reply.metadata_json,
                            &model,
                            &reply.turn_id,
                            &reply_to,
                            seq,
                            true,
                            Some(&self.backend),
                        )
                        .await;
                        info!(
                            session_id = %remote_session_id,
                            turn_id = %reply.turn_id,
                            bytes = reply.content.len(),
                            "cron: persisted AgentReply to session/live and cloud"
                        );
                    } else {
                        warn!(
                            session_id = %remote_session_id,
                            "cron: teamclaw SessionManager unavailable; AgentReply not persisted"
                        );
                    }
                }
                serde_json::json!({
                    "ok": true,
                    "result": { "text": reply.content, "session_id": remote_session_id },
                })
            }
            Err(e) => serde_json::json!({
                "ok": true,
                "result": { "session_id": remote_session_id, "agent_error": e.to_string() },
            }),
        };

        let _ = reply_tx.send(result.to_string());
    }

    /// Cron cloud session title, matching what the desktop expects: `Cron: <job
    /// name, first 60 chars>`, falling back to `Cron job`.
    fn cron_session_title(job_name: Option<&str>) -> String {
        match job_name {
            Some(n) if !n.is_empty() => {
                format!("Cron: {}", n.chars().take(60).collect::<String>())
            }
            _ => "Cron job".to_string(),
        }
    }

    /// Create the cloud `sessions` row for a cron run (seeding the primary agent
    /// + human admins as participants so the desktop can see/open it). Returns
    /// the cloud session id. Shared by `cron-prepare-session` and the
    /// prompt-await create path.
    async fn create_cron_cloud_session(
        &self,
        team_id: &str,
        job_name: Option<&str>,
    ) -> anyhow::Result<String> {
        let primary_agent_actor_id = self.actor_id.clone();
        let title = Self::cron_session_title(job_name);
        self.backend
            .create_cron_session(team_id, &primary_agent_actor_id, &title)
            .await
            .map_err(|e| anyhow::anyhow!("create_cron_session: {e}"))
    }

    /// Eagerly create the cloud session for a cron run and cache it, returning
    /// `{ "session_id": "<uuid>" }`. Fast (no ACP runtime spawn), so the desktop
    /// scheduler can stamp `session_id` into the run record — and the UI can
    /// navigate to the session — within a second or two of "Run Now", long
    /// before the (cold-starting) runtime finishes the turn. The subsequent
    /// `prompt-await` reuses this cached session instead of creating a new one.
    pub(super) async fn handle_cron_prepare_session(
        &mut self,
        payload: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        let session_key = payload
            .get("session_key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("cron-prepare-session: missing 'session_key'"))?;
        if !session_key.starts_with("cron/") {
            anyhow::bail!("cron-prepare-session: session_key must start with 'cron/'");
        }
        let job_name = payload
            .get("job_name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());

        // Idempotent: if this run's session already exists (prepared or fully
        // paired), return it rather than creating a duplicate.
        if let Some((sb, _)) = self.cron_sessions.get_pair(session_key) {
            return Ok(serde_json::json!({ "session_id": sb }));
        }
        if let Some(sb) = self.cron_sessions.get_prepared(session_key) {
            return Ok(serde_json::json!({ "session_id": sb }));
        }

        let team_id = self
            .config
            .team_id
            .clone()
            .ok_or_else(|| anyhow::anyhow!("daemon has no team_id; run `amuxd init` first"))?;

        let sb_sid = self.create_cron_cloud_session(&team_id, job_name).await?;
        self.cron_sessions.insert_prepared(session_key, &sb_sid);
        info!(
            session_key = %session_key,
            session_id = %sb_sid,
            "cron: prepared cloud session (eager)"
        );
        Ok(serde_json::json!({ "session_id": sb_sid }))
    }

    /// Persist the cron job prompt as a `text` message on the cloud session.
    ///
    /// Skips session/live publish so the daemon does not re-route the prompt
    /// back into the ACP runtime (cron already calls `send_prompt_raw`).
    pub(crate) async fn persist_cron_user_prompt(
        &self,
        team_id: &str,
        session_id: &str,
        prompt: &str,
    ) {
        let Some(tc) = self.teamclaw.as_ref() else {
            warn!(
                session_id,
                "cron: SessionManager unavailable; user prompt not persisted"
            );
            return;
        };

        let sender_actor_id = self
            .backend
            .list_agent_admin_member_actor_ids(&self.actor_id)
            .await
            .ok()
            .and_then(|ids| ids.into_iter().next())
            .unwrap_or_else(|| self.actor_id.clone());

        let message_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now();
        let proto_msg = crate::proto::teamclaw::Message {
            message_id: message_id.clone(),
            session_id: session_id.to_string(),
            sender_actor_id: sender_actor_id.clone(),
            kind: crate::proto::teamclaw::MessageKind::Text as i32,
            content: prompt.to_string(),
            created_at: now.timestamp(),
            ..Default::default()
        };

        if let Err(e) = tc.persist_message(session_id, &proto_msg).await {
            warn!(?e, session_id, "cron: persist user prompt to TOML failed");
        }

        info!(
            session_id,
            bytes = prompt.len(),
            sender_actor_id = %sender_actor_id,
            "cron: persisted user prompt to session TOML and cloud"
        );

        let backend = self.backend.clone();
        let team_id = team_id.to_string();
        let session = session_id.to_string();
        let content = prompt.to_string();
        tokio::spawn(async move {
            if let Err(e) = backend
                .insert_message(
                    &message_id,
                    &team_id,
                    &session,
                    &sender_actor_id,
                    "text",
                    &content,
                    "",
                    "",
                    "",
                    "",
                    0,
                )
                .await
            {
                warn!(
                    ?e,
                    session_id = %session,
                    "cron: backend insert user prompt failed"
                );
            }
        });
    }

    /// Resolve the working directory to use for a cron turn that didn't pin
    /// an explicit `working_directory` on the wire.
    ///
    /// Cron runs on behalf of the daemon's own primary agent (`self.actor_id`
    /// is the actor performing the turn — see `primary_agent_actor_id` above),
    /// so the natural source of truth is that agent's cloud-configured
    /// default workspace (`agents.default_workspace_id`, fetched via
    /// `Backend::get_agent_defaults` and resolved to a filesystem path
    /// through the shared `workspace_resolver` cache — the same path the
    /// gateway/channels code uses, see `channels.rs`).
    ///
    /// If the agent has no default configured, or the configured id fails to
    /// resolve (deleted workspace, cache miss with backend error, etc.),
    /// falls back to the team's first workspace whose local path still
    /// exists on this machine (`Backend::get_workspaces_by_team`, added in
    /// Task 8) — this mirrors the team-link sweep's approach of trusting
    /// only on-disk paths from the cloud row set.
    async fn resolve_cron_default_workspace(&self) -> Option<String> {
        crate::config::resolve_default_workspace_path(
            &self.backend,
            &self.workspace_resolver,
            self.config.team_id.as_deref(),
            &self.actor_id,
        )
        .await
    }

    /// Drive a single ACP turn for `acp_sid` to its finalized `AgentReply`,
    /// releasing the global `RuntimeManager` mutex while awaiting the model.
    ///
    /// This mirrors the gateway path (`AmuxdAcpHandle::send_prompt`) rather than
    /// the legacy `RuntimeManager::send_prompt_and_await_reply`, which pins the
    /// manager mutex for the entire turn and so serializes every other agent's
    /// activity behind one cron run. Concurrency model:
    ///
    ///   1. Grab the per-agent `turn_lock` under a brief manager lock, release
    ///      the manager mutex, then acquire `turn_lock` (serialises only *this*
    ///      agent's turns; the checkout below cannot then race).
    ///   2. Re-lock the manager *briefly* to check the agent's `event_rx` out
    ///      of its handle and send the prompt.
    ///   3. Drive the aggregator off the local `event_rx.recv().await` with the
    ///      manager mutex free; re-lock only for the sub-millisecond
    ///      `aggregator.ingest(&event)` after each event.
    ///   4. Always check the receiver back in (success or error) so
    ///      `poll_events` resumes draining.
    ///
    /// Reply detection is identical to `send_prompt_and_await_reply`: the turn
    /// ends on the first finalized `AgentReply`, an ACP `Error` event, a closed
    /// channel, or the timeout.
    ///
    /// Takes `agents` explicitly (rather than `&self`) so it can run on a
    /// spawned task after the run loop has moved on — see `handle_prompt_await`.
    async fn drive_cron_turn(
        agents: &Arc<AsyncMutex<RuntimeManager>>,
        acp_sid: &str,
        prompt: &str,
        timeout: Duration,
    ) -> anyhow::Result<crate::runtime::turn_aggregator::EmittedMessage> {
        // 1. Per-agent turn lock (held for the whole turn) under a brief
        //    manager lock.
        let turn_lock = {
            let mgr = agents.lock().await;
            let agent_id = mgr
                .agent_id_by_acp_session(acp_sid)
                .ok_or_else(|| anyhow::anyhow!("no agent for acp_session_id {acp_sid}"))?;
            let handle = mgr
                .get_handle(&agent_id)
                .ok_or_else(|| anyhow::anyhow!("agent {agent_id} disappeared before turn"))?;
            handle.turn_lock.clone()
        };
        let _turn_guard = turn_lock.lock().await;

        // 2. Check out the receiver and send the prompt under a brief lock.
        let (agent_id, mut event_rx) = {
            let mut mgr = agents.lock().await;
            let (turn, _again) = mgr
                .checkout_turn_for_acp(acp_sid)
                .map_err(|e| anyhow::anyhow!("checkout_turn_for_acp: {e}"))?;
            mgr.send_prompt_raw(&turn.agent_id, prompt, vec![], None, None)
                .await
                .map_err(|e| anyhow::anyhow!("send_prompt_raw: {e}"))?;
            (turn.agent_id, turn.event_rx)
        };

        // 3. Drive the aggregator off the local receiver without holding the
        //    manager mutex while awaiting the model.
        let deadline = std::time::Instant::now() + timeout;
        let result: anyhow::Result<crate::runtime::turn_aggregator::EmittedMessage> = loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break Err(anyhow::anyhow!("ACP turn timed out"));
            }
            let event = match tokio::time::timeout(remaining, event_rx.recv()).await {
                Ok(Some(ev)) => ev,
                Ok(None) => break Err(anyhow::anyhow!("ACP event channel closed before reply")),
                Err(_) => break Err(anyhow::anyhow!("ACP turn timed out")),
            };

            if let Some(crate::proto::amux::acp_event::Event::Error(err)) = &event.event.event {
                let details = if err.details.is_empty() {
                    err.message.clone()
                } else {
                    err.details.clone()
                };
                break Err(anyhow::anyhow!("ACP turn failed: {details}"));
            }

            let emitted = {
                let mut mgr = agents.lock().await;
                mgr.aggregator_mut(&agent_id)
                    .map(|agg| agg.ingest(&event.event))
                    .unwrap_or_default()
            };
            if let Some(reply) = emitted
                .into_iter()
                .find(|m| matches!(m.kind, crate::proto::teamclaw::MessageKind::AgentReply))
            {
                break Ok(reply);
            }
        };

        // 4. Always check the receiver back in.
        {
            let mut mgr = agents.lock().await;
            mgr.checkin_turn(crate::runtime::CheckedOutTurn { agent_id, event_rx });
        }

        result
    }
}

#[cfg(test)]
mod tests {
    use super::CronSessionCache;
    use crate::backend::mock::MockBackend;
    use crate::backend::{AgentDefaults, Backend, WorkspaceRow};
    use crate::daemon::server::tests::test_server_with_cloud_api;
    use std::sync::Arc;

    #[tokio::test]
    async fn resolve_cron_default_workspace_uses_resolvable_agent_default() {
        let dir = tempfile::tempdir().unwrap();
        let mock = MockBackend::with_identity("team-test", "agent-actor");
        {
            let mut st = mock.state();
            st.agent_defaults.insert(
                "agent-actor".to_string(),
                AgentDefaults {
                    default_agent_type: None,
                    default_workspace_id: Some("ws-default".to_string()),
                },
            );
            st.workspaces_by_id.insert(
                "ws-default".to_string(),
                WorkspaceRow {
                    id: "ws-default".to_string(),
                    team_id: "team-test".to_string(),
                    path: Some(dir.path().to_string_lossy().to_string()),
                },
            );
        }
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let test_server = test_server_with_cloud_api(backend);

        let resolved = test_server
            .server
            .resolve_cron_default_workspace()
            .await
            .expect("should resolve agent default workspace");
        assert_eq!(resolved, dir.path().to_string_lossy().to_string());
    }

    #[tokio::test]
    async fn resolve_cron_default_workspace_falls_back_to_team_first_on_disk_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let mock = MockBackend::with_identity("team-test", "agent-actor");
        {
            let mut st = mock.state();
            // No agent default configured (agent_defaults left empty).
            st.workspaces_by_id.insert(
                "ws-missing".to_string(),
                WorkspaceRow {
                    id: "ws-missing".to_string(),
                    team_id: "team-test".to_string(),
                    path: Some("/definitely/not/on/this/machine/cron-fallback-test".to_string()),
                },
            );
            st.workspaces_by_id.insert(
                "ws-on-disk".to_string(),
                WorkspaceRow {
                    id: "ws-on-disk".to_string(),
                    team_id: "team-test".to_string(),
                    path: Some(dir.path().to_string_lossy().to_string()),
                },
            );
            // Different team; must never be picked.
            st.workspaces_by_id.insert(
                "ws-other-team".to_string(),
                WorkspaceRow {
                    id: "ws-other-team".to_string(),
                    team_id: "team-other".to_string(),
                    path: Some(dir.path().to_string_lossy().to_string()),
                },
            );
        }
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let test_server = test_server_with_cloud_api(backend);

        let resolved = test_server
            .server
            .resolve_cron_default_workspace()
            .await
            .expect("should fall back to team's first on-disk workspace");
        assert_eq!(resolved, dir.path().to_string_lossy().to_string());
    }

    #[tokio::test]
    async fn resolve_cron_default_workspace_none_when_no_candidates() {
        let mock = MockBackend::with_identity("team-test", "agent-actor");
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let test_server = test_server_with_cloud_api(backend);

        assert_eq!(
            test_server.server.resolve_cron_default_workspace().await,
            None
        );
    }

    #[test]
    fn cache_round_trips_the_session_pair() {
        let mut cache = CronSessionCache::new();
        assert_eq!(cache.get_pair("cron/job-1/run-1"), None);

        cache.insert_pair("cron/job-1/run-1", "cloud-sid", "acp-sid");
        assert_eq!(
            cache.get_pair("cron/job-1/run-1"),
            Some(("cloud-sid".to_string(), "acp-sid".to_string()))
        );
        // Distinct keys do not collide.
        assert_eq!(cache.get_pair("cron/job-1/run-2"), None);
    }

    #[test]
    fn insert_pair_overwrites_existing_key() {
        let mut cache = CronSessionCache::new();
        cache.insert_pair("k", "old-cloud", "old-acp");
        cache.insert_pair("k", "new-cloud", "new-acp");
        assert_eq!(
            cache.get_pair("k"),
            Some(("new-cloud".to_string(), "new-acp".to_string()))
        );
    }

    #[tokio::test]
    async fn persist_cron_user_prompt_inserts_text_for_admin_sender() {
        use crate::backend::mock::MockBackend;
        use crate::backend::Backend;
        use std::sync::Arc;

        let mock = MockBackend::with_identity("team-test", "agent-actor");
        {
            let mut st = mock.state();
            st.admin_member_actor_ids
                .insert("agent-actor".to_string(), vec!["human-admin".to_string()]);
        }
        let backend: Arc<dyn Backend> = Arc::new(mock.clone());
        let test_server = test_server_with_cloud_api(backend);

        test_server
            .server
            .persist_cron_user_prompt("team-test", "session-1", "check approvals")
            .await;

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let snap = mock.state();
        assert_eq!(snap.messages_inserted.len(), 1);
        assert_eq!(snap.messages_inserted[0].kind, "text");
        assert_eq!(snap.messages_inserted[0].content, "check approvals");
        assert_eq!(snap.messages_inserted[0].sender_actor_id, "human-admin");
        assert_eq!(snap.messages_inserted[0].session_id, "session-1");
    }
}

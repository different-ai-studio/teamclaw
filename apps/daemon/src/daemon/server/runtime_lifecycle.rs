//! Extracted from `server.rs` — methods of `DaemonServer` grouped by concern.
//! See `server.rs` for the struct definition and core lifecycle.

use super::*;

impl DaemonServer {
    /// Bind remote-tool routing to a live runtime and persist the host-level MCP config.
    /// Route selection is message-level via `remote_context_id`; this binding is
    /// retained only for compatibility/diagnostics and must not trigger ACP resume.
    pub(crate) async fn bind_remote_tool_member(
        &self,
        runtime_id: &str,
        session_id: &str,
        member_actor_id: &str,
        team_id: &str,
    ) {
        if session_id.is_empty() || member_actor_id.is_empty() {
            return;
        }
        {
            let mut agents = self.agents.lock().await;
            if let Some(h) = agents.get_handle_mut(runtime_id) {
                h.remote_tool_member_id = member_actor_id.to_string();
            }
        }
        {
            let mut targets = self.session_remote_targets.lock().await;
            targets.prune_expired();
            targets.set(session_id, member_actor_id);
        }
        if let Err(e) =
            crate::remote_tools::write_remote_tools_mcp_config(session_id, team_id, member_actor_id)
        {
            warn!(
                session_id,
                runtime_id,
                err = %e,
                "bind_remote_tool_member: write_remote_tools_mcp_config failed (non-fatal)"
            );
        }
    }

    /// Legacy no-op. Remote-tools MCP is now a host baseline; reattaching a
    /// session can perturb OpenCode's shared MCP registry.
    pub(crate) async fn flush_pending_remote_tools_mcp_refresh(&self, runtime_id: &str) {
        let mut agents = self.agents.lock().await;
        if let Some(h) = agents.get_handle_mut(runtime_id) {
            h.remote_tools_mcp_refresh_pending = false;
        }
    }

    /// Legacy no-op. Host-level MCP baseline removes the need to refresh peers
    /// by ACP resume.
    async fn sync_peer_remote_tools_on_worktree(
        &self,
        _worktree: &str,
        _workspace_id: &str,
        _exclude_runtime_id: &str,
        _team_id: &str,
    ) {
    }

    /// Keep remote-tools routing metadata on a live collab runtime. MCP itself
    /// is a host baseline and is not refreshed via per-session ACP resume.
    pub(crate) async fn ensure_live_runtime_remote_tools(
        &self,
        runtime_id: &str,
        session_id: &str,
        requester_actor_id: &str,
        team_id: &str,
    ) {
        if session_id.is_empty() || requester_actor_id.is_empty() {
            return;
        }

        self.bind_remote_tool_member(runtime_id, session_id, requester_actor_id, team_id)
            .await;
    }

    /// Spawns a Claude Code subprocess and publishes lifecycle state
    /// transitions on the retained runtime state topic. Shared by legacy
    /// AcpCommand::StartAgent and RPC RuntimeStart handlers.
    ///
    /// Lifecycle publishes:
    ///   - STARTING (stage "spawning_process") published retained right after
    ///     spawn_agent returns the new runtime_id, before StoredSession upsert.
    ///   - ACTIVE published retained via publish_runtime_state_by_id after
    ///     StoredSession upsert (that call reads the now-populated RuntimeHandle).
    ///   - No FAILED publish here — spawn_agent error path returns before any
    ///     runtime_id is allocated, so there is no retained topic to write to.
    ///     Callers may surface the error via their wire envelope.
    ///
    /// Load a collab session + participants from the backend, cache them in
    /// the teamclaw session manager, and subscribe to `session/{sid}/live`.
    /// Idempotent — safe on every RuntimeStart, including dedup reuse.
    pub(crate) async fn ensure_collab_session_registered(
        &mut self,
        session_id: &str,
    ) -> Result<(), StartRuntimeError> {
        if session_id.is_empty() {
            return Ok(());
        }
        match self
            .backend
            .fetch_session_with_participants(session_id)
            .await
        {
            Ok(snap) => {
                if let Some(tc) = self.teamclaw.as_mut() {
                    if let Err(e) = tc
                        .insert_session_from_backend(&snap.session, &snap.participants)
                        .await
                    {
                        return Err(StartRuntimeError {
                            error_code: "SESSION_SUBSCRIBE_FAILED".to_string(),
                            error_message: format!("insert_session_from_backend failed: {}", e),
                            failed_stage: "session_subscribe".to_string(),
                        });
                    }
                } else {
                    return Err(StartRuntimeError {
                        error_code: "SESSION_SUBSCRIBE_FAILED".to_string(),
                        error_message:
                            "teamclaw session manager is not available for session runtime"
                                .to_string(),
                        failed_stage: "session_subscribe".to_string(),
                    });
                }
            }
            Err(e) => {
                return Err(StartRuntimeError {
                    error_code: "SESSION_LOOKUP_FAILED".to_string(),
                    error_message: format!("fetch_session_with_participants failed: {}", e),
                    failed_stage: "session_lookup".to_string(),
                });
            }
        }
        Ok(())
    }

    pub(crate) async fn apply_start_runtime(
        &mut self,
        agent_type: amux::AgentType,
        workspace_id: &str,
        worktree: &str,
        session_id: &str,
        initial_prompt: &str,
        initial_model_override: Option<String>,
        requester_actor_id: &str,
    ) -> Result<StartRuntimeOutcome, StartRuntimeError> {
        info!(workspace_id, worktree, session_id, "apply_start_runtime");

        let team_id = self.config.team_id.clone().unwrap_or_default();
        let wants_remote_mcp = !session_id.is_empty() && !requester_actor_id.is_empty();

        // Resolve workspace + worktree via the cloud-backed WorkspaceResolver.
        // The cloud UUID (`workspace_id`) IS the workspace id now — there is
        // no separate local/remote id split.
        let (mut resolved_worktree, mut ws_id): (String, String) = if !workspace_id.is_empty() {
            match self.workspace_resolver.resolve(workspace_id).await {
                Ok(ws) => (ws.path, workspace_id.to_string()),
                Err(_) if !worktree.is_empty() => {
                    // Intentional (cloud-source-of-truth design): resolve()
                    // failing here almost always means the cloud is
                    // unreachable (offline), not that the workspace doesn't
                    // exist. The client-supplied `workspace_id` is still a
                    // real cloud UUID we simply can't confirm right now, so
                    // we deliberately keep stamping it into `ws_id` (which
                    // flows into `agent_runtimes.workspace_id`) rather than
                    // clearing it. This preserves the workspace association;
                    // the row self-corrects once the cloud becomes reachable
                    // and a subsequent resolve() succeeds. Not a bug.
                    (worktree.to_string(), workspace_id.to_string())
                }
                Err(e) => {
                    return Err(StartRuntimeError {
                        error_code: "WORKSPACE_NOT_FOUND".to_string(),
                        error_message: format!("resolve {workspace_id}: {e:?}"),
                        failed_stage: "validation".to_string(),
                    });
                }
            }
        } else {
            // Bare-agent spawn: empty workspace_id. Use worktree if provided,
            // else the onboarded team's default worktree
            // (`~/.amuxd/teams/<id>/workspace`), falling back to "." only when
            // not onboarded. Production daemons run with cwd `/` (read-only, set
            // by the desktop app), so a "." worktree fails env setup with a
            // read-only-filesystem error — this drove the offline-session
            // auto-restart into a permanent failure loop.
            let wt = if !worktree.is_empty() {
                worktree.to_string()
            } else {
                crate::config::global_team_store::onboarded_default_workspace_dir()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|| ".".to_string())
            };
            (wt, String::new())
        };

        // Fallback: when ws_id stayed empty (bare-agent spawn), try to
        // reverse-resolve resolved_worktree against the resolver's cache so
        // the runtime row, persisted session, and downstream agent_runtimes
        // upsert all carry the right workspace_id instead of stomping it
        // null on idle transitions.
        // Note: `id_for_path` only consults the resolver's in-memory,
        // lazily-populated cache — it does not itself hit the cloud. This is
        // the intended end-state under the cloud-source-of-truth design (no
        // local workspace store persists the path->id mapping anymore), but
        // it means that immediately after a daemon restart, with a cold
        // cache, a bare spawn may fail to backfill `ws_id` here. That's
        // acceptable: downstream tolerates an empty `ws_id`, and the mapping
        // self-heals as soon as any `resolve()` call runs and populates the
        // cache.
        if ws_id.is_empty() {
            if let Some(id) = self
                .workspace_resolver
                .id_for_path(&resolved_worktree)
                .await
            {
                ws_id = id;
            }
        }

        // Invariant: a conversation has at most one live runtime *on this
        // daemon*. The daemon is a single actor/participant in the session, so
        // it must answer an @mention exactly once. Historically each desktop
        // session-start / model-switch / workspace-change spawned a fresh
        // runtime_id keyed by (session_id, agent_type, workspace_id); several
        // could end up live at the same time (e.g. one resumed-on-restart in
        // workspace A plus one freshly started in workspace B) and *each* then
        // replied to the same prompt — the duplicate-reply bug.
        //
        // Collapse to one: among this session's live runtimes, reuse the one
        // that exactly matches the requested (agent_type, workspace_id) and
        // supersede (stop) every other one so the latest client intent wins
        // and only a single runtime remains to answer. Also protects against
        // misbehaving clients that fire RuntimeStart twice (picker + inline
        // mention race on the desktop client pre-4210aad8).
        let (existing_runtime, superseded): (Option<String>, Vec<String>) = if session_id.is_empty()
        {
            (None, Vec::new())
        } else {
            let agents = self.agents.lock().await;
            let mut reuse: Option<String> = None;
            let mut stale: Vec<String> = Vec::new();
            for rid in agents.runtime_ids_for_session(session_id) {
                match agents.get_handle(&rid) {
                    Some(h)
                        if reuse.is_none()
                            && h.agent_type == agent_type
                            && h.workspace_id == ws_id =>
                    {
                        reuse = Some(rid);
                    }
                    _ => stale.push(rid),
                }
            }
            (reuse, stale)
        };

        if !superseded.is_empty() {
            for rid in &superseded {
                self.agents.lock().await.stop_agent(rid).await;
                self.remote_tool_turn_contexts
                    .lock()
                    .await
                    .clear_runtime(rid);
                if let Some(s) = self.sessions.find_by_id_mut(rid) {
                    s.status = amux::AgentStatus::Stopped as i32;
                }
            }
            let _ = self.sessions.save(&self.sessions_path);
            info!(
                session_id,
                superseded = ?superseded,
                "apply_start_runtime: superseded stale runtimes for session (one live runtime per session)"
            );
        }

        if let Some(existing) = existing_runtime {
            let (existing_acp_session_id, existing_worktree, existing_remote_member) = {
                let agents = self.agents.lock().await;
                agents
                    .get_handle(&existing)
                    .map(|h| {
                        (
                            h.acp_session_id.clone(),
                            h.worktree.clone(),
                            h.remote_tool_member_id.clone(),
                        )
                    })
                    .unwrap_or_default()
            };
            info!(
                session_id,
                workspace_id = %ws_id,
                runtime_id = %existing,
                acp_session_id = %existing_acp_session_id,
                handle_worktree = %existing_worktree,
                remote_tool_member_id = %existing_remote_member,
                wants_remote_mcp,
                "apply_start_runtime: dedup hit; reusing existing runtime"
            );
            // TODO(perf-runtime-start-throttle): See the same id on the client
            // (`ensureAgentRuntimesForSession` in packages/app). Dedup still runs
            // ensure_collab_session_registered, refresh_membership MQTT, reconcile
            // (full `messages_after_cursor`), and catchup — costly on large sessions.
            // Do NOT implement unless the user explicitly asks — ignore routinely.
            // 无用户明确指令时不要实现本 TODO，日常开发请忽略。
            // Still register the session + subscribe to session/live. The
            // spawn path does this before returning; skipping it on dedup left
            // runtimes that were reused without a live subscription, so
            // @-mention prompts published to MQTT never reached send_prompt.
            self.ensure_collab_session_registered(session_id).await?;
            if let Some(desired_model) = initial_model_override
                .as_deref()
                .map(str::trim)
                .filter(|model| !model.is_empty())
            {
                let current = self
                    .agents
                    .lock()
                    .await
                    .current_model(&existing)
                    .cloned()
                    .unwrap_or_default();
                if desired_model != current {
                    let mut agents = self.agents.lock().await;
                    match agents.send_set_model(&existing, desired_model).await {
                        Ok(()) => {
                            agents.set_current_model(&existing, desired_model);
                        }
                        Err(e) => {
                            warn!(
                                runtime_id = %existing,
                                session_id,
                                model_id = %desired_model,
                                err = %e,
                                "apply_start_runtime: dedup reuse send_set_model failed"
                            );
                        }
                    }
                }
            }
            if wants_remote_mcp {
                self.ensure_live_runtime_remote_tools(
                    &existing,
                    session_id,
                    requester_actor_id,
                    &team_id,
                )
                .await;
            }
            if !initial_prompt.trim().is_empty() {
                self.prepare_remote_tool_context_for_turn(
                    &existing,
                    session_id,
                    requester_actor_id,
                )
                .await;
                if let Err(e) = self
                    .agents
                    .lock()
                    .await
                    .send_prompt(&existing, initial_prompt, vec![])
                    .await
                {
                    warn!(
                        runtime_id = %existing,
                        session_id,
                        err = %e,
                        "apply_start_runtime: dedup reuse send_prompt failed"
                    );
                } else {
                    info!(
                        runtime_id = %existing,
                        session_id,
                        "apply_start_runtime: dedup reuse delivered initial_prompt"
                    );
                }
            }
            // Re-publish retained RuntimeInfo so clients that missed the
            // original retain (late subscribe, reconnect) still populate the
            // model picker without spawning a duplicate process.
            self.publish_runtime_state_by_id(&existing).await;
            if !session_id.is_empty() {
                if let Some(tc) = self.teamclaw.as_mut() {
                    if let Err(e) = tc.ensure_session_live_subscription(session_id).await {
                        warn!(
                            session_id,
                            err = %e,
                            "apply_start_runtime: ensure_session_live_subscription failed (dedup)"
                        );
                    }
                }
            }
            // Live MQTT can miss messages that landed in the backend after the
            // initial attach catchup (e.g. client dedup runtimeStart on send).
            // Replay from the cursor so @-mentioned rows still reach send_prompt.
            self.catchup_runtime(&existing).await;
            return Ok(StartRuntimeOutcome {
                runtime_id: existing,
                session_id: session_id.to_string(),
            });
        }

        // If iOS handed us a cloud session_id, pull the row + participants
        // so we (a) populate the teamclaw cache that `agents_to_activate`
        // reads, and (b) subscribe to `session/{sid}/live` so inbound
        // `message.created` events from iOS actually reach us.
        // iOS creates these sessions directly in the cloud backend, so this is the
        // only place the daemon learns about them.
        if !session_id.is_empty() {
            match self
                .backend
                .fetch_session_with_participants(session_id)
                .await
            {
                Ok(mut snap) => {
                    if !snap
                        .participants
                        .iter()
                        .any(|p| p.actor_id == self.actor_id)
                    {
                        snap.participants
                            .push(crate::backend::BackendParticipantRow {
                                session_id: session_id.to_string(),
                                actor_id: self.actor_id.clone(),
                                role: Some("agent".to_string()),
                                joined_at: chrono::Utc::now(),
                            });
                    }
                    if let Some(tc) = self.teamclaw.as_mut() {
                        if let Err(e) = tc
                            .insert_session_from_backend(&snap.session, &snap.participants)
                            .await
                        {
                            return Err(StartRuntimeError {
                                error_code: "SESSION_SUBSCRIBE_FAILED".to_string(),
                                error_message: format!("insert_session_from_backend failed: {}", e),
                                failed_stage: "session_subscribe".to_string(),
                            });
                        }
                        if let Err(e) = tc.ensure_session_live_subscription(session_id).await {
                            warn!(
                                session_id,
                                err = %e,
                                "apply_start_runtime: ensure_session_live_subscription failed"
                            );
                        }
                    } else {
                        return Err(StartRuntimeError {
                            error_code: "SESSION_SUBSCRIBE_FAILED".to_string(),
                            error_message:
                                "teamclaw session manager is not available for session runtime"
                                    .to_string(),
                            failed_stage: "session_subscribe".to_string(),
                        });
                    }
                }
                Err(e) => {
                    return Err(StartRuntimeError {
                        error_code: "SESSION_LOOKUP_FAILED".to_string(),
                        error_message: format!("fetch_session_with_participants failed: {}", e),
                        failed_stage: "session_lookup".to_string(),
                    });
                }
            }
        }

        if !session_id.is_empty() && !ws_id.is_empty() {
            if let Some(outcome) = self
                .try_resume_runtime_for_start(
                    session_id,
                    agent_type,
                    &ws_id,
                    initial_prompt,
                    initial_model_override.as_deref(),
                    requester_actor_id,
                )
                .await
            {
                return Ok(outcome);
            }
        }

        let session_id_opt = (!session_id.is_empty()).then_some(session_id);
        let resume_acp_session_id = if !session_id.is_empty() && !ws_id.is_empty() {
            resolve_backend_session_id(
                &self.backend,
                &self.actor_id,
                session_id,
                &self.sessions,
                agent_type,
                &ws_id,
            )
            .await
        } else {
            None
        };
        if let Some(ref sid) = resume_acp_session_id {
            info!(
                session_id,
                workspace_id = %ws_id,
                backend_session_id = %sid,
                "apply_start_runtime: spawning with ACP resume (no matching stored runtime row)"
            );
        }

        let workspace_team_id = self.resolve_workspace_team_id(&ws_id).await;

        if let Some(ref team_id) = workspace_team_id {
            let gate = crate::team_link::team_share_gate(self.backend.as_ref(), team_id).await;
            crate::team_link::materialize_or_teardown(gate, team_id, &resolved_worktree);
        }

        if let Some(config) = load_team_shared_config_for_workspace(Path::new(&resolved_worktree)) {
            sync_team_shared_dir_for_workspace(Path::new(&resolved_worktree), &config);
        }

        self.suppress_internal_opencode_writes(&resolved_worktree);
        let runtime_env = self
            .assemble_spawn_runtime_env_for_worktree(&resolved_worktree, &ws_id)
            .await
            .map_err(|e| StartRuntimeError {
                error_code: "ENV_ASSEMBLE_FAILED".to_string(),
                error_message: format!("assemble_runtime_env failed: {e}"),
                failed_stage: "env_setup".to_string(),
            })?;

        let wants_remote_mcp = !session_id.is_empty() && !requester_actor_id.is_empty();

        let mut remote_mcp_ready = false;
        let mcp_config_path = if wants_remote_mcp {
            match crate::remote_tools::write_remote_tools_mcp_config(
                session_id,
                &team_id,
                requester_actor_id,
            ) {
                Ok(_) => {
                    remote_mcp_ready = true;
                    Some(crate::remote_tools::remote_tools_mcp_config_path(
                        session_id,
                    ))
                }
                Err(e) => {
                    warn!(
                        session_id,
                        err = %e,
                        "apply_start_runtime: write_remote_tools_mcp_config before spawn failed; skipping remote MCP"
                    );
                    None
                }
            }
        } else {
            None
        };

        // Spawn.
        let spawn_res = self
            .agents
            .lock()
            .await
            .spawn_agent_with_model(
                agent_type,
                &resolved_worktree,
                "",
                &ws_id,
                (!ws_id.is_empty()).then_some(ws_id.as_str()),
                session_id_opt,
                initial_model_override,
                mcp_config_path,
                resume_acp_session_id,
                runtime_env,
            )
            .await;
        let new_id = match spawn_res {
            Ok(id) => id,
            Err(e) => {
                error!("spawn_agent failed: {}", e);
                // We never allocated a retained topic (spawn_agent failed before
                // returning an id), so there's no retain to publish FAILED to.
                // The caller formats the error into its wire envelope; no state
                // topic is involved.
                return Err(StartRuntimeError {
                    error_code: "SPAWN_FAILED".to_string(),
                    error_message: format!("spawn_agent failed: {}", e),
                    failed_stage: "spawning_process".to_string(),
                });
            }
        };

        if remote_mcp_ready {
            self.bind_remote_tool_member(&new_id, session_id, requester_actor_id, &team_id)
                .await;
        }

        if !initial_prompt.trim().is_empty() {
            self.prepare_remote_tool_context_for_turn(&new_id, session_id, requester_actor_id)
                .await;
            if let Err(e) = self
                .agents
                .lock()
                .await
                .send_prompt(&new_id, initial_prompt, vec![])
                .await
            {
                warn!(
                    runtime_id = %new_id,
                    session_id,
                    err = %e,
                    "apply_start_runtime: initial_prompt send_prompt failed"
                );
            }
        }

        {
            let mut agents = self.agents.lock().await;
            if let Err(e) = apply_workspace_system_instructions(
                &mut agents,
                &new_id,
                Path::new(&resolved_worktree),
                agent_type,
            ) {
                warn!(
                    runtime_id = %new_id,
                    session_id,
                    err = %e,
                    "apply_start_runtime: workspace system instructions failed"
                );
            }
        }

        // STARTING retain — fleeting but observable by mid-spawn reconnects.
        let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
        let starting_info = amux::RuntimeInfo {
            runtime_id: new_id.clone(),
            agent_type: agent_type as i32,
            worktree: resolved_worktree.clone(),
            workspace_id: ws_id.clone(),
            state: amux::RuntimeLifecycle::Starting as i32,
            stage: "spawning_process".to_string(),
            started_at: chrono::Utc::now().timestamp(),
            ..Default::default()
        };
        let _ = publisher
            .publish_runtime_state(&new_id, &starting_info)
            .await;

        // Persist session + transition to ACTIVE.
        let acp_sid = self
            .agents
            .lock()
            .await
            .get_handle(&new_id)
            .map(|h| h.acp_session_id.clone())
            .unwrap_or_default();
        let stored = StoredSession {
            runtime_id: new_id.clone(),
            acp_session_id: acp_sid,
            session_id: session_id.to_string(),
            agent_type: agent_type as i32,
            workspace_id: ws_id.clone(),
            worktree: resolved_worktree.clone(),
            status: amux::AgentStatus::Active as i32,
            created_at: chrono::Utc::now().timestamp(),
            last_prompt: initial_prompt.to_string(),
            last_output_summary: String::new(),
            tool_use_count: 0,
        };
        if !session_id.is_empty() {
            let disk_superseded = self.sessions.supersede_stale_for_session(
                session_id,
                &ws_id,
                agent_type as i32,
                &new_id,
            );
            if !disk_superseded.is_empty() {
                let _ = self.sessions.save(&self.sessions_path);
            }
        }
        self.sessions.upsert(stored);
        let _ = self.sessions.save(&self.sessions_path);

        // ACTIVE — publish_runtime_state_by_id reads the live RuntimeHandle and
        // dual-publishes to agent/{id}/state + runtime/{id}/state. The handle
        // today encodes state=ACTIVE (Phase 1a Idea 4).
        self.publish_runtime_state_by_id(&new_id).await;

        // Replay any messages the runtime missed before it was spawned.
        // Uses Option B (event loop hook is not needed here because
        // apply_start_runtime already has `&mut self` access and runs
        // synchronously after spawn_agent returns). This is the cleanest
        // insertion point — the handle is fully populated (session_id,
        // backend_runtime_row_id) and state is ACTIVE.
        self.catchup_runtime(&new_id).await;

        if remote_mcp_ready {
            self.sync_peer_remote_tools_on_worktree(&resolved_worktree, &ws_id, &new_id, &team_id)
                .await;
        }

        Ok(StartRuntimeOutcome {
            runtime_id: new_id,
            session_id: session_id.to_string(),
        })
    }

    pub(crate) async fn handle_stop_runtime(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        stop: &crate::proto::teamclaw::RuntimeStopRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, RpcResponse, RuntimeStopResult};

        let runtime_id = stop.runtime_id.clone();
        if runtime_id.is_empty() {
            return reject_stop(request, "runtime_id required");
        }

        // Reject if runtime is not known.
        if self.agents.lock().await.get_handle(&runtime_id).is_none() {
            return reject_stop(request, &format!("unknown runtime_id: {}", runtime_id));
        }

        // Terminate via RuntimeManager (same path as AcpCommand::StopAgent).
        if self
            .agents
            .lock()
            .await
            .stop_agent(&runtime_id)
            .await
            .is_none()
        {
            return reject_stop(
                request,
                &format!("stop failed for runtime_id: {}", runtime_id),
            );
        }

        self.remote_tool_turn_contexts
            .lock()
            .await
            .clear_runtime(&runtime_id);

        self.publish_runtime_stopped(&runtime_id).await;

        RpcResponse {
            request_id: request.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::RuntimeStopResult(RuntimeStopResult {
                accepted: true,
                rejected_reason: String::new(),
            })),
        }
    }

    /// Publish terminal `runtime/{id}/state`, clear the retained topic, and
    /// flip the persisted session row to Stopped. Idempotent — calling
    /// twice on the same `runtime_id` is safe (the second clear is a no-op
    /// against an already-empty retain).
    pub(crate) async fn publish_runtime_stopped(&mut self, runtime_id: &str) {
        if let Some(session) = self.sessions.find_by_id_mut(runtime_id) {
            session.status = amux::AgentStatus::Stopped as i32;
            let _ = self.sessions.save(&self.sessions_path);
        }
        let stopped_info = amux::RuntimeInfo {
            runtime_id: runtime_id.to_string(),
            state: amux::RuntimeLifecycle::Stopped as i32,
            ..Default::default()
        };
        let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
        let _ = publisher
            .publish_runtime_state(runtime_id, &stopped_info)
            .await;
        let _ = publisher.clear_runtime_state(runtime_id).await;
    }

    pub(crate) async fn handle_start_runtime(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        start: &crate::proto::teamclaw::RuntimeStartRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, RpcResponse, RuntimeStartResult};

        let requested =
            amux::AgentType::try_from(start.agent_type).unwrap_or(amux::AgentType::ClaudeCode);
        let at = resolve_requested_agent_type(&self.config, requested);
        if at != requested {
            info!(requested = ?requested, resolved = ?at, "runtimeStart agent_type overridden by daemon config");
        }

        let initial_model_override = runtime_start_initial_model_override(start);
        let outcome = self
            .apply_start_runtime(
                at,
                &start.workspace_id,
                &start.worktree,
                &start.session_id,
                &start.initial_prompt,
                initial_model_override,
                &request.requester_actor_id,
            )
            .await;

        match outcome {
            Ok(res) => RpcResponse {
                request_id: request.request_id.clone(),
                success: true,
                error: String::new(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                result: Some(rpc_response::Result::RuntimeStartResult(
                    RuntimeStartResult {
                        accepted: true,
                        runtime_id: res.runtime_id,
                        session_id: res.session_id,
                        rejected_reason: String::new(),
                    },
                )),
            },
            Err(err) => RpcResponse {
                request_id: request.request_id.clone(),
                success: false,
                error: err.error_message.clone(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                result: Some(rpc_response::Result::RuntimeStartResult(
                    RuntimeStartResult {
                        accepted: false,
                        runtime_id: String::new(),
                        session_id: String::new(),
                        rejected_reason: err.error_message,
                    },
                )),
            },
        }
    }

    /// Forward a SetModel request to the matching runtime via ACP. On success
    /// the daemon's `current_model_per_agent` is bumped synchronously inside
    /// `RuntimeManager::set_model`, so we re-publish the runtime's retained
    /// state to fan the new `current_model` out to every subscriber.
    pub(crate) async fn handle_set_model(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        set: &crate::proto::teamclaw::SetModelRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, RpcResponse, SetModelResult};

        let runtime_id = set.runtime_id.clone();
        let model_id = set.model_id.clone();
        if runtime_id.is_empty() {
            return reject_set_model(request, "runtime_id required");
        }
        if model_id.is_empty() {
            return reject_set_model(request, "model_id required");
        }

        let result = self
            .agents
            .lock()
            .await
            .set_model(&runtime_id, &model_id)
            .await;
        let (success, error) = match result {
            Ok(()) => (true, String::new()),
            Err(e) => (false, e.to_string()),
        };

        // On success, fan the new current_model out via the retained per-runtime
        // state topic so iOS subscribers see the change immediately. Also
        // upsert agent_runtimes.current_model so clients that read the cloud backend
        // (e.g. when MQTT delivery is flaky) see the change — without this,
        // iOS picks up the stale current_model and the row label snaps back
        // to the previous model after refreshMemberSheet runs.
        if success {
            self.publish_runtime_state_by_id(&runtime_id).await;

            let sb = &self.backend;
            let agents = self.agents.lock().await;
            let handle = agents.get_handle(&runtime_id);
            let (acp_sid, session_id, ws_id, backend_type) = (
                handle.map(|h| h.acp_session_id.clone()).unwrap_or_default(),
                handle.map(|h| h.session_id.clone()).unwrap_or_default(),
                handle.map(|h| h.workspace_id.clone()).unwrap_or_default(),
                handle
                    .map(|h| agents.launch_config_for(h.agent_type).backend_type)
                    .unwrap_or("claude"),
            );
            let status_str: &'static str = handle
                .map(|h| match amux::AgentStatus::try_from(h.status as i32) {
                    Ok(amux::AgentStatus::Active) => "running",
                    Ok(amux::AgentStatus::Idle) => "idle",
                    Ok(amux::AgentStatus::Stopped) => "stopped",
                    _ => "starting",
                })
                .unwrap_or("starting");
            drop(agents);

            let team_id = sb.team_id().to_string();
            let actor_id = sb.actor_id().to_string();
            let sb_clone = sb.clone();
            let runtime_id_owned = runtime_id.clone();
            let model_id_owned = model_id.clone();
            tokio::spawn(async move {
                let row = AgentRuntimeUpsert {
                    team_id: &team_id,
                    agent_id: &actor_id,
                    session_id: (!session_id.is_empty()).then_some(session_id.as_str()),
                    workspace_id: (!ws_id.is_empty()).then_some(ws_id.as_str()),
                    backend_type,
                    backend_session_id: if acp_sid.is_empty() {
                        None
                    } else {
                        Some(acp_sid.as_str())
                    },
                    runtime_id: Some(runtime_id_owned.as_str()),
                    status: status_str,
                    current_model: Some(model_id_owned.as_str()),
                    last_seen_at: chrono::Utc::now(),
                };
                if let Err(e) = sb_clone.upsert_agent_runtime(&row).await {
                    warn!("agent_runtimes upsert (set_model): {e}");
                }
            });
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::SetModelResult(SetModelResult {
                success,
                error,
            })),
        }
    }
}

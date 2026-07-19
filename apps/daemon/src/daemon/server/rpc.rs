//! Extracted from `server.rs` — methods of `DaemonServer` grouped by concern.
//! See `server.rs` for the struct definition and core lifecycle.

use super::*;

impl DaemonServer {
    /// Server-level RPC dispatch. Decodes the wire payload, matches on Method,
    /// delegates session/idea methods to SessionManager, and handles non-session
    /// methods locally. Publishes the response to the sender's rpc/res topic.
    pub(crate) async fn handle_rpc_request(&mut self, topic: &str, payload: &[u8]) {
        use crate::proto::teamclaw::{rpc_request::Method, RpcRequest, RpcResponse};
        use prost::Message as ProstMessage;

        let request = match RpcRequest::decode(payload) {
            Ok(r) => r,
            Err(e) => {
                warn!(%topic, "failed to decode RpcRequest: {}", e);
                return;
            }
        };

        // Each daemon only subscribes to its own `amux/{team}/{actor}/rpc/req`
        // topic; ignore mis-delivered requests so we never apply another actor's
        // workspace path on this machine.
        let parts: Vec<&str> = topic.split('/').collect();
        if parts.len() == 5
            && parts[0] == "amux"
            && parts[3] == "rpc"
            && parts[4] == "req"
            && parts[2] != self.actor_id.as_str()
        {
            warn!(
                %topic,
                expected_actor = %self.actor_id,
                "ignoring RpcRequest routed to a different actor"
            );
            return;
        }

        let response: RpcResponse = match &request.method {
            // ─── Session/idea methods — delegate to SessionManager ───
            Some(Method::CreateSession(_))
            | Some(Method::FetchSession(_))
            | Some(Method::FetchSessionMessages(_))
            | Some(Method::JoinSession(_))
            | Some(Method::AddParticipant(_))
            | Some(Method::RemoveParticipant(_))
            | Some(Method::CreateIdea(_))
            | Some(Method::ClaimIdea(_))
            | Some(Method::SubmitIdea(_))
            | Some(Method::UpdateIdea(_)) => {
                // Pre-compute primary before the mutable borrow of self.teamclaw.
                let primary = self.primary_agent_id().await;
                if let Some(tc) = self.teamclaw.as_mut() {
                    tc.handle_rpc_method(request.clone(), primary).await
                } else {
                    not_yet_implemented(&request, "session_manager not initialized")
                }
            }
            // ─── Non-session methods — handle locally ───
            // Phase 1b Ideas 3-9 replace these stubs with real handlers.
            Some(Method::FetchPeers(_)) => self.handle_fetch_peers(&request).await,
            Some(Method::FetchWorkspaces(_)) => self.handle_fetch_workspaces(&request).await,
            Some(Method::AnnouncePeer(ann)) => self.handle_announce_peer(&request, ann).await,
            Some(Method::DisconnectPeer(d)) => self.handle_disconnect_peer(&request, d).await,
            Some(Method::AddWorkspace(a)) => self.handle_add_workspace(&request, a).await,
            Some(Method::RemoveWorkspace(r)) => self.handle_remove_workspace(&request, r).await,
            Some(Method::RemoveMember(r)) => self.handle_remove_member(&request, r).await,
            Some(Method::RuntimeStop(s)) => self.handle_stop_runtime(&request, s).await,
            Some(Method::RuntimeStart(s)) => self.handle_start_runtime(&request, s).await,
            Some(Method::SetModel(s)) => self.handle_set_model(&request, s).await,
            Some(Method::RemoteToolInvoke(_)) => not_yet_implemented(
                &request,
                "RemoteToolInvoke is handled by clients, not daemon",
            ),
            None => RpcResponse {
                request_id: request.request_id.clone(),
                success: false,
                error: "no method".to_string(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                result: None,
            },
        };

        // Publish response on the requester's rpc/res topic (mirrors
        // RpcServer::respond). The requester subscribes on its own actor
        // namespace `amux/{team}/{actor}/rpc/res`.
        let res_topic = self.topics.rpc_res_for(&request.requester_actor_id);
        let bytes = response.encode_to_vec();
        info!(
            request_id = %request.request_id,
            res_topic = %res_topic,
            success = response.success,
            "publishing RpcResponse"
        );
        if let Err(e) = self
            .mqtt
            .client
            .publish(res_topic, rumqttc::QoS::AtLeastOnce, false, bytes)
            .await
        {
            warn!("failed to publish RpcResponse: {}", e);
        }
    }

    pub(crate) fn session_title_for_log(&self, session_id: &str) -> String {
        self.teamclaw
            .as_ref()
            .and_then(|tc| tc.sessions.find_by_id(session_id))
            .map(|session| session.title.trim())
            .filter(|title| !title.is_empty())
            .unwrap_or("<unknown>")
            .to_string()
    }

    pub(crate) async fn handle_incoming(&mut self, msg: subscriber::IncomingMessage) {
        use prost::Message as ProstMessage;
        match msg {
            subscriber::IncomingMessage::RuntimeCommand {
                runtime_id,
                envelope,
            } => {
                self.handle_agent_command(&runtime_id, envelope).await;
            }
            subscriber::IncomingMessage::TeamclawRpc { topic, payload } => {
                self.handle_rpc_request(&topic, &payload).await;
            }
            subscriber::IncomingMessage::TeamclawRpcResponse { topic, payload } => {
                let _ = self
                    .rpc_client
                    .lock()
                    .await
                    .handle_response(&topic, &payload);
            }
            subscriber::IncomingMessage::TeamclawSessionLive {
                session_id,
                payload,
            } => {
                let session_title = self.session_title_for_log(&session_id);
                let daemon_config_actor_id = self.config.actor.id.as_str();
                let daemon_actor_id = self.actor_id.as_str();
                let daemon_team_id = self.config.team_id.as_deref().unwrap_or("<none>");
                info!(
                    session_id = %session_id,
                    session_title = %session_title,
                    daemon_config_actor_id = %daemon_config_actor_id,
                    daemon_actor_id = %daemon_actor_id,
                    daemon_team_id = %daemon_team_id,
                    payload_bytes = payload.len(),
                    "session/live message received"
                );
                let envelope_res =
                    crate::proto::teamclaw::LiveEventEnvelope::decode(payload.as_slice());
                if let Err(e) = &envelope_res {
                    warn!(
                        session_id = %session_id,
                        session_title = %session_title,
                        daemon_config_actor_id = %daemon_config_actor_id,
                        daemon_actor_id = %daemon_actor_id,
                        daemon_team_id = %daemon_team_id,
                        err = %e,
                        "LiveEventEnvelope decode FAILED"
                    );
                }
                if let Ok(envelope) = envelope_res {
                    info!(
                        session_id = %session_id,
                        session_title = %session_title,
                        daemon_config_actor_id = %daemon_config_actor_id,
                        daemon_actor_id = %daemon_actor_id,
                        daemon_team_id = %daemon_team_id,
                        event_type = %envelope.event_type,
                        event_id = %envelope.event_id,
                        body_bytes = envelope.body.len(),
                        "LiveEventEnvelope decoded"
                    );
                    match envelope.event_type.as_str() {
                        "message.created" => {
                            let env = match crate::proto::teamclaw::SessionMessageEnvelope::decode(
                                envelope.body.as_slice(),
                            ) {
                                Ok(e) => e,
                                Err(e) => {
                                    warn!(
                                        session_id = %session_id,
                                        session_title = %session_title,
                                        daemon_config_actor_id = %daemon_config_actor_id,
                                        daemon_actor_id = %daemon_actor_id,
                                        daemon_team_id = %daemon_team_id,
                                        err = %e,
                                        "SessionMessageEnvelope decode failed"
                                    );
                                    return;
                                }
                            };
                            let Some(msg) = env.message.as_ref() else {
                                warn!(
                                    session_id = %session_id,
                                    session_title = %session_title,
                                    daemon_config_actor_id = %daemon_config_actor_id,
                                    daemon_actor_id = %daemon_actor_id,
                                    daemon_team_id = %daemon_team_id,
                                    "SessionMessageEnvelope without inner message; dropping"
                                );
                                return;
                            };
                            // Dedup is enforced centrally in
                            // `route_session_message_to_runtimes` (the single
                            // routing sink) so the live path and the
                            // catchup-replay path share one message_id gate and
                            // a freshly-sent message can't be prompted twice.
                            self.route_session_message(
                                &session_id,
                                msg,
                                &resolve_mention_actor_ids(
                                    &env.mention_actor_ids,
                                    &msg.metadata_json,
                                ),
                            )
                            .await;
                        }
                        "idea.created" | "idea.updated" => {
                            if let Ok(event) =
                                crate::proto::teamclaw::IdeaEvent::decode(envelope.body.as_slice())
                            {
                                if let Some(tc) = &mut self.teamclaw {
                                    if !tc.should_process_idea_event(&session_id, &event) {
                                        return;
                                    }
                                }
                                if let Some(tc) = &self.teamclaw {
                                    let activated =
                                        tc.agents_to_activate_for_idea(&session_id, &event);
                                    for agent_actor_id in activated {
                                        if let Some(runtime_id) = self
                                            .runtime_id_for_agent_actor_in_session(
                                                &agent_actor_id,
                                                &session_id,
                                            )
                                            .await
                                        {
                                            let prompt = format_idea_prompt(&session_id, &event);
                                            if !prompt.is_empty() {
                                                let send_res = self
                                                    .agents
                                                    .lock()
                                                    .await
                                                    .send_prompt(&runtime_id, &prompt, vec![])
                                                    .await;
                                                if let Err(e) = send_res {
                                                    warn!(
                                                        "Failed to route live idea to agent {} runtime {}: {}",
                                                        agent_actor_id, runtime_id, e
                                                    );
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            subscriber::IncomingMessage::TeamclawNotify { actor_id, payload } => {
                match crate::proto::teamclaw::Notify::decode(payload.as_slice()) {
                    Ok(n) => {
                        if n.event_type == "membership.refresh" && !n.refresh_hint.is_empty() {
                            match self
                                .backend
                                .fetch_session_with_participants(&n.refresh_hint)
                                .await
                            {
                                Ok(snap) => {
                                    if let Some(tc) = &mut self.teamclaw {
                                        if let Err(err) = tc
                                            .insert_session_from_backend(
                                                &snap.session,
                                                &snap.participants,
                                            )
                                            .await
                                        {
                                            warn!(
                                                ?err,
                                                actor_id = %actor_id,
                                                session_id = %n.refresh_hint,
                                                "failed to ingest cloud session after membership.refresh notify"
                                            );
                                        }
                                    }
                                }
                                Err(err) => {
                                    warn!(
                                        ?err,
                                        actor_id = %actor_id,
                                        session_id = %n.refresh_hint,
                                        "failed to fetch cloud session after membership.refresh notify"
                                    );
                                }
                            }
                        }
                    }
                    Err(err) => {
                        warn!(?err, "failed to decode actor notify payload as Notify");
                    }
                }
            }
        }
    }

    /// Derive the caller's MemberRole via a cloud `agent_member_access`
    /// lookup keyed on (our own agent actor id, envelope's sender_actor_id).
    /// the cloud backend is the sole source of truth — on any failure (RPC error,
    /// missing sender_actor_id) the caller is denied (`Member` is the safe
    /// no-op level). Previous versions fell back to a `peer_id` token-prefix
    /// scrape against members.toml, which let anyone who guessed a 6-char
    /// prefix masquerade as a member during a cloud backend outage; that path
    /// is gone.
    pub(crate) async fn resolve_role(
        &mut self,
        sender_actor_id: &str,
        _peer_id: &str,
    ) -> amux::MemberRole {
        if sender_actor_id.is_empty() {
            warn!("resolve_role: empty sender_actor_id, denying as Member");
            return amux::MemberRole::Member;
        }
        let sb = &self.backend;
        let my_agent_id = sb.actor_id().to_string();
        match sb
            .check_agent_permission(&my_agent_id, sender_actor_id)
            .await
        {
            Ok(Some(level)) => match level.as_str() {
                "admin" => amux::MemberRole::Owner,
                _ => amux::MemberRole::Member,
            },
            Ok(None) => {
                warn!(actor_id = %sender_actor_id, "no agent_member_access grant");
                amux::MemberRole::Member
            }
            Err(e) => {
                warn!(%e, actor_id = %sender_actor_id, "cloud permission check failed; denying");
                amux::MemberRole::Member
            }
        }
    }

    pub(crate) async fn handle_agent_command(
        &mut self,
        agent_id: &str,
        envelope: amux::RuntimeCommandEnvelope,
    ) {
        let peer_id = envelope.peer_id.clone();
        let command_id = envelope.command_id.clone();
        let sender_actor_id = envelope.sender_actor_id.clone();
        let reply_actor_id = if envelope.reply_to_actor_id.is_empty() {
            envelope.actor_id.clone()
        } else {
            envelope.reply_to_actor_id.clone()
        };

        let acp_command = match envelope.acp_command {
            Some(c) => c,
            None => return,
        };
        let cmd = match acp_command.command {
            Some(c) => c,
            None => return,
        };

        // Permission check.
        // Preferred path: iOS sets `sender_actor_id` on the envelope, daemon
        // looks up `agent_member_access.permission_level` via the cloud backend and
        // reduces that to a MemberRole. Legacy path: fall back to the
        // peer's MQTT-era role when the cloud backend lookup is unavailable.
        let role = self.resolve_role(&sender_actor_id, &peer_id).await;

        if let Err(reason) = self.permissions.check_command_permission(role, &cmd) {
            warn!(
                peer_id,
                reply_actor_id = %reply_actor_id,
                command_id = %command_id,
                %reason,
                "command rejected; legacy collab NACK no longer published"
            );
            return;
        }

        match cmd {
            amux::acp_command::Command::StartAgent(start) => {
                let requested =
                    amux::AgentType::try_from(start.agent_type).unwrap_or(amux::AgentType::Unknown);
                let at = resolve_requested_agent_type(&self.config, requested);

                info!(
                    workspace_id = %start.workspace_id,
                    worktree = %start.worktree,
                    peer_id,
                    "received startAgent envelope"
                );

                let outcome = self
                    .apply_start_runtime(
                        at,
                        &start.workspace_id,
                        &start.worktree,
                        &start.session_id,
                        &start.initial_prompt,
                        None,
                        &sender_actor_id,
                    )
                    .await;

                match outcome {
                    Ok(res) => {
                        info!(
                            agent_id = %res.runtime_id,
                            peer_id,
                            reply_actor_id = %reply_actor_id,
                            command_id = %command_id,
                            session_id = %res.session_id,
                            "agent started; legacy collab AgentStartResult no longer published"
                        );
                    }
                    Err(err) => {
                        let reason = err.error_message.clone();
                        error!(
                            peer_id,
                            reply_actor_id = %reply_actor_id,
                            command_id = %command_id,
                            session_id = %start.session_id,
                            "startAgent failed: {}; legacy collab AgentStartResult no longer published",
                            reason
                        );
                    }
                }
            }

            amux::acp_command::Command::StopAgent(_) => {
                let stopped = self
                    .agents
                    .lock()
                    .await
                    .stop_agent(agent_id)
                    .await
                    .is_some();
                if stopped {
                    self.remote_tool_turn_contexts
                        .lock()
                        .await
                        .clear_runtime(agent_id);
                    if let Some(session) = self.sessions.find_by_id_mut(agent_id) {
                        session.status = amux::AgentStatus::Stopped as i32;
                        let _ = self.sessions.save(&self.sessions_path);
                    }
                    self.publish_runtime_state_by_id(agent_id).await;
                    info!(agent_id, peer_id, "agent stopped");
                }
            }

            amux::acp_command::Command::SendPrompt(prompt) => {
                // Lazy resume: if agent is not live but exists in session store,
                // spawn a new ACP process and resume the session.
                let needs_resume = self.agents.lock().await.get_handle(agent_id).is_none();
                if needs_resume {
                    if let Some(stored) = self.sessions.find_by_id(agent_id) {
                        let at = amux::AgentType::try_from(stored.agent_type)
                            .unwrap_or(amux::AgentType::ClaudeCode);
                        let worktree = stored.worktree.clone();
                        let ws_id = stored.workspace_id.clone();
                        let acp_sid = stored.acp_session_id.clone();
                        let session_id = stored.session_id.clone();
                        info!(agent_id, "lazy-resuming historical session");
                        let remote_workspace_id = (!ws_id.is_empty()).then_some(ws_id.clone());
                        self.suppress_internal_opencode_writes(&worktree);
                        let runtime_env = match self
                            .assemble_spawn_runtime_env_for_worktree(&worktree, &ws_id)
                            .await
                        {
                            Ok(env) => env,
                            Err(e) => {
                                warn!(
                                    agent_id,
                                    worktree = %worktree,
                                    error = %e,
                                    "lazy-resume: assemble runtime env failed; continuing with empty env"
                                );
                                crate::runtime::SpawnRuntimeEnv::default()
                            }
                        };
                        let resume_res = self
                            .agents
                            .lock()
                            .await
                            .resume_agent(
                                agent_id,
                                &acp_sid,
                                at,
                                &worktree,
                                &ws_id,
                                remote_workspace_id.as_deref(),
                                (!session_id.is_empty()).then_some(session_id.as_str()),
                                "",
                                None,
                                runtime_env,
                            )
                            .await;
                        match resume_res {
                            Ok(new_acp_sid) => {
                                let team_id = self.config.team_id.clone().unwrap_or_default();
                                if !session_id.is_empty() && !sender_actor_id.is_empty() {
                                    self.bind_remote_tool_member(
                                        agent_id,
                                        &session_id,
                                        &sender_actor_id,
                                        &team_id,
                                    )
                                    .await;
                                }
                                // Forward model_id if the client requested one
                                let desired_model = prompt.model_id.clone();
                                if !desired_model.is_empty() {
                                    let mut agents = self.agents.lock().await;
                                    match agents.send_set_model(agent_id, &desired_model).await {
                                        Ok(()) => {
                                            agents.set_current_model(agent_id, &desired_model);
                                        }
                                        Err(e) => {
                                            warn!(agent_id, model_id = %desired_model, "set_model after resume failed: {}", e);
                                        }
                                    }
                                }
                                self.prepare_remote_tool_context_for_turn(
                                    agent_id,
                                    &session_id,
                                    &sender_actor_id,
                                )
                                .await;
                                let requester = (!sender_actor_id.is_empty())
                                    .then(|| sender_actor_id.clone());
                                let send_res = self
                                    .agents
                                    .lock()
                                    .await
                                    .send_prompt_with_requester(
                                        agent_id,
                                        &prompt.text,
                                        prompt.attachment_urls.clone(),
                                        requester,
                                    )
                                    .await;
                                if let Err(e) = send_res {
                                    warn!(agent_id, "lazy resume prompt send failed: {}", e);
                                    self.publish_session_event(
                                        agent_id,
                                        amux::SessionEvent {
                                            event: Some(
                                                amux::session_event::Event::PromptRejected(
                                                    amux::PromptRejected {
                                                        command_id,
                                                        reason: format!(
                                                        "failed to send prompt after resume: {}",
                                                        e
                                                    ),
                                                    },
                                                ),
                                            ),
                                        },
                                    )
                                    .await;
                                    return;
                                }
                                // Update stored session with potentially new acp_session_id
                                if let Some(s) = self.sessions.find_by_id_mut(agent_id) {
                                    s.acp_session_id = new_acp_sid;
                                    s.session_id = session_id.clone();
                                    s.status = amux::AgentStatus::Active as i32;
                                    s.last_prompt = prompt.text.clone();
                                }
                                let _ = self.sessions.save(&self.sessions_path);
                                info!(agent_id, peer_id, "session resumed, prompt sent");
                                self.publish_session_event(
                                    agent_id,
                                    amux::SessionEvent {
                                        event: Some(amux::session_event::Event::PromptAccepted(
                                            amux::PromptAccepted { command_id },
                                        )),
                                    },
                                )
                                .await;
                                self.publish_runtime_state_by_id(agent_id).await;
                            }
                            Err(e) => {
                                warn!(agent_id, "lazy resume failed: {}", e);
                                self.publish_session_event(
                                    agent_id,
                                    amux::SessionEvent {
                                        event: Some(amux::session_event::Event::PromptRejected(
                                            amux::PromptRejected {
                                                command_id,
                                                reason: format!("session resume failed: {}", e),
                                            },
                                        )),
                                    },
                                )
                                .await;
                            }
                        }
                        return;
                    }
                }

                // Check busy
                let busy_reject: Option<String> = {
                    let agents = self.agents.lock().await;
                    if let Some(handle) = agents.get_handle(agent_id) {
                        self.permissions.check_agent_busy(handle.status).err()
                    } else {
                        None
                    }
                };
                if let Some(reason) = busy_reject {
                    self.publish_session_event(
                        agent_id,
                        amux::SessionEvent {
                            event: Some(amux::session_event::Event::PromptRejected(
                                amux::PromptRejected { command_id, reason },
                            )),
                        },
                    )
                    .await;
                    return;
                }

                // If the client requested a specific model and it differs from
                // the one we last applied, forward a SetModel command before
                // the prompt so the new turn runs on the requested model.
                let desired_model = prompt.model_id.clone();
                let mut model_changed = false;
                if !desired_model.is_empty() {
                    let current = self
                        .agents
                        .lock()
                        .await
                        .current_model(agent_id)
                        .cloned()
                        .unwrap_or_default();
                    if desired_model != current {
                        let mut agents = self.agents.lock().await;
                        match agents.send_set_model(agent_id, &desired_model).await {
                            Ok(()) => {
                                agents.set_current_model(agent_id, &desired_model);
                                model_changed = true;
                            }
                            Err(e) => {
                                warn!(agent_id, model_id = %desired_model, "send_set_model failed: {}", e);
                            }
                        }
                    }
                }
                if model_changed {
                    self.publish_runtime_state_by_id(agent_id).await;
                }

                // Send prompt to agent (respawns if process exited)
                let session_id = self
                    .agents
                    .lock()
                    .await
                    .get_handle(agent_id)
                    .map(|h| h.session_id.clone())
                    .unwrap_or_default();
                self.prepare_remote_tool_context_for_turn(agent_id, &session_id, &sender_actor_id)
                    .await;
                let requester =
                    (!sender_actor_id.is_empty()).then(|| sender_actor_id.clone());
                let send_res = self
                    .agents
                    .lock()
                    .await
                    .send_prompt_with_requester(
                        agent_id,
                        &prompt.text,
                        prompt.attachment_urls.clone(),
                        requester,
                    )
                    .await;
                match send_res {
                    Ok(_drained) => {
                        {
                            let mut agents = self.agents.lock().await;
                            if let Some(handle) = agents.get_handle_mut(agent_id) {
                                handle.status = amux::AgentStatus::Active;
                                handle.current_prompt = prompt.text.clone();
                            }
                        }
                        if let Some(session) = self.sessions.find_by_id_mut(agent_id) {
                            session.last_prompt = prompt.text.clone();
                            let _ = self.sessions.save(&self.sessions_path);
                        }
                        info!(agent_id, peer_id, "prompt sent to agent");
                        self.publish_session_event(
                            agent_id,
                            amux::SessionEvent {
                                event: Some(amux::session_event::Event::PromptAccepted(
                                    amux::PromptAccepted { command_id },
                                )),
                            },
                        )
                        .await;
                        self.publish_runtime_state_by_id(agent_id).await;
                    }
                    Err(e) => {
                        warn!(agent_id, "failed to send prompt: {}", e);
                        self.publish_session_event(
                            agent_id,
                            amux::SessionEvent {
                                event: Some(amux::session_event::Event::PromptRejected(
                                    amux::PromptRejected {
                                        command_id,
                                        reason: format!("failed to send prompt: {}", e),
                                    },
                                )),
                            },
                        )
                        .await;
                    }
                }
            }

            amux::acp_command::Command::Cancel(_) => {
                let cancel_res = self.agents.lock().await.cancel_agent(agent_id).await;
                match cancel_res {
                    Ok(()) => {
                        {
                            let mut agents = self.agents.lock().await;
                            if let Some(handle) = agents.get_handle_mut(agent_id) {
                                handle.status = amux::AgentStatus::Idle;
                            }
                        }
                        info!(agent_id, peer_id, "agent cancelled via ACP");
                        self.publish_runtime_state_by_id(agent_id).await;
                    }
                    Err(e) => {
                        warn!(agent_id, "failed to cancel agent: {}", e);
                    }
                }
            }

            amux::acp_command::Command::GrantPermission(grant) => {
                let grant_option_id =
                    (!grant.option_id.is_empty()).then(|| grant.option_id.clone());
                if self.permissions.try_resolve_permission(&grant.request_id) {
                    // Resolve via ACP permission response
                    match self
                        .agents
                        .lock()
                        .await
                        .resolve_permission_for_topic(
                            agent_id,
                            &grant.request_id,
                            true,
                            grant_option_id,
                        )
                        .await
                    {
                        Ok(()) => {
                            info!(request_id = %grant.request_id, peer_id, agent_id, "permission granted via ACP");
                        }
                        Err(e) => {
                            warn!(
                                request_id = %grant.request_id,
                                peer_id,
                                agent_id,
                                error = %e,
                                "resolve_permission failed after grant; ACP may stay blocked"
                            );
                        }
                    }
                    self.publish_session_event(
                        agent_id,
                        amux::SessionEvent {
                            event: Some(amux::session_event::Event::PermissionResolved(
                                amux::PermissionResolved {
                                    request_id: grant.request_id,
                                    resolved_by_peer_id: peer_id,
                                    granted: true,
                                },
                            )),
                        },
                    )
                    .await;
                }
            }

            amux::acp_command::Command::DenyPermission(deny) => {
                if self.permissions.try_resolve_permission(&deny.request_id) {
                    // Resolve via ACP permission response
                    match self
                        .agents
                        .lock()
                        .await
                        .resolve_permission_for_topic(agent_id, &deny.request_id, false, None)
                        .await
                    {
                        Ok(()) => {
                            info!(request_id = %deny.request_id, peer_id, agent_id, "permission denied via ACP");
                        }
                        Err(e) => {
                            warn!(
                                request_id = %deny.request_id,
                                peer_id,
                                agent_id,
                                error = %e,
                                "resolve_permission failed after deny"
                            );
                        }
                    }
                    self.publish_session_event(
                        agent_id,
                        amux::SessionEvent {
                            event: Some(amux::session_event::Event::PermissionResolved(
                                amux::PermissionResolved {
                                    request_id: deny.request_id,
                                    resolved_by_peer_id: peer_id,
                                    granted: false,
                                },
                            )),
                        },
                    )
                    .await;
                }
            }

            amux::acp_command::Command::RequestHistory(req) => {
                use prost::Message;
                let page_size = if req.page_size == 0 {
                    50
                } else {
                    req.page_size
                };
                let (mut events, mut has_more) =
                    self.history
                        .read_page(agent_id, req.after_sequence, page_size);

                // Keep history replies under a conservative 10 KB publish
                // budget. Trim the batch by estimated encoded length so we never
                // produce a publish the broker will reject (which otherwise
                // forces the daemon's MQTT client to reconnect and knocks
                // every iOS peer offline in a loop).
                const HISTORY_BATCH_BUDGET: usize = 9500;
                while events.len() > 1 {
                    let estimate: usize = events
                        .iter()
                        .map(|e| {
                            let n = e.encoded_len();
                            1 + prost::encoding::encoded_len_varint(n as u64) + n
                        })
                        .sum::<usize>()
                        + req.request_id.len()
                        + 32;
                    if estimate < HISTORY_BATCH_BUDGET {
                        break;
                    }
                    events.pop();
                    has_more = true;
                }

                let next_seq = events
                    .last()
                    .map(|e| e.sequence)
                    .unwrap_or(req.after_sequence);
                info!(
                    agent_id,
                    peer_id,
                    after_seq = req.after_sequence,
                    count = events.len(),
                    has_more,
                    "history requested"
                );
                let batch = amux::HistoryBatch {
                    request_id: req.request_id,
                    events,
                    has_more,
                    next_after_sequence: next_seq,
                };
                self.publish_session_event(
                    agent_id,
                    amux::SessionEvent {
                        event: Some(amux::session_event::Event::HistoryBatch(batch)),
                    },
                )
                .await;
            }

            amux::acp_command::Command::RequestTurnHistory(req) => {
                use prost::Message;
                let mut events = self.history.read_turn(agent_id, &req.turn_id);
                let mut has_more = false;

                // Same 10 KB publish budget as RequestHistory. Turns are
                // usually small (tens of events) so a single batch covers
                // them. If a turn ever grows past the budget, trim the tail
                // and set has_more — iOS sees a partial turn and the local
                // streaming cache fills the gap until we add per-turn
                // pagination.
                const HISTORY_BATCH_BUDGET: usize = 9500;
                while events.len() > 1 {
                    let estimate: usize = events
                        .iter()
                        .map(|e| {
                            let n = e.encoded_len();
                            1 + prost::encoding::encoded_len_varint(n as u64) + n
                        })
                        .sum::<usize>()
                        + req.request_id.len()
                        + 32;
                    if estimate < HISTORY_BATCH_BUDGET {
                        break;
                    }
                    events.pop();
                    has_more = true;
                }

                info!(
                    agent_id,
                    peer_id,
                    turn_id = %req.turn_id,
                    count = events.len(),
                    has_more,
                    "turn history requested"
                );
                let batch = amux::HistoryBatch {
                    request_id: req.request_id,
                    events,
                    has_more,
                    next_after_sequence: 0,
                };
                self.publish_session_event(
                    agent_id,
                    amux::SessionEvent {
                        event: Some(amux::session_event::Event::HistoryBatch(batch)),
                    },
                )
                .await;
            }
        }
    }

    /// Publish a session event (e.g. HistoryBatch reply) onto the same
    /// canonical sink as agent-originated envelopes. Reuses
    /// `publish_envelope_to_sessions` so HistoryBatch responses land on
    /// `session/{sid}/live` next to the streaming output that triggered
    /// them — iOS subscribes there exclusively.
    pub(crate) async fn publish_session_event(&self, agent_id: &str, event: amux::SessionEvent) {
        // Session-level events (HistoryBatch reply, etc.) are not part of an
        // ACP turn; leave turn_id empty. iOS does not dedupe session events
        // by turn anyway.
        let envelope = amux::Envelope {
            runtime_id: agent_id.into(),
            actor_id: self.config.actor.id.clone(),
            source_peer_id: String::new(),
            timestamp: chrono::Utc::now().timestamp(),
            sequence: 0,
            turn_id: String::new(),
            acp_session_id: String::new(),
            payload: Some(amux::envelope::Payload::SessionEvent(event)),
        };
        self.publish_envelope_to_sessions(agent_id, &envelope).await;
    }

    // ─── Non-session RPC handlers ───
}

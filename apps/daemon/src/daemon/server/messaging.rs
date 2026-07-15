//! Extracted from `server.rs` — methods of `DaemonServer` grouped by concern.
//! See `server.rs` for the struct definition and core lifecycle.

use super::*;
use crate::runtime::acp_event_frame::AcpEventFrame;

/// One-way latency probe (dev-only). When the daemon is started with
/// AMUX_LATENCY_PROBE=1, outgoing ACP envelopes carry a `probe:<ms>` marker in
/// the otherwise-unused `source_peer_id` field; the desktop webview computes
/// `Date.now() - ms` on receipt (same machine → same clock).
fn latency_probe_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED
        .get_or_init(|| std::env::var("AMUX_LATENCY_PROBE").is_ok_and(|v| v == "1" || v == "true"))
}

impl DaemonServer {
    /// Build merged agent list: active agents + historical (non-active) sessions.
    /// Now only used by `publish_all_agent_states` to iterate startup/reconnect state.
    /// Per-agent updates should go through `publish_runtime_state_by_id`.
    pub(crate) async fn merged_agent_list(&self) -> amux::AgentList {
        let mut agent_list = self.agents.lock().await.to_proto_agent_list();
        let active_ids: std::collections::HashSet<String> = agent_list
            .runtimes
            .iter()
            .map(|a| a.runtime_id.clone())
            .collect();
        for session_info in self.sessions.to_proto_agent_list() {
            if !active_ids.contains(&session_info.runtime_id) {
                agent_list.runtimes.push(session_info);
            }
        }
        agent_list
    }

    /// Look up a single agent's current RuntimeInfo — live adapter first, then
    /// the historical session store. Returns `None` if unknown.
    pub(crate) async fn agent_info_by_id(&self, agent_id: &str) -> Option<amux::RuntimeInfo> {
        match self.agents.lock().await.to_proto_info(agent_id) {
            Some(info) => Some(info),
            None => self.sessions.to_proto_agent_info(agent_id),
        }
    }

    /// Publish retained RuntimeInfo for a single agent on its per-agent state
    /// topic. Swallows errors (same convention as other publish helpers).
    pub(crate) async fn publish_runtime_state_by_id(&self, agent_id: &str) {
        if let Some(info) = self.agent_info_by_id(agent_id).await {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher.publish_runtime_state(agent_id, &info).await;
        }
    }

    /// Publish every known agent (active + historical) individually. Used on
    /// startup and after MQTT reconnect so clients subscribing to the wildcard
    /// `agent/+/state` topic receive one retained message per agent — keeping
    /// each publish small instead of relying on a large broker packet limit,
    /// which the old single-list publish would blow past once the session
    /// count grew.
    pub(crate) async fn publish_all_agent_states(&self) {
        let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
        for info in self.merged_agent_list().await.runtimes {
            let _ = publisher
                .publish_runtime_state(&info.runtime_id, &info)
                .await;
        }
    }

    /// Returns the single collab session_id this runtime should publish
    /// ACP events to. Each runtime is bound at spawn time to one session
    /// via `RuntimeHandle.session_id` (set from
    /// `apply_start_runtime`'s remote_session_id), so fanout has to be
    /// scoped to that one session.
    ///
    /// Earlier versions of this function unioned in
    /// `teamclaw.sessions_for_agent(daemon_actor_id)` — the set of
    /// sessions where the daemon (as agent participant) lives. That set
    /// is "all collab sessions this daemon serves," not "the session
    /// this turn belongs to," so every agent event got fanned out to
    /// every session — bug observed 2026-04-27 where one user message
    /// in session A produced agent reply copies in 8 unrelated sessions
    /// (and 9× the broker traffic on every turn). The runtime's own
    /// `session_id` is the only correct destination.
    ///
    /// Returns an empty vec for ambient/bare-agent spawns where
    /// `session_id` was never set; callers fall back to the
    /// legacy per-runtime events topic in that case.
    ///
    /// Gateway-spawned runtimes never reach `apply_start_runtime` and
    /// therefore have no entry in the local SessionStore. They carry the
    /// cloud session UUID on their in-memory `RuntimeHandle` instead,
    /// so when the persisted lookup misses we fall back to RuntimeManager.
    pub(crate) async fn target_sessions(&self, agent_id: &str) -> Vec<String> {
        if let Some(sid) = self
            .sessions
            .find_by_id(agent_id)
            .map(|s| s.session_id.clone())
            .filter(|s| !s.is_empty())
        {
            return vec![sid];
        }
        let live = self
            .agents
            .lock()
            .await
            .get_handle(agent_id)
            .map(|h| h.session_id.clone())
            .unwrap_or_default();
        if live.is_empty() {
            Vec::new()
        } else {
            vec![live]
        }
    }

    pub(crate) async fn forward_agent_event(&mut self, agent_id: &str, frame: AcpEventFrame) {
        let acp_session_id = frame.acp_session_id.clone();
        let is_child_event = {
            let agents = self.agents.lock().await;
            agents
                .get_handle(agent_id)
                .map(|h| !acp_session_id.is_empty() && acp_session_id != h.acp_session_id)
                .unwrap_or(false)
        };
        let mut acp_event = frame.event;
        // Stamp the current model on agent-reply events (Output, Thinking) so iOS
        // bubbles can show which model produced the response. Other event types
        // (status changes, tool calls, permission requests, raw control messages)
        // are not model-attributable and stay empty. Safe to read current_model
        // here for the same reason as the collab publish path: the daemon event
        // loop is single-threaded, so no SetModel can interleave between the
        // agent's reply and this lookup.
        if matches!(
            acp_event.event,
            Some(amux::acp_event::Event::Output(_)) | Some(amux::acp_event::Event::Thinking(_))
        ) {
            if let Some(model) = self.agents.lock().await.current_model(agent_id).cloned() {
                acp_event.model = model;
            }
        }

        // Register permission requests for later resolution
        if let Some(amux::acp_event::Event::PermissionRequest(ref pr)) = acp_event.event {
            self.permissions.register_pending(&pr.request_id);
        }

        if let Some(amux::acp_event::Event::Error(ref err)) = acp_event.event {
            let message = if err.message.is_empty() {
                "ACP runtime error".to_string()
            } else {
                err.message.clone()
            };
            let details = if err.details.is_empty() {
                message.clone()
            } else {
                err.details.clone()
            };
            {
                let mut agents = self.agents.lock().await;
                if let Some(handle) = agents.get_handle_mut(agent_id) {
                    handle.status = amux::AgentStatus::Error;
                }
            }
            if let Some(session) = self.sessions.find_by_id_mut(agent_id) {
                session.status = amux::AgentStatus::Error as i32;
                let _ = self.sessions.save(&self.sessions_path);
            }
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher
                .publish_runtime_failed(agent_id, "ACP_ERROR", &details, "acp")
                .await;
        }

        // Handle internal RawJson events (session_title, tool_title_update)
        if let Some(amux::acp_event::Event::Raw(ref raw)) = acp_event.event {
            if raw.method == "session_title" {
                let title = String::from_utf8_lossy(&raw.json_payload).to_string();
                let updated = {
                    let mut agents = self.agents.lock().await;
                    if let Some(handle) = agents.get_handle_mut(agent_id) {
                        handle.session_title = title;
                        true
                    } else {
                        false
                    }
                };
                if updated {
                    self.publish_runtime_state_by_id(agent_id).await;
                }
                return;
            }
            if raw.method == "tool_title_update" {
                // Format: "tool_id|new_title"
                let payload = String::from_utf8_lossy(&raw.json_payload);
                if let Some((_tool_id, _new_title)) = payload.split_once('|') {
                    // Forward as a ToolUse event so iOS updates the tool name
                    let update_event = amux::AcpEvent {
                        event: Some(amux::acp_event::Event::Raw(amux::AcpRawJson {
                            method: "tool_title_update".into(),
                            json_payload: raw.json_payload.clone(),
                        })),
                        model: String::new(),
                    };
                    let (seq, turn_id) = {
                        let mut agents = self.agents.lock().await;
                        let seq = agents
                            .get_handle_mut(agent_id)
                            .map(|h| h.next_sequence())
                            .unwrap_or(0);
                        let turn_id = agents
                            .aggregator(agent_id)
                            .and_then(|a| a.current_turn_id())
                            .unwrap_or("")
                            .to_string();
                        (seq, turn_id)
                    };
                    let envelope = amux::Envelope {
                        runtime_id: agent_id.into(),
                        actor_id: self.config.actor.id.clone(),
                        source_peer_id: String::new(),
                        timestamp: chrono::Utc::now().timestamp(),
                        sequence: seq,
                        turn_id,
                        acp_session_id: if is_child_event {
                            acp_session_id.clone()
                        } else {
                            String::new()
                        },
                        payload: Some(amux::envelope::Payload::AcpEvent(update_event)),
                    };
                    self.history.append(agent_id, &envelope);
                    self.publish_envelope_to_sessions(agent_id, &envelope).await;
                }
                return;
            }
        }

        // Update agent status if this is a status change event
        if let Some(amux::acp_event::Event::StatusChange(ref sc)) = acp_event.event {
            {
                let mut agents = self.agents.lock().await;
                if let Some(handle) = agents.get_handle_mut(agent_id) {
                    handle.status = amux::AgentStatus::try_from(sc.new_status)
                        .unwrap_or(amux::AgentStatus::Unknown);
                }
            }
            if let Some(session) = self.sessions.find_by_id_mut(agent_id) {
                session.status = sc.new_status;
                let _ = self.sessions.save(&self.sessions_path);
            }
            self.publish_runtime_state_by_id(agent_id).await;

            // Upsert agent_runtimes on status transitions
            {
                let sb = &self.backend;
                let new_status = amux::AgentStatus::try_from(sc.new_status)
                    .unwrap_or(amux::AgentStatus::Unknown);
                let cloud_status: &'static str = match new_status {
                    amux::AgentStatus::Active => "running",
                    amux::AgentStatus::Idle => "idle",
                    amux::AgentStatus::Stopped => "stopped",
                    _ => "unknown",
                };
                let (acp_sid, session_id, ws_id, current_model, backend_type) = {
                    let agents = self.agents.lock().await;
                    let h = agents.get_handle(agent_id);
                    (
                        h.map(|h| h.acp_session_id.clone()).unwrap_or_default(),
                        h.map(|h| h.session_id.clone()).unwrap_or_default(),
                        h.map(|h| h.workspace_id.clone()).unwrap_or_default(),
                        agents.current_model(agent_id).cloned(),
                        h.map(|h| agents.launch_config_for(h.agent_type).backend_type)
                            .unwrap_or("claude"),
                    )
                };
                let cloud_workspace_id = (!ws_id.is_empty()).then_some(ws_id.clone());
                let team_id = sb.team_id().to_string();
                let actor_id = sb.actor_id().to_string();
                let runtime_id_owned = agent_id.to_string();
                let sb_clone = sb.clone();
                let now = chrono::Utc::now();
                tokio::spawn(async move {
                    let row = AgentRuntimeUpsert {
                        team_id: &team_id,
                        agent_id: &actor_id,
                        session_id: (!session_id.is_empty()).then_some(session_id.as_str()),
                        workspace_id: cloud_workspace_id.as_deref(),
                        backend_type,
                        backend_session_id: if acp_sid.is_empty() {
                            None
                        } else {
                            Some(acp_sid.as_str())
                        },
                        runtime_id: Some(runtime_id_owned.as_str()),
                        status: cloud_status,
                        current_model: current_model.as_deref(),
                        last_seen_at: now,
                    };
                    if let Err(e) = sb_clone.upsert_agent_runtime(&row).await {
                        warn!("agent_runtimes upsert ({cloud_status}): {e}");
                    }
                });
            }
        }

        // Update session on tool use
        if let Some(amux::acp_event::Event::ToolUse(_)) = acp_event.event {
            {
                let mut agents = self.agents.lock().await;
                if let Some(handle) = agents.get_handle_mut(agent_id) {
                    handle.tool_use_count += 1;
                }
            }
            if let Some(session) = self.sessions.find_by_id_mut(agent_id) {
                session.tool_use_count += 1;
                let _ = self.sessions.save(&self.sessions_path);
            }
        }

        // Drive the per-agent TurnAggregator. Emitted logical messages are
        // appended to local TOML, published to session/live as
        // `message.created`, and (for AGENT_REPLY only) persisted to
        // cloud `messages`. ACP `acp.event` envelopes still flow through
        // the unchanged publish path below for streaming UI.
        let collab_sessions = self.target_sessions(agent_id).await;
        // Allocate the envelope sequence up front so it can also stamp
        // emitted messages (cloud `messages.sequence`). The envelope
        // append below uses the same value, keeping a 1:1 link between an
        // ACP event boundary and the messages that flowed from it.
        let (emitted, turn_id, seq) = {
            let mut agents = self.agents.lock().await;
            let seq = agents
                .get_handle_mut(agent_id)
                .map(|h| h.next_sequence())
                .unwrap_or(0);
            match agents.aggregator_mut(agent_id) {
                Some(agg) if !is_child_event => {
                    // ingest may transition Active→Idle, which clears
                    // current_turn_id. Read AFTER ingest so the envelope for
                    // the final status-change carries an empty turn_id (the
                    // turn just ended); deltas / completions within an active
                    // turn capture the still-Some id.
                    let emitted = agg.ingest(&acp_event);
                    let turn_id = agg.current_turn_id().unwrap_or("").to_string();
                    (emitted, turn_id, seq)
                }
                Some(agg) => {
                    let turn_id = agg.current_turn_id().unwrap_or("").to_string();
                    (Vec::new(), turn_id, seq)
                }
                None => (Vec::new(), String::new(), seq),
            }
        };
        if !collab_sessions.is_empty() && !emitted.is_empty() {
            if let Some(tc) = self.teamclaw.as_ref() {
                let actor_id = self.actor_id.clone();
                let model = self
                    .agents
                    .lock()
                    .await
                    .current_model(agent_id)
                    .cloned()
                    .unwrap_or_default();
                for msg in emitted {
                    let persist =
                        crate::runtime::turn_aggregator::TurnAggregator::cloud_persistent(&msg);
                    // Non-persistent kinds (AgentThinking / AgentToolCall /
                    // AgentToolResult) are already fully covered by the
                    // acp.event stream below — re-publishing them as
                    // message.created on session/live just makes iOS
                    // render the same content twice (folded thinking card
                    // + plain bubble via handleIncomingChatMessage). Only
                    // AgentReply needs message.created, since that is the
                    // turn-finalized form persisted to the cloud backend and used
                    // by historical replay / other collaborators.
                    if !persist {
                        continue;
                    }
                    let kind = msg.kind;
                    let content = msg.content;
                    let metadata_json = msg.metadata_json;
                    let turn_id = msg.turn_id;
                    for sid in &collab_sessions {
                        tc.emit_agent_message(
                            sid,
                            &actor_id,
                            kind,
                            &content,
                            &metadata_json,
                            &model,
                            &turn_id,
                            seq,
                            persist,
                            Some(&self.backend),
                        )
                        .await;
                    }
                }
            }
        }

        // Ambient state variants (replaced wholesale on each push) should not
        // be persisted into the history buffer — replaying stale lists on
        // reconnect wastes bandwidth and contradicts the "in-memory only"
        // contract iOS assumes.
        let is_ambient = matches!(
            acp_event.event,
            Some(amux::acp_event::Event::AvailableCommands(_))
        );

        // Keep publishes under a conservative 10 KB budget. Claude Code's
        // AvailableCommands list with full descriptions routinely lands at
        // ~12 KB, which can trip broker packet limits and knock the daemon's
        // MQTT session offline mid-session-start. Trim descriptions (and as a
        // last resort commands themselves) in-place until the envelope fits.
        if let Some(amux::acp_event::Event::AvailableCommands(ref mut ac)) = acp_event.event {
            fit_available_commands_in_budget(ac);
            // Cache the trimmed list so the retained `runtime/{id}/state`
            // publish carries the same commands a fresh subscriber would
            // otherwise miss (events stream is not retained). Republish
            // immediately — ACP's AvailableCommandsUpdate fires after spawn
            // but typically before any status transition, so without this
            // bump the retained state would stay empty until the next
            // unrelated transition.
            self.agents
                .lock()
                .await
                .set_available_commands(agent_id, ac.commands.clone());
            self.publish_runtime_state_by_id(agent_id).await;
        }

        let envelope = amux::Envelope {
            runtime_id: agent_id.into(),
            actor_id: self.config.actor.id.clone(),
            // Agent-initiated events leave this empty. Under AMUX_LATENCY_PROBE=1
            // we borrow the (otherwise never-read) field to carry the publish-side
            // ms timestamp so the desktop can measure one-way transport latency
            // (daemon publish → webview receive) without a proto change. The
            // probe measures exactly the segment a local SSE fast-path would
            // eliminate: it stamps AFTER the 50ms drain pump and BEFORE the
            // frontend rAF buffer, both of which are transport-independent.
            source_peer_id: if latency_probe_enabled() {
                format!("probe:{}", chrono::Utc::now().timestamp_millis())
            } else {
                String::new()
            },
            timestamp: chrono::Utc::now().timestamp(),
            sequence: seq,
            turn_id,
            acp_session_id: if is_child_event {
                acp_session_id
            } else {
                String::new()
            },
            payload: Some(amux::envelope::Payload::AcpEvent(acp_event)),
        };

        if !is_ambient {
            self.history.append(agent_id, &envelope);
        }
        self.publish_envelope_to_sessions(agent_id, &envelope).await;
    }

    /// Enforce the one-live-runtime-per-session invariant at message-routing
    /// time. If multiple handles leaked into memory (race, stale resume, etc.),
    /// keep the newest and stop the rest before fanning out a prompt.
    pub(crate) async fn coalesce_session_runtimes(&mut self, session_id: &str) -> Vec<String> {
        let ids = self.agents.lock().await.runtime_ids_for_session(session_id);
        if ids.len() <= 1 {
            return ids;
        }
        let keep = self
            .agents
            .lock()
            .await
            .newest_runtime_id_for_session(session_id);
        let Some(keep) = keep else {
            return ids;
        };
        let superseded: Vec<String> = ids.into_iter().filter(|id| id != &keep).collect();
        warn!(
            session_id = %session_id,
            keep = %keep,
            superseded = ?superseded,
            "coalesce_session_runtimes: stopping duplicate live runtimes before fanout"
        );
        for rid in &superseded {
            self.agents.lock().await.stop_agent(rid).await;
            if let Some(s) = self.sessions.find_by_id_mut(rid) {
                s.status = amux::AgentStatus::Stopped as i32;
            }
        }
        if !superseded.is_empty() {
            let _ = self.sessions.save(&self.sessions_path);
        }
        vec![keep]
    }

    /// Route an inbound `message.created` from `session/{sid}/live` to the
    /// appropriate runtimes: mentioned runtimes receive a real prompt (which
    /// flushes any queued silent context first); un-mentioned runtimes have
    /// the message appended to `pending_silent` for delivery on next mention.
    ///
    /// Self-authored messages (i.e. sent by this daemon's own actor_id) are
    /// silently dropped to prevent feedback loops.
    pub(crate) async fn route_session_message(
        &mut self,
        session_id: &str,
        message: &crate::proto::teamclaw::Message,
        mention_actor_ids: &[String],
    ) {
        // Skip messages this daemon authored — those are the agent reply we
        // just emitted; routing them back into our own runtimes would loop.
        if message.sender_actor_id == self.actor_id {
            return;
        }

        let runtime_ids = self.coalesce_session_runtimes(session_id).await;
        if runtime_ids.is_empty() {
            if self
                .resume_historical_runtimes_for_session(
                    session_id,
                    (!message.sender_actor_id.is_empty()).then_some(message.sender_actor_id.as_str()),
                )
                .await
            {
                return;
            }

            let runtime_ids = self.coalesce_session_runtimes(session_id).await;
            if !runtime_ids.is_empty() {
                self.route_session_message_to_runtimes(
                    session_id,
                    message,
                    mention_actor_ids,
                    runtime_ids,
                )
                .await;
                return;
            }

            // We're subscribed to session/{sid}/live but have no runtime
            // for it and no resumable historical runtime on disk. The daemon
            // cannot infer worktree/backend session details from the live
            // message alone, so this message cannot be routed locally.
            warn!(
                session_id = %session_id,
                message_id = %message.message_id,
                sender_actor_id = %message.sender_actor_id,
                "route_session_message: no runtime for session; dropping message"
            );
            return;
        }

        self.route_session_message_to_runtimes(session_id, message, mention_actor_ids, runtime_ids)
            .await;
    }

    pub(crate) async fn route_session_message_to_runtimes(
        &mut self,
        session_id: &str,
        message: &crate::proto::teamclaw::Message,
        mention_actor_ids: &[String],
        runtime_ids: Vec<String>,
    ) {
        use crate::runtime::PendingMessage;

        if message.sender_actor_id == self.actor_id {
            return;
        }

        // Single dedup gate for ALL ingestion paths. A freshly-sent message
        // reaches the daemon twice — once via live MQTT `message.created` and
        // once via the runtimeStart→catchup replay (it is already persisted by
        // the time the client fires runtimeStart). Both funnel through this
        // sink, so deduping here (keyed by message_id) guarantees each message
        // is prompted/queued exactly once regardless of which path wins the
        // race. Cross-restart dedup relies on `last_processed_message_id` and
        // catchup reconcile (see `reconcile_runtime_cursor`), not this cache.
        if !message.message_id.is_empty() {
            if let Some(tc) = self.teamclaw.as_mut() {
                if !tc.should_process_message(session_id, &message.message_id) {
                    debug!(
                        session_id = %session_id,
                        message_id = %message.message_id,
                        "route_session_message: already processed; skipping (dedup gate)"
                    );
                    return;
                }
            }
        }

        let sender_display = self
            .display_name_for_actor(&message.sender_actor_id)
            .unwrap_or_else(|| message.sender_actor_id.chars().take(8).collect());

        // Each runtime in this list belongs to this daemon, so a mention of
        // this daemon's actor engages the runtime. The handle's `agent_id`
        // is the 8-char runtime key (per CLAUDE.md glossary), NOT the actor
        // id that mention_actor_ids encodes — matching against it would
        // never hit and every message would fall through to silent queue.
        let mentioned_actor = mention_actor_ids.iter().any(|m| m == &self.actor_id);
        if mention_actor_ids.is_empty() {
            warn!(
                message_id = %message.message_id,
                daemon_actor_id = %self.actor_id,
                "route_session_message: empty mention_actor_ids; message will be silent-queued"
            );
        } else if !mentioned_actor {
            debug!(
                message_id = %message.message_id,
                daemon_actor_id = %self.actor_id,
                mention_actor_ids = ?mention_actor_ids,
                "route_session_message: mention_actor_ids present but not this daemon; silent-queued"
            );
        }
        let attachment_urls = message_attachment_urls(message);
        for runtime_id in runtime_ids {
            if self.agents.lock().await.agent_id_of(&runtime_id).is_none() {
                continue;
            }
            let mentioned = mentioned_actor;

            if mentioned {
                let prompt_body = message.content.trim();
                if prompt_body.is_empty() && attachment_urls.is_empty() {
                    warn!(
                        runtime_id = %runtime_id,
                        message_id = %message.message_id,
                        "route_session_message: mentioned but empty content; skipping send_prompt"
                    );
                    continue;
                }
                info!(
                    runtime_id = %runtime_id,
                    message_id = %message.message_id,
                    mention_actor_ids = ?mention_actor_ids,
                    "route_session_message: @ mention matched; sending prompt"
                );
                // Real prompt — flush_pending_silent inside send_prompt does the prefix work.
                info!(
                    runtime_id = %runtime_id,
                    message_id = %message.message_id,
                    session_id = %session_id,
                    "route_session_message: delivering mentioned prompt to runtime"
                );
                if let Some(desired_model) = session_message_model_override(message) {
                    let current_model = self
                        .agents
                        .lock()
                        .await
                        .current_model(&runtime_id)
                        .cloned()
                        .unwrap_or_default();
                    if desired_model != current_model {
                        let mut agents = self.agents.lock().await;
                        match agents.send_set_model(&runtime_id, &desired_model).await {
                            Ok(()) => {
                                agents.set_current_model(&runtime_id, &desired_model);
                            }
                            Err(e) => {
                                warn!(
                                    runtime_id = %runtime_id,
                                    message_id = %message.message_id,
                                    model_id = %desired_model,
                                    err = %e,
                                    "route_session_message: send_set_model failed"
                                );
                            }
                        }
                    }
                }
                let send_res = self
                    .agents
                    .lock()
                    .await
                    .send_prompt(
                        &runtime_id,
                        message.content.as_str(),
                        attachment_urls.clone(),
                    )
                    .await;
                let _drained = match send_res {
                    Ok(d) => {
                        info!(
                            runtime_id = %runtime_id,
                            message_id = %message.message_id,
                            drained_silent = d.len(),
                            "route_session_message: send_prompt ok"
                        );
                        d
                    }
                    Err(e) => {
                        warn!(runtime_id = %runtime_id, err = ?e, "send_prompt failed");
                        continue;
                    }
                };

                self.persist_runtime_cursor(&runtime_id, &message.message_id)
                    .await;
            } else {
                // Silent: queue for next real prompt.
                {
                    let mut agents = self.agents.lock().await;
                    if let Some(handle) = agents.get_handle_mut(&runtime_id) {
                        handle.pending_silent.push(PendingMessage {
                            message_id: message.message_id.clone(),
                            sender_display: sender_display.clone(),
                            content: message.content.clone(),
                            created_at: message.created_at,
                        });
                    }
                }
                self.persist_runtime_cursor(&runtime_id, &message.message_id)
                    .await;
            }
        }
    }

    /// Advance in-memory cursor immediately; persist to Cloud in the background.
    pub(crate) async fn persist_runtime_cursor(&self, runtime_id: &str, message_id: &str) {
        if message_id.is_empty() {
            return;
        }
        {
            let mut agents = self.agents.lock().await;
            agents.advance_message_cursor(runtime_id, message_id);
        }
        let row_id = self.agents.lock().await.backend_runtime_row_id(runtime_id);
        if let Some(row_id) = row_id {
            let backend = self.backend.clone();
            let message_id = message_id.to_string();
            let runtime_id = runtime_id.to_string();
            tokio::spawn(async move {
                if let Err(e) = backend.update_runtime_cursor(&row_id, &message_id).await {
                    warn!(?e, runtime_id, "update_runtime_cursor failed");
                }
            });
        }
    }

    /// Align in-memory and persisted cursor with messages that already have an
    /// agent reply, so catchup does not re-prompt completed @mentions.
    ///
    /// Returns the full session message list when fetch succeeds so
    /// [`Self::catchup_runtime`] can slice locally instead of refetching.
    pub(crate) async fn reconcile_runtime_cursor(
        &mut self,
        runtime_id: &str,
    ) -> Option<Vec<crate::backend::StoredMessage>> {
        let (session_id, floor) = {
            let agents = self.agents.lock().await;
            let h = agents.get_handle(runtime_id)?;
            (h.session_id.clone(), h.last_processed_message_id.clone())
        };
        if session_id.is_empty() {
            return None;
        }

        let messages = match self.backend.messages_after_cursor(&session_id, None).await {
            Ok(m) => m,
            Err(e) => {
                warn!(
                    ?e,
                    runtime_id, "reconcile_runtime_cursor: messages fetch failed"
                );
                return None;
            }
        };
        if messages.is_empty() {
            return None;
        }

        let floor = floor.as_deref().filter(|s| !s.is_empty());
        let effective = compute_effective_cursor_from_messages(&messages, &self.actor_id, floor);
        if let Some(id) = effective {
            info!(
                runtime_id,
                cursor = %id,
                "reconcile_runtime_cursor: advanced from message history"
            );
            self.persist_runtime_cursor(runtime_id, &id).await;
        }
        Some(messages)
    }

    pub(crate) fn mark_superseded_runtime_rows_stopped(&mut self, superseded: &[String]) {
        for runtime_id in superseded {
            if let Some(s) = self.sessions.find_by_id_mut(runtime_id) {
                s.status = amux::AgentStatus::Stopped as i32;
            }
        }
        if !superseded.is_empty() {
            let _ = self.sessions.save(&self.sessions_path);
        }
    }

    /// Replay any session messages that arrived before this runtime was spawned.
    ///
    /// Fetches all messages after the runtime's `last_processed_message_id`
    /// cursor (None → fetch all) and routes each through the no-resume message
    /// router so live and catchup share identical semantics (mentioned → real
    /// prompt, un-mentioned → pending_silent queue).
    ///
    /// **Stale-mention compaction** (offline-replay-specific): when the
    /// daemon comes back online after missing N messages, only the *last*
    /// `@daemon` mention in the replay slice triggers a fresh turn — earlier
    /// `@daemon` rows are compacted into `pending_silent` even though they
    /// nominally mention us.
    pub async fn catchup_runtime(&mut self, runtime_id: &str) -> bool {
        let session_id = {
            let agents = self.agents.lock().await;
            let Some(h) = agents.get_handle(runtime_id) else {
                return false;
            };
            h.session_id.clone()
        };
        if session_id.is_empty() {
            return false;
        }

        let reconciled_all = self.reconcile_runtime_cursor(runtime_id).await;

        let last_processed_message_id = self
            .agents
            .lock()
            .await
            .get_handle(runtime_id)
            .and_then(|h| h.last_processed_message_id.clone());

        let messages = if let Some(all) = reconciled_all {
            messages_strictly_after_cursor(&all, last_processed_message_id.as_deref())
        } else {
            match self
                .backend
                .messages_after_cursor(&session_id, last_processed_message_id.as_deref())
                .await
            {
                Ok(m) => m,
                Err(e) => {
                    warn!(?e, runtime_id, "catchup messages_after_cursor failed");
                    return false;
                }
            }
        };
        if messages.is_empty() {
            return false;
        }

        let my_actor = self.actor_id.clone();
        if !slice_has_actionable_inbound(&messages, &my_actor) {
            debug!(
                runtime_id,
                session_id = %session_id,
                "catchup_runtime: no actionable inbound messages after reconcile"
            );
            return false;
        }

        // Only the last *unanswered* @mention triggers a real prompt; earlier
        // @-mentions (including already-answered ones) are silent context.
        let last_mention_idx = last_unanswered_mention_idx(&messages, &my_actor);

        info!(
            runtime_id,
            count = messages.len(),
            last_mention_idx,
            "catching up runtime"
        );

        for (idx, m) in messages.iter().enumerate() {
            if self.agents.lock().await.get_handle(runtime_id).is_none() {
                warn!(
                    runtime_id,
                    session_id, "catchup found no runtime after resume"
                );
                return false;
            }
            let mention_ids = parse_mention_actor_ids(&m.metadata_json);
            let proto = crate::proto::teamclaw::Message {
                message_id: m.id.clone(),
                session_id: m.session_id.clone(),
                sender_actor_id: m.sender_actor_id.clone(),
                kind: 0,
                content: m.content.clone(),
                created_at: m.created_at,
                ..Default::default()
            };
            let effective_mentions: &[String] = if Some(idx) == last_mention_idx {
                &mention_ids
            } else {
                &[]
            };
            self.route_session_message_to_runtimes(
                &session_id,
                &proto,
                effective_mentions,
                vec![runtime_id.to_string()],
            )
            .await;
        }
        true
    }

    /// Look up a display name for an actor_id from the in-memory peer tracker.
    /// Returns `None` if the actor is unknown; the caller falls back to the
    /// first 8 chars of the actor_id.
    pub(crate) fn display_name_for_actor(&self, actor_id: &str) -> Option<String> {
        // PeerTracker is keyed by peer_id (session-scoped), not actor_id.
        // Search linearly for a matching member_id / peer entry.
        // If no match is found, return None and let the caller use the fallback.
        self.peers
            .get_peer(actor_id)
            .map(|p| p.display_name.clone())
    }

    /// Single sink for agent-originated envelopes. Fans out to
    /// `session/{sid}/live` for every session the agent is bound to.
    /// Returns silently when the agent has no session — every iOS
    /// session is session-backed today, so a bound-less agent is a
    /// legacy bare-runtime spawn whose `runtime/{rid}/events` topic
    /// has no subscriber. Logs a warn so it shows up if regression
    /// reintroduces session-less spawns.
    pub(crate) async fn publish_envelope_to_sessions(
        &self,
        agent_id: &str,
        envelope: &amux::Envelope,
    ) {
        let Some(tc) = self.teamclaw.as_ref() else {
            warn!(agent_id, "no teamclaw client; dropping envelope");
            return;
        };
        let sessions = self.target_sessions(agent_id).await;
        if sessions.is_empty() {
            warn!(agent_id, "agent has no bound session; dropping envelope");
            return;
        }
        let actor_id = self.actor_id.clone();
        for sid in &sessions {
            tc.publish_agent_acp_event(sid, &actor_id, envelope).await;
        }
    }

    /// Returns the primary (first running) agent ID for this daemon.
    /// Used to stamp new sessions with the host's agent without passing
    /// RuntimeManager into SessionManager.
    pub(crate) async fn primary_agent_id(&self) -> Option<String> {
        self.agents.lock().await.first_running_agent_id()
    }

    pub(crate) async fn runtime_id_for_agent_actor_in_session(
        &self,
        agent_actor_id: &str,
        session_id: &str,
    ) -> Option<String> {
        let agents = self.agents.lock().await;
        if agents.get_handle(agent_actor_id).is_some() {
            return Some(agent_actor_id.to_string());
        }
        if agent_actor_id == self.backend.actor_id() {
            return agents.running_agent_id_for_collab_session(session_id);
        }
        None
    }
}

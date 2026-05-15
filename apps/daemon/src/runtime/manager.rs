use std::collections::HashMap;
use tracing::{info, warn};
use uuid::Uuid;

use super::adapter;
use super::handle::RuntimeHandle;
use crate::proto::amux;
use crate::runtime::turn_aggregator::TurnAggregator;
use crate::supabase::{AgentRuntimeUpsert, SupabaseClient};
use chrono::Utc;

pub struct RuntimeManager {
    agents: HashMap<String, RuntimeHandle>,
    pub aggregators: std::collections::HashMap<String, TurnAggregator>,
    claude_binary: String,
    /// Tracks the model id currently applied to each agent's ACP session.
    /// Populated on spawn (after the adapter sends the initial set_model)
    /// and updated whenever set_current_model is called. The adapter is
    /// responsible for actually calling ACP `session/set_model`; this map
    /// is the daemon-side mirror used to populate RuntimeInfo.current_model.
    current_model_per_agent: HashMap<String, String>,
    /// Most recent slash commands reported via ACP `AvailableCommandsUpdate`,
    /// keyed by agent id. Cached so a fresh subscriber on the retained
    /// `runtime/{id}/state` topic sees the same list the agent already
    /// announced earlier on the (non-retained) events topic.
    available_commands_per_agent: HashMap<String, Vec<amux::AcpAvailableCommand>>,
    supabase: Option<SupabaseClient>,
    /// Test-only: records the last body sent per agent_id via send_prompt_raw.
    #[cfg(test)]
    last_sent: HashMap<String, String>,
}

impl RuntimeManager {
    pub fn new(binary: String, _flags: Vec<String>, supabase: Option<SupabaseClient>) -> Self {
        Self {
            agents: HashMap::new(),
            aggregators: std::collections::HashMap::new(),
            claude_binary: binary,
            current_model_per_agent: HashMap::new(),
            available_commands_per_agent: HashMap::new(),
            supabase,
            #[cfg(test)]
            last_sent: HashMap::new(),
        }
    }

    /// Records the latest slash-command list for an agent. Callers feed
    /// this from the adapter's translated `AvailableCommands` events so
    /// `to_proto_info` can include them in retained state.
    pub fn set_available_commands(
        &mut self,
        agent_id: &str,
        commands: Vec<amux::AcpAvailableCommand>,
    ) {
        self.available_commands_per_agent
            .insert(agent_id.to_string(), commands);
    }

    /// Records that an agent's session is now running on `model_id`.
    /// Caller is responsible for actually invoking ACP set_model on the
    /// adapter; this only updates the tracking map.
    pub fn set_current_model(&mut self, agent_id: &str, model_id: &str) {
        self.current_model_per_agent
            .insert(agent_id.to_string(), model_id.to_string());
    }

    /// Returns the model id last recorded for `agent_id`, if any.
    pub fn current_model(&self, agent_id: &str) -> Option<&String> {
        self.current_model_per_agent.get(agent_id)
    }

    /// Returns a mutable reference to the per-agent `TurnAggregator`, if any.
    /// Inserted on `spawn_agent` / `resume_agent` and removed on `stop_agent`.
    pub fn aggregator_mut(&mut self, agent_id: &str) -> Option<&mut TurnAggregator> {
        self.aggregators.get_mut(agent_id)
    }

    pub async fn spawn_agent(
        &mut self,
        agent_type: amux::AgentType,
        worktree: &str,
        prompt: &str,
        workspace_id: &str,
        supabase_workspace_id: Option<&str>,
        supabase_session_id: Option<&str>,
    ) -> crate::error::Result<String> {
        let agent_id = Uuid::new_v4().to_string()[..8].to_string();
        let mut handle = RuntimeHandle::new(
            agent_id.clone(),
            agent_type,
            worktree.into(),
            workspace_id.into(),
        );
        handle.current_prompt = prompt.into();
        handle.session_id = supabase_session_id.unwrap_or_default().to_string();

        let (initial_model_tx, initial_model_rx) =
            tokio::sync::oneshot::channel::<Option<String>>();
        let (acp_session_id_tx, acp_session_id_rx) = tokio::sync::oneshot::channel::<String>();

        let cmd_tx = adapter::spawn_acp_agent(
            self.claude_binary.clone(),
            worktree.to_string(),
            prompt.to_string(),
            agent_type,
            handle.event_tx.clone(),
            initial_model_tx,
            None,
            acp_session_id_tx,
        )?;

        handle.cmd_tx = Some(cmd_tx);
        handle.status = amux::AgentStatus::Active;

        info!(agent_id, worktree, "agent spawned via ACP");
        self.agents.insert(agent_id.clone(), handle);
        self.aggregators
            .insert(agent_id.clone(), TurnAggregator::new());

        // Wait for the adapter to report the model it applied. None means no
        // model was applied (no models known for this agent type, or the ACP
        // call failed); skip recording in that case.
        if let Ok(Some(model_id)) = initial_model_rx.await {
            self.set_current_model(&agent_id, &model_id);
        }

        // Capture ACP session_id
        if let Ok(acp_sid) = acp_session_id_rx.await {
            if let Some(h) = self.agents.get_mut(&agent_id) {
                h.acp_session_id = acp_sid;
            }
        }

        // Upsert agent_runtimes with status="starting"; capture the returned
        // row id so catchup_runtime can use update_runtime_cursor later.
        if let Some(sb) = &self.supabase {
            let acp_sid = self
                .agents
                .get(&agent_id)
                .map(|h| h.acp_session_id.clone())
                .unwrap_or_default();
            let row = AgentRuntimeUpsert {
                team_id: &sb.config().team_id,
                agent_id: &sb.config().actor_id,
                session_id: supabase_session_id,
                workspace_id: supabase_workspace_id,
                backend_type: "claude",
                backend_session_id: if acp_sid.is_empty() {
                    None
                } else {
                    Some(&acp_sid)
                },
                runtime_id: Some(agent_id.as_str()),
                status: "starting",
                current_model: self
                    .current_model_per_agent
                    .get(&agent_id)
                    .map(|s| s.as_str()),
                last_seen_at: Utc::now(),
            };
            match sb.upsert_agent_runtime(&row).await {
                Ok(Some(row_id)) => {
                    if let Some(handle) = self.agents.get_mut(&agent_id) {
                        handle.supabase_runtime_row_id = Some(row_id);
                    }
                }
                Ok(None) => warn!(agent_id, "upsert_agent_runtime returned no row id"),
                Err(e) => warn!("agent_runtimes upsert (starting): {e}"),
            }
        }

        Ok(agent_id)
    }

    pub async fn resume_agent(
        &mut self,
        agent_id: &str,
        acp_session_id: &str,
        agent_type: amux::AgentType,
        worktree: &str,
        workspace_id: &str,
        supabase_workspace_id: Option<&str>,
        supabase_session_id: Option<&str>,
        prompt: &str,
    ) -> crate::error::Result<String> {
        let mut handle = RuntimeHandle::new(
            agent_id.to_string(),
            agent_type,
            worktree.into(),
            workspace_id.into(),
        );
        handle.session_id = supabase_session_id.unwrap_or_default().to_string();

        let (initial_model_tx, initial_model_rx) =
            tokio::sync::oneshot::channel::<Option<String>>();
        let (acp_session_id_tx, acp_session_id_rx) = tokio::sync::oneshot::channel::<String>();

        let cmd_tx = adapter::spawn_acp_agent(
            self.claude_binary.clone(),
            worktree.to_string(),
            prompt.to_string(),
            agent_type,
            handle.event_tx.clone(),
            initial_model_tx,
            Some(acp_session_id.to_string()),
            acp_session_id_tx,
        )?;
        handle.cmd_tx = Some(cmd_tx);
        handle.status = amux::AgentStatus::Active;
        handle.current_prompt = prompt.to_string();

        info!(agent_id, worktree, "agent resumed via ACP");
        self.agents.insert(agent_id.to_string(), handle);
        self.aggregators
            .insert(agent_id.to_string(), TurnAggregator::new());

        // Capture initial model
        if let Ok(Some(model_id)) = initial_model_rx.await {
            self.set_current_model(agent_id, &model_id);
        }

        // Capture ACP session_id (may differ from input if resume failed)
        let new_acp_sid = if let Ok(sid) = acp_session_id_rx.await {
            if let Some(h) = self.agents.get_mut(agent_id) {
                h.acp_session_id = sid.clone();
            }
            sid
        } else {
            acp_session_id.to_string()
        };

        // Upsert agent_runtimes with status="starting" on resume
        if let Some(sb) = &self.supabase {
            let row = AgentRuntimeUpsert {
                team_id: &sb.config().team_id,
                agent_id: &sb.config().actor_id,
                session_id: supabase_session_id,
                workspace_id: supabase_workspace_id,
                backend_type: "claude",
                backend_session_id: if new_acp_sid.is_empty() {
                    None
                } else {
                    Some(&new_acp_sid)
                },
                runtime_id: Some(agent_id),
                status: "starting",
                current_model: self
                    .current_model_per_agent
                    .get(agent_id)
                    .map(|s| s.as_str()),
                last_seen_at: Utc::now(),
            };
            if let Err(e) = sb.upsert_agent_runtime(&row).await {
                warn!("agent_runtimes upsert (starting/resume): {e}");
            }
        }

        Ok(new_acp_sid)
    }

    pub async fn stop_agent(&mut self, agent_id: &str) -> Option<RuntimeHandle> {
        if let Some(mut handle) = self.agents.remove(agent_id) {
            self.aggregators.remove(agent_id);
            handle.status = amux::AgentStatus::Stopped;
            handle.shutdown().await;
            info!(agent_id, "agent stopped");
            Some(handle)
        } else {
            None
        }
    }

    /// Send a prompt to an existing agent via ACP, draining any pending_silent
    /// messages as a `[Context …]` prefix first.
    /// Returns the drained message IDs (empty when no pending context existed).
    pub async fn send_prompt(
        &mut self,
        agent_id: &str,
        text: &str,
    ) -> crate::error::Result<Vec<String>> {
        let (final_text, drained_ids) = if let Some(handle) = self.agents.get_mut(agent_id) {
            let (prefix, drained) = handle.flush_pending_silent();
            let final_text = if prefix.is_empty() {
                text.to_string()
            } else {
                format!("{prefix}{text}")
            };
            (final_text, drained)
        } else {
            return Err(crate::error::AmuxError::Agent(format!(
                "agent {} not found",
                agent_id
            )));
        };

        self.send_prompt_raw(agent_id, &final_text).await?;
        Ok(drained_ids)
    }

    /// Inner helper: send the given body to ACP without any prefix logic.
    async fn send_prompt_raw(&mut self, agent_id: &str, text: &str) -> crate::error::Result<()> {
        #[cfg(test)]
        {
            self.last_sent
                .insert(agent_id.to_string(), text.to_string());
            return Ok(());
        }
        #[cfg(not(test))]
        {
            let handle = self.agents.get(agent_id).ok_or_else(|| {
                crate::error::AmuxError::Agent(format!("agent {} not found", agent_id))
            })?;
            handle.send_prompt(text).await
        }
    }

    /// Public wrapper used by the SetModel RPC handler. Forwards to the
    /// adapter and immediately mirrors the choice into
    /// `current_model_per_agent` so retained `runtime/{id}/state` reflects
    /// the request without waiting for an out-of-band ack from the adapter.
    /// `runtime_id` is the same key `send_prompt` / `stop_agent` use.
    pub async fn set_model(
        &mut self,
        runtime_id: &str,
        model_id: &str,
    ) -> crate::error::Result<()> {
        self.send_set_model(runtime_id, model_id).await?;
        self.set_current_model(runtime_id, model_id);
        Ok(())
    }

    /// Forward a `SetModel` command onto the agent's ACP command channel.
    /// The adapter is responsible for performing `session/set_model`; the
    /// caller is responsible for updating `current_model_per_agent` once the
    /// command has been queued (we cannot wait for the adapter to confirm
    /// without changing the channel contract).
    pub async fn send_set_model(
        &mut self,
        agent_id: &str,
        model_id: &str,
    ) -> crate::error::Result<()> {
        let handle = self.agents.get(agent_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("agent {} not found", agent_id))
        })?;
        let tx = handle
            .cmd_tx
            .as_ref()
            .ok_or_else(|| crate::error::AmuxError::Agent("no ACP command channel".into()))?;
        tx.send(adapter::AcpCommand::SetModel {
            model_id: model_id.to_string(),
        })
        .await
        .map_err(|_| crate::error::AmuxError::Agent("ACP command channel closed".into()))
    }

    /// Returns an agent_id whose adapter has finished initializing and is ready
    /// for prompts. Excludes Starting (transient) and dead statuses -- an agent
    /// in Starting may crash before becoming Active, and baking that into a
    /// session's `primary_agent_id` would point to a dead slot.
    /// Used to populate the `primary_agent_id` of newly created collab sessions
    /// in v1 (multi-agent sessions are out of scope).
    pub fn first_running_agent_id(&self) -> Option<String> {
        self.agents
            .iter()
            .find(|(_, h)| {
                matches!(
                    h.status,
                    amux::AgentStatus::Active | amux::AgentStatus::Idle
                )
            })
            .map(|(id, _)| id.clone())
    }

    pub fn running_agent_id_for_collab_session(&self, session_id: &str) -> Option<String> {
        if session_id.is_empty() {
            return None;
        }
        self.agents
            .iter()
            .find(|(_, h)| {
                h.session_id == session_id
                    && matches!(
                        h.status,
                        amux::AgentStatus::Active | amux::AgentStatus::Idle
                    )
            })
            .map(|(id, _)| id.clone())
    }

    /// Cancel the current turn for an agent.
    pub async fn cancel_agent(&mut self, agent_id: &str) -> crate::error::Result<()> {
        let handle = self.agents.get(agent_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("agent {} not found", agent_id))
        })?;

        handle.cancel().await
    }

    /// Resolve a permission request for an agent.
    pub async fn resolve_permission(
        &mut self,
        agent_id: &str,
        request_id: &str,
        granted: bool,
    ) -> crate::error::Result<()> {
        let handle = self.agents.get(agent_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("agent {} not found", agent_id))
        })?;

        handle.resolve_permission(request_id, granted).await
    }

    pub fn get_handle(&self, agent_id: &str) -> Option<&RuntimeHandle> {
        self.agents.get(agent_id)
    }

    /// Find an existing live runtime matching the (session_id, agent_type,
    /// workspace_id) key. Used by `apply_start_runtime` to dedupe duplicate
    /// `RuntimeStart` RPCs from misbehaving clients into a single spawn.
    ///
    /// Bare-agent spawns (empty `session_id`) are never deduped — every such
    /// call gets its own runtime. `stop_agent` removes handles from the map,
    /// so anything present here is by definition still tracked; the caller
    /// reads `AgentStatus` off the retained state topic if it cares about
    /// liveness.
    pub fn find_active_runtime_for(
        &self,
        session_id: &str,
        agent_type: amux::AgentType,
        workspace_id: &str,
    ) -> Option<String> {
        if session_id.is_empty() {
            return None;
        }
        self.agents
            .iter()
            .find(|(_, h)| {
                h.session_id == session_id
                    && h.agent_type == agent_type
                    && h.workspace_id == workspace_id
            })
            .map(|(id, _)| id.clone())
    }

    pub fn get_handle_mut(&mut self, agent_id: &str) -> Option<&mut RuntimeHandle> {
        self.agents.get_mut(agent_id)
    }

    /// Drain events from all agents, returns (agent_id, event) pairs
    pub fn poll_events(&mut self) -> Vec<(String, amux::AcpEvent)> {
        let mut events = vec![];
        for (agent_id, handle) in &mut self.agents {
            while let Ok(event) = handle.event_rx.try_recv() {
                events.push((agent_id.clone(), event));
            }
        }
        events
    }

    pub fn to_proto_agent_list(&self) -> amux::AgentList {
        amux::AgentList {
            runtimes: self
                .agents
                .iter()
                .map(|(id, h)| {
                    let available = crate::runtime::models::available_models_for(h.agent_type);
                    let current = self
                        .current_model_per_agent
                        .get(id)
                        .cloned()
                        .unwrap_or_default();
                    let commands = self
                        .available_commands_per_agent
                        .get(id)
                        .cloned()
                        .unwrap_or_default();
                    h.to_proto_info(available, current, commands)
                })
                .collect(),
        }
    }

    /// Build a `RuntimeInfo` for a single agent, populating the model fields
    /// from the manager's tracking state. Returns None if the agent is unknown.
    pub fn to_proto_info(&self, agent_id: &str) -> Option<amux::RuntimeInfo> {
        let handle = self.agents.get(agent_id)?;
        let available = crate::runtime::models::available_models_for(handle.agent_type);
        let current = self
            .current_model_per_agent
            .get(agent_id)
            .cloned()
            .unwrap_or_default();
        let commands = self
            .available_commands_per_agent
            .get(agent_id)
            .cloned()
            .unwrap_or_default();
        Some(handle.to_proto_info(available, current, commands))
    }

    pub fn agent_ids(&self) -> Vec<String> {
        self.agents.keys().cloned().collect()
    }

    /// Return all runtime IDs whose handle has `session_id == session_id`.
    pub fn runtime_ids_for_session(&self, session_id: &str) -> Vec<String> {
        self.agents
            .iter()
            .filter(|(_, h)| h.session_id == session_id)
            .map(|(rid, _)| rid.clone())
            .collect()
    }

    /// Return the `agent_id` stored on the handle for the given runtime key.
    /// For handles created by spawn/resume, this equals the runtime key itself.
    pub fn agent_id_of(&self, runtime_id: &str) -> Option<String> {
        self.agents.get(runtime_id).map(|h| h.agent_id.clone())
    }

    /// Return the Supabase `agent_runtimes.id` for this runtime, if known.
    /// Currently `None` until Task 9 wires the upsert return value back here.
    pub fn supabase_runtime_row_id(&self, runtime_id: &str) -> Option<String> {
        self.agents
            .get(runtime_id)
            .and_then(|h| h.supabase_runtime_row_id.clone())
    }
}

#[cfg(test)]
impl RuntimeManager {
    /// Build a manager with a single dummy runtime pre-inserted, for tests.
    pub fn test_dummy_with_runtime(runtime_id: &str) -> Self {
        let mut mgr = RuntimeManager::new("claude".to_string(), vec![], None);
        let mut h = super::handle::RuntimeHandle::test_dummy();
        h.agent_id = runtime_id.to_string();
        mgr.agents.insert(runtime_id.to_string(), h);
        mgr
    }

    /// Insert a test runtime with explicit runtime_id, agent_id, and session_id.
    pub fn add_test_runtime(&mut self, runtime_id: &str, agent_id: &str, session_id: &str) {
        let mut h = super::handle::RuntimeHandle::test_dummy();
        h.agent_id = agent_id.to_string();
        h.session_id = session_id.to_string();
        self.agents.insert(runtime_id.to_string(), h);
    }

    /// Return the last body sent to the given runtime via send_prompt_raw.
    pub fn last_sent_to(&self, runtime_id: &str) -> Option<String> {
        self.last_sent.get(runtime_id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::super::handle::PendingMessage;
    use super::*;

    #[test]
    fn set_current_model_records_value() {
        let mut mgr = RuntimeManager::new("claude".to_string(), vec![], None);
        mgr.set_current_model("agent-1", "claude-sonnet-4-6");
        assert_eq!(
            mgr.current_model("agent-1").map(|s| s.as_str()),
            Some("claude-sonnet-4-6")
        );
    }

    #[test]
    fn current_model_returns_none_for_unknown_agent() {
        let mgr = RuntimeManager::new("claude".to_string(), vec![], None);
        assert_eq!(mgr.current_model("agent-1"), None);
    }

    #[test]
    fn running_agent_id_for_collab_session_ignores_stopped_agents() {
        let mut mgr = RuntimeManager::new("claude".to_string(), vec![], None);
        let mut stopped = RuntimeHandle::new(
            "stopped-1".to_string(),
            amux::AgentType::ClaudeCode,
            ".".to_string(),
            "workspace-1".to_string(),
        );
        stopped.session_id = "session-1".to_string();
        stopped.status = amux::AgentStatus::Stopped;

        let mut running = RuntimeHandle::new(
            "running-1".to_string(),
            amux::AgentType::ClaudeCode,
            ".".to_string(),
            "workspace-1".to_string(),
        );
        running.session_id = "session-1".to_string();
        running.status = amux::AgentStatus::Idle;

        mgr.agents.insert(stopped.agent_id.clone(), stopped);
        mgr.agents.insert(running.agent_id.clone(), running);

        assert_eq!(
            mgr.running_agent_id_for_collab_session("session-1")
                .as_deref(),
            Some("running-1")
        );
        assert_eq!(mgr.running_agent_id_for_collab_session("missing"), None);
    }

    #[test]
    fn find_active_runtime_for_matches_full_tuple() {
        let mut mgr = RuntimeManager::new("claude".to_string(), vec![], None);
        let mut h = RuntimeHandle::new(
            "rt-1".to_string(),
            amux::AgentType::ClaudeCode,
            "/tmp/wt".to_string(),
            "ws-1".to_string(),
        );
        h.session_id = "sess-1".to_string();
        mgr.agents.insert(h.agent_id.clone(), h);

        assert_eq!(
            mgr.find_active_runtime_for("sess-1", amux::AgentType::ClaudeCode, "ws-1"),
            Some("rt-1".to_string())
        );
        // workspace mismatch — different session in a different workspace
        // is a legitimate distinct runtime, not a dup.
        assert_eq!(
            mgr.find_active_runtime_for("sess-1", amux::AgentType::ClaudeCode, "ws-OTHER"),
            None
        );
        // session mismatch — distinct sessions on the same workspace also
        // get their own runtimes.
        assert_eq!(
            mgr.find_active_runtime_for("sess-OTHER", amux::AgentType::ClaudeCode, "ws-1"),
            None
        );
    }

    #[test]
    fn find_active_runtime_for_skips_bare_agent_spawns() {
        // Empty session_id is the bare-agent / test spawn sentinel. Two
        // such spawns must NOT dedupe into the first one — they're
        // explicit fresh runtimes.
        let mut mgr = RuntimeManager::new("claude".to_string(), vec![], None);
        let mut h = RuntimeHandle::new(
            "rt-bare".to_string(),
            amux::AgentType::ClaudeCode,
            ".".to_string(),
            "".to_string(),
        );
        h.session_id = "".to_string();
        mgr.agents.insert(h.agent_id.clone(), h);

        assert_eq!(
            mgr.find_active_runtime_for("", amux::AgentType::ClaudeCode, ""),
            None
        );
    }

    #[tokio::test]
    async fn send_prompt_drains_pending_silent_into_prefix() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        {
            let h = mgr.get_handle_mut("rt1").unwrap();
            h.pending_silent.push(PendingMessage {
                message_id: "m1".into(),
                sender_display: "Ann".into(),
                content: "earlier note".into(),
                created_at: 100,
            });
        }
        let drained = mgr.send_prompt("rt1", "real question").await.unwrap();
        assert_eq!(drained, vec!["m1".to_string()]);
        let last = mgr.last_sent_to("rt1").unwrap();
        assert!(last.contains("Ann: earlier note"), "body was: {last}");
        assert!(last.ends_with("real question"), "body was: {last}");
    }

    #[tokio::test]
    async fn send_prompt_no_pending_sends_plain_text() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        let drained = mgr.send_prompt("rt1", "hello").await.unwrap();
        assert!(drained.is_empty());
        assert_eq!(mgr.last_sent_to("rt1").as_deref(), Some("hello"));
    }

    #[tokio::test]
    async fn send_prompt_returns_err_for_missing_runtime() {
        let mut mgr = RuntimeManager::new("claude".to_string(), vec![], None);
        let result = mgr.send_prompt("nonexistent", "hello").await;
        assert!(result.is_err());
    }

    // ── mention-routing accessors ─────────────────────────────────────────────

    #[test]
    fn runtime_ids_for_session_filters_by_session() {
        let mut mgr = RuntimeManager::new("claude".to_string(), vec![], None);
        mgr.add_test_runtime("rt1", "agent_A", "session_S");
        mgr.add_test_runtime("rt2", "agent_B", "session_S");
        mgr.add_test_runtime("rt3", "agent_C", "session_OTHER");

        let mut ids = mgr.runtime_ids_for_session("session_S");
        ids.sort();
        assert_eq!(ids, vec!["rt1", "rt2"]);
        assert_eq!(mgr.runtime_ids_for_session("session_OTHER"), vec!["rt3"]);
        assert!(mgr.runtime_ids_for_session("unknown").is_empty());
    }

    #[test]
    fn agent_id_of_returns_handle_agent_id() {
        let mut mgr = RuntimeManager::new("claude".to_string(), vec![], None);
        mgr.add_test_runtime("rt1", "agent_X", "session_S");
        assert_eq!(mgr.agent_id_of("rt1").as_deref(), Some("agent_X"));
        assert_eq!(mgr.agent_id_of("missing"), None);
    }

    #[test]
    fn supabase_runtime_row_id_returns_none_when_unset() {
        let mut mgr = RuntimeManager::new("claude".to_string(), vec![], None);
        mgr.add_test_runtime("rt1", "agent_X", "session_S");
        // supabase_runtime_row_id defaults to None until Task 9 wires it.
        assert_eq!(mgr.supabase_runtime_row_id("rt1"), None);
    }

    /// Simulate the "mentioned" branch: send_prompt is called with the message content.
    #[tokio::test]
    async fn route_mentioned_sends_prompt() {
        let mut mgr = RuntimeManager::new("claude".to_string(), vec![], None);
        mgr.add_test_runtime("rt1", "agent_X", "session_S");

        // Simulates the mentioned path: directly call send_prompt (as route_session_message does).
        let mention_actor_ids = vec!["agent_X".to_string()];
        let runtime_ids = mgr.runtime_ids_for_session("session_S");
        for rid in runtime_ids {
            let agent_id = mgr.agent_id_of(&rid).unwrap();
            let mentioned = mention_actor_ids.iter().any(|m| m == &agent_id);
            if mentioned {
                mgr.send_prompt(&rid, "hi").await.unwrap();
            }
        }

        assert_eq!(mgr.last_sent_to("rt1").as_deref(), Some("hi"));
        assert!(mgr.get_handle("rt1").unwrap().pending_silent.is_empty());
    }

    /// Simulate the "not mentioned" branch: message is queued as pending_silent.
    #[tokio::test]
    async fn route_not_mentioned_queues_silent() {
        let mut mgr = RuntimeManager::new("claude".to_string(), vec![], None);
        mgr.add_test_runtime("rt1", "agent_X", "session_S");

        let mention_actor_ids: Vec<String> = vec!["agent_OTHER".to_string()];
        let runtime_ids = mgr.runtime_ids_for_session("session_S");
        for rid in &runtime_ids {
            let agent_id = mgr.agent_id_of(rid).unwrap();
            let mentioned = mention_actor_ids.iter().any(|m| m == &agent_id);
            if !mentioned {
                if let Some(h) = mgr.get_handle_mut(rid) {
                    h.pending_silent.push(PendingMessage {
                        message_id: "m1".into(),
                        sender_display: "Alice".into(),
                        content: "context".into(),
                        created_at: 100,
                    });
                }
            }
        }

        assert_eq!(mgr.last_sent_to("rt1"), None);
        assert_eq!(mgr.get_handle("rt1").unwrap().pending_silent.len(), 1);
        assert_eq!(
            mgr.get_handle("rt1").unwrap().pending_silent[0].message_id,
            "m1"
        );
    }
}

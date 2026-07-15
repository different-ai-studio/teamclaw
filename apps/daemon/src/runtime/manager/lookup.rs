//! Read-only agent lookups, extracted from `manager.rs`.
//!
//! Resolve a runtime/agent identity from one of the keys callers hold — a
//! cloud `session_id`, a runtime key, or an ACP session uuid. All are pure
//! reads of the manager's private `agents` map.
//!
//! Child module of `runtime::manager`, so the `impl RuntimeManager` block
//! reaches `agents` directly.

use crate::proto::amux;

use super::RuntimeManager;

impl RuntimeManager {
    /// Return all runtime IDs whose handle has `session_id == session_id`.
    pub fn runtime_ids_for_session(&self, session_id: &str) -> Vec<String> {
        self.agents
            .iter()
            .filter(|(_, h)| h.session_id == session_id)
            .map(|(rid, _)| rid.clone())
            .collect()
    }

    /// Among in-memory runtimes bound to `session_id`, return the one with
    /// the greatest `started_at`. Defense-in-depth when multiple runtimes
    /// leaked despite the one-runtime-per-session invariant.
    pub fn newest_runtime_id_for_session(&self, session_id: &str) -> Option<String> {
        self.agents
            .iter()
            .filter(|(_, h)| h.session_id == session_id)
            .max_by_key(|(_, h)| h.started_at)
            .map(|(id, _)| id.clone())
    }

    /// Return the `agent_id` stored on the handle for the given runtime key.
    /// For handles created by spawn/resume, this equals the runtime key itself.
    pub fn agent_id_of(&self, runtime_id: &str) -> Option<String> {
        self.agents.get(runtime_id).map(|h| h.agent_id.clone())
    }

    /// Member actor bound for remote-tool RPC on the live runtime for `session_id`.
    pub fn remote_tool_member_for_session(&self, session_id: &str) -> Option<String> {
        self.runtime_ids_for_session(session_id)
            .into_iter()
            .find_map(|rid| {
                self.get_handle(&rid).and_then(|h| {
                    if h.remote_tool_member_id.is_empty() {
                        None
                    } else {
                        Some(h.remote_tool_member_id.clone())
                    }
                })
            })
    }

    /// Return the backend `agent_runtimes.id` for this runtime, if known.
    /// Currently `None` until Task 9 wires the upsert return value back here.
    pub fn backend_runtime_row_id(&self, runtime_id: &str) -> Option<String> {
        self.agents
            .get(runtime_id)
            .and_then(|h| h.backend_runtime_row_id.clone())
    }

    /// Look up an agent runtime by its ACP session id (the 36-char uuid
    /// returned by `session/new` and stored on `RuntimeHandle.acp_session_id`).
    /// Returns the daemon-side 8-char `agent_id` key used by `send_prompt`.
    pub fn agent_id_by_acp_session(&self, acp_session_id: &str) -> Option<String> {
        if acp_session_id.is_empty() {
            return None;
        }
        self.agents
            .iter()
            .find(|(_, h)| h.acp_session_id == acp_session_id)
            .map(|(id, _)| id.clone())
    }

    /// Return the agent type for the runtime with the given ACP session id.
    pub fn agent_type_for_acp_session(&self, acp_session_id: &str) -> Option<amux::AgentType> {
        if acp_session_id.is_empty() {
            return None;
        }
        self.agents
            .iter()
            .find(|(_, h)| h.acp_session_id == acp_session_id)
            .map(|(_, h)| h.agent_type)
    }
}

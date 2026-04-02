use super::blackboard::{Blackboard, BoardType};
use super::types::{AgentProfile, AgentStatus, capability_score, now_millis};
use tracing::warn;

pub struct AgentRegistry {
    local_profile: Option<AgentProfile>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self { local_profile: None }
    }

    /// Register this agent on the blackboard and store the profile locally.
    pub fn register_local(&mut self, bb: &mut Blackboard, profile: AgentProfile) {
        self.write_profile(bb, &profile);
        self.local_profile = Some(profile);
    }

    /// Update the local agent's status and heartbeat timestamp.
    pub fn update_local_status(
        &mut self,
        bb: &mut Blackboard,
        status: AgentStatus,
        current_task: Option<String>,
    ) {
        if let Some(profile) = &mut self.local_profile {
            profile.status = status;
            profile.current_task = current_task;
            profile.last_heartbeat = now_millis();
            let profile_clone = profile.clone();
            self.write_profile(bb, &profile_clone);
        } else {
            warn!("update_local_status called but no local profile registered");
        }
    }

    /// Read all agent profiles from the Loro "agents" map.
    pub fn get_all_agents(&self, bb: &Blackboard) -> Vec<AgentProfile> {
        let Some(doc) = bb.get_doc(BoardType::Registry) else {
            return Vec::new();
        };
        let agents_map = doc.get_map("agents");
        let mut profiles = Vec::new();
        for key in agents_map.keys() {
            if let Some(value) = agents_map.get(&key) {
                if let loro::ValueOrContainer::Value(loro::LoroValue::String(json_str)) = value {
                    match serde_json::from_str::<AgentProfile>(json_str.as_ref()) {
                        Ok(profile) => profiles.push(profile),
                        Err(e) => warn!("Failed to deserialize agent profile for key {key}: {e}"),
                    }
                }
            }
        }
        profiles
    }

    /// Return online agents that have a capability in `domain`, sorted by
    /// `capability_score` descending.
    pub fn discover_agents(&self, bb: &Blackboard, domain: &str) -> Vec<AgentProfile> {
        let mut agents: Vec<AgentProfile> = self
            .get_all_agents(bb)
            .into_iter()
            .filter(|a| {
                a.status != AgentStatus::Offline
                    && a.capabilities.iter().any(|c| c.domain == domain)
            })
            .collect();

        agents.sort_by(|a, b| {
            let score_a = capability_score(a, domain);
            let score_b = capability_score(b, domain);
            score_b.partial_cmp(&score_a).unwrap_or(std::cmp::Ordering::Equal)
        });

        agents
    }

    /// Mark agents whose `last_heartbeat` is older than `timeout_ms` as Offline.
    /// Returns the list of node IDs that were marked offline.
    pub fn mark_stale_agents_offline(
        &self,
        bb: &mut Blackboard,
        timeout_ms: u64,
    ) -> Result<Vec<String>, String> {
        let now = now_millis();
        let stale: Vec<AgentProfile> = self
            .get_all_agents(bb)
            .into_iter()
            .filter(|a| {
                a.status != AgentStatus::Offline && now.saturating_sub(a.last_heartbeat) > timeout_ms
            })
            .collect();

        let mut marked = Vec::new();
        for mut profile in stale {
            let id = profile.node_id.clone();
            profile.status = AgentStatus::Offline;
            self.write_profile(bb, &profile);
            marked.push(id);
        }
        Ok(marked)
    }

    /// Return an immutable reference to the local profile, if registered.
    pub fn local_profile(&self) -> Option<&AgentProfile> {
        self.local_profile.as_ref()
    }

    /// Public wrapper for writing a remote profile to the blackboard.
    pub fn write_remote_profile(&self, bb: &mut Blackboard, profile: &AgentProfile) {
        self.write_profile(bb, profile);
    }

    /// Serialize `profile` to JSON and insert it into the LoroMap "agents",
    /// keyed by `profile.node_id`.
    fn write_profile(&self, bb: &mut Blackboard, profile: &AgentProfile) {
        let json = match serde_json::to_string(profile) {
            Ok(s) => s,
            Err(e) => {
                warn!("Failed to serialize agent profile {}: {e}", profile.node_id);
                return;
            }
        };
        let Some(doc) = bb.get_doc_mut(BoardType::Registry) else {
            warn!("Registry doc not found when writing profile {}", profile.node_id);
            return;
        };
        let agents_map = doc.get_map("agents");
        if let Err(e) = agents_map.insert(&profile.node_id, json) {
            warn!("Failed to write agent profile {} to LoroMap: {e}", profile.node_id);
        }
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::Capability;
    use tempfile::tempdir;

    fn make_test_env() -> (AgentRegistry, Blackboard) {
        let dir = tempdir().expect("tempdir");
        let bb = Blackboard::new(dir.path().to_path_buf());
        // Keep the tempdir alive by leaking it — acceptable in tests.
        std::mem::forget(dir);
        (AgentRegistry::new(), bb)
    }

    fn make_profile(
        node_id: &str,
        name: &str,
        domain: &str,
        confidence: f64,
        avg_score: f64,
    ) -> AgentProfile {
        AgentProfile {
            node_id: node_id.to_string(),
            name: name.to_string(),
            owner: "test-owner".to_string(),
            capabilities: vec![Capability {
                domain: domain.to_string(),
                skills: vec![],
                tools: vec![],
                languages: vec![],
                confidence,
                task_count: 1,
                avg_score,
            }],
            status: AgentStatus::Online,
            current_task: None,
            last_heartbeat: now_millis(),
            version: "0.1.0".to_string(),
            model_id: "claude-opus".to_string(),
            joined_at: now_millis(),
        }
    }

    // 1. Register a local agent, check local_profile, check get_all_agents returns 1.
    #[test]
    fn register_and_retrieve_local_agent() {
        let (mut registry, mut bb) = make_test_env();
        let profile = make_profile("node-1", "Agent One", "frontend", 0.9, 0.85);

        registry.register_local(&mut bb, profile.clone());

        assert!(registry.local_profile().is_some(), "local_profile should be set");
        assert_eq!(registry.local_profile().unwrap().node_id, "node-1");

        let all = registry.get_all_agents(&bb);
        assert_eq!(all.len(), 1, "should have exactly 1 agent");
        assert_eq!(all[0].node_id, "node-1");
    }

    // 2. Register, then update status to Busy with a task; verify the change.
    #[test]
    fn update_local_status() {
        let (mut registry, mut bb) = make_test_env();
        let profile = make_profile("node-2", "Agent Two", "backend", 0.8, 0.7);
        registry.register_local(&mut bb, profile);

        registry.update_local_status(
            &mut bb,
            AgentStatus::Busy,
            Some("refactoring auth module".to_string()),
        );

        let lp = registry.local_profile().expect("local_profile should exist");
        assert_eq!(lp.status, AgentStatus::Busy);
        assert_eq!(lp.current_task, Some("refactoring auth module".to_string()));

        // The blackboard should also reflect the update.
        let all = registry.get_all_agents(&bb);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].status, AgentStatus::Busy);
        assert_eq!(all[0].current_task, Some("refactoring auth module".to_string()));
    }

    // 3. Register agents in different domains, discover each domain separately.
    #[test]
    fn discover_agents_filters_by_domain() {
        let (mut registry, mut bb) = make_test_env();

        let frontend = make_profile("fe-1", "Frontend Agent", "frontend", 0.9, 0.8);
        registry.register_local(&mut bb, frontend);
        registry.write_remote_profile(&mut bb, &make_profile("be-1", "Backend Agent", "backend", 0.85, 0.75));

        // discover frontend
        let fe_results = registry.discover_agents(&bb, "frontend");
        assert_eq!(fe_results.len(), 1);
        assert_eq!(fe_results[0].node_id, "fe-1");

        // discover backend
        let be_results = registry.discover_agents(&bb, "backend");
        assert_eq!(be_results.len(), 1);
        assert_eq!(be_results[0].node_id, "be-1");
    }

    // 4. Three agents with different capability scores; verify sort order (strongest first).
    #[test]
    fn discover_agents_sorted_by_score() {
        let (registry, mut bb) = make_test_env();

        // Scores: weak=0.2*0.5=0.10, medium=0.5*0.6=0.30, strong=0.9*0.8=0.72
        let weak   = make_profile("weak",   "Weak Agent",   "ml", 0.2, 0.5);
        let medium = make_profile("medium", "Medium Agent", "ml", 0.5, 0.6);
        let strong = make_profile("strong", "Strong Agent", "ml", 0.9, 0.8);

        registry.write_remote_profile(&mut bb, &weak);
        registry.write_remote_profile(&mut bb, &medium);
        registry.write_remote_profile(&mut bb, &strong);

        let results = registry.discover_agents(&bb, "ml");
        assert_eq!(results.len(), 3, "all three agents should be returned");
        assert_eq!(results[0].node_id, "strong", "strongest should be first");
        assert_eq!(results[1].node_id, "medium");
        assert_eq!(results[2].node_id, "weak");
    }

    // 5. Online + offline agents in same domain; only online are returned.
    #[test]
    fn discover_agents_excludes_offline() {
        let (registry, mut bb) = make_test_env();

        let online = make_profile("online-1", "Online Agent", "devops", 0.8, 0.9);
        let mut offline = make_profile("offline-1", "Offline Agent", "devops", 0.95, 0.95);
        offline.status = AgentStatus::Offline;

        registry.write_remote_profile(&mut bb, &online);
        registry.write_remote_profile(&mut bb, &offline);

        let results = registry.discover_agents(&bb, "devops");
        assert_eq!(results.len(), 1, "only the online agent should be returned");
        assert_eq!(results[0].node_id, "online-1");
    }

    // 6. Agent with an old heartbeat gets marked offline by mark_stale_agents_offline.
    #[test]
    fn mark_stale_agents_offline() {
        let (registry, mut bb) = make_test_env();

        // Create a profile with a heartbeat 2 minutes in the past.
        let mut stale = make_profile("stale-1", "Stale Agent", "data", 0.7, 0.8);
        stale.last_heartbeat = now_millis().saturating_sub(120_000);
        registry.write_remote_profile(&mut bb, &stale);

        // Also register a fresh agent that should NOT be marked offline.
        let fresh = make_profile("fresh-1", "Fresh Agent", "data", 0.7, 0.8);
        registry.write_remote_profile(&mut bb, &fresh);

        let marked = registry
            .mark_stale_agents_offline(&mut bb, 60_000)
            .expect("mark_stale_agents_offline should succeed");

        assert_eq!(marked.len(), 1, "only the stale agent should be marked");
        assert_eq!(marked[0], "stale-1");

        // Verify in blackboard.
        let all = registry.get_all_agents(&bb);
        let stale_in_bb = all.iter().find(|a| a.node_id == "stale-1").unwrap();
        assert_eq!(stale_in_bb.status, AgentStatus::Offline);

        let fresh_in_bb = all.iter().find(|a| a.node_id == "fresh-1").unwrap();
        assert_eq!(fresh_in_bb.status, AgentStatus::Online);
    }

    // 7. Discovering an unknown domain returns an empty vec.
    #[test]
    fn discover_returns_empty_for_unknown_domain() {
        let (mut registry, mut bb) = make_test_env();

        let profile = make_profile("node-x", "Some Agent", "frontend", 0.9, 0.8);
        registry.register_local(&mut bb, profile);

        let results = registry.discover_agents(&bb, "quantum-computing");
        assert!(results.is_empty(), "unknown domain should return empty vec");
    }
}

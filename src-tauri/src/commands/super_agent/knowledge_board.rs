use serde::de::DeserializeOwned;
use tracing::warn;

use super::blackboard::{Blackboard, BoardType};
use super::types::{DistilledSkill, Experience, KnowledgeSnapshot, Strategy};

pub struct KnowledgeBoard;

impl KnowledgeBoard {
    pub fn new() -> Self {
        Self
    }

    // ── Generic helper ────────────────────────────────────────────────────────

    /// Read every entry in a named Loro map and deserialize each value as `T`.
    fn read_all_from_map<T: DeserializeOwned>(bb: &Blackboard, map_name: &str) -> Vec<T> {
        let Some(doc) = bb.get_doc(BoardType::Knowledge) else {
            return Vec::new();
        };
        let map = doc.get_map(map_name);
        let mut items = Vec::new();
        for key in map.keys() {
            if let Some(value) = map.get(&key) {
                if let loro::ValueOrContainer::Value(loro::LoroValue::String(json_str)) = value {
                    match serde_json::from_str::<T>(json_str.as_ref()) {
                        Ok(item) => items.push(item),
                        Err(e) => warn!(
                            "Failed to deserialize entry for key {key} in map {map_name}: {e}"
                        ),
                    }
                }
            }
        }
        items
    }

    // ── Experiences ───────────────────────────────────────────────────────────

    /// Insert or update an experience in the Loro `"experiences"` map.
    pub fn upsert_experience(
        &self,
        bb: &mut Blackboard,
        exp: &Experience,
    ) -> Result<(), String> {
        let json = serde_json::to_string(exp)
            .map_err(|e| format!("Failed to serialize experience {}: {e}", exp.id))?;
        let doc = bb
            .get_doc_mut(BoardType::Knowledge)
            .ok_or_else(|| "Knowledge doc not found".to_string())?;
        let map = doc.get_map("experiences");
        map.insert(&exp.id, json)
            .map_err(|e| format!("Failed to write experience {} to LoroMap: {e}", exp.id))?;
        Ok(())
    }

    /// Retrieve a single experience by ID, or `None` if not found.
    pub fn get_experience(&self, bb: &Blackboard, id: &str) -> Option<Experience> {
        let doc = bb.get_doc(BoardType::Knowledge)?;
        let map = doc.get_map("experiences");
        let value = map.get(id)?;
        if let loro::ValueOrContainer::Value(loro::LoroValue::String(json_str)) = value {
            match serde_json::from_str::<Experience>(json_str.as_ref()) {
                Ok(exp) => Some(exp),
                Err(e) => {
                    warn!("Failed to deserialize experience {id}: {e}");
                    None
                }
            }
        } else {
            None
        }
    }

    /// Return all experiences stored in the KnowledgeBoard.
    pub fn get_all_experiences(&self, bb: &Blackboard) -> Vec<Experience> {
        Self::read_all_from_map::<Experience>(bb, "experiences")
    }

    /// Return all experiences whose `domain` field matches `domain`.
    pub fn get_experiences_by_domain(&self, bb: &Blackboard, domain: &str) -> Vec<Experience> {
        self.get_all_experiences(bb)
            .into_iter()
            .filter(|e| e.domain == domain)
            .collect()
    }

    // ── Strategies ────────────────────────────────────────────────────────────

    /// Insert or update a strategy in the Loro `"strategies"` map.
    pub fn upsert_strategy(
        &self,
        bb: &mut Blackboard,
        strat: &Strategy,
    ) -> Result<(), String> {
        let json = serde_json::to_string(strat)
            .map_err(|e| format!("Failed to serialize strategy {}: {e}", strat.id))?;
        let doc = bb
            .get_doc_mut(BoardType::Knowledge)
            .ok_or_else(|| "Knowledge doc not found".to_string())?;
        let map = doc.get_map("strategies");
        map.insert(&strat.id, json)
            .map_err(|e| format!("Failed to write strategy {} to LoroMap: {e}", strat.id))?;
        Ok(())
    }

    /// Retrieve a single strategy by ID, or `None` if not found.
    pub fn get_strategy(&self, bb: &Blackboard, id: &str) -> Option<Strategy> {
        let doc = bb.get_doc(BoardType::Knowledge)?;
        let map = doc.get_map("strategies");
        let value = map.get(id)?;
        if let loro::ValueOrContainer::Value(loro::LoroValue::String(json_str)) = value {
            match serde_json::from_str::<Strategy>(json_str.as_ref()) {
                Ok(strat) => Some(strat),
                Err(e) => {
                    warn!("Failed to deserialize strategy {id}: {e}");
                    None
                }
            }
        } else {
            None
        }
    }

    /// Return all strategies stored in the KnowledgeBoard.
    pub fn get_all_strategies(&self, bb: &Blackboard) -> Vec<Strategy> {
        Self::read_all_from_map::<Strategy>(bb, "strategies")
    }

    // ── Distilled Skills ──────────────────────────────────────────────────────

    /// Insert or update a distilled skill in the Loro `"distilled_skills"` map.
    pub fn upsert_skill(
        &self,
        bb: &mut Blackboard,
        skill: &DistilledSkill,
    ) -> Result<(), String> {
        let json = serde_json::to_string(skill)
            .map_err(|e| format!("Failed to serialize skill {}: {e}", skill.id))?;
        let doc = bb
            .get_doc_mut(BoardType::Knowledge)
            .ok_or_else(|| "Knowledge doc not found".to_string())?;
        let map = doc.get_map("distilled_skills");
        map.insert(&skill.id, json)
            .map_err(|e| format!("Failed to write skill {} to LoroMap: {e}", skill.id))?;
        Ok(())
    }

    /// Return all distilled skills stored in the KnowledgeBoard.
    pub fn get_all_skills(&self, bb: &Blackboard) -> Vec<DistilledSkill> {
        Self::read_all_from_map::<DistilledSkill>(bb, "distilled_skills")
    }

    // ── Snapshot ──────────────────────────────────────────────────────────────

    /// Return a full snapshot of all knowledge held in the board.
    pub fn get_snapshot(&self, bb: &Blackboard) -> KnowledgeSnapshot {
        KnowledgeSnapshot {
            experiences: self.get_all_experiences(bb),
            strategies: self.get_all_strategies(bb),
            distilled_skills: self.get_all_skills(bb),
        }
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::blackboard::Blackboard;
    use super::super::types::{
        DistilledSkill, Experience, ExperienceMetrics, ExperienceOutcome,
        KnowledgeSnapshot, Strategy, StrategyType, StrategyValidation, ValidationStatus,
    };
    use tempfile::tempdir;

    fn make_test_env() -> (KnowledgeBoard, Blackboard, tempfile::TempDir) {
        let dir = tempdir().expect("tempdir");
        let bb = Blackboard::new(dir.path().to_path_buf());
        (KnowledgeBoard::new(), bb, dir)
    }

    fn make_experience(id: &str, domain: &str) -> Experience {
        Experience {
            id: id.to_string(),
            agent_id: "agent-1".to_string(),
            task_id: "task-1".to_string(),
            session_id: "sess-1".to_string(),
            domain: domain.to_string(),
            tags: vec!["rust".to_string()],
            outcome: ExperienceOutcome::Success,
            context: "context".to_string(),
            action: "action".to_string(),
            result: "result".to_string(),
            lesson: "lesson".to_string(),
            metrics: ExperienceMetrics {
                tokens_used: 100,
                duration: 1000,
                tool_call_count: 5,
                score: 0.9,
                retry_count: 0,
            },
            created_at: 1_000_000,
            expires_at: 9_999_999_999_999,
        }
    }

    fn make_strategy(id: &str, domain: &str) -> Strategy {
        Strategy {
            id: id.to_string(),
            domain: domain.to_string(),
            tags: vec!["tag1".to_string()],
            strategy_type: StrategyType::Recommend,
            condition: "when X".to_string(),
            recommendation: "do Y".to_string(),
            reasoning: "because Z".to_string(),
            source_experiences: vec!["exp-1".to_string()],
            success_rate: 0.85,
            sample_size: 10,
            contributing_agents: vec!["agent-1".to_string()],
            confidence_interval: 0.05,
            validation: StrategyValidation {
                status: ValidationStatus::Validated,
                validated_by: vec!["agent-2".to_string()],
                validation_score: 0.9,
            },
            created_at: 2_000_000,
            updated_at: 3_000_000,
        }
    }

    fn make_skill(id: &str, name: &str) -> DistilledSkill {
        DistilledSkill {
            id: id.to_string(),
            name: name.to_string(),
            source_strategy_id: "strat-1".to_string(),
            skill_content: "skill content".to_string(),
            adoption_count: 3,
            avg_effectiveness: 0.8,
            created_at: 4_000_000,
        }
    }

    // 1. upsert_and_get_experience
    #[test]
    fn upsert_and_get_experience() {
        let (kb, mut bb, _dir) = make_test_env();
        let exp = make_experience("exp-1", "frontend");

        kb.upsert_experience(&mut bb, &exp).expect("upsert should succeed");

        let retrieved = kb.get_experience(&bb, "exp-1");
        assert!(retrieved.is_some(), "experience should be retrievable after upsert");
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.id, "exp-1");
        assert_eq!(retrieved.domain, "frontend");
        assert_eq!(retrieved.outcome, ExperienceOutcome::Success);
    }

    // 2. get_all_experiences
    #[test]
    fn get_all_experiences() {
        let (kb, mut bb, _dir) = make_test_env();
        let exp_a = make_experience("exp-a", "frontend");
        let exp_b = make_experience("exp-b", "backend");

        kb.upsert_experience(&mut bb, &exp_a).expect("upsert exp-a");
        kb.upsert_experience(&mut bb, &exp_b).expect("upsert exp-b");

        let all = kb.get_all_experiences(&bb);
        assert_eq!(all.len(), 2, "should have exactly 2 experiences");
        let ids: Vec<&str> = all.iter().map(|e| e.id.as_str()).collect();
        assert!(ids.contains(&"exp-a"), "exp-a should be present");
        assert!(ids.contains(&"exp-b"), "exp-b should be present");
    }

    // 3. get_experiences_by_domain
    #[test]
    fn get_experiences_by_domain() {
        let (kb, mut bb, _dir) = make_test_env();
        let fe1 = make_experience("fe-1", "frontend");
        let fe2 = make_experience("fe-2", "frontend");
        let be1 = make_experience("be-1", "backend");

        kb.upsert_experience(&mut bb, &fe1).expect("upsert fe-1");
        kb.upsert_experience(&mut bb, &fe2).expect("upsert fe-2");
        kb.upsert_experience(&mut bb, &be1).expect("upsert be-1");

        let frontend = kb.get_experiences_by_domain(&bb, "frontend");
        assert_eq!(frontend.len(), 2, "should have 2 frontend experiences");
        assert!(frontend.iter().all(|e| e.domain == "frontend"));

        let backend = kb.get_experiences_by_domain(&bb, "backend");
        assert_eq!(backend.len(), 1, "should have 1 backend experience");
        assert_eq!(backend[0].id, "be-1");

        let devops = kb.get_experiences_by_domain(&bb, "devops");
        assert!(devops.is_empty(), "no devops experiences should exist");
    }

    // 4. upsert_and_get_strategy
    #[test]
    fn upsert_and_get_strategy() {
        let (kb, mut bb, _dir) = make_test_env();
        let strat = make_strategy("strat-1", "backend");

        kb.upsert_strategy(&mut bb, &strat).expect("upsert should succeed");

        let retrieved = kb.get_strategy(&bb, "strat-1");
        assert!(retrieved.is_some(), "strategy should be retrievable after upsert");
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.id, "strat-1");
        assert_eq!(retrieved.domain, "backend");
        assert_eq!(retrieved.strategy_type, StrategyType::Recommend);
    }

    // 5. get_all_strategies
    #[test]
    fn get_all_strategies() {
        let (kb, mut bb, _dir) = make_test_env();
        let strat_a = make_strategy("strat-a", "backend");
        let strat_b = make_strategy("strat-b", "frontend");

        kb.upsert_strategy(&mut bb, &strat_a).expect("upsert strat-a");
        kb.upsert_strategy(&mut bb, &strat_b).expect("upsert strat-b");

        let all = kb.get_all_strategies(&bb);
        assert_eq!(all.len(), 2, "should have exactly 2 strategies");
        let ids: Vec<&str> = all.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&"strat-a"), "strat-a should be present");
        assert!(ids.contains(&"strat-b"), "strat-b should be present");
    }

    // 6. get_snapshot
    #[test]
    fn get_snapshot() {
        let (kb, mut bb, _dir) = make_test_env();
        let exp = make_experience("exp-snap", "devops");
        let strat = make_strategy("strat-snap", "devops");
        let skill = make_skill("skill-snap", "deploy-automation");

        kb.upsert_experience(&mut bb, &exp).expect("upsert experience");
        kb.upsert_strategy(&mut bb, &strat).expect("upsert strategy");
        kb.upsert_skill(&mut bb, &skill).expect("upsert skill");

        let snapshot: KnowledgeSnapshot = kb.get_snapshot(&bb);
        assert_eq!(snapshot.experiences.len(), 1, "snapshot should have 1 experience");
        assert_eq!(snapshot.strategies.len(), 1, "snapshot should have 1 strategy");
        assert_eq!(snapshot.distilled_skills.len(), 1, "snapshot should have 1 skill");
        assert_eq!(snapshot.experiences[0].id, "exp-snap");
        assert_eq!(snapshot.strategies[0].id, "strat-snap");
        assert_eq!(snapshot.distilled_skills[0].id, "skill-snap");
    }
}

use tracing::warn;

use super::blackboard::{Blackboard, BoardType};
use super::types::{DebateRecord, DebateSnapshot, DebateStatus};

pub struct DebateBoard;

impl DebateBoard {
    pub fn new() -> Self {
        Self
    }

    /// Insert or update a debate record in the Loro `"debates"` map.
    pub fn upsert_debate(&self, bb: &mut Blackboard, debate: &DebateRecord) -> Result<(), String> {
        let json = serde_json::to_string(debate)
            .map_err(|e| format!("Failed to serialize debate {}: {e}", debate.id))?;
        let doc = bb
            .get_doc_mut(BoardType::Debates)
            .ok_or_else(|| "Debates doc not found".to_string())?;
        let map = doc.get_map("debates");
        map.insert(&debate.id, json)
            .map_err(|e| format!("Failed to write debate {} to LoroMap: {e}", debate.id))?;
        Ok(())
    }

    /// Retrieve a single debate record by ID, or `None` if not found.
    pub fn get_debate(&self, bb: &Blackboard, id: &str) -> Option<DebateRecord> {
        let doc = bb.get_doc(BoardType::Debates)?;
        let map = doc.get_map("debates");
        let value = map.get(id)?;
        if let loro::ValueOrContainer::Value(loro::LoroValue::String(json_str)) = value {
            match serde_json::from_str::<DebateRecord>(json_str.as_ref()) {
                Ok(debate) => Some(debate),
                Err(e) => {
                    warn!("Failed to deserialize debate {id}: {e}");
                    None
                }
            }
        } else {
            None
        }
    }

    /// Return all debate records stored in the DebateBoard.
    pub fn get_all_debates(&self, bb: &Blackboard) -> Vec<DebateRecord> {
        let Some(doc) = bb.get_doc(BoardType::Debates) else {
            return Vec::new();
        };
        let map = doc.get_map("debates");
        let mut debates = Vec::new();
        for key in map.keys() {
            if let Some(value) = map.get(&key) {
                if let loro::ValueOrContainer::Value(loro::LoroValue::String(json_str)) = value {
                    match serde_json::from_str::<DebateRecord>(json_str.as_ref()) {
                        Ok(debate) => debates.push(debate),
                        Err(e) => warn!("Failed to deserialize debate for key {key}: {e}"),
                    }
                }
            }
        }
        debates
    }

    /// Return all debates whose status is not `Concluded`.
    pub fn get_active_debates(&self, bb: &Blackboard) -> Vec<DebateRecord> {
        self.get_all_debates(bb)
            .into_iter()
            .filter(|d| d.status != DebateStatus::Concluded)
            .collect()
    }

    /// Return a snapshot of all debates.
    pub fn get_snapshot(&self, bb: &Blackboard) -> DebateSnapshot {
        DebateSnapshot {
            debates: self.get_all_debates(bb),
        }
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::blackboard::Blackboard;
    use super::super::types::{
        Angle, DebateRecord, DebateStatus, DeliberationTrigger,
        Perspective,
    };
    use tempfile::tempdir;

    fn make_test_env() -> (DebateBoard, Blackboard, tempfile::TempDir) {
        let dir = tempdir().expect("tempdir");
        let bb = Blackboard::new(dir.path().to_path_buf());
        (DebateBoard::new(), bb, dir)
    }

    fn make_trigger() -> DeliberationTrigger {
        DeliberationTrigger {
            explicit: true,
            creator_confidence: 0.5,
            domain_failure_rate: 0.1,
            cross_domain_count: 2,
        }
    }

    fn make_debate(id: &str, status: DebateStatus) -> DebateRecord {
        DebateRecord {
            id: id.to_string(),
            question: format!("Question for {id}"),
            context: "some context".to_string(),
            trigger: make_trigger(),
            status,
            requested_angles: vec![Angle::Feasibility, Angle::Risk],
            perspectives: vec![],
            rounds: vec![],
            candidate_options: vec![],
            votes: vec![],
            synthesis: None,
            outcome: None,
            created_at: 1_000_000,
            concluded_at: None,
            deadline: 9_999_999_999_999,
        }
    }

    // 1. upsert_and_get_debate
    #[test]
    fn upsert_and_get_debate() {
        let (db, mut bb, _dir) = make_test_env();
        let debate = make_debate("debate-1", DebateStatus::GatheringPerspectives);

        db.upsert_debate(&mut bb, &debate).expect("upsert should succeed");

        let retrieved = db.get_debate(&bb, "debate-1");
        assert!(retrieved.is_some(), "debate should be retrievable after upsert");
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.id, "debate-1");
        assert_eq!(retrieved.status, DebateStatus::GatheringPerspectives);
        assert_eq!(retrieved.question, "Question for debate-1");
    }

    // 2. get_all_debates — 2 debates
    #[test]
    fn get_all_debates() {
        let (db, mut bb, _dir) = make_test_env();
        let debate_a = make_debate("debate-a", DebateStatus::GatheringPerspectives);
        let debate_b = make_debate("debate-b", DebateStatus::Debating);

        db.upsert_debate(&mut bb, &debate_a).expect("upsert debate-a");
        db.upsert_debate(&mut bb, &debate_b).expect("upsert debate-b");

        let all = db.get_all_debates(&bb);
        assert_eq!(all.len(), 2, "should have exactly 2 debates");
        let ids: Vec<&str> = all.iter().map(|d| d.id.as_str()).collect();
        assert!(ids.contains(&"debate-a"), "debate-a should be present");
        assert!(ids.contains(&"debate-b"), "debate-b should be present");
    }

    // 3. get_active_debates — 2 active + 1 concluded → 2 returned
    #[test]
    fn get_active_debates() {
        let (db, mut bb, _dir) = make_test_env();
        let active_1 = make_debate("active-1", DebateStatus::GatheringPerspectives);
        let active_2 = make_debate("active-2", DebateStatus::Voting);
        let concluded = make_debate("concluded-1", DebateStatus::Concluded);

        db.upsert_debate(&mut bb, &active_1).expect("upsert active-1");
        db.upsert_debate(&mut bb, &active_2).expect("upsert active-2");
        db.upsert_debate(&mut bb, &concluded).expect("upsert concluded-1");

        let active = db.get_active_debates(&bb);
        assert_eq!(active.len(), 2, "should return exactly 2 active debates");
        assert!(
            active.iter().all(|d| d.status != DebateStatus::Concluded),
            "no concluded debates should be in the active list"
        );
        let ids: Vec<&str> = active.iter().map(|d| d.id.as_str()).collect();
        assert!(ids.contains(&"active-1"), "active-1 should be present");
        assert!(ids.contains(&"active-2"), "active-2 should be present");
    }

    // 4. update_debate_adds_perspective — add perspective, verify
    #[test]
    fn update_debate_adds_perspective() {
        let (db, mut bb, _dir) = make_test_env();
        let mut debate = make_debate("debate-persp", DebateStatus::GatheringPerspectives);
        db.upsert_debate(&mut bb, &debate).expect("initial upsert");

        let perspective = Perspective {
            debate_id: "debate-persp".to_string(),
            agent_id: "agent-1".to_string(),
            angle: Angle::Security,
            position: "We should prioritise security".to_string(),
            reasoning: "Security flaws cost more to fix later".to_string(),
            evidence: vec!["study-1".to_string()],
            risks: vec!["performance overhead".to_string()],
            preferred_option: "option-a".to_string(),
            option_ranking: vec![],
            confidence: 0.9,
        };
        debate.perspectives.push(perspective);
        db.upsert_debate(&mut bb, &debate).expect("upsert with perspective");

        let retrieved = db
            .get_debate(&bb, "debate-persp")
            .expect("debate should exist");
        assert_eq!(
            retrieved.perspectives.len(),
            1,
            "debate should have exactly 1 perspective"
        );
        assert_eq!(retrieved.perspectives[0].agent_id, "agent-1");
        assert_eq!(retrieved.perspectives[0].angle, Angle::Security);
    }

    // 5. get_snapshot
    #[test]
    fn get_snapshot() {
        let (db, mut bb, _dir) = make_test_env();
        let debate_1 = make_debate("snap-debate-1", DebateStatus::GatheringPerspectives);
        let debate_2 = make_debate("snap-debate-2", DebateStatus::Concluded);

        db.upsert_debate(&mut bb, &debate_1).expect("upsert snap-debate-1");
        db.upsert_debate(&mut bb, &debate_2).expect("upsert snap-debate-2");

        let snapshot = db.get_snapshot(&bb);
        assert_eq!(snapshot.debates.len(), 2, "snapshot should contain 2 debates");
        let ids: Vec<&str> = snapshot.debates.iter().map(|d| d.id.as_str()).collect();
        assert!(ids.contains(&"snap-debate-1"), "snap-debate-1 should be in snapshot");
        assert!(ids.contains(&"snap-debate-2"), "snap-debate-2 should be in snapshot");
    }

    // 6. nonexistent_debate_returns_none
    #[test]
    fn nonexistent_debate_returns_none() {
        let (db, bb, _dir) = make_test_env();
        let result = db.get_debate(&bb, "does-not-exist");
        assert!(result.is_none(), "nonexistent debate should return None");
    }
}

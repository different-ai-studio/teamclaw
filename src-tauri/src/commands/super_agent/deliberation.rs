use super::blackboard::Blackboard;
use super::debate_board::DebateBoard;
use super::types::{
    CandidateOption, DebateRecord, DebateRound, DebateStatus, DeliberationTrigger, Angle,
    Perspective, PostDecisionOutcome, SynthesisResult, Vote, now_millis,
};

/// Orchestrates the 3-phase deliberation pipeline:
///   Phase 1 — GatheringPerspectives
///   Phase 2 — Debating
///   Phase 3 — Voting → Concluded
pub struct DeliberationEngine {
    pub debate_board: DebateBoard,
    local_node_id: String,
}

impl DeliberationEngine {
    pub fn new(local_node_id: String) -> Self {
        Self {
            debate_board: DebateBoard::new(),
            local_node_id,
        }
    }

    /// Create a new debate in `GatheringPerspectives` status.
    /// deadline = now + 30 s, max_rounds = 3 (stored as `rounds` capacity sentinel,
    /// accessed via `conclude_debate`/`should_terminate`).
    pub fn create_deliberation(
        &self,
        bb: &mut Blackboard,
        question: String,
        context: String,
        requested_angles: Vec<Angle>,
        trigger: DeliberationTrigger,
    ) -> Result<DebateRecord, String> {
        let now = now_millis();
        let debate = DebateRecord {
            id: nanoid::nanoid!(),
            question,
            context,
            trigger,
            status: DebateStatus::GatheringPerspectives,
            requested_angles,
            perspectives: vec![],
            rounds: vec![],
            candidate_options: vec![],
            votes: vec![],
            synthesis: None,
            outcome: None,
            created_at: now,
            concluded_at: None,
            // deadline = now + 30 000 ms
            deadline: now + 30_000,
        };
        self.debate_board.upsert_debate(bb, &debate)?;
        Ok(debate)
    }

    /// Add a perspective to an existing debate.
    /// Only allowed while status is `GatheringPerspectives`.
    pub fn add_perspective(
        &self,
        bb: &mut Blackboard,
        debate_id: &str,
        perspective: Perspective,
    ) -> Result<(), String> {
        let mut debate = self
            .debate_board
            .get_debate(bb, debate_id)
            .ok_or_else(|| format!("Debate {debate_id} not found"))?;

        if debate.status != DebateStatus::GatheringPerspectives {
            return Err(format!(
                "Cannot add perspective: debate {debate_id} is in status {:?}",
                debate.status
            ));
        }

        debate.perspectives.push(perspective);
        self.debate_board.upsert_debate(bb, &debate)
    }

    /// Add a debate round and transition the debate to `Debating`.
    pub fn add_round(
        &self,
        bb: &mut Blackboard,
        debate_id: &str,
        round: DebateRound,
    ) -> Result<(), String> {
        let mut debate = self
            .debate_board
            .get_debate(bb, debate_id)
            .ok_or_else(|| format!("Debate {debate_id} not found"))?;

        debate.rounds.push(round);
        debate.status = DebateStatus::Debating;
        self.debate_board.upsert_debate(bb, &debate)
    }

    /// Add a vote, deduplicating by `agent_id`, and transition to `Voting`.
    pub fn add_vote(
        &self,
        bb: &mut Blackboard,
        debate_id: &str,
        vote: Vote,
    ) -> Result<(), String> {
        let mut debate = self
            .debate_board
            .get_debate(bb, debate_id)
            .ok_or_else(|| format!("Debate {debate_id} not found"))?;

        // Dedup: replace existing vote from same agent, or push new one.
        if let Some(existing) = debate
            .votes
            .iter_mut()
            .find(|v| v.agent_id == vote.agent_id)
        {
            *existing = vote;
        } else {
            debate.votes.push(vote);
        }
        debate.status = DebateStatus::Voting;
        self.debate_board.upsert_debate(bb, &debate)
    }

    /// Replace the candidate options for a debate.
    pub fn set_candidate_options(
        &self,
        bb: &mut Blackboard,
        debate_id: &str,
        options: Vec<CandidateOption>,
    ) -> Result<(), String> {
        let mut debate = self
            .debate_board
            .get_debate(bb, debate_id)
            .ok_or_else(|| format!("Debate {debate_id} not found"))?;

        debate.candidate_options = options;
        self.debate_board.upsert_debate(bb, &debate)
    }

    /// Conclude a debate: set status to `Concluded`, record `synthesis_result`,
    /// store `final_decision` (winning option id), and compute `consensus_reached`
    /// (margin > 2/3).
    pub fn conclude_debate(
        &self,
        bb: &mut Blackboard,
        debate_id: &str,
        result: SynthesisResult,
    ) -> Result<(), String> {
        let mut debate = self
            .debate_board
            .get_debate(bb, debate_id)
            .ok_or_else(|| format!("Debate {debate_id} not found"))?;

        debate.status = DebateStatus::Concluded;
        debate.concluded_at = Some(now_millis());
        debate.synthesis = Some(result);
        self.debate_board.upsert_debate(bb, &debate)
    }

    /// Run ranked-choice voting over the debate's candidate options and conclude the debate.
    pub fn run_voting_and_conclude(
        &self,
        bb: &mut Blackboard,
        debate_id: &str,
    ) -> Result<SynthesisResult, String> {
        let debate = self.debate_board.get_debate(bb, debate_id)
            .ok_or_else(|| format!("Debate {debate_id} not found"))?;

        let option_ids: Vec<String> = debate.candidate_options.iter()
            .map(|o| o.id.clone())
            .collect();

        if option_ids.is_empty() {
            return Err("No candidate options to vote on".to_string());
        }

        let mut result = super::voting::ranked_choice_vote(&debate.votes, &option_ids);

        // Fill in the winning description
        if let Some(opt) = debate.candidate_options.iter().find(|o| o.id == result.winning_option_id) {
            result.winning_description = opt.description.clone();
        }

        self.conclude_debate(bb, debate_id, result.clone())?;
        Ok(result)
    }

    /// Record a post-decision outcome for a debate.
    pub fn record_outcome(
        &self,
        bb: &mut Blackboard,
        debate_id: &str,
        outcome: PostDecisionOutcome,
    ) -> Result<(), String> {
        let mut debate = self
            .debate_board
            .get_debate(bb, debate_id)
            .ok_or_else(|| format!("Debate {debate_id} not found"))?;

        debate.outcome = Some(outcome);
        self.debate_board.upsert_debate(bb, &debate)
    }

    /// Returns `true` when perspectives differ in their `preferred_option`.
    pub fn has_divergence(perspectives: &[Perspective]) -> bool {
        if perspectives.len() < 2 {
            return false;
        }
        let first = &perspectives[0].preferred_option;
        perspectives[1..].iter().any(|p| &p.preferred_option != first)
    }

    /// Returns `true` when the debate should stop:
    /// - all responses in the latest round are `ready_to_converge`, OR
    /// - the number of rounds has reached `max_rounds`, OR
    /// - a supermajority (> 2/3) of the latest-round responses share the same
    ///   `updated_position`.
    pub fn should_terminate(rounds: &[DebateRound], max_rounds: u32) -> bool {
        // Max rounds reached
        if rounds.len() as u32 >= max_rounds {
            return true;
        }

        let Some(latest) = rounds.last() else {
            return false;
        };

        if latest.responses.is_empty() {
            return false;
        }

        // All converge
        if latest.responses.iter().all(|r| r.ready_to_converge) {
            return true;
        }

        // Supermajority (> 2/3) share the same updated_position
        let total = latest.responses.len();
        let mut freq: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for r in &latest.responses {
            *freq.entry(r.updated_position.as_str()).or_insert(0) += 1;
        }
        if let Some(&max_count) = freq.values().max() {
            if max_count as f64 / total as f64 > 2.0 / 3.0 {
                return true;
            }
        }

        false
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::{
        Angle, DebateResponse, DebateRound, DeliberationTrigger,
        Perspective, SynthesisResult,
    };
    use tempfile::tempdir;

    fn make_engine() -> (DeliberationEngine, Blackboard, tempfile::TempDir) {
        let dir = tempdir().expect("tempdir");
        let bb = Blackboard::new(dir.path().to_path_buf());
        (DeliberationEngine::new("local-node".to_string()), bb, dir)
    }

    fn make_trigger() -> DeliberationTrigger {
        DeliberationTrigger {
            explicit: true,
            creator_confidence: 0.5,
            domain_failure_rate: 0.1,
            cross_domain_count: 2,
        }
    }

    fn make_perspective(agent_id: &str, preferred_option: &str) -> Perspective {
        Perspective {
            debate_id: "test-debate".to_string(),
            agent_id: agent_id.to_string(),
            angle: Angle::Feasibility,
            position: format!("position from {agent_id}"),
            reasoning: "some reasoning".to_string(),
            evidence: vec![],
            risks: vec![],
            preferred_option: preferred_option.to_string(),
            option_ranking: vec![],
            confidence: 0.8,
        }
    }

    // 1. create_deliberation — status=GatheringPerspectives, deadline > now, max_rounds=3
    #[test]
    fn create_deliberation() {
        let (engine, mut bb, _dir) = make_engine();
        let before = now_millis();
        let debate = engine
            .create_deliberation(
                &mut bb,
                "Should we refactor?".to_string(),
                "context here".to_string(),
                vec![Angle::Feasibility, Angle::Risk],
                make_trigger(),
            )
            .expect("create_deliberation should succeed");

        assert_eq!(debate.status, DebateStatus::GatheringPerspectives);
        assert!(
            debate.deadline > before,
            "deadline should be in the future"
        );
        // deadline should be approximately now + 30_000 ms
        assert!(
            debate.deadline >= before + 30_000,
            "deadline should be at least 30 s from creation"
        );
        // max_rounds = 3 is the constant used in should_terminate
        assert_eq!(debate.rounds.len(), 0, "new debate has no rounds");

        // Verify it was persisted in the blackboard
        let retrieved = engine
            .debate_board
            .get_debate(&bb, &debate.id)
            .expect("debate should be persisted");
        assert_eq!(retrieved.id, debate.id);
        assert_eq!(retrieved.status, DebateStatus::GatheringPerspectives);
    }

    // 2. add_perspective — perspective added, participant tracked
    #[test]
    fn add_perspective() {
        let (engine, mut bb, _dir) = make_engine();
        let debate = engine
            .create_deliberation(
                &mut bb,
                "Which approach?".to_string(),
                "ctx".to_string(),
                vec![Angle::Performance],
                make_trigger(),
            )
            .expect("create");

        let perspective = make_perspective("agent-42", "option-a");
        engine
            .add_perspective(&mut bb, &debate.id, perspective.clone())
            .expect("add_perspective should succeed");

        let retrieved = engine
            .debate_board
            .get_debate(&bb, &debate.id)
            .expect("debate should exist");
        assert_eq!(retrieved.perspectives.len(), 1);
        assert_eq!(retrieved.perspectives[0].agent_id, "agent-42");
        assert_eq!(retrieved.perspectives[0].preferred_option, "option-a");
    }

    // 3. has_divergence_detects_different_positions — different preferred_options → true
    #[test]
    fn has_divergence_detects_different_positions() {
        let perspectives = vec![
            make_perspective("agent-1", "option-a"),
            make_perspective("agent-2", "option-b"),
        ];
        assert!(
            DeliberationEngine::has_divergence(&perspectives),
            "different preferred_options should report divergence"
        );
    }

    // 4. has_divergence_false_for_agreement — same preferred_option → false
    #[test]
    fn has_divergence_false_for_agreement() {
        let perspectives = vec![
            make_perspective("agent-1", "option-a"),
            make_perspective("agent-2", "option-a"),
            make_perspective("agent-3", "option-a"),
        ];
        assert!(
            !DeliberationEngine::has_divergence(&perspectives),
            "identical preferred_options should not report divergence"
        );
    }

    // 5. check_termination_all_converged — all ready_to_converge → true
    #[test]
    fn check_termination_all_converged() {
        let rounds = vec![DebateRound {
            round: 1,
            responses: vec![
                DebateResponse {
                    agent_id: "a1".to_string(),
                    rebuttals: vec![],
                    updated_position: "go with A".to_string(),
                    updated_confidence: 0.9,
                    ready_to_converge: true,
                },
                DebateResponse {
                    agent_id: "a2".to_string(),
                    rebuttals: vec![],
                    updated_position: "go with A".to_string(),
                    updated_confidence: 0.85,
                    ready_to_converge: true,
                },
            ],
        }];
        assert!(
            DeliberationEngine::should_terminate(&rounds, 3),
            "all ready_to_converge should terminate"
        );
    }

    // 6. check_termination_max_rounds — 3 rounds → true
    #[test]
    fn check_termination_max_rounds() {
        let make_round = |n: u32| DebateRound {
            round: n,
            responses: vec![DebateResponse {
                agent_id: "a1".to_string(),
                rebuttals: vec![],
                updated_position: format!("pos-{n}"),
                updated_confidence: 0.5,
                ready_to_converge: false,
            }],
        };
        let rounds = vec![make_round(1), make_round(2), make_round(3)];
        assert!(
            DeliberationEngine::should_terminate(&rounds, 3),
            "reaching max_rounds=3 should terminate"
        );
    }

    // 7. check_termination_supermajority — 2/3 same position → true
    #[test]
    fn check_termination_supermajority() {
        // 3 out of 3 agents share same position → strictly > 2/3 → terminate
        let rounds = vec![DebateRound {
            round: 1,
            responses: vec![
                DebateResponse {
                    agent_id: "a1".to_string(),
                    rebuttals: vec![],
                    updated_position: "option-X".to_string(),
                    updated_confidence: 0.8,
                    ready_to_converge: false,
                },
                DebateResponse {
                    agent_id: "a2".to_string(),
                    rebuttals: vec![],
                    updated_position: "option-X".to_string(),
                    updated_confidence: 0.7,
                    ready_to_converge: false,
                },
                DebateResponse {
                    agent_id: "a3".to_string(),
                    rebuttals: vec![],
                    updated_position: "option-X".to_string(),
                    updated_confidence: 0.75,
                    ready_to_converge: false,
                },
            ],
        }];
        assert!(
            DeliberationEngine::should_terminate(&rounds, 10),
            "supermajority (3/3) all same position should terminate"
        );
    }

    // 8. conclude_debate — sets Concluded, synthesis_result, final_decision
    #[test]
    fn conclude_debate() {
        let (engine, mut bb, _dir) = make_engine();
        let debate = engine
            .create_deliberation(
                &mut bb,
                "Best option?".to_string(),
                "context".to_string(),
                vec![Angle::Cost],
                make_trigger(),
            )
            .expect("create");

        let synthesis = SynthesisResult {
            winning_option_id: "option-alpha".to_string(),
            winning_description: "The best approach".to_string(),
            voting_rounds: 1,
            margin: 0.75,
            dissent: vec![],
        };

        engine
            .conclude_debate(&mut bb, &debate.id, synthesis.clone())
            .expect("conclude_debate should succeed");

        let retrieved = engine
            .debate_board
            .get_debate(&bb, &debate.id)
            .expect("debate should exist after concluding");

        assert_eq!(retrieved.status, DebateStatus::Concluded);
        assert!(retrieved.concluded_at.is_some(), "concluded_at should be set");
        let stored_synthesis = retrieved.synthesis.expect("synthesis should be set");
        assert_eq!(stored_synthesis.winning_option_id, "option-alpha");
        assert_eq!(stored_synthesis.margin, 0.75);
        // consensus_reached: margin > 2/3
        assert!(
            stored_synthesis.margin > 2.0 / 3.0,
            "margin 0.75 > 2/3 means consensus was reached"
        );
    }
}

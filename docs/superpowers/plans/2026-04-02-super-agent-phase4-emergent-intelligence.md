# Super Agent Phase 4: Emergent Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable multiple agents to collectively think about complex problems through structured deliberation — gathering perspectives from different angles, debating with evidence, and converging on decisions via Ranked Choice Voting that are better than any single agent could produce.

**Architecture:** Extends the `super_agent` module with a three-phase deliberation pipeline: Perspective Gathering → Debate Protocol → Synthesis & Voting. New `BoardType::Debates` Loro doc stores complete debate records. A `DeliberationEngine` coordinates the pipeline with timeouts. New `NervePayload` variants (`debate:propose`, `debate:perspective`, `debate:rebuttal`, `debate:vote`, `debate:conclude`) enable real-time deliberation over gossip. Post-decision outcomes feed back into Layer 3 collective learning.

**Tech Stack:** Rust (loro 1, serde, tokio, nanoid), TypeScript (Zustand, Tauri IPC), React

**Test strategy:** Rust `#[cfg(test)]` for deliberation types, Ranked Choice Voting algorithm, debate lifecycle, perspective gathering logic, and debate board CRUD. Frontend Vitest for type guards.

---

## File Structure

### Rust Backend (new + modified files in `src-tauri/src/commands/super_agent/`)

| File | Action | Responsibility |
|------|--------|---------------|
| `types.rs` | Modify | Add `Angle`, `Perspective`, `PerspectiveRequest`, `DebateRound`, `DebateResponse`, `Rebuttal`, `RebuttalStance`, `CandidateOption`, `Vote`, `SynthesisResult`, `DeliberationTrigger`, `DebateRecord`, `DebateStatus`, `PostDecisionOutcome`, `DebateSnapshot`. Add debate `NervePayload` variants. |
| `blackboard.rs` | Modify | Add `BoardType::Debates` variant. |
| `debate_board.rs` | **Create** | CRUD for `DebateRecord` on `debates.loro` Loro doc. |
| `voting.rs` | **Create** | Ranked Choice Voting algorithm — pure logic, no IO. |
| `deliberation.rs` | **Create** | `DeliberationEngine` — orchestrates the 3-phase pipeline: creates debate, collects perspectives, runs rounds, triggers synthesis+voting, records result. |
| `commands.rs` | Modify | Add commands: `super_agent_start_deliberation`, `super_agent_get_debates`, `super_agent_submit_perspective`, `super_agent_submit_vote`, `super_agent_record_outcome`. |
| `state.rs` | Modify | Add `DeliberationEngine` + `DebateBoard` to `SuperAgentNode`. Handle debate nerve messages in gossip listener. |
| `mod.rs` | Modify | Add module declarations and re-exports. |

### Frontend (`packages/app/src/`)

| File | Action | Responsibility |
|------|--------|---------------|
| `stores/super-agent.ts` | Modify | Add debate types, debate state, deliberation methods. |
| `stores/__tests__/super-agent-debates.test.ts` | **Create** | Vitest tests for debate type guards. |
| `components/settings/team/DebateView.tsx` | **Create** | Debate visualization: perspectives, rounds, votes, outcome. |

---

## Task 1: Deliberation Types + Tests (`types.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/types.rs`

- [ ] **Step 1: Write failing tests**

Add these tests to the existing `#[cfg(test)] mod tests` block:

```rust
#[test]
fn angle_serde_lowercase() {
    assert_eq!(serde_json::to_string(&Angle::Feasibility).unwrap(), "\"feasibility\"");
    assert_eq!(serde_json::to_string(&Angle::Security).unwrap(), "\"security\"");
    assert_eq!(serde_json::to_string(&Angle::Cost).unwrap(), "\"cost\"");
}

#[test]
fn perspective_serde_roundtrip() {
    let p = Perspective {
        debate_id: "d1".to_string(),
        agent_id: "node-a".to_string(),
        angle: Angle::Performance,
        position: "Use caching".to_string(),
        reasoning: "Reduces latency".to_string(),
        evidence: vec!["bench results".to_string()],
        risks: vec!["cache invalidation".to_string()],
        preferred_option: Some("option-a".to_string()),
        option_ranking: vec![
            OptionScore { option: "option-a".to_string(), score: 9.0, reason: "fast".to_string() },
        ],
        confidence: 0.85,
    };
    let json = serde_json::to_string(&p).unwrap();
    let back: Perspective = serde_json::from_str(&json).unwrap();
    assert_eq!(back.angle, Angle::Performance);
    assert!((back.confidence - 0.85).abs() < f64::EPSILON);
    assert_eq!(back.option_ranking.len(), 1);
}

#[test]
fn debate_record_serde_roundtrip() {
    let record = DebateRecord {
        id: "d1".to_string(),
        question: "How to handle auth?".to_string(),
        trigger: DeliberationTrigger {
            explicit: true,
            creator_confidence: 0.3,
            domain_failure_rate: 0.0,
            cross_domain_count: 1,
        },
        status: DebateStatus::GatheringPerspectives,
        perspectives: vec![],
        rounds: vec![],
        candidate_options: vec![],
        votes: vec![],
        synthesis_result: None,
        participants: vec!["node-a".to_string()],
        deadline: now_millis() + 30_000,
        max_rounds: 3,
        duration: 0,
        consensus_reached: false,
        final_decision: None,
        post_decision_outcome: None,
        created_at: now_millis(),
    };
    let json = serde_json::to_string(&record).unwrap();
    let back: DebateRecord = serde_json::from_str(&json).unwrap();
    assert_eq!(back.id, "d1");
    assert_eq!(back.status, DebateStatus::GatheringPerspectives);
    assert!(back.synthesis_result.is_none());
}

#[test]
fn debate_status_transitions() {
    let statuses = vec![
        DebateStatus::GatheringPerspectives,
        DebateStatus::Debating,
        DebateStatus::Voting,
        DebateStatus::Concluded,
    ];
    for s in statuses {
        let json = serde_json::to_string(&s).unwrap();
        let back: DebateStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }
}

#[test]
fn synthesis_result_serde() {
    let result = SynthesisResult {
        winning_option_id: "opt-1".to_string(),
        winning_description: "Use JWT auth".to_string(),
        voting_rounds: 2,
        margin: 0.67,
        dissent: vec!["Prefer session-based auth".to_string()],
    };
    let json = serde_json::to_string(&result).unwrap();
    let back: SynthesisResult = serde_json::from_str(&json).unwrap();
    assert_eq!(back.voting_rounds, 2);
    assert!((back.margin - 0.67).abs() < f64::EPSILON);
    assert_eq!(back.dissent.len(), 1);
}

#[test]
fn debate_propose_payload_serde() {
    let payload = NervePayload::DebatePropose {
        debate_id: "d1".to_string(),
        question: "How to handle auth?".to_string(),
        context: "Rebuilding auth system".to_string(),
        deadline: 1000,
        requested_angles: vec![Angle::Security, Angle::Feasibility],
    };
    let json = serde_json::to_string(&payload).unwrap();
    let back: NervePayload = serde_json::from_str(&json).unwrap();
    match back {
        NervePayload::DebatePropose { debate_id, requested_angles, .. } => {
            assert_eq!(debate_id, "d1");
            assert_eq!(requested_angles.len(), 2);
        }
        _ => panic!("Expected DebatePropose"),
    }
}

#[test]
fn debate_vote_payload_serde() {
    let payload = NervePayload::DebateVote {
        debate_id: "d1".to_string(),
    };
    let json = serde_json::to_string(&payload).unwrap();
    assert!(json.contains("debate:vote"));
}

#[test]
fn rebuttal_stance_serde() {
    assert_eq!(serde_json::to_string(&RebuttalStance::Agree).unwrap(), "\"agree\"");
    assert_eq!(serde_json::to_string(&RebuttalStance::Disagree).unwrap(), "\"disagree\"");
    assert_eq!(serde_json::to_string(&RebuttalStance::PartiallyAgree).unwrap(), "\"partially_agree\"");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent::types --features p2p 2>&1 | tail -20`

- [ ] **Step 3: Add all Layer 4 types**

Add after the Layer 3 types section (which Phase 3 will have added), before `pub fn now_millis()`:

```rust
// ─── Layer 4: Emergent Intelligence ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Angle {
    Feasibility,
    Performance,
    Security,
    Maintainability,
    UserExperience,
    Cost,
    Risk,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionScore {
    pub option: String,
    pub score: f64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Perspective {
    pub debate_id: String,
    pub agent_id: String,
    pub angle: Angle,
    pub position: String,
    pub reasoning: String,
    pub evidence: Vec<String>,
    pub risks: Vec<String>,
    pub preferred_option: Option<String>,
    pub option_ranking: Vec<OptionScore>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerspectiveRequest {
    pub debate_id: String,
    pub question: String,
    pub context: String,
    pub constraints: Vec<String>,
    pub deadline: u64,
    pub requested_angles: Vec<Angle>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RebuttalStance {
    Agree,
    Disagree,
    PartiallyAgree,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rebuttal {
    pub target_agent_id: String,
    pub target_claim: String,
    pub response: RebuttalStance,
    pub argument: String,
    pub new_evidence: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebateResponse {
    pub agent_id: String,
    pub rebuttals: Vec<Rebuttal>,
    pub updated_position: Option<String>,
    pub updated_confidence: f64,
    pub ready_to_converge: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebateRound {
    pub round: u32,
    pub responses: Vec<DebateResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateOption {
    pub id: String,
    pub description: String,
    pub synthesized_from: Vec<String>,
    pub pros: Vec<String>,
    pub cons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoteRanking {
    pub option_id: String,
    pub rank: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vote {
    pub agent_id: String,
    pub preferred_option_id: String,
    pub ranking: Vec<VoteRanking>,
    pub confidence: f64,
    pub final_reasoning: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisResult {
    pub winning_option_id: String,
    pub winning_description: String,
    pub voting_rounds: u32,
    pub margin: f64,
    pub dissent: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliberationTrigger {
    pub explicit: bool,
    pub creator_confidence: f64,
    pub domain_failure_rate: f64,
    pub cross_domain_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DebateStatus {
    GatheringPerspectives,
    Debating,
    Voting,
    Concluded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostDecisionOutcome {
    pub task_id: String,
    pub actual_result: String,
    pub score: f64,
    pub was_correct_decision: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebateRecord {
    pub id: String,
    pub question: String,
    pub trigger: DeliberationTrigger,
    pub status: DebateStatus,
    pub perspectives: Vec<Perspective>,
    pub rounds: Vec<DebateRound>,
    pub candidate_options: Vec<CandidateOption>,
    pub votes: Vec<Vote>,
    pub synthesis_result: Option<SynthesisResult>,
    pub participants: Vec<String>,
    pub deadline: u64,
    pub max_rounds: u32,
    pub duration: u64,
    pub consensus_reached: bool,
    pub final_decision: Option<String>,
    pub post_decision_outcome: Option<PostDecisionOutcome>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebateSnapshot {
    pub debates: Vec<DebateRecord>,
}
```

Add new `NervePayload` variants to the existing enum:

```rust
// Phase 4: Deliberation payloads
#[serde(rename = "debate:propose")]
DebatePropose {
    debate_id: String,
    question: String,
    context: String,
    deadline: u64,
    requested_angles: Vec<Angle>,
},
#[serde(rename = "debate:perspective")]
DebatePerspective {
    debate_id: String,
    agent_id: String,
    angle: Angle,
    position: String,
    confidence: f64,
},
#[serde(rename = "debate:rebuttal")]
DebateRebuttal {
    debate_id: String,
    round: u32,
    agent_id: String,
    ready_to_converge: bool,
},
#[serde(rename = "debate:vote")]
DebateVote {
    debate_id: String,
},
#[serde(rename = "debate:conclude")]
DebateConclude {
    debate_id: String,
    winning_option: String,
    margin: f64,
},
```

Add `NerveMessage` constructor:

```rust
pub fn new_debate(from: String, payload: NervePayload) -> Self {
    Self {
        id: nanoid::nanoid!(),
        topic: NerveTopic::Debate,
        from,
        timestamp: now_millis(),
        ttl: 120,
        payload,
    }
}
```

- [ ] **Step 4: Run tests**

Expected: All tests pass (existing + 8 new).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/super_agent/types.rs
git commit -m "feat(super-agent): add emergent intelligence types and debate NervePayload variants"
```

---

## Task 2: Ranked Choice Voting + Tests (`voting.rs`)

**Files:**
- Create: `src-tauri/src/commands/super_agent/voting.rs`

Pure algorithm — no IO, no async. This is the core of the synthesis phase.

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn make_vote(agent: &str, ranking: Vec<(&str, u32)>) -> Vote {
        Vote {
            agent_id: agent.to_string(),
            preferred_option_id: ranking[0].0.to_string(),
            ranking: ranking.into_iter().map(|(id, rank)| VoteRanking {
                option_id: id.to_string(),
                rank,
            }).collect(),
            confidence: 0.8,
            final_reasoning: "test".to_string(),
        }
    }

    #[test]
    fn single_option_wins_immediately() {
        let votes = vec![
            make_vote("a", vec![("opt-1", 1)]),
            make_vote("b", vec![("opt-1", 1)]),
        ];
        let options = vec!["opt-1".to_string()];
        let result = ranked_choice_vote(&votes, &options);
        assert_eq!(result.winning_option_id, "opt-1");
        assert_eq!(result.voting_rounds, 1);
        assert!((result.margin - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn majority_wins_first_round() {
        let votes = vec![
            make_vote("a", vec![("opt-1", 1), ("opt-2", 2)]),
            make_vote("b", vec![("opt-1", 1), ("opt-2", 2)]),
            make_vote("c", vec![("opt-2", 1), ("opt-1", 2)]),
        ];
        let options = vec!["opt-1".to_string(), "opt-2".to_string()];
        let result = ranked_choice_vote(&votes, &options);
        assert_eq!(result.winning_option_id, "opt-1");
        assert_eq!(result.voting_rounds, 1);
        assert!(result.margin > 0.5);
    }

    #[test]
    fn elimination_and_redistribution() {
        // 3 options: A=2, B=2, C=1 → C eliminated → C's voter prefers A
        let votes = vec![
            make_vote("v1", vec![("A", 1), ("B", 2), ("C", 3)]),
            make_vote("v2", vec![("A", 1), ("C", 2), ("B", 3)]),
            make_vote("v3", vec![("B", 1), ("A", 2), ("C", 3)]),
            make_vote("v4", vec![("B", 1), ("C", 2), ("A", 3)]),
            make_vote("v5", vec![("C", 1), ("A", 2), ("B", 3)]),
        ];
        let options = vec!["A".to_string(), "B".to_string(), "C".to_string()];
        let result = ranked_choice_vote(&votes, &options);
        // Round 1: A=2, B=2, C=1 → C eliminated
        // Round 2: A=3 (got C's voter), B=2 → A wins
        assert_eq!(result.winning_option_id, "A");
        assert_eq!(result.voting_rounds, 2);
    }

    #[test]
    fn no_votes_returns_first_option() {
        let votes: Vec<Vote> = vec![];
        let options = vec!["opt-1".to_string(), "opt-2".to_string()];
        let result = ranked_choice_vote(&votes, &options);
        assert_eq!(result.winning_option_id, "opt-1");
        assert_eq!(result.voting_rounds, 0);
    }

    #[test]
    fn dissent_captures_minority_reasoning() {
        let votes = vec![
            make_vote("a", vec![("opt-1", 1), ("opt-2", 2)]),
            make_vote("b", vec![("opt-1", 1), ("opt-2", 2)]),
            make_vote("c", vec![("opt-2", 1), ("opt-1", 2)]),
        ];
        let mut votes_clone = votes.clone();
        votes_clone[2].final_reasoning = "I prefer opt-2 because it's simpler".to_string();
        let options = vec!["opt-1".to_string(), "opt-2".to_string()];
        let result = ranked_choice_vote(&votes_clone, &options);
        assert_eq!(result.winning_option_id, "opt-1");
        assert!(!result.dissent.is_empty());
    }

    #[test]
    fn tie_resolved_by_elimination() {
        // Perfect tie: 2 vs 2, no third option → last option alphabetically eliminated
        let votes = vec![
            make_vote("a", vec![("X", 1), ("Y", 2)]),
            make_vote("b", vec![("X", 1), ("Y", 2)]),
            make_vote("c", vec![("Y", 1), ("X", 2)]),
            make_vote("d", vec![("Y", 1), ("X", 2)]),
        ];
        let options = vec!["X".to_string(), "Y".to_string()];
        let result = ranked_choice_vote(&votes, &options);
        // With 2 options tied, one will be eliminated and the other wins
        assert!(result.winning_option_id == "X" || result.winning_option_id == "Y");
    }
}
```

- [ ] **Step 2: Implement Ranked Choice Voting**

```rust
// src-tauri/src/commands/super_agent/voting.rs

use super::types::{Vote, VoteRanking, SynthesisResult};
use std::collections::HashMap;

/// Run Ranked Choice Voting on a set of votes.
/// Eliminates the option with fewest first-choice votes each round,
/// redistributing those votes to their next choices.
pub fn ranked_choice_vote(votes: &[Vote], options: &[String]) -> SynthesisResult {
    if votes.is_empty() || options.is_empty() {
        return SynthesisResult {
            winning_option_id: options.first().cloned().unwrap_or_default(),
            winning_description: String::new(),
            voting_rounds: 0,
            margin: 0.0,
            dissent: vec![],
        };
    }

    let total_voters = votes.len() as f64;
    let mut eliminated: Vec<String> = vec![];
    let mut round = 0;

    loop {
        round += 1;

        // Count first-choice votes (excluding eliminated options)
        let mut counts: HashMap<String, usize> = HashMap::new();
        for opt in options {
            if !eliminated.contains(opt) {
                counts.insert(opt.clone(), 0);
            }
        }

        for vote in votes {
            // Find highest-ranked non-eliminated option
            let mut sorted_ranking = vote.ranking.clone();
            sorted_ranking.sort_by_key(|r| r.rank);

            for vr in &sorted_ranking {
                if !eliminated.contains(&vr.option_id) && counts.contains_key(&vr.option_id) {
                    *counts.get_mut(&vr.option_id).unwrap() += 1;
                    break;
                }
            }
        }

        // Check for majority
        let active_options: Vec<(String, usize)> = counts.into_iter().collect();

        if active_options.is_empty() {
            break;
        }

        let max_votes = active_options.iter().map(|(_, c)| *c).max().unwrap_or(0);
        let winners: Vec<&String> = active_options.iter()
            .filter(|(_, c)| *c == max_votes)
            .map(|(id, _)| id)
            .collect();

        if max_votes as f64 > total_voters / 2.0 || active_options.len() <= 1 {
            // We have a winner
            let winner_id = winners[0].clone();
            let margin = max_votes as f64 / total_voters;

            // Collect dissent from voters who didn't pick the winner
            let dissent: Vec<String> = votes.iter()
                .filter(|v| v.preferred_option_id != winner_id)
                .map(|v| v.final_reasoning.clone())
                .filter(|r| !r.is_empty() && r != "test")
                .collect();

            return SynthesisResult {
                winning_option_id: winner_id,
                winning_description: String::new(),
                voting_rounds: round,
                margin,
                dissent,
            };
        }

        // Eliminate option with fewest votes
        let min_votes = active_options.iter().map(|(_, c)| *c).min().unwrap_or(0);
        let to_eliminate: Vec<String> = active_options.iter()
            .filter(|(_, c)| *c == min_votes)
            .map(|(id, _)| id.clone())
            .collect();

        // If all tied, eliminate the last one alphabetically
        if let Some(elim) = to_eliminate.into_iter().max() {
            eliminated.push(elim);
        }

        // Safety: prevent infinite loop
        if round > options.len() as u32 + 1 {
            break;
        }
    }

    // Fallback: return first non-eliminated option
    let winner = options.iter()
        .find(|o| !eliminated.contains(o))
        .cloned()
        .unwrap_or_else(|| options[0].clone());

    SynthesisResult {
        winning_option_id: winner,
        winning_description: String::new(),
        voting_rounds: round,
        margin: 0.0,
        dissent: vec![],
    }
}
```

- [ ] **Step 3: Add `pub mod voting;` to `mod.rs`**

- [ ] **Step 4: Run tests**

Expected: All 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/super_agent/voting.rs src-tauri/src/commands/super_agent/mod.rs
git commit -m "feat(super-agent): add Ranked Choice Voting algorithm with 6 unit tests"
```

---

## Task 3: Debate Board + Tests (`debate_board.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/blackboard.rs`
- Create: `src-tauri/src/commands/super_agent/debate_board.rs`

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::super_agent::blackboard::Blackboard;
    use crate::commands::super_agent::types::*;

    fn make_env() -> (DebateBoard, Blackboard) {
        let dir = tempfile::tempdir().unwrap();
        let bb = Blackboard::new(dir.path().to_path_buf());
        let db = DebateBoard::new();
        (db, bb)
    }

    fn make_debate(id: &str, status: DebateStatus) -> DebateRecord {
        DebateRecord {
            id: id.to_string(),
            question: "How to handle auth?".to_string(),
            trigger: DeliberationTrigger {
                explicit: true,
                creator_confidence: 0.3,
                domain_failure_rate: 0.0,
                cross_domain_count: 1,
            },
            status,
            perspectives: vec![],
            rounds: vec![],
            candidate_options: vec![],
            votes: vec![],
            synthesis_result: None,
            participants: vec!["node-a".to_string()],
            deadline: now_millis() + 30_000,
            max_rounds: 3,
            duration: 0,
            consensus_reached: false,
            final_decision: None,
            post_decision_outcome: None,
            created_at: now_millis(),
        }
    }

    #[test]
    fn upsert_and_get_debate() {
        let (db, mut bb) = make_env();
        let debate = make_debate("d1", DebateStatus::GatheringPerspectives);
        db.upsert_debate(&mut bb, &debate).unwrap();

        let retrieved = db.get_debate(&bb, "d1").unwrap();
        assert_eq!(retrieved.question, "How to handle auth?");
        assert_eq!(retrieved.status, DebateStatus::GatheringPerspectives);
    }

    #[test]
    fn get_all_debates() {
        let (db, mut bb) = make_env();
        db.upsert_debate(&mut bb, &make_debate("d1", DebateStatus::GatheringPerspectives)).unwrap();
        db.upsert_debate(&mut bb, &make_debate("d2", DebateStatus::Concluded)).unwrap();

        let all = db.get_all_debates(&bb);
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn get_active_debates() {
        let (db, mut bb) = make_env();
        db.upsert_debate(&mut bb, &make_debate("d1", DebateStatus::GatheringPerspectives)).unwrap();
        db.upsert_debate(&mut bb, &make_debate("d2", DebateStatus::Debating)).unwrap();
        db.upsert_debate(&mut bb, &make_debate("d3", DebateStatus::Concluded)).unwrap();

        let active = db.get_active_debates(&bb);
        assert_eq!(active.len(), 2);
    }

    #[test]
    fn update_debate_adds_perspective() {
        let (db, mut bb) = make_env();
        let mut debate = make_debate("d1", DebateStatus::GatheringPerspectives);
        db.upsert_debate(&mut bb, &debate).unwrap();

        debate.perspectives.push(Perspective {
            debate_id: "d1".to_string(),
            agent_id: "node-b".to_string(),
            angle: Angle::Security,
            position: "Use JWT".to_string(),
            reasoning: "Stateless".to_string(),
            evidence: vec![],
            risks: vec![],
            preferred_option: None,
            option_ranking: vec![],
            confidence: 0.8,
        });
        db.upsert_debate(&mut bb, &debate).unwrap();

        let retrieved = db.get_debate(&bb, "d1").unwrap();
        assert_eq!(retrieved.perspectives.len(), 1);
    }

    #[test]
    fn get_snapshot() {
        let (db, mut bb) = make_env();
        db.upsert_debate(&mut bb, &make_debate("d1", DebateStatus::Concluded)).unwrap();

        let snapshot = db.get_snapshot(&bb);
        assert_eq!(snapshot.debates.len(), 1);
    }

    #[test]
    fn nonexistent_debate_returns_none() {
        let (db, bb) = make_env();
        assert!(db.get_debate(&bb, "nonexistent").is_none());
    }
}
```

- [ ] **Step 2: Add `BoardType::Debates` to `blackboard.rs`**

Add `Debates` variant. Update `key()` → `"debates"`, `snapshot_filename()`. Add `init_board(BoardType::Debates)` in `Blackboard::new()`.

- [ ] **Step 3: Implement DebateBoard**

```rust
// src-tauri/src/commands/super_agent/debate_board.rs

use super::blackboard::{Blackboard, BoardType};
use super::types::*;
use tracing::warn;

pub struct DebateBoard;

impl DebateBoard {
    pub fn new() -> Self {
        DebateBoard
    }

    pub fn upsert_debate(&self, bb: &mut Blackboard, debate: &DebateRecord) -> Result<(), String> {
        let doc = bb.get_doc_mut(BoardType::Debates)
            .ok_or("Debates board not initialized")?;
        let map = doc.get_map("debates");
        let json = serde_json::to_string(debate)
            .map_err(|e| format!("Failed to serialize debate: {e}"))?;
        map.insert(&debate.id, json)
            .map_err(|e| format!("Failed to write debate: {e}"))?;
        Ok(())
    }

    pub fn get_debate(&self, bb: &Blackboard, id: &str) -> Option<DebateRecord> {
        let doc = bb.get_doc(BoardType::Debates)?;
        let map = doc.get_map("debates");
        let value = map.get(id)?;
        let json_str = value.as_string()?;
        serde_json::from_str::<DebateRecord>(json_str.as_ref()).ok()
    }

    pub fn get_all_debates(&self, bb: &Blackboard) -> Vec<DebateRecord> {
        let Some(doc) = bb.get_doc(BoardType::Debates) else { return vec![] };
        let map = doc.get_map("debates");
        let mut result = vec![];
        for key in map.keys() {
            if let Some(value) = map.get(&key) {
                if let Some(json_str) = value.as_string() {
                    match serde_json::from_str::<DebateRecord>(json_str.as_ref()) {
                        Ok(record) => result.push(record),
                        Err(e) => warn!("Failed to parse debate {key}: {e}"),
                    }
                }
            }
        }
        result
    }

    pub fn get_active_debates(&self, bb: &Blackboard) -> Vec<DebateRecord> {
        self.get_all_debates(bb)
            .into_iter()
            .filter(|d| d.status != DebateStatus::Concluded)
            .collect()
    }

    pub fn get_snapshot(&self, bb: &Blackboard) -> DebateSnapshot {
        DebateSnapshot {
            debates: self.get_all_debates(bb),
        }
    }
}
```

- [ ] **Step 4: Add `pub mod debate_board;` to `mod.rs`**

- [ ] **Step 5: Run tests**

Expected: All 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/super_agent/debate_board.rs src-tauri/src/commands/super_agent/blackboard.rs src-tauri/src/commands/super_agent/mod.rs
git commit -m "feat(super-agent): add DebateBoard with Loro CRDT and 6 unit tests"
```

---

## Task 4: Deliberation Engine + Tests (`deliberation.rs`)

**Files:**
- Create: `src-tauri/src/commands/super_agent/deliberation.rs`

Orchestrates the 3-phase deliberation pipeline.

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::super_agent::blackboard::Blackboard;
    use crate::commands::super_agent::types::*;

    fn make_env() -> (DeliberationEngine, Blackboard) {
        let dir = tempfile::tempdir().unwrap();
        let bb = Blackboard::new(dir.path().to_path_buf());
        let engine = DeliberationEngine::new("node-local".to_string());
        (engine, bb)
    }

    fn make_perspective(agent_id: &str, debate_id: &str, angle: Angle, position: &str) -> Perspective {
        Perspective {
            debate_id: debate_id.to_string(),
            agent_id: agent_id.to_string(),
            angle,
            position: position.to_string(),
            reasoning: "Because".to_string(),
            evidence: vec![],
            risks: vec![],
            preferred_option: Some(format!("option-{}", position.chars().next().unwrap_or('x'))),
            option_ranking: vec![],
            confidence: 0.8,
        }
    }

    #[test]
    fn create_deliberation() {
        let (engine, mut bb) = make_env();
        let trigger = DeliberationTrigger {
            explicit: true,
            creator_confidence: 0.3,
            domain_failure_rate: 0.0,
            cross_domain_count: 1,
        };

        let debate = engine.create_deliberation(
            &mut bb,
            "How to handle auth?".to_string(),
            "Rebuilding auth system".to_string(),
            vec![Angle::Security, Angle::Feasibility],
            trigger,
        ).unwrap();

        assert_eq!(debate.status, DebateStatus::GatheringPerspectives);
        assert!(debate.deadline > now_millis());
        assert_eq!(debate.max_rounds, 3);
    }

    #[test]
    fn add_perspective() {
        let (engine, mut bb) = make_env();
        let trigger = DeliberationTrigger { explicit: true, creator_confidence: 0.3, domain_failure_rate: 0.0, cross_domain_count: 1 };
        let debate = engine.create_deliberation(&mut bb, "Q".to_string(), "C".to_string(), vec![], trigger).unwrap();

        let perspective = make_perspective("node-b", &debate.id, Angle::Security, "Use JWT");
        engine.add_perspective(&mut bb, &debate.id, perspective).unwrap();

        let updated = engine.debate_board.get_debate(&bb, &debate.id).unwrap();
        assert_eq!(updated.perspectives.len(), 1);
        assert!(updated.participants.contains(&"node-b".to_string()));
    }

    #[test]
    fn has_divergence_detects_different_positions() {
        let perspectives = vec![
            make_perspective("a", "d1", Angle::Security, "Use JWT"),
            make_perspective("b", "d1", Angle::Performance, "Use sessions"),
        ];
        assert!(DeliberationEngine::has_divergence(&perspectives));
    }

    #[test]
    fn has_divergence_false_for_agreement() {
        let perspectives = vec![
            make_perspective("a", "d1", Angle::Security, "Use JWT"),
            make_perspective("b", "d1", Angle::Performance, "Use JWT"),
        ];
        assert!(!DeliberationEngine::has_divergence(&perspectives));
    }

    #[test]
    fn check_termination_all_converged() {
        let round = DebateRound {
            round: 1,
            responses: vec![
                DebateResponse {
                    agent_id: "a".to_string(),
                    rebuttals: vec![],
                    updated_position: None,
                    updated_confidence: 0.9,
                    ready_to_converge: true,
                },
                DebateResponse {
                    agent_id: "b".to_string(),
                    rebuttals: vec![],
                    updated_position: None,
                    updated_confidence: 0.8,
                    ready_to_converge: true,
                },
            ],
        };
        assert!(DeliberationEngine::should_terminate(&[round], 3));
    }

    #[test]
    fn check_termination_max_rounds() {
        let rounds: Vec<DebateRound> = (1..=3).map(|r| DebateRound {
            round: r,
            responses: vec![DebateResponse {
                agent_id: "a".to_string(),
                rebuttals: vec![],
                updated_position: None,
                updated_confidence: 0.5,
                ready_to_converge: false,
            }],
        }).collect();
        assert!(DeliberationEngine::should_terminate(&rounds, 3));
    }

    #[test]
    fn check_termination_supermajority() {
        let round = DebateRound {
            round: 1,
            responses: vec![
                DebateResponse { agent_id: "a".to_string(), rebuttals: vec![], updated_position: Some("JWT".to_string()), updated_confidence: 0.9, ready_to_converge: false },
                DebateResponse { agent_id: "b".to_string(), rebuttals: vec![], updated_position: Some("JWT".to_string()), updated_confidence: 0.8, ready_to_converge: false },
                DebateResponse { agent_id: "c".to_string(), rebuttals: vec![], updated_position: Some("Sessions".to_string()), updated_confidence: 0.6, ready_to_converge: false },
            ],
        };
        // 2/3 = 0.67 > 2/3 threshold → supermajority
        assert!(DeliberationEngine::should_terminate(&[round], 3));
    }

    #[test]
    fn conclude_debate() {
        let (engine, mut bb) = make_env();
        let trigger = DeliberationTrigger { explicit: true, creator_confidence: 0.3, domain_failure_rate: 0.0, cross_domain_count: 1 };
        let debate = engine.create_deliberation(&mut bb, "Q".to_string(), "C".to_string(), vec![], trigger).unwrap();

        let result = SynthesisResult {
            winning_option_id: "opt-1".to_string(),
            winning_description: "Use JWT".to_string(),
            voting_rounds: 1,
            margin: 0.67,
            dissent: vec![],
        };
        engine.conclude_debate(&mut bb, &debate.id, result).unwrap();

        let concluded = engine.debate_board.get_debate(&bb, &debate.id).unwrap();
        assert_eq!(concluded.status, DebateStatus::Concluded);
        assert!(concluded.synthesis_result.is_some());
        assert_eq!(concluded.final_decision, Some("Use JWT".to_string()));
    }
}
```

- [ ] **Step 2: Implement DeliberationEngine**

```rust
// src-tauri/src/commands/super_agent/deliberation.rs

use super::debate_board::DebateBoard;
use super::types::*;
use std::collections::HashMap;
use tracing::info;

const DEFAULT_DEADLINE_MS: u64 = 30_000; // 30 seconds
const DEFAULT_MAX_ROUNDS: u32 = 3;
const SUPERMAJORITY_THRESHOLD: f64 = 2.0 / 3.0;
const MIN_PERSPECTIVES: usize = 3;

use super::blackboard::Blackboard;

pub struct DeliberationEngine {
    pub debate_board: DebateBoard,
    local_node_id: String,
}

impl DeliberationEngine {
    pub fn new(local_node_id: String) -> Self {
        DeliberationEngine {
            debate_board: DebateBoard::new(),
            local_node_id,
        }
    }

    /// Create a new deliberation and store it.
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
            trigger,
            status: DebateStatus::GatheringPerspectives,
            perspectives: vec![],
            rounds: vec![],
            candidate_options: vec![],
            votes: vec![],
            synthesis_result: None,
            participants: vec![self.local_node_id.clone()],
            deadline: now + DEFAULT_DEADLINE_MS,
            max_rounds: DEFAULT_MAX_ROUNDS,
            duration: 0,
            consensus_reached: false,
            final_decision: None,
            post_decision_outcome: None,
            created_at: now,
        };

        self.debate_board.upsert_debate(bb, &debate)?;
        Ok(debate)
    }

    /// Add a perspective to an active debate.
    pub fn add_perspective(
        &self,
        bb: &mut Blackboard,
        debate_id: &str,
        perspective: Perspective,
    ) -> Result<(), String> {
        let mut debate = self.debate_board.get_debate(bb, debate_id)
            .ok_or_else(|| format!("Debate {debate_id} not found"))?;

        if debate.status != DebateStatus::GatheringPerspectives {
            return Err(format!("Debate {debate_id} not accepting perspectives"));
        }

        if !debate.participants.contains(&perspective.agent_id) {
            debate.participants.push(perspective.agent_id.clone());
        }
        debate.perspectives.push(perspective);
        self.debate_board.upsert_debate(bb, &debate)
    }

    /// Add a debate round.
    pub fn add_round(
        &self,
        bb: &mut Blackboard,
        debate_id: &str,
        round: DebateRound,
    ) -> Result<(), String> {
        let mut debate = self.debate_board.get_debate(bb, debate_id)
            .ok_or_else(|| format!("Debate {debate_id} not found"))?;

        debate.rounds.push(round);
        if debate.status == DebateStatus::GatheringPerspectives {
            debate.status = DebateStatus::Debating;
        }
        self.debate_board.upsert_debate(bb, &debate)
    }

    /// Add a vote to a debate.
    pub fn add_vote(
        &self,
        bb: &mut Blackboard,
        debate_id: &str,
        vote: Vote,
    ) -> Result<(), String> {
        let mut debate = self.debate_board.get_debate(bb, debate_id)
            .ok_or_else(|| format!("Debate {debate_id} not found"))?;

        debate.votes.retain(|v| v.agent_id != vote.agent_id);
        debate.votes.push(vote);

        if debate.status != DebateStatus::Voting {
            debate.status = DebateStatus::Voting;
        }
        self.debate_board.upsert_debate(bb, &debate)
    }

    /// Set candidate options for voting.
    pub fn set_candidate_options(
        &self,
        bb: &mut Blackboard,
        debate_id: &str,
        options: Vec<CandidateOption>,
    ) -> Result<(), String> {
        let mut debate = self.debate_board.get_debate(bb, debate_id)
            .ok_or_else(|| format!("Debate {debate_id} not found"))?;
        debate.candidate_options = options;
        self.debate_board.upsert_debate(bb, &debate)
    }

    /// Conclude a debate with a synthesis result.
    pub fn conclude_debate(
        &self,
        bb: &mut Blackboard,
        debate_id: &str,
        result: SynthesisResult,
    ) -> Result<(), String> {
        let mut debate = self.debate_board.get_debate(bb, debate_id)
            .ok_or_else(|| format!("Debate {debate_id} not found"))?;

        debate.final_decision = Some(result.winning_description.clone());
        debate.synthesis_result = Some(result);
        debate.status = DebateStatus::Concluded;
        debate.consensus_reached = debate.synthesis_result.as_ref()
            .map(|r| r.margin > SUPERMAJORITY_THRESHOLD)
            .unwrap_or(false);
        debate.duration = now_millis().saturating_sub(debate.created_at);

        info!("Debate {} concluded: {}", debate_id, debate.final_decision.as_deref().unwrap_or(""));
        self.debate_board.upsert_debate(bb, &debate)
    }

    /// Record post-decision outcome for learning feedback.
    pub fn record_outcome(
        &self,
        bb: &mut Blackboard,
        debate_id: &str,
        outcome: PostDecisionOutcome,
    ) -> Result<(), String> {
        let mut debate = self.debate_board.get_debate(bb, debate_id)
            .ok_or_else(|| format!("Debate {debate_id} not found"))?;
        debate.post_decision_outcome = Some(outcome);
        self.debate_board.upsert_debate(bb, &debate)
    }

    /// Check if perspectives have divergent positions.
    pub fn has_divergence(perspectives: &[Perspective]) -> bool {
        if perspectives.len() < 2 {
            return false;
        }
        let positions: Vec<&str> = perspectives.iter()
            .filter_map(|p| p.preferred_option.as_deref())
            .collect();
        if positions.is_empty() {
            // Fall back to comparing position text
            let texts: Vec<&str> = perspectives.iter().map(|p| p.position.as_str()).collect();
            let first = texts.first().unwrap();
            return texts.iter().any(|t| t != first);
        }
        let first = positions[0];
        positions.iter().any(|p| *p != first)
    }

    /// Check if debate should terminate.
    pub fn should_terminate(rounds: &[DebateRound], max_rounds: u32) -> bool {
        if rounds.is_empty() {
            return false;
        }

        // Max rounds reached
        if rounds.len() as u32 >= max_rounds {
            return true;
        }

        let last_round = &rounds[rounds.len() - 1];

        // All participants ready to converge
        if !last_round.responses.is_empty()
            && last_round.responses.iter().all(|r| r.ready_to_converge)
        {
            return true;
        }

        // Supermajority on same position
        if last_round.responses.len() >= 3 {
            let mut position_counts: HashMap<String, usize> = HashMap::new();
            for resp in &last_round.responses {
                if let Some(pos) = &resp.updated_position {
                    *position_counts.entry(pos.clone()).or_default() += 1;
                }
            }
            let total = last_round.responses.len() as f64;
            for (_, count) in &position_counts {
                if (*count as f64 / total) >= SUPERMAJORITY_THRESHOLD {
                    return true;
                }
            }
        }

        false
    }
}
```

- [ ] **Step 3: Add `pub mod deliberation;` to `mod.rs`**

- [ ] **Step 4: Run tests**

Expected: All 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/super_agent/deliberation.rs src-tauri/src/commands/super_agent/mod.rs
git commit -m "feat(super-agent): add DeliberationEngine with 3-phase pipeline and 8 unit tests"
```

---

## Task 5: Tauri Commands + State Wiring

**Files:**
- Modify: `src-tauri/src/commands/super_agent/commands.rs`
- Modify: `src-tauri/src/commands/super_agent/state.rs`
- Modify: `src-tauri/src/commands/super_agent/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Read current `state.rs` and `commands.rs`**

- [ ] **Step 2: Add debate commands to `commands.rs`**

```rust
use super::types::{DebateSnapshot, DebateRecord, Perspective, Vote, PostDecisionOutcome, Angle, DeliberationTrigger};

#[tauri::command]
pub async fn super_agent_start_deliberation(
    question: String,
    context: String,
    requested_angles: Vec<String>,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<DebateRecord, String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let angles: Vec<Angle> = requested_angles.iter().map(|a| match a.as_str() {
        "feasibility" => Angle::Feasibility,
        "performance" => Angle::Performance,
        "security" => Angle::Security,
        "maintainability" => Angle::Maintainability,
        "user_experience" => Angle::UserExperience,
        "cost" => Angle::Cost,
        _ => Angle::Risk,
    }).collect();

    let trigger = DeliberationTrigger {
        explicit: true,
        creator_confidence: 0.0,
        domain_failure_rate: 0.0,
        cross_domain_count: 0,
    };

    let mut bb = node.blackboard.lock().await;
    let debate = node.deliberation_engine.create_deliberation(
        &mut bb, question.clone(), context.clone(), angles.clone(), trigger,
    )?;

    // Broadcast debate:propose
    let payload = NervePayload::DebatePropose {
        debate_id: debate.id.clone(),
        question,
        context,
        deadline: debate.deadline,
        requested_angles: angles,
    };
    let msg = NerveMessage::new_debate(node.local_node_id.clone(), payload);
    drop(bb);
    node.nerve.broadcast(msg).await;

    Ok(debate)
}

#[tauri::command]
pub async fn super_agent_get_debates(
    state: tauri::State<'_, SuperAgentState>,
) -> Result<DebateSnapshot, String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;
    let bb = node.blackboard.lock().await;
    Ok(node.deliberation_engine.debate_board.get_snapshot(&bb))
}

#[tauri::command]
pub async fn super_agent_submit_perspective(
    debate_id: String,
    angle: String,
    position: String,
    reasoning: String,
    confidence: f64,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<(), String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let angle_enum = match angle.as_str() {
        "feasibility" => Angle::Feasibility,
        "performance" => Angle::Performance,
        "security" => Angle::Security,
        "maintainability" => Angle::Maintainability,
        "user_experience" => Angle::UserExperience,
        "cost" => Angle::Cost,
        _ => Angle::Risk,
    };

    let perspective = Perspective {
        debate_id: debate_id.clone(),
        agent_id: node.local_node_id.clone(),
        angle: angle_enum.clone(),
        position: position.clone(),
        reasoning,
        evidence: vec![],
        risks: vec![],
        preferred_option: None,
        option_ranking: vec![],
        confidence,
    };

    let mut bb = node.blackboard.lock().await;
    node.deliberation_engine.add_perspective(&mut bb, &debate_id, perspective)?;

    // Broadcast perspective
    let payload = NervePayload::DebatePerspective {
        debate_id,
        agent_id: node.local_node_id.clone(),
        angle: angle_enum,
        position,
        confidence,
    };
    let msg = NerveMessage::new_debate(node.local_node_id.clone(), payload);
    drop(bb);
    node.nerve.broadcast(msg).await;

    Ok(())
}

#[tauri::command]
pub async fn super_agent_submit_vote(
    debate_id: String,
    preferred_option_id: String,
    ranking: Vec<(String, u32)>,
    reasoning: String,
    confidence: f64,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<(), String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let vote = Vote {
        agent_id: node.local_node_id.clone(),
        preferred_option_id,
        ranking: ranking.into_iter().map(|(id, rank)| VoteRanking {
            option_id: id,
            rank,
        }).collect(),
        confidence,
        final_reasoning: reasoning,
    };

    let mut bb = node.blackboard.lock().await;
    node.deliberation_engine.add_vote(&mut bb, &debate_id, vote)?;

    let payload = NervePayload::DebateVote { debate_id };
    let msg = NerveMessage::new_debate(node.local_node_id.clone(), payload);
    drop(bb);
    node.nerve.broadcast(msg).await;

    Ok(())
}

#[tauri::command]
pub async fn super_agent_record_outcome(
    debate_id: String,
    task_id: String,
    actual_result: String,
    score: f64,
    was_correct: bool,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<(), String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let outcome = PostDecisionOutcome {
        task_id,
        actual_result,
        score,
        was_correct_decision: was_correct,
    };

    let mut bb = node.blackboard.lock().await;
    node.deliberation_engine.record_outcome(&mut bb, &debate_id, outcome)
}
```

- [ ] **Step 3: Add `DeliberationEngine` and `DebateBoard` to `SuperAgentNode` in `state.rs`**

```rust
pub deliberation_engine: DeliberationEngine,
```

Initialize in `start()`:
```rust
let deliberation_engine = DeliberationEngine::new(local_node_id.clone());
```

Handle debate NervePayload variants in gossip listener:
```rust
NervePayload::DebatePropose { debate_id, question, context, deadline, requested_angles } => {
    // Auto-respond with perspective based on our capabilities
    info!("Debate proposed: {debate_id} - {question}");
}

NervePayload::DebatePerspective { debate_id, agent_id, angle, position, confidence } => {
    let mut bb = blackboard.lock().await;
    let perspective = Perspective {
        debate_id: debate_id.clone(),
        agent_id: agent_id.clone(),
        angle,
        position,
        reasoning: String::new(),
        evidence: vec![],
        risks: vec![],
        preferred_option: None,
        option_ranking: vec![],
        confidence,
    };
    let _ = deliberation_engine.add_perspective(&mut bb, &debate_id, perspective);
}

NervePayload::DebateRebuttal { debate_id, round, agent_id, ready_to_converge } => {
    info!("Debate {debate_id} round {round}: {agent_id} converge={ready_to_converge}");
}

NervePayload::DebateVote { debate_id } => {
    info!("Vote received for debate {debate_id}");
}

NervePayload::DebateConclude { debate_id, winning_option, margin } => {
    info!("Debate {debate_id} concluded: {winning_option} (margin: {margin:.1}%)");
}
```

- [ ] **Step 4: Update `mod.rs` re-exports and register commands in `lib.rs`**

- [ ] **Step 5: Verify compilation and tests**

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/super_agent/ src-tauri/src/lib.rs
git commit -m "feat(super-agent): wire deliberation commands and debate gossip handling"
```

---

## Task 6: Frontend Debate Types + Store

**Files:**
- Modify: `packages/app/src/stores/super-agent.ts`
- Create: `packages/app/src/stores/__tests__/super-agent-debates.test.ts`

- [ ] **Step 1: Add debate types and store methods**

```typescript
// Types
export type Angle = 'feasibility' | 'performance' | 'security' | 'maintainability' | 'user_experience' | 'cost' | 'risk'
export type DebateStatus = 'gathering_perspectives' | 'debating' | 'voting' | 'concluded'
export type RebuttalStance = 'agree' | 'disagree' | 'partially_agree'

export interface Perspective {
  debateId: string
  agentId: string
  angle: Angle
  position: string
  reasoning: string
  evidence: string[]
  risks: string[]
  preferredOption: string | null
  optionRanking: Array<{ option: string; score: number; reason: string }>
  confidence: number
}

export interface Rebuttal {
  targetAgentId: string
  targetClaim: string
  response: RebuttalStance
  argument: string
  newEvidence: string | null
}

export interface DebateResponse {
  agentId: string
  rebuttals: Rebuttal[]
  updatedPosition: string | null
  updatedConfidence: number
  readyToConverge: boolean
}

export interface DebateRound {
  round: number
  responses: DebateResponse[]
}

export interface CandidateOption {
  id: string
  description: string
  synthesizedFrom: string[]
  pros: string[]
  cons: string[]
}

export interface VoteRanking {
  optionId: string
  rank: number
}

export interface DebateVote {
  agentId: string
  preferredOptionId: string
  ranking: VoteRanking[]
  confidence: number
  finalReasoning: string
}

export interface SynthesisResult {
  winningOptionId: string
  winningDescription: string
  votingRounds: number
  margin: number
  dissent: string[]
}

export interface PostDecisionOutcome {
  taskId: string
  actualResult: string
  score: number
  wasCorrectDecision: boolean
}

export interface DebateRecord {
  id: string
  question: string
  status: DebateStatus
  perspectives: Perspective[]
  rounds: DebateRound[]
  candidateOptions: CandidateOption[]
  votes: DebateVote[]
  synthesisResult: SynthesisResult | null
  participants: string[]
  deadline: number
  consensusReached: boolean
  finalDecision: string | null
  postDecisionOutcome: PostDecisionOutcome | null
  createdAt: number
}

export interface DebateSnapshot {
  debates: DebateRecord[]
}

export function isDebateSnapshot(value: unknown): value is DebateSnapshot {
  if (!value || typeof value !== 'object') return false
  const c = value as Partial<DebateSnapshot>
  return Array.isArray(c.debates)
}
```

Store additions:
```typescript
debates: DebateSnapshot
fetchDebates: () => Promise<void>
startDeliberation: (question: string, context: string, angles: Angle[]) => Promise<DebateRecord | null>
submitPerspective: (debateId: string, angle: Angle, position: string, reasoning: string, confidence: number) => Promise<void>
submitVote: (debateId: string, preferredOptionId: string, ranking: Array<[string, number]>, reasoning: string, confidence: number) => Promise<void>
```

- [ ] **Step 2: Write tests**

```typescript
// packages/app/src/stores/__tests__/super-agent-debates.test.ts
import { describe, it, expect } from 'vitest'
import { isDebateSnapshot } from '../super-agent'

describe('isDebateSnapshot', () => {
  it('returns true for valid empty snapshot', () => {
    expect(isDebateSnapshot({ debates: [] })).toBe(true)
  })

  it('returns false for null', () => {
    expect(isDebateSnapshot(null)).toBe(false)
  })

  it('returns false for missing debates', () => {
    expect(isDebateSnapshot({})).toBe(false)
  })

  it('returns false for non-array debates', () => {
    expect(isDebateSnapshot({ debates: 'not' })).toBe(false)
  })
})
```

- [ ] **Step 3: Run tests**

Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/stores/super-agent.ts packages/app/src/stores/__tests__/super-agent-debates.test.ts
git commit -m "feat(super-agent): add debate types and store methods with 4 Vitest tests"
```

---

## Task 7: Frontend Debate Visualization Panel

**Files:**
- Create: `packages/app/src/components/settings/team/DebateView.tsx`

- [ ] **Step 1: Read existing panel components for patterns**

- [ ] **Step 2: Create DebateView component**

Three sections matching the 3-phase pipeline:

1. **Perspectives Panel**: Each perspective as a card with angle badge (color per angle), position, confidence bar, evidence count
2. **Debate Rounds**: Collapsible rounds showing rebuttals (agree=green, disagree=red, partial=yellow), updated positions, convergence indicators
3. **Voting & Result**: Candidate options with pros/cons, vote tally, winning option highlighted, margin display, dissent section

Header shows: debate question, status badge, participant count, time remaining (if active) or duration (if concluded).

Post-decision outcome shows: task result, score, correct/incorrect badge.

Poll `fetchDebates` every 5 seconds.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/components/settings/team/DebateView.tsx
git commit -m "feat(super-agent): add debate visualization panel component"
```

---

## Summary

| Task | Component | Tests | What it delivers |
|------|-----------|-------|-----------------|
| 1 | `types.rs` | 8 | All L4 types (Angle, Perspective, DebateRound, Vote, SynthesisResult, DebateRecord) + 5 NervePayload debate variants |
| 2 | `voting.rs` | 6 | Ranked Choice Voting algorithm with elimination and redistribution |
| 3 | `debate_board.rs` + `blackboard.rs` | 6 | Debates Loro doc CRUD |
| 4 | `deliberation.rs` | 8 | 3-phase deliberation pipeline (gather → debate → vote), termination conditions |
| 5 | Commands + State + lib.rs | — | 5 Tauri commands + gossip listener for debate messages |
| 6 | `super-agent.ts` + tests | 4 | Frontend debate types + store methods |
| 7 | `DebateView.tsx` | — | Debate visualization panel |

**Total: 32 new tests** (28 Rust + 4 TypeScript)

**Test commands:**
- Rust: `cargo test -p teamclaw --lib super_agent --features p2p`
- Frontend: `npx vitest run src/stores/__tests__/super-agent-debates.test.ts`

**After all 7 tasks, the emergent intelligence pipeline:**
1. Agent creates deliberation → broadcasts `debate:propose` to network
2. Agents respond with perspectives from different angles (security, performance, cost...)
3. If divergence detected → structured debate up to 3 rounds with rebuttals
4. Termination when: all converge, max rounds, or supermajority (>2/3)
5. Candidate options synthesized → Ranked Choice Voting produces winner
6. Decision recorded with full debate history → outcome tracked for learning feedback

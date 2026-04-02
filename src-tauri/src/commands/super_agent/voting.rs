use std::collections::HashMap;
use super::types::{Vote, VoteRanking, SynthesisResult};

/// Ranked Choice Voting algorithm.
///
/// Pure function — no IO, no async.
pub fn ranked_choice_vote(votes: &[Vote], options: &[String]) -> SynthesisResult {
    // Edge case: no votes
    if votes.is_empty() {
        let winning_option_id = options.first().cloned().unwrap_or_default();
        return SynthesisResult {
            winning_option_id,
            winning_description: String::new(),
            voting_rounds: 0,
            margin: 0.0,
            dissent: vec![],
        };
    }

    // Edge case: no options
    if options.is_empty() {
        return SynthesisResult {
            winning_option_id: String::new(),
            winning_description: String::new(),
            voting_rounds: 0,
            margin: 0.0,
            dissent: vec![],
        };
    }

    // Track which options are still active (not eliminated)
    let mut eliminated: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut round: u32 = 0;

    loop {
        round += 1;

        // Count first-choice votes for each non-eliminated option
        let mut counts: HashMap<String, u32> = HashMap::new();
        for opt in options {
            if !eliminated.contains(opt) {
                counts.insert(opt.clone(), 0);
            }
        }

        for vote in votes {
            // Find the highest-ranked (lowest rank number) non-eliminated option for this voter
            let mut ranked: Vec<(&str, u32)> = vote
                .ranking
                .iter()
                .filter(|r| !eliminated.contains(&r.option_id))
                .map(|r| (r.option_id.as_str(), r.rank))
                .collect();
            ranked.sort_by_key(|&(_, rank)| rank);

            if let Some((top_choice, _)) = ranked.first() {
                if let Some(count) = counts.get_mut(*top_choice) {
                    *count += 1;
                }
            }
        }

        let total_votes: u32 = counts.values().sum();

        if total_votes == 0 {
            // No votes could be assigned — pick first remaining option
            let winner = options
                .iter()
                .find(|o| !eliminated.contains(*o))
                .cloned()
                .unwrap_or_default();
            return SynthesisResult {
                winning_option_id: winner,
                winning_description: String::new(),
                voting_rounds: round,
                margin: 0.0,
                dissent: vec![],
            };
        }

        // Check for a majority winner (>50%)
        if let Some((winner, &winner_count)) = counts.iter().max_by_key(|(_, &c)| c) {
            let ratio = winner_count as f64 / total_votes as f64;
            if ratio > 0.5 {
                let winning_option_id = winner.clone();
                let dissent = collect_dissent(votes, &winning_option_id);
                return SynthesisResult {
                    winning_option_id,
                    winning_description: String::new(),
                    voting_rounds: round,
                    margin: ratio,
                    dissent,
                };
            }
        }

        // No majority — eliminate the option with the fewest votes.
        // If there are only 0 or 1 active options left, declare winner.
        let active_options: Vec<String> = options
            .iter()
            .filter(|o| !eliminated.contains(*o))
            .cloned()
            .collect();

        if active_options.len() <= 1 {
            let winner = active_options.into_iter().next().unwrap_or_default();
            let dissent = collect_dissent(votes, &winner);
            let ratio = counts.get(&winner).copied().unwrap_or(0) as f64
                / total_votes as f64;
            return SynthesisResult {
                winning_option_id: winner,
                winning_description: String::new(),
                voting_rounds: round,
                margin: ratio,
                dissent,
            };
        }

        // Find option with fewest votes to eliminate
        let loser = counts
            .iter()
            .min_by_key(|(_, &c)| c)
            .map(|(opt, _)| opt.clone())
            .unwrap();
        eliminated.insert(loser);

        // Safety: prevent infinite loop if all options eliminated
        if eliminated.len() >= options.len() {
            let winner = options.first().cloned().unwrap_or_default();
            return SynthesisResult {
                winning_option_id: winner,
                winning_description: String::new(),
                voting_rounds: round,
                margin: 0.0,
                dissent: vec![],
            };
        }
    }
}

/// Collect final_reasoning from voters whose top-ranked non-eliminated option
/// was NOT the winner (i.e., their first preference was a losing option).
fn collect_dissent(votes: &[Vote], winning_option_id: &str) -> Vec<String> {
    votes
        .iter()
        .filter(|v| v.preferred_option_id != winning_option_id)
        .filter(|v| !v.final_reasoning.is_empty())
        .map(|v| v.final_reasoning.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_vote(agent: &str, ranking: Vec<(&str, u32)>) -> Vote {
        let preferred_option_id = ranking
            .iter()
            .min_by_key(|&&(_, rank)| rank)
            .map(|&(opt, _)| opt.to_string())
            .unwrap_or_default();
        Vote {
            agent_id: agent.to_string(),
            preferred_option_id,
            ranking: ranking
                .into_iter()
                .map(|(option_id, rank)| VoteRanking {
                    option_id: option_id.to_string(),
                    rank,
                })
                .collect(),
            confidence: 1.0,
            final_reasoning: format!("reasoning from {}", agent),
        }
    }

    #[test]
    fn single_option_wins_immediately() {
        let options = vec!["A".to_string(), "B".to_string()];
        let votes = vec![
            make_vote("agent-1", vec![("A", 1), ("B", 2)]),
            make_vote("agent-2", vec![("A", 1), ("B", 2)]),
        ];
        let result = ranked_choice_vote(&votes, &options);
        assert_eq!(result.winning_option_id, "A");
        assert_eq!(result.voting_rounds, 1);
        assert!((result.margin - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn majority_wins_first_round() {
        let options = vec!["A".to_string(), "B".to_string()];
        let votes = vec![
            make_vote("agent-1", vec![("A", 1), ("B", 2)]),
            make_vote("agent-2", vec![("A", 1), ("B", 2)]),
            make_vote("agent-3", vec![("B", 1), ("A", 2)]),
        ];
        let result = ranked_choice_vote(&votes, &options);
        assert_eq!(result.winning_option_id, "A");
        assert_eq!(result.voting_rounds, 1);
        // 2/3 ≈ 0.667
        assert!(result.margin > 0.5);
    }

    #[test]
    fn elimination_and_redistribution() {
        // A=2, B=2, C=1 → C eliminated → C's voter prefers A → A wins round 2
        let options = vec!["A".to_string(), "B".to_string(), "C".to_string()];
        let votes = vec![
            make_vote("agent-1", vec![("A", 1), ("B", 2), ("C", 3)]),
            make_vote("agent-2", vec![("A", 1), ("B", 2), ("C", 3)]),
            make_vote("agent-3", vec![("B", 1), ("A", 2), ("C", 3)]),
            make_vote("agent-4", vec![("B", 1), ("A", 2), ("C", 3)]),
            make_vote("agent-5", vec![("C", 1), ("A", 2), ("B", 3)]),
        ];
        let result = ranked_choice_vote(&votes, &options);
        assert_eq!(result.winning_option_id, "A");
        assert_eq!(result.voting_rounds, 2);
    }

    #[test]
    fn no_votes_returns_first_option() {
        let options = vec!["X".to_string(), "Y".to_string()];
        let votes: Vec<Vote> = vec![];
        let result = ranked_choice_vote(&votes, &options);
        assert_eq!(result.winning_option_id, "X");
        assert_eq!(result.voting_rounds, 0);
    }

    #[test]
    fn dissent_captures_minority_reasoning() {
        let options = vec!["A".to_string(), "B".to_string()];
        let mut votes = vec![
            make_vote("agent-1", vec![("A", 1), ("B", 2)]),
            make_vote("agent-2", vec![("A", 1), ("B", 2)]),
            make_vote("agent-3", vec![("B", 1), ("A", 2)]),
        ];
        // Give agent-3 a distinctive reasoning string
        votes[2].final_reasoning = "I prefer B because it's better".to_string();

        let result = ranked_choice_vote(&votes, &options);
        assert_eq!(result.winning_option_id, "A");
        assert!(result.dissent.contains(&"I prefer B because it's better".to_string()));
    }

    #[test]
    fn tie_resolved_by_elimination() {
        // 2 votes each for A and B → one eliminated → the other wins
        let options = vec!["A".to_string(), "B".to_string()];
        let votes = vec![
            make_vote("agent-1", vec![("A", 1), ("B", 2)]),
            make_vote("agent-2", vec![("A", 1), ("B", 2)]),
            make_vote("agent-3", vec![("B", 1), ("A", 2)]),
            make_vote("agent-4", vec![("B", 1), ("A", 2)]),
        ];
        let result = ranked_choice_vote(&votes, &options);
        // Either A or B may win depending on tie-breaking, but a winner must be declared
        assert!(result.winning_option_id == "A" || result.winning_option_id == "B");
        assert!(result.voting_rounds >= 1);
    }
}

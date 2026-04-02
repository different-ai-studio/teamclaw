use std::collections::HashMap;

use super::types::{
    Experience, ExperienceOutcome, Strategy, StrategyType, StrategyValidation, ValidationStatus,
    now_millis,
};

// ─── StrategyEngine ───────────────────────────────────────────────────────────

/// Pure-logic engine that distils a slice of `Experience` records into
/// `Strategy` objects.  No I/O; all state is passed in and returned.
pub struct StrategyEngine;

impl StrategyEngine {
    pub fn new() -> Self {
        StrategyEngine
    }

    /// Attempt to distil `experiences` into strategies.
    ///
    /// Experiences are grouped by domain.  Any group with fewer than 3 members
    /// is skipped.  For each qualifying group a single `Strategy` is produced
    /// whose type is determined by the success/failure ratio:
    ///
    /// * success_rate > 0.7 → `Recommend`
    /// * failure_rate > 0.5 → `Avoid`
    /// * otherwise          → `Compare`
    pub fn try_distill(&self, experiences: &[Experience]) -> Vec<Strategy> {
        // Group by domain.
        let mut by_domain: HashMap<&str, Vec<&Experience>> = HashMap::new();
        for exp in experiences {
            by_domain.entry(exp.domain.as_str()).or_default().push(exp);
        }

        let now = now_millis();
        let mut strategies = Vec::new();

        for (domain, group) in by_domain {
            if group.len() < 3 {
                continue;
            }

            let total = group.len() as f64;
            let success_count = group
                .iter()
                .filter(|e| e.outcome == ExperienceOutcome::Success)
                .count() as f64;
            let failure_count = group
                .iter()
                .filter(|e| e.outcome == ExperienceOutcome::Failure)
                .count() as f64;

            let success_rate = success_count / total;
            let failure_rate = failure_count / total;

            let strategy_type = if success_rate > 0.7 {
                StrategyType::Recommend
            } else if failure_rate > 0.5 {
                StrategyType::Avoid
            } else {
                StrategyType::Compare
            };

            // Collect source experience IDs and contributing agents (deduped).
            let source_experiences: Vec<String> =
                group.iter().map(|e| e.id.clone()).collect();

            let mut seen_agents: Vec<String> = Vec::new();
            for exp in &group {
                if !seen_agents.contains(&exp.agent_id) {
                    seen_agents.push(exp.agent_id.clone());
                }
            }

            // Derive condition / recommendation / reasoning from the group.
            let condition = format!(
                "When working in the '{}' domain ({} experiences observed)",
                domain,
                group.len()
            );
            let recommendation = match strategy_type {
                StrategyType::Recommend => format!(
                    "Apply approaches used in this domain (success rate: {:.0}%)",
                    success_rate * 100.0
                ),
                StrategyType::Avoid => format!(
                    "Avoid common approaches in this domain (failure rate: {:.0}%)",
                    failure_rate * 100.0
                ),
                StrategyType::Compare => format!(
                    "Compare multiple approaches in this domain (mixed results, success rate: {:.0}%)",
                    success_rate * 100.0
                ),
            };
            let reasoning = format!(
                "Distilled from {} experiences: {} successes, {} failures",
                group.len(),
                success_count as u32,
                failure_count as u32
            );

            // Collect all tags from the group (deduped).
            let mut tags: Vec<String> = Vec::new();
            for exp in &group {
                for tag in &exp.tags {
                    if !tags.contains(tag) {
                        tags.push(tag.clone());
                    }
                }
            }

            let strategy = Strategy {
                id: nanoid::nanoid!(),
                domain: domain.to_string(),
                tags,
                strategy_type,
                condition,
                recommendation,
                reasoning,
                source_experiences,
                success_rate,
                sample_size: group.len() as u32,
                contributing_agents: seen_agents,
                confidence_interval: 0.0,
                validation: StrategyValidation {
                    status: ValidationStatus::Proposed,
                    validated_by: vec![],
                    validation_score: 0.0,
                },
                created_at: now,
                updated_at: now,
            };

            strategies.push(strategy);
        }

        strategies
    }

    /// Return `true` when a strategy is ready for wider adoption.
    ///
    /// All four conditions must hold:
    /// 1. Validation status is `Validated`
    /// 2. At least 2 validators have signed off
    /// 3. Confidence interval ≥ 0.7
    /// 4. Sample size ≥ 5
    pub fn is_ready_for_distillation(strategy: &Strategy) -> bool {
        strategy.validation.status == ValidationStatus::Validated
            && strategy.validation.validated_by.len() >= 2
            && strategy.confidence_interval >= 0.7
            && strategy.sample_size >= 5
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::super_agent::types::{ExperienceMetrics, ValidationStatus};

    fn make_exp(id: &str, agent_id: &str, domain: &str, outcome: ExperienceOutcome) -> Experience {
        Experience {
            id: id.to_string(),
            agent_id: agent_id.to_string(),
            task_id: "task-1".to_string(),
            session_id: "sess-1".to_string(),
            domain: domain.to_string(),
            tags: vec![domain.to_string()],
            outcome,
            context: "test context".to_string(),
            action: "test action".to_string(),
            result: "test result".to_string(),
            lesson: "test lesson".to_string(),
            metrics: ExperienceMetrics {
                tokens_used: 100,
                duration: 1000,
                tool_call_count: 2,
                score: 0.8,
                retry_count: 0,
            },
            created_at: 1_000_000,
            expires_at: 9_999_999_999_999,
        }
    }

    // 1. No strategy produced when fewer than 3 experiences exist for a domain.
    #[test]
    fn no_strategy_with_fewer_than_3_experiences() {
        let engine = StrategyEngine::new();
        let experiences = vec![
            make_exp("e1", "a1", "frontend", ExperienceOutcome::Success),
            make_exp("e2", "a2", "frontend", ExperienceOutcome::Success),
        ];
        let strategies = engine.try_distill(&experiences);
        assert!(
            strategies.is_empty(),
            "Expected no strategies for fewer than 3 experiences"
        );
    }

    // 2. Three successes in a domain produce a Recommend strategy.
    #[test]
    fn recommend_strategy_from_mostly_successful() {
        let engine = StrategyEngine::new();
        let experiences = vec![
            make_exp("e1", "a1", "frontend", ExperienceOutcome::Success),
            make_exp("e2", "a2", "frontend", ExperienceOutcome::Success),
            make_exp("e3", "a3", "frontend", ExperienceOutcome::Success),
        ];
        let strategies = engine.try_distill(&experiences);
        assert_eq!(strategies.len(), 1);
        assert_eq!(strategies[0].strategy_type, StrategyType::Recommend);
        assert_eq!(strategies[0].domain, "frontend");
        assert!((strategies[0].success_rate - 1.0).abs() < f64::EPSILON);
    }

    // 3. Two failures + one success in a domain produce an Avoid strategy.
    #[test]
    fn avoid_strategy_from_mostly_failed() {
        let engine = StrategyEngine::new();
        let experiences = vec![
            make_exp("e1", "a1", "backend", ExperienceOutcome::Failure),
            make_exp("e2", "a2", "backend", ExperienceOutcome::Failure),
            make_exp("e3", "a3", "backend", ExperienceOutcome::Success),
        ];
        let strategies = engine.try_distill(&experiences);
        assert_eq!(strategies.len(), 1);
        assert_eq!(strategies[0].strategy_type, StrategyType::Avoid);
        assert_eq!(strategies[0].domain, "backend");
        // failure_rate = 2/3 ≈ 0.667 > 0.5
        let failure_rate = 2.0_f64 / 3.0;
        assert!((strategies[0].success_rate - (1.0 / 3.0)).abs() < 1e-10);
        assert!(failure_rate > 0.5);
    }

    // 4. 3 frontend + 3 backend experiences produce 2 separate strategies.
    #[test]
    fn separate_domains_produce_separate_strategies() {
        let engine = StrategyEngine::new();
        let experiences = vec![
            make_exp("e1", "a1", "frontend", ExperienceOutcome::Success),
            make_exp("e2", "a2", "frontend", ExperienceOutcome::Success),
            make_exp("e3", "a3", "frontend", ExperienceOutcome::Success),
            make_exp("e4", "b1", "backend", ExperienceOutcome::Success),
            make_exp("e5", "b2", "backend", ExperienceOutcome::Success),
            make_exp("e6", "b3", "backend", ExperienceOutcome::Success),
        ];
        let strategies = engine.try_distill(&experiences);
        assert_eq!(strategies.len(), 2);

        let domains: Vec<&str> = strategies.iter().map(|s| s.domain.as_str()).collect();
        assert!(domains.contains(&"frontend"), "Expected frontend strategy");
        assert!(domains.contains(&"backend"), "Expected backend strategy");
    }

    // 5. Three experiences from three different agents produce 3 contributing agents.
    #[test]
    fn contributing_agents_tracked() {
        let engine = StrategyEngine::new();
        let experiences = vec![
            make_exp("e1", "agent-alpha", "devops", ExperienceOutcome::Success),
            make_exp("e2", "agent-beta", "devops", ExperienceOutcome::Success),
            make_exp("e3", "agent-gamma", "devops", ExperienceOutcome::Failure),
        ];
        let strategies = engine.try_distill(&experiences);
        assert_eq!(strategies.len(), 1);
        let contributors = &strategies[0].contributing_agents;
        assert_eq!(contributors.len(), 3);
        assert!(contributors.contains(&"agent-alpha".to_string()));
        assert!(contributors.contains(&"agent-beta".to_string()));
        assert!(contributors.contains(&"agent-gamma".to_string()));
    }

    // 6. is_ready_for_distillation requires validated status, ≥2 validators,
    //    confidence ≥ 0.7, and sample_size ≥ 5.
    #[test]
    fn is_ready_for_distillation_checks() {
        let now = now_millis();

        let make_strategy = |status: ValidationStatus,
                              validated_by: Vec<String>,
                              confidence_interval: f64,
                              sample_size: u32|
         -> Strategy {
            Strategy {
                id: nanoid::nanoid!(),
                domain: "test".to_string(),
                tags: vec![],
                strategy_type: StrategyType::Recommend,
                condition: "test".to_string(),
                recommendation: "test".to_string(),
                reasoning: "test".to_string(),
                source_experiences: vec![],
                success_rate: 0.8,
                sample_size,
                contributing_agents: vec![],
                confidence_interval,
                validation: StrategyValidation {
                    status,
                    validated_by,
                    validation_score: 0.9,
                },
                created_at: now,
                updated_at: now,
            }
        };

        // All conditions met → ready.
        let ready = make_strategy(
            ValidationStatus::Validated,
            vec!["node-a".to_string(), "node-b".to_string()],
            0.8,
            10,
        );
        assert!(StrategyEngine::is_ready_for_distillation(&ready));

        // Wrong status → not ready.
        let wrong_status = make_strategy(
            ValidationStatus::Testing,
            vec!["node-a".to_string(), "node-b".to_string()],
            0.8,
            10,
        );
        assert!(!StrategyEngine::is_ready_for_distillation(&wrong_status));

        // Only 1 validator → not ready.
        let too_few_validators = make_strategy(
            ValidationStatus::Validated,
            vec!["node-a".to_string()],
            0.8,
            10,
        );
        assert!(!StrategyEngine::is_ready_for_distillation(&too_few_validators));

        // Confidence below threshold → not ready.
        let low_confidence = make_strategy(
            ValidationStatus::Validated,
            vec!["node-a".to_string(), "node-b".to_string()],
            0.6,
            10,
        );
        assert!(!StrategyEngine::is_ready_for_distillation(&low_confidence));

        // Sample size below threshold → not ready.
        let small_sample = make_strategy(
            ValidationStatus::Validated,
            vec!["node-a".to_string(), "node-b".to_string()],
            0.8,
            4,
        );
        assert!(!StrategyEngine::is_ready_for_distillation(&small_sample));
    }
}

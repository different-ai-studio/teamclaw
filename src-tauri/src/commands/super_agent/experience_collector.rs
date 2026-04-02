use super::types::{
    Experience, ExperienceMetrics, ExperienceOutcome, Task, TaskStatus, now_millis,
};

pub struct ExperienceCollector {
    local_node_id: String,
}

pub struct CapabilityUpdate {
    pub domain: String,
    pub score_delta: f64,
    pub task_delta: u64,
}

impl ExperienceCollector {
    pub fn new(local_node_id: String) -> Self {
        Self { local_node_id }
    }

    /// Generate an experience from a completed or failed task.
    /// Returns None if the task is not in a terminal state (Completed or Failed),
    /// or if the task has no result attached.
    pub fn collect_from_task(&self, task: &Task) -> Option<Experience> {
        // Only terminal states produce an experience
        match task.status {
            TaskStatus::Completed | TaskStatus::Failed => {}
            _ => return None,
        }

        let result = task.result.as_ref()?;

        let outcome = if task.status == TaskStatus::Failed {
            ExperienceOutcome::Failure
        } else if result.score >= 0.7 {
            ExperienceOutcome::Success
        } else if result.score >= 0.4 {
            ExperienceOutcome::Partial
        } else {
            ExperienceOutcome::Failure
        };

        let domain = task
            .required_capabilities
            .first()
            .cloned()
            .unwrap_or_else(|| "general".to_string());

        let duration = task.updated_at.saturating_sub(task.created_at) / 1000;

        let created_at = now_millis();
        let expires_at = created_at + 30u64 * 24 * 3600 * 1000;

        Some(Experience {
            id: nanoid::nanoid!(),
            agent_id: self.local_node_id.clone(),
            task_id: task.id.clone(),
            session_id: result.session_id.clone(),
            domain,
            tags: task.required_capabilities.clone(),
            outcome,
            context: task.description.clone(),
            action: String::new(),
            result: result.summary.clone(),
            lesson: String::new(),
            metrics: ExperienceMetrics {
                tokens_used: result.tokens_used,
                duration,
                tool_call_count: 0,
                score: result.score,
                retry_count: 0,
            },
            created_at,
            expires_at,
        })
    }

    /// Compute a capability update from a given experience.
    pub fn compute_capability_update(exp: &Experience) -> CapabilityUpdate {
        let score_delta = match exp.outcome {
            ExperienceOutcome::Success => exp.metrics.score,
            ExperienceOutcome::Partial => exp.metrics.score * 0.5,
            ExperienceOutcome::Failure => -exp.metrics.score,
        };

        CapabilityUpdate {
            domain: exp.domain.clone(),
            score_delta,
            task_delta: 1,
        }
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::{Task, TaskComplexity, TaskResult, TaskStatus, TaskUrgency};

    fn make_task(status: TaskStatus, score: f64) -> Task {
        Task {
            id: "task-1".to_string(),
            creator: "node-a".to_string(),
            description: "Implement feature X".to_string(),
            required_capabilities: vec!["rust".to_string(), "async".to_string()],
            urgency: TaskUrgency::Normal,
            complexity: TaskComplexity::Solo,
            status,
            bids: vec![],
            assignee: Some("node-b".to_string()),
            result: Some(TaskResult {
                summary: "Feature implemented successfully".to_string(),
                session_id: "sess-abc".to_string(),
                tokens_used: 2000,
                score,
            }),
            created_at: 1_000_000,
            updated_at: 1_061_000, // 61 seconds later → duration = 61s
        }
    }

    // 1. collect_from_completed_task — all fields correctly mapped
    #[test]
    fn collect_from_completed_task() {
        let collector = ExperienceCollector::new("node-local".to_string());
        let task = make_task(TaskStatus::Completed, 0.9);

        let exp = collector.collect_from_task(&task).expect("should produce an experience");

        assert_eq!(exp.agent_id, "node-local");
        assert_eq!(exp.task_id, "task-1");
        assert_eq!(exp.session_id, "sess-abc");
        assert_eq!(exp.domain, "rust");
        assert_eq!(exp.outcome, ExperienceOutcome::Success);
        assert_eq!(exp.context, "Implement feature X");
        assert_eq!(exp.result, "Feature implemented successfully");
        assert_eq!(exp.lesson, "");
        assert_eq!(exp.metrics.tokens_used, 2000);
        // duration = (1_061_000 - 1_000_000) / 1000 = 61
        assert_eq!(exp.metrics.duration, 61);
        assert!((exp.metrics.score - 0.9).abs() < f64::EPSILON);
        // expires_at is 30 days after created_at
        assert!(exp.expires_at > exp.created_at);
    }

    // 2. collect_maps_score_to_outcome — 0.8→Success, 0.5→Partial, Failed status→Failure
    #[test]
    fn collect_maps_score_to_outcome() {
        let collector = ExperienceCollector::new("node-local".to_string());

        // score 0.8 → Success
        let task_high = make_task(TaskStatus::Completed, 0.8);
        let exp_high = collector.collect_from_task(&task_high).unwrap();
        assert_eq!(exp_high.outcome, ExperienceOutcome::Success);

        // score 0.5 → Partial
        let task_mid = make_task(TaskStatus::Completed, 0.5);
        let exp_mid = collector.collect_from_task(&task_mid).unwrap();
        assert_eq!(exp_mid.outcome, ExperienceOutcome::Partial);

        // TaskStatus::Failed → always Failure regardless of score
        let task_failed = make_task(TaskStatus::Failed, 0.9);
        let exp_failed = collector.collect_from_task(&task_failed).unwrap();
        assert_eq!(exp_failed.outcome, ExperienceOutcome::Failure);
    }

    // 3. collect_returns_none_for_running_task — non-terminal returns None
    #[test]
    fn collect_returns_none_for_running_task() {
        let collector = ExperienceCollector::new("node-local".to_string());

        let statuses = vec![
            TaskStatus::Open,
            TaskStatus::Bidding,
            TaskStatus::Assigned,
            TaskStatus::Running,
        ];

        for status in statuses {
            let task = make_task(status, 0.9);
            assert!(
                collector.collect_from_task(&task).is_none(),
                "non-terminal task should yield None"
            );
        }
    }

    // 4. experience_expires_in_30_days — diff between expires_at and created_at ≈ 30 days
    #[test]
    fn experience_expires_in_30_days() {
        let collector = ExperienceCollector::new("node-local".to_string());
        let task = make_task(TaskStatus::Completed, 0.8);
        let exp = collector.collect_from_task(&task).unwrap();

        let thirty_days_ms: u64 = 30 * 24 * 3600 * 1000;
        let diff = exp.expires_at - exp.created_at;
        assert_eq!(diff, thirty_days_ms, "expires_at should be exactly 30 days after created_at");
    }

    // 5. capability_update_from_experience — domain + score_delta + task_delta=1
    #[test]
    fn capability_update_from_experience() {
        let exp = Experience {
            id: "exp-1".to_string(),
            agent_id: "node-1".to_string(),
            task_id: "task-1".to_string(),
            session_id: "sess-1".to_string(),
            domain: "rust".to_string(),
            tags: vec!["rust".to_string()],
            outcome: ExperienceOutcome::Success,
            context: "ctx".to_string(),
            action: String::new(),
            result: "res".to_string(),
            lesson: String::new(),
            metrics: ExperienceMetrics {
                tokens_used: 1000,
                duration: 60,
                tool_call_count: 5,
                score: 0.85,
                retry_count: 0,
            },
            created_at: 1_000_000,
            expires_at: 9_999_999_999_999,
        };

        let update = ExperienceCollector::compute_capability_update(&exp);

        assert_eq!(update.domain, "rust");
        assert_eq!(update.task_delta, 1);
        // Success: score_delta = score (0.85)
        assert!((update.score_delta - 0.85).abs() < f64::EPSILON);
    }
}

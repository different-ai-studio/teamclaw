use super::blackboard::Blackboard;
use super::task_board::TaskBoard;
use super::types::*;
use tracing::info;

pub struct TaskOrchestrator {
    pub task_board: TaskBoard,
    local_node_id: String,
    bidding_config: BiddingConfig,
}

impl TaskOrchestrator {
    pub fn new(local_node_id: String, bidding_config: BiddingConfig) -> Self {
        Self {
            task_board: TaskBoard::new(),
            local_node_id,
            bidding_config,
        }
    }

    /// Create a new task.
    ///
    /// - `TaskComplexity::Solo`     → immediately set to Running and self-assigned.
    /// - `TaskComplexity::Delegate` → set to Bidding so peers can submit bids.
    pub fn create_task(
        &self,
        bb: &mut Blackboard,
        description: String,
        required_capabilities: Vec<String>,
        urgency: TaskUrgency,
        complexity: TaskComplexity,
    ) -> Result<Task, String> {
        let mut task = Task::new(
            self.local_node_id.clone(),
            description,
            required_capabilities,
            urgency,
            complexity.clone(),
        );

        match complexity {
            TaskComplexity::Solo => {
                task.status = TaskStatus::Running;
                task.assignee = Some(self.local_node_id.clone());
                info!(
                    "Solo task {} created and self-assigned to {}",
                    task.id, self.local_node_id
                );
            }
            TaskComplexity::Delegate => {
                task.status = TaskStatus::Bidding;
                info!("Delegate task {} opened for bidding", task.id);
            }
        }

        self.task_board.upsert_task(bb, &task)?;
        Ok(task)
    }

    /// Add a bid to a task that is currently in Bidding status.
    ///
    /// If the same node has already submitted a bid it is replaced.
    pub fn add_bid(
        &self,
        bb: &mut Blackboard,
        task_id: &str,
        bid: Bid,
    ) -> Result<(), String> {
        let mut task = self
            .task_board
            .get_task(bb, task_id)
            .ok_or_else(|| format!("Task {task_id} not found"))?;

        if task.status != TaskStatus::Bidding {
            return Err(format!(
                "Task {task_id} is not in Bidding status (current: {:?})",
                task.status
            ));
        }

        // Replace an existing bid from the same node, or append.
        if let Some(pos) = task.bids.iter().position(|b| b.node_id == bid.node_id) {
            task.bids[pos] = bid;
        } else {
            task.bids.push(bid);
        }

        task.updated_at = now_millis();
        self.task_board.upsert_task(bb, &task)?;
        Ok(())
    }

    /// Score all bids and return the node_id of the highest-scoring bidder.
    ///
    /// Returns `None` when the task has no bids.
    pub fn select_winner(&self, bb: &Blackboard, task_id: &str) -> Option<String> {
        let task = self.task_board.get_task(bb, task_id)?;

        if task.bids.is_empty() {
            return None;
        }

        let max_tokens = task
            .bids
            .iter()
            .map(|b| b.estimated_tokens)
            .max()
            .unwrap_or(0);

        task.bids
            .iter()
            .max_by(|a, b| {
                let sa = a.score(&self.bidding_config, max_tokens);
                let sb = b.score(&self.bidding_config, max_tokens);
                sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|b| b.node_id.clone())
    }

    /// Assign a task to `assignee`, moving it to Assigned status.
    pub fn assign_task(
        &self,
        bb: &mut Blackboard,
        task_id: &str,
        assignee: String,
    ) -> Result<(), String> {
        let mut task = self
            .task_board
            .get_task(bb, task_id)
            .ok_or_else(|| format!("Task {task_id} not found"))?;

        task.status = TaskStatus::Assigned;
        task.assignee = Some(assignee.clone());
        task.updated_at = now_millis();

        info!("Task {} assigned to {}", task_id, assignee);
        self.task_board.upsert_task(bb, &task)?;
        Ok(())
    }

    /// Move a task from Assigned → Running.
    pub fn start_task(&self, bb: &mut Blackboard, task_id: &str) -> Result<(), String> {
        let mut task = self
            .task_board
            .get_task(bb, task_id)
            .ok_or_else(|| format!("Task {task_id} not found"))?;

        task.status = TaskStatus::Running;
        task.updated_at = now_millis();

        info!("Task {} started", task_id);
        self.task_board.upsert_task(bb, &task)?;
        Ok(())
    }

    /// Mark a task as Completed and record its result.
    pub fn complete_task(
        &self,
        bb: &mut Blackboard,
        task_id: &str,
        result: TaskResult,
    ) -> Result<(), String> {
        let mut task = self
            .task_board
            .get_task(bb, task_id)
            .ok_or_else(|| format!("Task {task_id} not found"))?;

        task.status = TaskStatus::Completed;
        task.result = Some(result);
        task.updated_at = now_millis();

        info!("Task {} completed", task_id);
        self.task_board.upsert_task(bb, &task)?;
        Ok(())
    }

    /// Mark a task as Failed and record an error result.
    pub fn fail_task(
        &self,
        bb: &mut Blackboard,
        task_id: &str,
        reason: String,
    ) -> Result<(), String> {
        let mut task = self
            .task_board
            .get_task(bb, task_id)
            .ok_or_else(|| format!("Task {task_id} not found"))?;

        task.status = TaskStatus::Failed;
        task.result = Some(TaskResult {
            summary: reason.clone(),
            session_id: String::new(),
            tokens_used: 0,
            score: 0.0,
        });
        task.updated_at = now_millis();

        info!("Task {} failed: {}", task_id, reason);
        self.task_board.upsert_task(bb, &task)?;
        Ok(())
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::blackboard::Blackboard;

    fn make_env() -> (TaskOrchestrator, Blackboard, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let bb = Blackboard::new(dir.path().to_path_buf());
        let orch = TaskOrchestrator::new("node-local".to_string(), BiddingConfig::default());
        (orch, bb, dir)
    }

    fn make_bid(node_id: &str, confidence: f64, cap_score: f64, load: f64, tokens: u64) -> Bid {
        Bid {
            node_id: node_id.to_string(),
            confidence,
            estimated_tokens: tokens,
            capability_score: cap_score,
            current_load: load,
            timestamp: now_millis(),
        }
    }

    // 1. Solo task goes directly to Running and is self-assigned.
    #[test]
    fn create_solo_task_goes_directly_to_running() {
        let (orch, mut bb, _dir) = make_env();
        let task = orch
            .create_task(
                &mut bb,
                "solo work".to_string(),
                vec!["rust".to_string()],
                TaskUrgency::Normal,
                TaskComplexity::Solo,
            )
            .expect("create_task should succeed");

        assert_eq!(task.status, TaskStatus::Running);
        assert_eq!(task.assignee, Some("node-local".to_string()));

        // Verify persisted state matches.
        let persisted = orch.task_board.get_task(&bb, &task.id).unwrap();
        assert_eq!(persisted.status, TaskStatus::Running);
        assert_eq!(persisted.assignee, Some("node-local".to_string()));
    }

    // 2. Delegate task opens bidding and has no assignee.
    #[test]
    fn create_delegate_task_opens_bidding() {
        let (orch, mut bb, _dir) = make_env();
        let task = orch
            .create_task(
                &mut bb,
                "delegate work".to_string(),
                vec!["python".to_string()],
                TaskUrgency::High,
                TaskComplexity::Delegate,
            )
            .expect("create_task should succeed");

        assert_eq!(task.status, TaskStatus::Bidding);
        assert!(task.assignee.is_none());

        let persisted = orch.task_board.get_task(&bb, &task.id).unwrap();
        assert_eq!(persisted.status, TaskStatus::Bidding);
        assert!(persisted.assignee.is_none());
    }

    // 3. Two bids submitted; the stronger bid wins winner selection.
    #[test]
    fn add_bid_and_select_winner() {
        let (orch, mut bb, _dir) = make_env();
        let task = orch
            .create_task(
                &mut bb,
                "pick winner".to_string(),
                vec!["ml".to_string()],
                TaskUrgency::Normal,
                TaskComplexity::Delegate,
            )
            .unwrap();

        let weak_bid = make_bid("node-weak", 0.4, 0.3, 0.8, 2000);
        let strong_bid = make_bid("node-strong", 0.9, 0.95, 0.1, 500);

        orch.add_bid(&mut bb, &task.id, weak_bid).expect("add weak bid");
        orch.add_bid(&mut bb, &task.id, strong_bid).expect("add strong bid");

        let winner = orch.select_winner(&bb, &task.id);
        assert_eq!(winner, Some("node-strong".to_string()));
    }

    // 4. assign_task sets status to Assigned and records the assignee.
    #[test]
    fn assign_task_updates_status() {
        let (orch, mut bb, _dir) = make_env();
        let task = orch
            .create_task(
                &mut bb,
                "assign me".to_string(),
                vec![],
                TaskUrgency::Low,
                TaskComplexity::Delegate,
            )
            .unwrap();

        orch.assign_task(&mut bb, &task.id, "node-winner".to_string())
            .expect("assign_task should succeed");

        let updated = orch.task_board.get_task(&bb, &task.id).unwrap();
        assert_eq!(updated.status, TaskStatus::Assigned);
        assert_eq!(updated.assignee, Some("node-winner".to_string()));
    }

    // 5. complete_task records status=Completed and the supplied result.
    #[test]
    fn complete_task_records_result() {
        let (orch, mut bb, _dir) = make_env();
        let task = orch
            .create_task(
                &mut bb,
                "do some work".to_string(),
                vec![],
                TaskUrgency::Normal,
                TaskComplexity::Solo,
            )
            .unwrap();

        let result = TaskResult {
            summary: "All done".to_string(),
            session_id: "sess-42".to_string(),
            tokens_used: 800,
            score: 0.95,
        };
        orch.complete_task(&mut bb, &task.id, result)
            .expect("complete_task should succeed");

        let updated = orch.task_board.get_task(&bb, &task.id).unwrap();
        assert_eq!(updated.status, TaskStatus::Completed);
        let r = updated.result.expect("result should be present");
        assert_eq!(r.summary, "All done");
        assert_eq!(r.tokens_used, 800);
        assert!((r.score - 0.95).abs() < f64::EPSILON);
    }

    // 6. fail_task sets status=Failed.
    #[test]
    fn fail_task_records_status() {
        let (orch, mut bb, _dir) = make_env();
        let task = orch
            .create_task(
                &mut bb,
                "will fail".to_string(),
                vec![],
                TaskUrgency::Normal,
                TaskComplexity::Solo,
            )
            .unwrap();

        orch.fail_task(&mut bb, &task.id, "out of memory".to_string())
            .expect("fail_task should succeed");

        let updated = orch.task_board.get_task(&bb, &task.id).unwrap();
        assert_eq!(updated.status, TaskStatus::Failed);
        let r = updated.result.expect("error result should be present");
        assert_eq!(r.summary, "out of memory");
    }

    // 7. select_winner with no bids returns None.
    #[test]
    fn no_bids_select_winner_returns_none() {
        let (orch, mut bb, _dir) = make_env();
        let task = orch
            .create_task(
                &mut bb,
                "nobody bid".to_string(),
                vec![],
                TaskUrgency::Low,
                TaskComplexity::Delegate,
            )
            .unwrap();

        let winner = orch.select_winner(&bb, &task.id);
        assert!(winner.is_none());
    }

    // 8. When confidence and capability are equal, the node with lower load wins.
    #[test]
    fn tiebreaker_prefers_lower_load() {
        let (orch, mut bb, _dir) = make_env();
        let task = orch
            .create_task(
                &mut bb,
                "tiebreaker test".to_string(),
                vec![],
                TaskUrgency::Normal,
                TaskComplexity::Delegate,
            )
            .unwrap();

        // Same confidence and capability_score; differ only in current_load.
        let high_load = make_bid("node-busy", 0.8, 0.8, 0.9, 1000);
        let low_load = make_bid("node-free", 0.8, 0.8, 0.1, 1000);

        orch.add_bid(&mut bb, &task.id, high_load).expect("add high-load bid");
        orch.add_bid(&mut bb, &task.id, low_load).expect("add low-load bid");

        let winner = orch.select_winner(&bb, &task.id);
        assert_eq!(winner, Some("node-free".to_string()));
    }
}

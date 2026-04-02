use super::blackboard::{Blackboard, BoardType};
use super::types::{Task, TaskStatus};
use tracing::warn;

pub struct TaskBoard;

impl TaskBoard {
    pub fn new() -> Self {
        Self
    }

    /// Insert or update a task in the Loro "tasks" map on the TaskBoard doc.
    pub fn upsert_task(&self, bb: &mut Blackboard, task: &Task) -> Result<(), String> {
        let json = serde_json::to_string(task)
            .map_err(|e| format!("Failed to serialize task {}: {e}", task.id))?;
        let doc = bb
            .get_doc_mut(BoardType::TaskBoard)
            .ok_or_else(|| "TaskBoard doc not found".to_string())?;
        let map = doc.get_map("tasks");
        map.insert(&task.id, json)
            .map_err(|e| format!("Failed to write task {} to LoroMap: {e}", task.id))?;
        Ok(())
    }

    /// Retrieve a single task by ID, or `None` if not found.
    pub fn get_task(&self, bb: &Blackboard, task_id: &str) -> Option<Task> {
        let doc = bb.get_doc(BoardType::TaskBoard)?;
        let map = doc.get_map("tasks");
        let value = map.get(task_id)?;
        if let loro::ValueOrContainer::Value(loro::LoroValue::String(json_str)) = value {
            match serde_json::from_str::<Task>(json_str.as_ref()) {
                Ok(task) => Some(task),
                Err(e) => {
                    warn!("Failed to deserialize task {task_id}: {e}");
                    None
                }
            }
        } else {
            None
        }
    }

    /// Return all tasks stored in the TaskBoard.
    pub fn get_all_tasks(&self, bb: &Blackboard) -> Vec<Task> {
        let Some(doc) = bb.get_doc(BoardType::TaskBoard) else {
            return Vec::new();
        };
        let map = doc.get_map("tasks");
        let mut tasks = Vec::new();
        for key in map.keys() {
            if let Some(value) = map.get(&key) {
                if let loro::ValueOrContainer::Value(loro::LoroValue::String(json_str)) = value {
                    match serde_json::from_str::<Task>(json_str.as_ref()) {
                        Ok(task) => tasks.push(task),
                        Err(e) => warn!("Failed to deserialize task for key {key}: {e}"),
                    }
                }
            }
        }
        tasks
    }

    /// Return all tasks whose status matches `status`.
    pub fn get_tasks_by_status(&self, bb: &Blackboard, status: TaskStatus) -> Vec<Task> {
        self.get_all_tasks(bb)
            .into_iter()
            .filter(|t| t.status == status)
            .collect()
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::blackboard::Blackboard;
    use super::super::types::{
        Bid, Task, TaskComplexity, TaskStatus, TaskUrgency,
    };
    use tempfile::tempdir;

    fn make_test_env() -> (TaskBoard, Blackboard) {
        let dir = tempdir().expect("tempdir");
        let bb = Blackboard::new(dir.path().to_path_buf());
        // Leak the tempdir so it stays alive for the duration of the test.
        std::mem::forget(dir);
        (TaskBoard::new(), bb)
    }

    fn make_task(id: &str, status: TaskStatus) -> Task {
        Task {
            id: id.to_string(),
            creator: "agent-creator".to_string(),
            description: format!("Task {id}"),
            required_capabilities: vec!["rust".to_string()],
            urgency: TaskUrgency::Normal,
            complexity: TaskComplexity::Solo,
            status,
            bids: vec![],
            assignee: None,
            result: None,
            created_at: 1_000,
            updated_at: 1_000,
        }
    }

    // 1. upsert + get by ID
    #[test]
    fn create_and_get_task() {
        let (tb, mut bb) = make_test_env();
        let task = make_task("task-1", TaskStatus::Open);

        tb.upsert_task(&mut bb, &task).expect("upsert should succeed");

        let retrieved = tb.get_task(&bb, "task-1");
        assert!(retrieved.is_some(), "task should be retrievable after upsert");
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.id, "task-1");
        assert_eq!(retrieved.status, TaskStatus::Open);
        assert_eq!(retrieved.creator, "agent-creator");
    }

    // 2. Two tasks upserted — both returned by get_all_tasks
    #[test]
    fn get_all_tasks() {
        let (tb, mut bb) = make_test_env();
        let task_a = make_task("task-a", TaskStatus::Open);
        let task_b = make_task("task-b", TaskStatus::Running);

        tb.upsert_task(&mut bb, &task_a).expect("upsert a");
        tb.upsert_task(&mut bb, &task_b).expect("upsert b");

        let all = tb.get_all_tasks(&bb);
        assert_eq!(all.len(), 2, "should have exactly 2 tasks");
        let ids: Vec<&str> = all.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"task-a"), "task-a should be present");
        assert!(ids.contains(&"task-b"), "task-b should be present");
    }

    // 3. Upsert with changed status, verify the update is reflected
    #[test]
    fn update_task_status() {
        let (tb, mut bb) = make_test_env();
        let task = make_task("task-update", TaskStatus::Open);
        tb.upsert_task(&mut bb, &task).expect("initial upsert");

        let mut updated = task.clone();
        updated.status = TaskStatus::Running;
        tb.upsert_task(&mut bb, &updated).expect("status update upsert");

        let retrieved = tb.get_task(&bb, "task-update").expect("task should exist");
        assert_eq!(
            retrieved.status,
            TaskStatus::Running,
            "status should be updated to Running"
        );
    }

    // 4. Push a bid to task.bids, upsert, verify the bid is persisted
    #[test]
    fn add_bid_to_task() {
        let (tb, mut bb) = make_test_env();
        let mut task = make_task("task-bid", TaskStatus::Bidding);
        tb.upsert_task(&mut bb, &task).expect("initial upsert");

        let bid = Bid {
            node_id: "bidder-node".to_string(),
            confidence: 0.85,
            estimated_tokens: 1_200,
            capability_score: 0.9,
            current_load: 0.15,
            timestamp: 42_000,
        };
        task.bids.push(bid);
        tb.upsert_task(&mut bb, &task).expect("upsert with bid");

        let retrieved = tb.get_task(&bb, "task-bid").expect("task should exist");
        assert_eq!(retrieved.bids.len(), 1, "task should have exactly 1 bid");
        assert_eq!(retrieved.bids[0].node_id, "bidder-node");
        assert!((retrieved.bids[0].confidence - 0.85).abs() < f64::EPSILON);
    }

    // 5. Open + Running tasks — filter each status independently
    #[test]
    fn get_tasks_by_status() {
        let (tb, mut bb) = make_test_env();
        let open_task = make_task("open-1", TaskStatus::Open);
        let running_task = make_task("running-1", TaskStatus::Running);

        tb.upsert_task(&mut bb, &open_task).expect("upsert open");
        tb.upsert_task(&mut bb, &running_task).expect("upsert running");

        let open_tasks = tb.get_tasks_by_status(&bb, TaskStatus::Open);
        assert_eq!(open_tasks.len(), 1, "should have 1 open task");
        assert_eq!(open_tasks[0].id, "open-1");

        let running_tasks = tb.get_tasks_by_status(&bb, TaskStatus::Running);
        assert_eq!(running_tasks.len(), 1, "should have 1 running task");
        assert_eq!(running_tasks[0].id, "running-1");

        let completed_tasks = tb.get_tasks_by_status(&bb, TaskStatus::Completed);
        assert!(completed_tasks.is_empty(), "no completed tasks should exist");
    }

    // 6. get_task on a nonexistent ID returns None
    #[test]
    fn nonexistent_task_returns_none() {
        let (tb, bb) = make_test_env();
        let result = tb.get_task(&bb, "does-not-exist");
        assert!(result.is_none(), "nonexistent task should return None");
    }
}

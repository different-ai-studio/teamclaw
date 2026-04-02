# Super Agent Phase 2: Task Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable agents to delegate tasks to the most suitable peer — Agent A broadcasts a task it can't handle, the best-matching Agent B bids and executes it, with the full lifecycle tracked on a shared CRDT task board.

**Architecture:** Extends the Phase 1 `super_agent` module. New task-related `NervePayload` variants for real-time events (broadcast/bid/assign/progress). New `BoardType::TaskBoard` Loro doc for persistent task state. A `TaskOrchestrator` coordinates the bidding protocol. Phase 2 scope: SOLO + DELEGATE only (no DAG/parallel). Frontend gets a task board panel.

**Tech Stack:** Rust (loro 1, serde, tokio, nanoid), TypeScript (Zustand, Tauri IPC), React

**Test strategy:** Rust `#[cfg(test)]` unit tests for task types, bidding logic, orchestrator state machine, and task board CRUD. Frontend store tests via Vitest.

---

## File Structure

### Rust Backend (modify existing + new files in `src-tauri/src/commands/super_agent/`)

| File | Action | Responsibility |
|------|--------|---------------|
| `types.rs` | Modify | Add `Task`, `TaskStatus`, `TaskComplexity`, `TaskUrgency`, `Bid`, `TaskResult`, `BiddingConfig` types. Add task-related `NervePayload` variants. |
| `blackboard.rs` | Modify | Add `BoardType::TaskBoard` variant, initialize `taskboard.loro` on startup. |
| `task_board.rs` | **Create** | `TaskBoard` — CRUD operations on taskboard.loro Loro doc: create task, add bid, assign, update status, query tasks. |
| `orchestrator.rs` | **Create** | `TaskOrchestrator` — bidding protocol, bid scoring, task lifecycle state machine, timeout handling. |
| `commands.rs` | Modify | Add Tauri commands: `super_agent_create_task`, `super_agent_get_tasks`, `super_agent_task_board_snapshot`. |
| `state.rs` | Modify | Add `TaskOrchestrator` to `SuperAgentNode`, handle task-related Nerve messages in gossip listener. |
| `mod.rs` | Modify | Add `pub mod task_board; pub mod orchestrator;`, re-export new commands. |

### Frontend (`packages/app/src/`)

| File | Action | Responsibility |
|------|--------|---------------|
| `stores/super-agent.ts` | Modify | Add task-related types, task board state, new invoke methods. |
| `stores/__tests__/super-agent-tasks.test.ts` | **Create** | Vitest tests for task type guards and bid scoring. |
| `components/settings/team/TaskBoard.tsx` | **Create** | Task board panel: shows tasks with status, bids, assignee. |

---

## Task 1: Task Types + Tests (`types.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/types.rs`

- [ ] **Step 1: Write failing tests for new types**

Add these tests to the existing `#[cfg(test)] mod tests` block in `types.rs`:

```rust
#[test]
fn task_status_serde_roundtrip() {
    let statuses = vec![
        TaskStatus::Open, TaskStatus::Bidding, TaskStatus::Assigned,
        TaskStatus::Running, TaskStatus::Completed, TaskStatus::Failed, TaskStatus::Aborted,
    ];
    for status in statuses {
        let json = serde_json::to_string(&status).unwrap();
        let back: TaskStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back, status);
    }
}

#[test]
fn task_serde_roundtrip() {
    let task = Task {
        id: "task-1".to_string(),
        creator: "node-a".to_string(),
        description: "Fix the bug".to_string(),
        required_capabilities: vec!["frontend".to_string()],
        urgency: TaskUrgency::Normal,
        complexity: TaskComplexity::Delegate,
        status: TaskStatus::Open,
        bids: vec![],
        assignee: None,
        result: None,
        created_at: 1000,
        updated_at: 1000,
    };
    let json = serde_json::to_string(&task).unwrap();
    let back: Task = serde_json::from_str(&json).unwrap();
    assert_eq!(back.id, "task-1");
    assert_eq!(back.status, TaskStatus::Open);
    assert_eq!(back.required_capabilities, vec!["frontend"]);
}

#[test]
fn bid_score_calculation() {
    let config = BiddingConfig::default();
    let bid = Bid {
        node_id: "n1".to_string(),
        confidence: 0.8,
        estimated_tokens: 1000,
        capability_score: 0.9,
        current_load: 0.2,
        timestamp: 0,
    };
    let score = bid.score(&config, 2000); // max_tokens = 2000 for normalization
    // 0.3*0.8 + 0.4*0.9 + 0.2*(1-0.2) + 0.1*(1 - 1000/2000)
    // = 0.24 + 0.36 + 0.16 + 0.05 = 0.81
    assert!((score - 0.81).abs() < 0.01, "Expected ~0.81, got {score}");
}

#[test]
fn bid_score_zero_tokens_handled() {
    let config = BiddingConfig::default();
    let bid = Bid {
        node_id: "n1".to_string(),
        confidence: 0.5,
        estimated_tokens: 0,
        capability_score: 0.5,
        current_load: 0.5,
        timestamp: 0,
    };
    let score = bid.score(&config, 0); // both zero
    assert!(score.is_finite());
}

#[test]
fn task_broadcast_payload_serde() {
    let payload = NervePayload::TaskBroadcast {
        task_id: "t1".to_string(),
        description: "Do stuff".to_string(),
        required_capabilities: vec!["backend".to_string()],
        urgency: TaskUrgency::High,
    };
    let msg = NerveMessage {
        id: "m1".to_string(),
        topic: NerveTopic::Task,
        from: "node-a".to_string(),
        timestamp: now_millis(),
        ttl: 60,
        payload,
    };
    let json = serde_json::to_string(&msg).unwrap();
    let back: NerveMessage = serde_json::from_str(&json).unwrap();
    assert_eq!(back.topic, NerveTopic::Task);
    match back.payload {
        NervePayload::TaskBroadcast { task_id, urgency, .. } => {
            assert_eq!(task_id, "t1");
            assert_eq!(urgency, TaskUrgency::High);
        }
        _ => panic!("Expected TaskBroadcast"),
    }
}

#[test]
fn task_bid_payload_serde() {
    let payload = NervePayload::TaskBid {
        task_id: "t1".to_string(),
        confidence: 0.85,
        estimated_tokens: 500,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let back: NervePayload = serde_json::from_str(&json).unwrap();
    match back {
        NervePayload::TaskBid { task_id, confidence, .. } => {
            assert_eq!(task_id, "t1");
            assert!((confidence - 0.85).abs() < f64::EPSILON);
        }
        _ => panic!("Expected TaskBid"),
    }
}

#[test]
fn task_assign_payload_serde() {
    let payload = NervePayload::TaskAssign {
        task_id: "t1".to_string(),
        assignee: "node-b".to_string(),
    };
    let json = serde_json::to_string(&payload).unwrap();
    let back: NervePayload = serde_json::from_str(&json).unwrap();
    match back {
        NervePayload::TaskAssign { task_id, assignee } => {
            assert_eq!(task_id, "t1");
            assert_eq!(assignee, "node-b");
        }
        _ => panic!("Expected TaskAssign"),
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent::types --features p2p 2>&1 | tail -20`

Expected: Compilation errors — `Task`, `TaskStatus`, `Bid`, etc. not defined yet.

- [ ] **Step 3: Add new types and NervePayload variants**

Add these types to `types.rs` (after the existing types, before the `impl NerveMessage` block):

```rust
// ─── Layer 2: Task Orchestration ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Open,
    Bidding,
    Assigned,
    Running,
    Completed,
    Failed,
    Aborted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskComplexity {
    Solo,
    Delegate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskUrgency {
    Low,
    Normal,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub creator: String,
    pub description: String,
    pub required_capabilities: Vec<String>,
    pub urgency: TaskUrgency,
    pub complexity: TaskComplexity,
    pub status: TaskStatus,
    pub bids: Vec<Bid>,
    pub assignee: Option<String>,
    pub result: Option<TaskResult>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bid {
    pub node_id: String,
    pub confidence: f64,
    pub estimated_tokens: u64,
    pub capability_score: f64,
    pub current_load: f64,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    pub summary: String,
    pub session_id: String,
    pub tokens_used: u64,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiddingConfig {
    pub window_ms: u64,
    pub min_bids: u32,
    pub w_confidence: f64,
    pub w_capability: f64,
    pub w_load: f64,
    pub w_token_efficiency: f64,
}

impl Default for BiddingConfig {
    fn default() -> Self {
        BiddingConfig {
            window_ms: 5000,
            min_bids: 1,
            w_confidence: 0.3,
            w_capability: 0.4,
            w_load: 0.2,
            w_token_efficiency: 0.1,
        }
    }
}

impl Bid {
    /// Calculate bid score using weighted formula.
    /// `max_estimated_tokens` is the highest estimated_tokens among all bids (for normalization).
    pub fn score(&self, config: &BiddingConfig, max_estimated_tokens: u64) -> f64 {
        let token_efficiency = if max_estimated_tokens == 0 || self.estimated_tokens == 0 {
            0.5 // neutral when no token data
        } else {
            1.0 - (self.estimated_tokens as f64 / max_estimated_tokens as f64)
        };

        config.w_confidence * self.confidence
            + config.w_capability * self.capability_score
            + config.w_load * (1.0 - self.current_load)
            + config.w_token_efficiency * token_efficiency
    }
}

impl Task {
    /// Create a new task in Open status.
    pub fn new(
        creator: String,
        description: String,
        required_capabilities: Vec<String>,
        urgency: TaskUrgency,
        complexity: TaskComplexity,
    ) -> Self {
        let now = now_millis();
        Task {
            id: nanoid::nanoid!(),
            creator,
            description,
            required_capabilities,
            urgency,
            complexity,
            status: TaskStatus::Open,
            bids: vec![],
            assignee: None,
            result: None,
            created_at: now,
            updated_at: now,
        }
    }
}

/// Snapshot of the task board for frontend display.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBoardSnapshot {
    pub tasks: Vec<Task>,
}
```

Add new `NervePayload` variants to the existing enum:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NervePayload {
    #[serde(rename = "heartbeat")]
    Heartbeat(HeartbeatPayload),
    #[serde(rename = "emergency:abort")]
    EmergencyAbort { task_id: Option<String>, reason: String },
    #[serde(rename = "emergency:alert")]
    EmergencyAlert { task_id: Option<String>, reason: String },
    // Phase 2: Task orchestration payloads
    #[serde(rename = "task:broadcast")]
    TaskBroadcast {
        task_id: String,
        description: String,
        required_capabilities: Vec<String>,
        urgency: TaskUrgency,
    },
    #[serde(rename = "task:bid")]
    TaskBid {
        task_id: String,
        confidence: f64,
        estimated_tokens: u64,
    },
    #[serde(rename = "task:assign")]
    TaskAssign {
        task_id: String,
        assignee: String,
    },
    #[serde(rename = "task:progress")]
    TaskProgress {
        task_id: String,
        progress: u32,
        message: String,
    },
}
```

Add a `NerveMessage` constructor for task messages:

```rust
impl NerveMessage {
    // ... existing methods ...

    pub fn new_task(from: String, payload: NervePayload) -> Self {
        Self {
            id: nanoid::nanoid!(),
            topic: NerveTopic::Task,
            from,
            timestamp: now_millis(),
            ttl: 60,
            payload,
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent::types --features p2p 2>&1 | tail -25`

Expected: All 14 tests pass (7 existing + 7 new).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/super_agent/types.rs
git commit -m "feat(super-agent): add task orchestration types and NervePayload variants"
```

---

## Task 2: TaskBoard Loro Doc (`blackboard.rs` + `task_board.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/blackboard.rs`
- Create: `src-tauri/src/commands/super_agent/task_board.rs`

- [ ] **Step 1: Write failing tests for TaskBoard**

Create `task_board.rs` with tests only:

```rust
// src-tauri/src/commands/super_agent/task_board.rs

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::super_agent::blackboard::Blackboard;
    use crate::commands::super_agent::types::*;

    fn make_env() -> (TaskBoard, Blackboard) {
        let dir = tempfile::tempdir().unwrap();
        let bb = Blackboard::new(dir.path().to_path_buf());
        let tb = TaskBoard::new();
        (tb, bb)
    }

    fn make_task(id: &str, creator: &str) -> Task {
        Task {
            id: id.to_string(),
            creator: creator.to_string(),
            description: "Test task".to_string(),
            required_capabilities: vec!["frontend".to_string()],
            urgency: TaskUrgency::Normal,
            complexity: TaskComplexity::Delegate,
            status: TaskStatus::Open,
            bids: vec![],
            assignee: None,
            result: None,
            created_at: now_millis(),
            updated_at: now_millis(),
        }
    }

    #[test]
    fn create_and_get_task() {
        let (tb, mut bb) = make_env();
        let task = make_task("t1", "node-a");
        tb.upsert_task(&mut bb, &task).unwrap();

        let retrieved = tb.get_task(&bb, "t1").unwrap();
        assert_eq!(retrieved.id, "t1");
        assert_eq!(retrieved.creator, "node-a");
    }

    #[test]
    fn get_all_tasks() {
        let (tb, mut bb) = make_env();
        tb.upsert_task(&mut bb, &make_task("t1", "a")).unwrap();
        tb.upsert_task(&mut bb, &make_task("t2", "b")).unwrap();

        let tasks = tb.get_all_tasks(&bb);
        assert_eq!(tasks.len(), 2);
    }

    #[test]
    fn update_task_status() {
        let (tb, mut bb) = make_env();
        let mut task = make_task("t1", "a");
        tb.upsert_task(&mut bb, &task).unwrap();

        task.status = TaskStatus::Bidding;
        task.updated_at = now_millis();
        tb.upsert_task(&mut bb, &task).unwrap();

        let retrieved = tb.get_task(&bb, "t1").unwrap();
        assert_eq!(retrieved.status, TaskStatus::Bidding);
    }

    #[test]
    fn add_bid_to_task() {
        let (tb, mut bb) = make_env();
        let mut task = make_task("t1", "a");
        task.status = TaskStatus::Bidding;
        tb.upsert_task(&mut bb, &task).unwrap();

        let bid = Bid {
            node_id: "node-b".to_string(),
            confidence: 0.8,
            estimated_tokens: 1000,
            capability_score: 0.9,
            current_load: 0.2,
            timestamp: now_millis(),
        };
        task.bids.push(bid);
        tb.upsert_task(&mut bb, &task).unwrap();

        let retrieved = tb.get_task(&bb, "t1").unwrap();
        assert_eq!(retrieved.bids.len(), 1);
        assert_eq!(retrieved.bids[0].node_id, "node-b");
    }

    #[test]
    fn get_tasks_by_status() {
        let (tb, mut bb) = make_env();
        let mut open = make_task("t1", "a");
        let mut running = make_task("t2", "b");
        running.status = TaskStatus::Running;

        tb.upsert_task(&mut bb, &open).unwrap();
        tb.upsert_task(&mut bb, &running).unwrap();

        let open_tasks = tb.get_tasks_by_status(&bb, TaskStatus::Open);
        assert_eq!(open_tasks.len(), 1);
        assert_eq!(open_tasks[0].id, "t1");

        let running_tasks = tb.get_tasks_by_status(&bb, TaskStatus::Running);
        assert_eq!(running_tasks.len(), 1);
        assert_eq!(running_tasks[0].id, "t2");
    }

    #[test]
    fn nonexistent_task_returns_none() {
        let (tb, bb) = make_env();
        assert!(tb.get_task(&bb, "nonexistent").is_none());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent::task_board --features p2p 2>&1 | tail -20`

Expected: Compilation errors — `TaskBoard` not defined.

- [ ] **Step 3: Add `BoardType::TaskBoard` to blackboard.rs**

In `blackboard.rs`, add the `TaskBoard` variant to `BoardType`:

```rust
pub enum BoardType {
    Registry,
    TaskBoard,
}
```

Update `key()` and `snapshot_filename()`:

```rust
impl BoardType {
    pub fn key(&self) -> &'static str {
        match self {
            BoardType::Registry => "registry",
            BoardType::TaskBoard => "taskboard",
        }
    }

    pub fn snapshot_filename(&self) -> String {
        match self {
            BoardType::Registry => "registry.snapshot".to_string(),
            BoardType::TaskBoard => "taskboard.snapshot".to_string(),
        }
    }
}
```

In `Blackboard::new()`, add initialization for the TaskBoard doc after Registry:

```rust
bb.init_board(BoardType::Registry)?;
bb.init_board(BoardType::TaskBoard)?;
```

- [ ] **Step 4: Implement TaskBoard**

Add the implementation above the test module in `task_board.rs`:

```rust
// src-tauri/src/commands/super_agent/task_board.rs

use super::blackboard::{Blackboard, BoardType};
use super::types::{Task, TaskStatus};
use tracing::warn;

/// Manages task CRUD operations on the taskboard Loro doc.
pub struct TaskBoard;

impl TaskBoard {
    pub fn new() -> Self {
        TaskBoard
    }

    /// Write (create or update) a task to the blackboard.
    pub fn upsert_task(&self, bb: &mut Blackboard, task: &Task) -> Result<(), String> {
        let doc = bb.get_doc_mut(BoardType::TaskBoard)
            .ok_or("TaskBoard not initialized")?;
        let tasks_map = doc.get_map("tasks");
        let json = serde_json::to_string(task)
            .map_err(|e| format!("Failed to serialize task: {e}"))?;
        tasks_map.insert(&task.id, json)
            .map_err(|e| format!("Failed to write task: {e}"))?;
        Ok(())
    }

    /// Get a single task by ID.
    pub fn get_task(&self, bb: &Blackboard, task_id: &str) -> Option<Task> {
        let doc = bb.get_doc(BoardType::TaskBoard)?;
        let tasks_map = doc.get_map("tasks");
        let value = tasks_map.get(task_id)?;
        let json_str = value.as_string()?;
        serde_json::from_str::<Task>(json_str.as_ref()).ok()
    }

    /// Get all tasks from the board.
    pub fn get_all_tasks(&self, bb: &Blackboard) -> Vec<Task> {
        let Some(doc) = bb.get_doc(BoardType::TaskBoard) else {
            return vec![];
        };
        let tasks_map = doc.get_map("tasks");
        let mut result = vec![];
        for key in tasks_map.keys() {
            if let Some(value) = tasks_map.get(&key) {
                if let Some(json_str) = value.as_string() {
                    match serde_json::from_str::<Task>(json_str.as_ref()) {
                        Ok(task) => result.push(task),
                        Err(e) => warn!("Failed to parse task {}: {e}", key),
                    }
                }
            }
        }
        result
    }

    /// Get tasks filtered by status.
    pub fn get_tasks_by_status(&self, bb: &Blackboard, status: TaskStatus) -> Vec<Task> {
        self.get_all_tasks(bb)
            .into_iter()
            .filter(|t| t.status == status)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    // ... (tests from Step 1)
}
```

- [ ] **Step 5: Add `pub mod task_board;` to `mod.rs`**

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent::task_board --features p2p 2>&1 | tail -20`

Expected: All 6 tests pass.

Also run all existing tests: `cargo test -p teamclaw --lib super_agent --features p2p`

Expected: All 29 tests pass (23 existing + 6 new).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/super_agent/task_board.rs src-tauri/src/commands/super_agent/blackboard.rs src-tauri/src/commands/super_agent/mod.rs
git commit -m "feat(super-agent): add TaskBoard with Loro CRDT and 6 unit tests"
```

---

## Task 3: Task Orchestrator + Tests (`orchestrator.rs`)

**Files:**
- Create: `src-tauri/src/commands/super_agent/orchestrator.rs`

The orchestrator manages the bidding protocol and task lifecycle.

- [ ] **Step 1: Write failing tests**

```rust
// src-tauri/src/commands/super_agent/orchestrator.rs

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::super_agent::blackboard::Blackboard;
    use crate::commands::super_agent::registry::AgentRegistry;
    use crate::commands::super_agent::types::*;

    fn make_env() -> (TaskOrchestrator, Blackboard) {
        let dir = tempfile::tempdir().unwrap();
        let bb = Blackboard::new(dir.path().to_path_buf());
        let orch = TaskOrchestrator::new("node-local".to_string(), BiddingConfig::default());
        (orch, bb)
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

    #[test]
    fn create_solo_task_goes_directly_to_running() {
        let (orch, mut bb) = make_env();
        let task = orch.create_task(
            &mut bb,
            "Fix typo".to_string(),
            vec![],
            TaskUrgency::Low,
            TaskComplexity::Solo,
        ).unwrap();

        assert_eq!(task.status, TaskStatus::Running);
        assert_eq!(task.assignee, Some("node-local".to_string()));
    }

    #[test]
    fn create_delegate_task_opens_bidding() {
        let (orch, mut bb) = make_env();
        let task = orch.create_task(
            &mut bb,
            "Build dashboard".to_string(),
            vec!["frontend".to_string()],
            TaskUrgency::Normal,
            TaskComplexity::Delegate,
        ).unwrap();

        assert_eq!(task.status, TaskStatus::Bidding);
        assert_eq!(task.assignee, None);
    }

    #[test]
    fn add_bid_and_select_winner() {
        let (orch, mut bb) = make_env();
        let task = orch.create_task(
            &mut bb,
            "Task".to_string(),
            vec!["frontend".to_string()],
            TaskUrgency::Normal,
            TaskComplexity::Delegate,
        ).unwrap();

        let bid_weak = make_bid("node-b", 0.3, 0.5, 0.8, 2000);
        let bid_strong = make_bid("node-c", 0.9, 0.9, 0.1, 500);

        orch.add_bid(&mut bb, &task.id, bid_weak).unwrap();
        orch.add_bid(&mut bb, &task.id, bid_strong).unwrap();

        let winner = orch.select_winner(&bb, &task.id).unwrap();
        assert_eq!(winner, "node-c");
    }

    #[test]
    fn assign_task_updates_status() {
        let (orch, mut bb) = make_env();
        let task = orch.create_task(
            &mut bb,
            "Task".to_string(),
            vec![],
            TaskUrgency::Normal,
            TaskComplexity::Delegate,
        ).unwrap();

        orch.assign_task(&mut bb, &task.id, "node-b").unwrap();

        let updated = orch.task_board.get_task(&bb, &task.id).unwrap();
        assert_eq!(updated.status, TaskStatus::Assigned);
        assert_eq!(updated.assignee, Some("node-b".to_string()));
    }

    #[test]
    fn complete_task_records_result() {
        let (orch, mut bb) = make_env();
        let task = orch.create_task(
            &mut bb,
            "Task".to_string(),
            vec![],
            TaskUrgency::Normal,
            TaskComplexity::Solo,
        ).unwrap();

        let result = TaskResult {
            summary: "Done".to_string(),
            session_id: "sess-1".to_string(),
            tokens_used: 500,
            score: 0.9,
        };
        orch.complete_task(&mut bb, &task.id, result).unwrap();

        let updated = orch.task_board.get_task(&bb, &task.id).unwrap();
        assert_eq!(updated.status, TaskStatus::Completed);
        assert!(updated.result.is_some());
        assert_eq!(updated.result.unwrap().summary, "Done");
    }

    #[test]
    fn fail_task_records_status() {
        let (orch, mut bb) = make_env();
        let task = orch.create_task(
            &mut bb,
            "Task".to_string(),
            vec![],
            TaskUrgency::Normal,
            TaskComplexity::Solo,
        ).unwrap();

        orch.fail_task(&mut bb, &task.id, "Out of tokens".to_string()).unwrap();

        let updated = orch.task_board.get_task(&bb, &task.id).unwrap();
        assert_eq!(updated.status, TaskStatus::Failed);
    }

    #[test]
    fn no_bids_select_winner_returns_none() {
        let (orch, mut bb) = make_env();
        let task = orch.create_task(
            &mut bb,
            "Task".to_string(),
            vec![],
            TaskUrgency::Normal,
            TaskComplexity::Delegate,
        ).unwrap();

        assert!(orch.select_winner(&bb, &task.id).is_none());
    }

    #[test]
    fn tiebreaker_prefers_lower_load() {
        let (orch, mut bb) = make_env();
        let task = orch.create_task(
            &mut bb,
            "Task".to_string(),
            vec![],
            TaskUrgency::Normal,
            TaskComplexity::Delegate,
        ).unwrap();

        // Same confidence and capability, different load
        let bid1 = make_bid("node-b", 0.8, 0.8, 0.5, 1000);
        let bid2 = make_bid("node-c", 0.8, 0.8, 0.1, 1000); // lower load

        orch.add_bid(&mut bb, &task.id, bid1).unwrap();
        orch.add_bid(&mut bb, &task.id, bid2).unwrap();

        let winner = orch.select_winner(&bb, &task.id).unwrap();
        assert_eq!(winner, "node-c");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent::orchestrator --features p2p 2>&1 | tail -20`

Expected: Compilation errors.

- [ ] **Step 3: Implement TaskOrchestrator**

```rust
// src-tauri/src/commands/super_agent/orchestrator.rs

use super::blackboard::Blackboard;
use super::task_board::TaskBoard;
use super::types::*;
use tracing::info;

/// Manages the task lifecycle: creation, bidding, assignment, completion.
pub struct TaskOrchestrator {
    pub task_board: TaskBoard,
    local_node_id: String,
    bidding_config: BiddingConfig,
}

impl TaskOrchestrator {
    pub fn new(local_node_id: String, bidding_config: BiddingConfig) -> Self {
        TaskOrchestrator {
            task_board: TaskBoard::new(),
            local_node_id,
            bidding_config,
        }
    }

    /// Create a new task. SOLO tasks go directly to Running; DELEGATE tasks open for bidding.
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
            }
            TaskComplexity::Delegate => {
                task.status = TaskStatus::Bidding;
            }
        }

        self.task_board.upsert_task(bb, &task)?;
        Ok(task)
    }

    /// Add a bid from a remote agent.
    pub fn add_bid(&self, bb: &mut Blackboard, task_id: &str, bid: Bid) -> Result<(), String> {
        let mut task = self.task_board.get_task(bb, task_id)
            .ok_or_else(|| format!("Task {task_id} not found"))?;

        if task.status != TaskStatus::Bidding {
            return Err(format!("Task {task_id} not accepting bids (status: {:?})", task.status));
        }

        // Replace existing bid from same node
        task.bids.retain(|b| b.node_id != bid.node_id);
        task.bids.push(bid);
        task.updated_at = now_millis();
        self.task_board.upsert_task(bb, &task)?;
        Ok(())
    }

    /// Select the winning bidder. Returns None if no bids.
    pub fn select_winner(&self, bb: &Blackboard, task_id: &str) -> Option<String> {
        let task = self.task_board.get_task(bb, task_id)?;

        if task.bids.is_empty() {
            return None;
        }

        let max_tokens = task.bids.iter()
            .map(|b| b.estimated_tokens)
            .max()
            .unwrap_or(1);

        let mut scored: Vec<(String, f64)> = task.bids.iter()
            .map(|b| (b.node_id.clone(), b.score(&self.bidding_config, max_tokens)))
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        scored.first().map(|(node_id, _)| node_id.clone())
    }

    /// Assign a task to a specific agent.
    pub fn assign_task(&self, bb: &mut Blackboard, task_id: &str, assignee: &str) -> Result<(), String> {
        let mut task = self.task_board.get_task(bb, task_id)
            .ok_or_else(|| format!("Task {task_id} not found"))?;

        task.status = TaskStatus::Assigned;
        task.assignee = Some(assignee.to_string());
        task.updated_at = now_millis();
        self.task_board.upsert_task(bb, &task)?;
        info!("Task {} assigned to {}", task_id, assignee);
        Ok(())
    }

    /// Mark a task's status as Running.
    pub fn start_task(&self, bb: &mut Blackboard, task_id: &str) -> Result<(), String> {
        let mut task = self.task_board.get_task(bb, task_id)
            .ok_or_else(|| format!("Task {task_id} not found"))?;
        task.status = TaskStatus::Running;
        task.updated_at = now_millis();
        self.task_board.upsert_task(bb, &task)
    }

    /// Complete a task with a result.
    pub fn complete_task(&self, bb: &mut Blackboard, task_id: &str, result: TaskResult) -> Result<(), String> {
        let mut task = self.task_board.get_task(bb, task_id)
            .ok_or_else(|| format!("Task {task_id} not found"))?;
        task.status = TaskStatus::Completed;
        task.result = Some(result);
        task.updated_at = now_millis();
        self.task_board.upsert_task(bb, &task)?;
        info!("Task {} completed", task_id);
        Ok(())
    }

    /// Fail a task with an error message.
    pub fn fail_task(&self, bb: &mut Blackboard, task_id: &str, reason: String) -> Result<(), String> {
        let mut task = self.task_board.get_task(bb, task_id)
            .ok_or_else(|| format!("Task {task_id} not found"))?;
        task.status = TaskStatus::Failed;
        task.result = Some(TaskResult {
            summary: reason,
            session_id: String::new(),
            tokens_used: 0,
            score: 0.0,
        });
        task.updated_at = now_millis();
        self.task_board.upsert_task(bb, &task)
    }
}

#[cfg(test)]
mod tests {
    // ... (tests from Step 1)
}
```

- [ ] **Step 4: Add `pub mod orchestrator;` to `mod.rs`**

- [ ] **Step 5: Run tests**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent::orchestrator --features p2p 2>&1 | tail -20`

Expected: All 8 tests pass.

Run all: `cargo test -p teamclaw --lib super_agent --features p2p`

Expected: All 37 tests pass (29 existing + 8 new).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/super_agent/orchestrator.rs src-tauri/src/commands/super_agent/mod.rs
git commit -m "feat(super-agent): add TaskOrchestrator with bidding protocol and 8 unit tests"
```

---

## Task 4: Tauri Commands for Tasks (`commands.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/commands.rs`
- Modify: `src-tauri/src/commands/super_agent/mod.rs`

- [ ] **Step 1: Add new commands**

Add to `commands.rs`:

```rust
use super::types::{Task, TaskBoardSnapshot, TaskComplexity, TaskUrgency, TaskResult};

/// Create a new task and broadcast it to the network.
#[tauri::command]
pub async fn super_agent_create_task(
    description: String,
    required_capabilities: Vec<String>,
    urgency: String,
    complexity: String,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<Task, String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let urgency = match urgency.as_str() {
        "low" => TaskUrgency::Low,
        "high" => TaskUrgency::High,
        "critical" => TaskUrgency::Critical,
        _ => TaskUrgency::Normal,
    };
    let complexity = match complexity.as_str() {
        "solo" => TaskComplexity::Solo,
        _ => TaskComplexity::Delegate,
    };

    let mut bb = node.blackboard.lock().await;
    let task = node.orchestrator.lock().await
        .create_task(&mut bb, description.clone(), required_capabilities.clone(), urgency.clone(), complexity.clone())?;

    // If delegate, broadcast to network
    if complexity == TaskComplexity::Delegate {
        let payload = super::types::NervePayload::TaskBroadcast {
            task_id: task.id.clone(),
            description,
            required_capabilities,
            urgency,
        };
        let msg = super::types::NerveMessage::new_task(
            node.local_node_id.clone(),
            payload,
        );
        if let Err(e) = node.nerve.broadcast(msg).await {
            tracing::warn!("Failed to broadcast task: {e}");
        }
    }

    Ok(task)
}

/// Get all tasks from the task board.
#[tauri::command]
pub async fn super_agent_get_tasks(
    state: tauri::State<'_, SuperAgentState>,
) -> Result<TaskBoardSnapshot, String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let bb = node.blackboard.lock().await;
    let orch = node.orchestrator.lock().await;
    let tasks = orch.task_board.get_all_tasks(&bb);

    Ok(TaskBoardSnapshot { tasks })
}
```

- [ ] **Step 2: Update `mod.rs` re-exports**

Add:
```rust
pub use commands::{super_agent_create_task, super_agent_get_tasks};
```

- [ ] **Step 3: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check --features p2p 2>&1 | tail -10`

Note: This will fail until Task 5 adds `orchestrator` to `SuperAgentNode`. Create a temporary compilation by adding `pub orchestrator: Arc<Mutex<TaskOrchestrator>>` to `SuperAgentNode`. Or — better — do Task 5 first and come back. But since we want atomic commits, just verify the commands module compiles in isolation by checking types are correct.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/super_agent/commands.rs src-tauri/src/commands/super_agent/mod.rs
git commit -m "feat(super-agent): add Tauri commands for task creation and listing"
```

---

## Task 5: Wire Orchestrator into State + Gossip Listener (`state.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/state.rs`

- [ ] **Step 1: Read the current `state.rs`**

Read the file to understand the current `SuperAgentNode` struct and `spawn_gossip_listener` function.

- [ ] **Step 2: Add `orchestrator` field to `SuperAgentNode`**

```rust
pub struct SuperAgentNode {
    pub registry: Arc<Mutex<AgentRegistry>>,
    pub nerve: Arc<NerveChannel>,
    pub blackboard: Arc<Mutex<Blackboard>>,
    pub orchestrator: Arc<Mutex<TaskOrchestrator>>,  // NEW
    pub local_node_id: String,
    shutdown_tx: tokio::sync::watch::Sender<bool>,
    _heartbeat_handle: tokio::task::JoinHandle<()>,
    _listener_handle: tokio::task::JoinHandle<()>,
}
```

- [ ] **Step 3: Initialize orchestrator in `start()`**

After creating registry and blackboard, add:
```rust
let orchestrator = TaskOrchestrator::new(local_node_id.clone(), BiddingConfig::default());
let orchestrator = Arc::new(Mutex::new(orchestrator));
```

Pass it to `spawn_gossip_listener` and store it in the struct.

- [ ] **Step 4: Handle task NervePayload variants in gossip listener**

In the `handle_nerve_message` function (or wherever incoming messages are matched), add handlers for the new payload types:

```rust
NervePayload::TaskBroadcast { task_id, description, required_capabilities, urgency } => {
    // A remote agent is looking for help. Check if we can bid.
    let reg = registry.lock().await;
    let bb = blackboard.lock().await;

    // Check if we have any matching capability
    let local = reg.local_profile();
    if let Some(profile) = local {
        let has_capability = required_capabilities.is_empty()
            || required_capabilities.iter().any(|cap| {
                profile.capabilities.iter().any(|c| c.domain == *cap)
            });

        if has_capability {
            // Calculate our bid
            let best_cap_score = required_capabilities.iter()
                .filter_map(|cap| profile.capabilities.iter().find(|c| c.domain == *cap))
                .map(|c| c.confidence * c.avg_score)
                .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                .unwrap_or(0.5);

            let bid_payload = NervePayload::TaskBid {
                task_id: task_id.clone(),
                confidence: best_cap_score, // Use our capability as confidence
                estimated_tokens: 1000, // Default estimate
            };
            let bid_msg = NerveMessage::new_task(
                nerve_msg.from.clone(), // will be overwritten by broadcast
                bid_payload,
            );
            // Note: the 'from' field on the NerveMessage comes from broadcast,
            // but we need to set our own node_id
            drop(bb);
            drop(reg);
            // Broadcast our bid
            let bid_msg = NerveMessage::new_task(local_node_id.clone(), NervePayload::TaskBid {
                task_id,
                confidence: best_cap_score,
                estimated_tokens: 1000,
            });
            if let Err(e) = nerve.broadcast(bid_msg).await {
                warn!("Failed to send task bid: {e}");
            }
        }
    }
}

NervePayload::TaskBid { task_id, confidence, estimated_tokens } => {
    // A remote agent is bidding on our task
    let mut bb = blackboard.lock().await;
    let orch = orchestrator.lock().await;

    // Build a Bid from the nerve message
    let bid = Bid {
        node_id: nerve_msg.from.clone(),
        confidence,
        estimated_tokens,
        capability_score: confidence, // approximate
        current_load: 0.0, // unknown for remote
        timestamp: nerve_msg.timestamp,
    };

    if let Err(e) = orch.add_bid(&mut bb, &task_id, bid) {
        warn!("Failed to add bid for task {task_id}: {e}");
    }
}

NervePayload::TaskAssign { task_id, assignee } => {
    // Task was assigned (notification)
    info!("Task {task_id} assigned to {assignee}");
    let mut bb = blackboard.lock().await;
    let orch = orchestrator.lock().await;
    let _ = orch.assign_task(&mut bb, &task_id, &assignee);
}

NervePayload::TaskProgress { task_id, progress, message } => {
    info!("Task {task_id}: {progress}% - {message}");
}
```

- [ ] **Step 5: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check --features p2p 2>&1 | tail -10`

- [ ] **Step 6: Run all tests still pass**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent --features p2p 2>&1 | tail -25`

Expected: All 37 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/super_agent/state.rs
git commit -m "feat(super-agent): wire TaskOrchestrator into state and gossip listener"
```

---

## Task 6: Register New Commands in `lib.rs`

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add new commands to generate_handler**

Find the existing super_agent command registrations and add:

```rust
#[cfg(feature = "p2p")]
commands::super_agent::commands::super_agent_create_task,
#[cfg(feature = "p2p")]
commands::super_agent::commands::super_agent_get_tasks,
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check --features p2p 2>&1 | tail -10`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(super-agent): register task orchestration commands in Tauri app"
```

---

## Task 7: Frontend Task Types + Store (`super-agent.ts`)

**Files:**
- Modify: `packages/app/src/stores/super-agent.ts`
- Create: `packages/app/src/stores/__tests__/super-agent-tasks.test.ts`

- [ ] **Step 1: Write frontend tests**

```typescript
// packages/app/src/stores/__tests__/super-agent-tasks.test.ts

import { describe, it, expect } from 'vitest'
import { isTaskBoardSnapshot } from '../super-agent'

describe('isTaskBoardSnapshot', () => {
  it('returns true for valid snapshot', () => {
    expect(isTaskBoardSnapshot({ tasks: [] })).toBe(true)
  })

  it('returns true for snapshot with tasks', () => {
    expect(
      isTaskBoardSnapshot({
        tasks: [
          {
            id: 't1',
            creator: 'node-a',
            description: 'Test',
            requiredCapabilities: [],
            urgency: 'normal',
            complexity: 'delegate',
            status: 'bidding',
            bids: [],
            assignee: null,
            result: null,
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
      }),
    ).toBe(true)
  })

  it('returns false for null', () => {
    expect(isTaskBoardSnapshot(null)).toBe(false)
  })

  it('returns false for missing tasks', () => {
    expect(isTaskBoardSnapshot({})).toBe(false)
  })

  it('returns false for non-array tasks', () => {
    expect(isTaskBoardSnapshot({ tasks: 'not-array' })).toBe(false)
  })
})
```

- [ ] **Step 2: Add task types and store methods to `super-agent.ts`**

Add after the existing types:

```typescript
// ─── Task Types ────────────────────────────────────────

export type TaskStatus = 'open' | 'bidding' | 'assigned' | 'running' | 'completed' | 'failed' | 'aborted'
export type TaskUrgency = 'low' | 'normal' | 'high' | 'critical'
export type TaskComplexity = 'solo' | 'delegate'

export interface Bid {
  nodeId: string
  confidence: number
  estimatedTokens: number
  capabilityScore: number
  currentLoad: number
  timestamp: number
}

export interface TaskResult {
  summary: string
  sessionId: string
  tokensUsed: number
  score: number
}

export interface Task {
  id: string
  creator: string
  description: string
  requiredCapabilities: string[]
  urgency: TaskUrgency
  complexity: TaskComplexity
  status: TaskStatus
  bids: Bid[]
  assignee: string | null
  result: TaskResult | null
  createdAt: number
  updatedAt: number
}

export interface TaskBoardSnapshot {
  tasks: Task[]
}

export function isTaskBoardSnapshot(value: unknown): value is TaskBoardSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<TaskBoardSnapshot>
  return Array.isArray(candidate.tasks)
}
```

Add to the store interface and implementation:

```typescript
interface SuperAgentState {
  // ... existing fields ...
  taskBoard: TaskBoardSnapshot
  fetchTasks: () => Promise<void>
  createTask: (description: string, capabilities: string[], urgency: TaskUrgency, complexity: TaskComplexity) => Promise<Task | null>
}
```

Add to the store:
```typescript
taskBoard: { tasks: [] },

fetchTasks: async () => {
  if (!isTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const snapshot = await invoke<TaskBoardSnapshot | null>('super_agent_get_tasks')
    if (isTaskBoardSnapshot(snapshot)) {
      set({ taskBoard: snapshot })
    }
  } catch (err) {
    console.warn('[SuperAgent] Failed to fetch tasks:', err)
  }
},

createTask: async (description, capabilities, urgency, complexity) => {
  if (!isTauri()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const task = await invoke<Task>('super_agent_create_task', {
      description,
      requiredCapabilities: capabilities,
      urgency,
      complexity,
    })
    await get().fetchTasks()
    return task
  } catch (err) {
    console.warn('[SuperAgent] Failed to create task:', err)
    return null
  }
},
```

- [ ] **Step 3: Run frontend tests**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/packages/app && npx vitest run src/stores/__tests__/super-agent-tasks.test.ts 2>&1 | tail -15`

Expected: All 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/stores/super-agent.ts packages/app/src/stores/__tests__/super-agent-tasks.test.ts
git commit -m "feat(super-agent): add task types and store methods with 5 Vitest tests"
```

---

## Task 8: Frontend Task Board Panel (`TaskBoard.tsx`)

**Files:**
- Create: `packages/app/src/components/settings/team/TaskBoard.tsx`

- [ ] **Step 1: Read existing team panel components for patterns**

Read `packages/app/src/components/settings/team/SuperAgentNetwork.tsx` to match the established component patterns.

- [ ] **Step 2: Create the TaskBoard component**

```tsx
// packages/app/src/components/settings/team/TaskBoard.tsx

import * as React from 'react'
import { useEffect } from 'react'
import { cn } from '@/lib/utils'
import {
  useSuperAgentStore,
  type Task,
  type TaskStatus,
} from '@/stores/super-agent'

const STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'Open',
  bidding: 'Bidding',
  assigned: 'Assigned',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Aborted',
}

const STATUS_COLORS: Record<TaskStatus, string> = {
  open: 'bg-blue-500',
  bidding: 'bg-yellow-500',
  assigned: 'bg-purple-500',
  running: 'bg-orange-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  aborted: 'bg-gray-500',
}

function TaskCard({ task }: { task: Task }) {
  const localAgent = useSuperAgentStore((s) => s.snapshot.localAgent)
  const isCreator = localAgent?.nodeId === task.creator
  const isAssignee = localAgent?.nodeId === task.assignee

  return (
    <div className="rounded-xl border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={cn('h-2 w-2 rounded-full', STATUS_COLORS[task.status])}
          />
          <span className="text-xs font-medium text-muted-foreground">
            {STATUS_LABELS[task.status]}
          </span>
          {task.urgency !== 'normal' && (
            <span
              className={cn(
                'text-xs px-1.5 py-0.5 rounded',
                task.urgency === 'critical'
                  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                  : task.urgency === 'high'
                    ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                    : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
              )}
            >
              {task.urgency}
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {task.bids.length} bid{task.bids.length !== 1 ? 's' : ''}
        </span>
      </div>

      <p className="text-sm">{task.description}</p>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {isCreator && <span className="text-blue-500">(you created)</span>}
        {isAssignee && <span className="text-green-500">(assigned to you)</span>}
        {task.assignee && !isAssignee && (
          <span>Assigned to: {task.assignee.slice(0, 8)}...</span>
        )}
        {task.result && (
          <span>Score: {task.result.score.toFixed(1)}</span>
        )}
      </div>

      {task.requiredCapabilities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {task.requiredCapabilities.map((cap) => (
            <span
              key={cap}
              className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs"
            >
              {cap}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function TaskBoard() {
  const { taskBoard, fetchTasks, init } = useSuperAgentStore()

  useEffect(() => {
    let cleanup: (() => void) | undefined
    init().then((fn) => {
      cleanup = fn
    })
    return () => cleanup?.()
  }, [init])

  useEffect(() => {
    fetchTasks()
    const interval = setInterval(fetchTasks, 5000) // Poll every 5s
    return () => clearInterval(interval)
  }, [fetchTasks])

  const active = taskBoard.tasks.filter(
    (t) => !['completed', 'failed', 'aborted'].includes(t.status),
  )
  const completed = taskBoard.tasks.filter(
    (t) => ['completed', 'failed', 'aborted'].includes(t.status),
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Task Board</h3>
        <span className="text-xs text-muted-foreground">
          {active.length} active / {taskBoard.tasks.length} total
        </span>
      </div>

      {taskBoard.tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tasks yet. Tasks appear when agents delegate work to each other.
        </p>
      ) : (
        <>
          {active.length > 0 && (
            <div className="space-y-2">
              {active.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          )}
          {completed.length > 0 && (
            <div className="space-y-2 opacity-60">
              <p className="text-xs text-muted-foreground">Completed</p>
              {completed.slice(0, 5).map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/components/settings/team/TaskBoard.tsx
git commit -m "feat(super-agent): add task board panel component"
```

---

## Summary

| Task | Component | Tests | What it delivers |
|------|-----------|-------|-----------------|
| 1 | `types.rs` | 7 new tests | Task, Bid, BiddingConfig types + NervePayload variants |
| 2 | `blackboard.rs` + `task_board.rs` | 6 tests | TaskBoard Loro doc CRUD |
| 3 | `orchestrator.rs` | 8 tests | Bidding protocol + task lifecycle state machine |
| 4 | `commands.rs` | — | Tauri IPC: create task, get tasks |
| 5 | `state.rs` | — | Wire orchestrator + handle task Nerve messages |
| 6 | `lib.rs` | — | Register new commands |
| 7 | `super-agent.ts` + test | 5 Vitest tests | Frontend task types + store methods |
| 8 | `TaskBoard.tsx` | — | Task board UI panel |

**Total: 26 new tests** (21 Rust + 5 TypeScript)

**Test commands:**
- Rust: `cargo test -p teamclaw --lib super_agent --features p2p`
- Frontend: `npx vitest run src/stores/__tests__/super-agent-tasks.test.ts`

**After all 8 tasks, the system will:**
- Agent A creates a DELEGATE task → broadcasts via Nerve Channel
- Online agents with matching capabilities auto-bid
- Creator selects winner via scoring formula → assigns task
- Full lifecycle tracked on CRDT TaskBoard (visible to all peers)
- Frontend shows real-time task board with status, bids, and assignments

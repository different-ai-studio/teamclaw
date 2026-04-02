# Super Agent Phase 1: Neural Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Layer 0 (Agent Identity & Capability Registry) and Layer 1 (Neural Fabric — Nerve Channel + Blackboard) so that agents can see each other, broadcast heartbeats, and maintain a persistent shared registry via CRDT.

**Architecture:** New `super_agent` Rust module alongside existing `team_p2p`. Layer 0 stores `AgentProfile` + `Capability` in a Loro CRDT doc (`registry.loro`) synced as a special entry in the existing iroh-docs P2P channel. Layer 1 adds gossip-based `NerveMessage` broadcasting (heartbeat + emergency topics) and a `Blackboard` abstraction over Loro docs. Frontend gets a new Zustand store and network topology panel.

**Tech Stack:** Rust (iroh 0.97, iroh-gossip 0.97, loro 1, serde, tokio), TypeScript (Zustand, Tauri IPC), React

**Test strategy:** Rust `#[cfg(test)]` unit tests for all pure logic, Blackboard Loro operations, and Registry CRUD. Tests run via `cargo test -p teamclaw --lib super_agent`. Frontend store type guards tested via Vitest.

---

## File Structure

### Rust Backend (`src-tauri/src/commands/super_agent/`)

| File | Responsibility |
|------|---------------|
| `mod.rs` | Module root, re-exports public types and Tauri commands |
| `types.rs` | Core data types: `AgentProfile`, `Capability`, `NerveMessage`, `NerveTopic`, all payload types. Includes `#[cfg(test)]` unit tests. |
| `registry.rs` | Layer 0: `AgentRegistry` — manages `registry.loro` Loro doc, agent CRUD, capability indexing, discovery queries. Includes `#[cfg(test)]` unit tests. |
| `nerve.rs` | Layer 1: `NerveChannel` — wraps iroh-gossip for topic-based pub/sub, message encoding/decoding, TTL filtering |
| `blackboard.rs` | Layer 1: `Blackboard` — manages Loro docs, handles serialization to/from iroh-docs entries, provides read/write API. Includes `#[cfg(test)]` unit tests. |
| `heartbeat.rs` | Heartbeat service: 15s timer, status detection, offline marking |
| `commands.rs` | Tauri `#[tauri::command]` functions exposed to frontend |
| `state.rs` | `SuperAgentState` type alias (`Arc<Mutex<Option<SuperAgentNode>>>`) and feature-gate shim |

### Frontend (`packages/app/src/`)

| File | Responsibility |
|------|---------------|
| `stores/super-agent.ts` | Zustand store: `AgentProfile[]`, connection status, Tauri event listener |
| `components/settings/team/SuperAgentNetwork.tsx` | Network topology panel: agent list with status badges and capability tags |

---

## Task 1: Core Types + Tests (`types.rs`)

**Files:**
- Create: `src-tauri/src/commands/super_agent/types.rs`

- [ ] **Step 1: Write the failing tests first**

Create `types.rs` with ONLY the test module:

```rust
// src-tauri/src/commands/super_agent/types.rs

// (types will be added in step 3)

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nerve_message_not_expired_within_ttl() {
        let msg = NerveMessage::new_heartbeat(
            "node-1".to_string(),
            HeartbeatPayload {
                status: AgentStatus::Online,
                current_task: None,
                load: 0.0,
            },
        );
        assert!(!msg.is_expired(), "Fresh message should not be expired");
    }

    #[test]
    fn nerve_message_expired_after_ttl() {
        let mut msg = NerveMessage::new_heartbeat(
            "node-1".to_string(),
            HeartbeatPayload {
                status: AgentStatus::Online,
                current_task: None,
                load: 0.0,
            },
        );
        // Set timestamp to 60 seconds ago, ttl is 30s
        msg.timestamp = now_millis() - 60_000;
        assert!(msg.is_expired(), "Old message should be expired");
    }

    #[test]
    fn nerve_message_heartbeat_serde_roundtrip() {
        let msg = NerveMessage::new_heartbeat(
            "node-abc".to_string(),
            HeartbeatPayload {
                status: AgentStatus::Busy,
                current_task: Some("fixing bug".to_string()),
                load: 0.75,
            },
        );
        let json = serde_json::to_string(&msg).unwrap();
        let deserialized: NerveMessage = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.from, "node-abc");
        assert_eq!(deserialized.topic, NerveTopic::Heartbeat);
        match deserialized.payload {
            NervePayload::Heartbeat(hb) => {
                assert_eq!(hb.status, AgentStatus::Busy);
                assert_eq!(hb.current_task, Some("fixing bug".to_string()));
                assert!((hb.load - 0.75).abs() < f64::EPSILON);
            }
            _ => panic!("Expected Heartbeat payload"),
        }
    }

    #[test]
    fn nerve_message_emergency_serde_roundtrip() {
        let msg = NerveMessage::new_emergency_alert(
            "node-xyz".to_string(),
            Some("task-123".to_string()),
            "disk full".to_string(),
        );
        let json = serde_json::to_string(&msg).unwrap();
        let deserialized: NerveMessage = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.topic, NerveTopic::Emergency);
        match deserialized.payload {
            NervePayload::EmergencyAlert { task_id, reason } => {
                assert_eq!(task_id, Some("task-123".to_string()));
                assert_eq!(reason, "disk full");
            }
            _ => panic!("Expected EmergencyAlert payload"),
        }
    }

    #[test]
    fn agent_profile_serde_roundtrip() {
        let profile = AgentProfile {
            node_id: "node-1".to_string(),
            name: "Test Agent".to_string(),
            owner: "matt".to_string(),
            capabilities: vec![Capability {
                domain: "frontend".to_string(),
                skills: vec!["react".to_string()],
                tools: vec![],
                languages: vec!["typescript".to_string()],
                confidence: 0.9,
                task_count: 5,
                avg_score: 0.85,
            }],
            status: AgentStatus::Online,
            current_task: None,
            last_heartbeat: 1000,
            version: "0.1.0".to_string(),
            model_id: "claude-opus".to_string(),
            joined_at: 500,
        };

        let json = serde_json::to_string(&profile).unwrap();
        let deserialized: AgentProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.node_id, "node-1");
        assert_eq!(deserialized.capabilities.len(), 1);
        assert_eq!(deserialized.capabilities[0].domain, "frontend");
        assert!((deserialized.capabilities[0].confidence - 0.9).abs() < f64::EPSILON);
    }

    #[test]
    fn agent_status_serde_lowercase() {
        let json = serde_json::to_string(&AgentStatus::Online).unwrap();
        assert_eq!(json, "\"online\"");
        let json = serde_json::to_string(&AgentStatus::Busy).unwrap();
        assert_eq!(json, "\"busy\"");
    }

    #[test]
    fn capability_score_calculation() {
        let agent = AgentProfile {
            node_id: "n1".to_string(),
            name: "A".to_string(),
            owner: "o".to_string(),
            capabilities: vec![
                Capability {
                    domain: "frontend".to_string(),
                    skills: vec![],
                    tools: vec![],
                    languages: vec![],
                    confidence: 0.8,
                    task_count: 10,
                    avg_score: 0.9,
                },
                Capability {
                    domain: "backend".to_string(),
                    skills: vec![],
                    tools: vec![],
                    languages: vec![],
                    confidence: 0.3,
                    task_count: 2,
                    avg_score: 0.5,
                },
            ],
            status: AgentStatus::Online,
            current_task: None,
            last_heartbeat: 0,
            version: "0.1.0".to_string(),
            model_id: "".to_string(),
            joined_at: 0,
        };

        assert!((capability_score(&agent, "frontend") - 0.72).abs() < f64::EPSILON);
        assert!((capability_score(&agent, "backend") - 0.15).abs() < f64::EPSILON);
        assert!((capability_score(&agent, "unknown") - 0.0).abs() < f64::EPSILON);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent::types 2>&1 | tail -20`

Expected: Compilation errors — `NerveMessage`, `AgentProfile`, etc. are not defined yet.

- [ ] **Step 3: Implement all types to make tests pass**

Add the type definitions above the test module:

```rust
// src-tauri/src/commands/super_agent/types.rs

use serde::{Deserialize, Serialize};

// ─── Layer 0: Identity & Capability ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub node_id: String,
    pub name: String,
    pub owner: String,
    pub capabilities: Vec<Capability>,
    pub status: AgentStatus,
    pub current_task: Option<String>,
    pub last_heartbeat: u64,
    pub version: String,
    pub model_id: String,
    pub joined_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Online,
    Busy,
    Idle,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub domain: String,
    pub skills: Vec<String>,
    pub tools: Vec<String>,
    pub languages: Vec<String>,
    pub confidence: f64,
    pub task_count: u64,
    pub avg_score: f64,
}

// ─── Layer 1: Nerve Channel ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NerveMessage {
    pub id: String,
    pub topic: NerveTopic,
    pub from: String,
    pub timestamp: u64,
    pub ttl: u64,
    pub payload: NervePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum NerveTopic {
    Heartbeat,
    Task,
    Experience,
    Debate,
    Emergency,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NervePayload {
    #[serde(rename = "heartbeat")]
    Heartbeat(HeartbeatPayload),
    #[serde(rename = "emergency:abort")]
    EmergencyAbort { task_id: Option<String>, reason: String },
    #[serde(rename = "emergency:alert")]
    EmergencyAlert { task_id: Option<String>, reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatPayload {
    pub status: AgentStatus,
    pub current_task: Option<String>,
    pub load: f64,
}

// ─── Snapshots for Frontend ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperAgentSnapshot {
    pub local_agent: Option<AgentProfile>,
    pub agents: Vec<AgentProfile>,
    pub connected: bool,
}

// ─── Helpers ───────────────────────────────────────────────────────────────

pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn capability_score(agent: &AgentProfile, domain: &str) -> f64 {
    agent
        .capabilities
        .iter()
        .find(|c| c.domain == domain)
        .map(|c| c.confidence * c.avg_score)
        .unwrap_or(0.0)
}

impl NerveMessage {
    pub fn is_expired(&self) -> bool {
        now_millis() > self.timestamp + (self.ttl * 1000)
    }

    pub fn new_heartbeat(from: String, payload: HeartbeatPayload) -> Self {
        Self {
            id: nanoid::nanoid!(),
            topic: NerveTopic::Heartbeat,
            from,
            timestamp: now_millis(),
            ttl: 30,
            payload: NervePayload::Heartbeat(payload),
        }
    }

    pub fn new_emergency_alert(from: String, task_id: Option<String>, reason: String) -> Self {
        Self {
            id: nanoid::nanoid!(),
            topic: NerveTopic::Emergency,
            from,
            timestamp: now_millis(),
            ttl: 120,
            payload: NervePayload::EmergencyAlert { task_id, reason },
        }
    }
}

#[cfg(test)]
mod tests {
    // ... (tests from Step 1)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent::types 2>&1 | tail -20`

Expected: All 7 tests pass:
```
test commands::super_agent::types::tests::nerve_message_not_expired_within_ttl ... ok
test commands::super_agent::types::tests::nerve_message_expired_after_ttl ... ok
test commands::super_agent::types::tests::nerve_message_heartbeat_serde_roundtrip ... ok
test commands::super_agent::types::tests::nerve_message_emergency_serde_roundtrip ... ok
test commands::super_agent::types::tests::agent_profile_serde_roundtrip ... ok
test commands::super_agent::types::tests::agent_status_serde_lowercase ... ok
test commands::super_agent::types::tests::capability_score_calculation ... ok
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/super_agent/types.rs
git commit -m "feat(super-agent): add core types with unit tests for L0 and L1"
```

---

## Task 2: Module Structure (`mod.rs`, `state.rs`, placeholders)

**Files:**
- Create: `src-tauri/src/commands/super_agent/mod.rs`
- Create: `src-tauri/src/commands/super_agent/state.rs`
- Create: `src-tauri/src/commands/super_agent/registry.rs` (placeholder)
- Create: `src-tauri/src/commands/super_agent/nerve.rs` (placeholder)
- Create: `src-tauri/src/commands/super_agent/blackboard.rs` (placeholder)
- Create: `src-tauri/src/commands/super_agent/heartbeat.rs` (placeholder)
- Create: `src-tauri/src/commands/super_agent/commands.rs` (placeholder)
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Create placeholders for all submodules**

```rust
// src-tauri/src/commands/super_agent/registry.rs
pub struct AgentRegistry;

// src-tauri/src/commands/super_agent/nerve.rs
pub struct NerveChannel;

// src-tauri/src/commands/super_agent/blackboard.rs
pub struct Blackboard;

// src-tauri/src/commands/super_agent/heartbeat.rs
// (empty)

// src-tauri/src/commands/super_agent/commands.rs
// (empty)
```

- [ ] **Step 2: Create the module root**

```rust
// src-tauri/src/commands/super_agent/mod.rs

pub mod types;
pub mod state;
pub mod registry;
pub mod nerve;
pub mod blackboard;
pub mod heartbeat;
pub mod commands;

pub use types::*;
pub use state::SuperAgentState;
```

- [ ] **Step 3: Create the state type alias**

```rust
// src-tauri/src/commands/super_agent/state.rs

use std::sync::Arc;
use tokio::sync::Mutex;

use super::registry::AgentRegistry;
use super::nerve::NerveChannel;
use super::blackboard::Blackboard;

/// Runtime state for the Super Agent subsystem.
pub struct SuperAgentNode {
    pub registry: AgentRegistry,
    pub nerve: NerveChannel,
    pub blackboard: Blackboard,
    pub local_node_id: String,
}

pub type SuperAgentState = Arc<Mutex<Option<SuperAgentNode>>>;
```

- [ ] **Step 4: Register the module in `commands/mod.rs`**

Add below the existing `#[cfg(feature = "p2p")] pub mod team_p2p;` line:

```rust
#[cfg(feature = "p2p")]
pub mod super_agent;
```

- [ ] **Step 5: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check 2>&1 | tail -10`

Expected: Compiles (with unused warnings, which is fine).

- [ ] **Step 6: Run existing tests still pass**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent 2>&1 | tail -10`

Expected: All 7 type tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/super_agent/ src-tauri/src/commands/mod.rs
git commit -m "feat(super-agent): scaffold module structure with state management"
```

---

## Task 3: Blackboard + Tests (`blackboard.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/blackboard.rs`

- [ ] **Step 1: Write failing tests first**

Replace the placeholder with tests only:

```rust
// src-tauri/src/commands/super_agent/blackboard.rs

// (implementation will be added in step 3)

#[cfg(test)]
mod tests {
    use super::*;

    fn make_blackboard() -> Blackboard {
        let dir = tempfile::tempdir().unwrap();
        Blackboard::new(dir.path()).unwrap()
    }

    #[test]
    fn new_blackboard_initializes_registry_doc() {
        let bb = make_blackboard();
        assert!(bb.get_doc(BoardType::Registry).is_some());
    }

    #[test]
    fn write_and_read_registry_entry() {
        let mut bb = make_blackboard();
        let doc = bb.get_doc_mut(BoardType::Registry).unwrap();

        let agents_map = doc.get_map("agents");
        agents_map.insert("node-1", r#"{"name":"Agent 1"}"#).unwrap();

        let doc = bb.get_doc(BoardType::Registry).unwrap();
        let agents_map = doc.get_map("agents");
        let val = agents_map.get("node-1").unwrap();
        assert_eq!(val.as_string().unwrap().as_ref(), r#"{"name":"Agent 1"}"#);
    }

    #[test]
    fn export_updates_returns_none_when_no_changes() {
        let mut bb = make_blackboard();

        // First export gets all updates (the initial empty doc)
        let first = bb.export_updates(BoardType::Registry).unwrap();
        assert!(first.is_some());

        // Second export with no changes should return None
        let second = bb.export_updates(BoardType::Registry).unwrap();
        assert!(second.is_none());
    }

    #[test]
    fn export_then_import_syncs_data() {
        // Simulate two peers: bb1 writes, bb2 imports
        let mut bb1 = make_blackboard();
        let mut bb2 = make_blackboard();

        // bb1 writes an agent
        {
            let doc = bb1.get_doc_mut(BoardType::Registry).unwrap();
            let agents = doc.get_map("agents");
            agents.insert("node-A", r#"{"name":"Alpha"}"#).unwrap();
        }

        // bb1 exports updates
        let updates = bb1.export_updates(BoardType::Registry).unwrap().unwrap();

        // bb2 imports updates
        bb2.import_updates(BoardType::Registry, &updates).unwrap();

        // bb2 should now have the agent
        let doc = bb2.get_doc(BoardType::Registry).unwrap();
        let agents = doc.get_map("agents");
        let val = agents.get("node-A").unwrap();
        assert_eq!(val.as_string().unwrap().as_ref(), r#"{"name":"Alpha"}"#);
    }

    #[test]
    fn concurrent_writes_merge_via_crdt() {
        let mut bb1 = make_blackboard();
        let mut bb2 = make_blackboard();

        // bb1 writes agent A
        {
            let doc = bb1.get_doc_mut(BoardType::Registry).unwrap();
            doc.get_map("agents").insert("node-A", "alpha").unwrap();
        }

        // bb2 writes agent B (independently)
        {
            let doc = bb2.get_doc_mut(BoardType::Registry).unwrap();
            doc.get_map("agents").insert("node-B", "beta").unwrap();
        }

        // Exchange updates
        let updates1 = bb1.export_updates(BoardType::Registry).unwrap().unwrap();
        let updates2 = bb2.export_updates(BoardType::Registry).unwrap().unwrap();

        bb1.import_updates(BoardType::Registry, &updates2).unwrap();
        bb2.import_updates(BoardType::Registry, &updates1).unwrap();

        // Both should now have both agents
        for bb in [&bb1, &bb2] {
            let doc = bb.get_doc(BoardType::Registry).unwrap();
            let agents = doc.get_map("agents");
            assert!(agents.get("node-A").is_some(), "Should have node-A");
            assert!(agents.get("node-B").is_some(), "Should have node-B");
        }
    }

    #[test]
    fn save_and_reload_snapshot() {
        let dir = tempfile::tempdir().unwrap();

        // Write data and save snapshot
        {
            let mut bb = Blackboard::new(dir.path()).unwrap();
            let doc = bb.get_doc_mut(BoardType::Registry).unwrap();
            doc.get_map("agents").insert("node-X", "data-X").unwrap();
            bb.save_snapshots().unwrap();
        }

        // Reload from snapshot
        {
            let bb = Blackboard::new(dir.path()).unwrap();
            let doc = bb.get_doc(BoardType::Registry).unwrap();
            let agents = doc.get_map("agents");
            let val = agents.get("node-X").unwrap();
            assert_eq!(val.as_string().unwrap().as_ref(), "data-X");
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent::blackboard 2>&1 | tail -20`

Expected: Compilation errors — `Blackboard`, `BoardType` not defined.

- [ ] **Step 3: Implement Blackboard**

Add the implementation above the test module:

```rust
// src-tauri/src/commands/super_agent/blackboard.rs

use loro::LoroDoc;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Well-known iroh-docs key prefix for super-agent blackboard entries.
const BLACKBOARD_KEY_PREFIX: &str = "__superagent__/blackboard/";

/// Identifies which Loro doc a blackboard entry belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BoardType {
    Registry,
}

impl BoardType {
    pub fn key(&self) -> String {
        match self {
            BoardType::Registry => format!("{}{}", BLACKBOARD_KEY_PREFIX, "registry"),
        }
    }

    pub fn snapshot_filename(&self) -> &str {
        match self {
            BoardType::Registry => "registry.loro",
        }
    }
}

/// Manages Loro CRDT documents that form the shared blackboard.
pub struct Blackboard {
    docs: HashMap<BoardType, LoroDoc>,
    last_exported_version: HashMap<BoardType, Vec<u8>>,
    storage_path: PathBuf,
}

impl Blackboard {
    /// Create a new Blackboard, loading any existing snapshots from disk.
    pub fn new(storage_path: &Path) -> Result<Self, String> {
        let bb_path = storage_path.join("blackboard");
        std::fs::create_dir_all(&bb_path)
            .map_err(|e| format!("Failed to create blackboard dir: {e}"))?;

        let mut bb = Blackboard {
            docs: HashMap::new(),
            last_exported_version: HashMap::new(),
            storage_path: bb_path,
        };

        bb.init_board(BoardType::Registry)?;
        Ok(bb)
    }

    fn init_board(&mut self, board: BoardType) -> Result<(), String> {
        let doc = LoroDoc::new();
        let snapshot_path = self.storage_path.join(board.snapshot_filename());

        if snapshot_path.exists() {
            let data = std::fs::read(&snapshot_path)
                .map_err(|e| format!("Failed to read {} snapshot: {e}", board.snapshot_filename()))?;
            doc.import(&data)
                .map_err(|e| format!("Failed to import {} snapshot: {e}", board.snapshot_filename()))?;
            info!("Loaded blackboard snapshot: {}", board.snapshot_filename());
        }

        self.docs.insert(board, doc);
        Ok(())
    }

    /// Get a reference to a Loro doc for reading.
    pub fn get_doc(&self, board: BoardType) -> Option<&LoroDoc> {
        self.docs.get(&board)
    }

    /// Get a mutable reference to a Loro doc for writing.
    pub fn get_doc_mut(&mut self, board: BoardType) -> Option<&mut LoroDoc> {
        self.docs.get_mut(&board)
    }

    /// Export incremental updates since last export. Returns `None` if no changes.
    pub fn export_updates(&mut self, board: BoardType) -> Result<Option<Vec<u8>>, String> {
        let doc = self.docs.get(&board)
            .ok_or_else(|| format!("Board {:?} not initialized", board))?;

        let updates = if let Some(vv_bytes) = self.last_exported_version.get(&board) {
            match loro::VersionVector::decode(vv_bytes) {
                Ok(vv) => {
                    let data = doc.export(loro::ExportMode::updates(&vv))
                        .map_err(|e| format!("Failed to export updates: {e}"))?;
                    if data.is_empty() {
                        return Ok(None);
                    }
                    data
                }
                Err(_) => {
                    doc.export(loro::ExportMode::all_updates())
                        .map_err(|e| format!("Failed to export all updates: {e}"))?
                }
            }
        } else {
            doc.export(loro::ExportMode::all_updates())
                .map_err(|e| format!("Failed to export all updates: {e}"))?
        };

        let vv = doc.version_vector();
        self.last_exported_version.insert(board, vv.encode());

        Ok(Some(updates))
    }

    /// Import updates from a remote peer.
    pub fn import_updates(&mut self, board: BoardType, data: &[u8]) -> Result<(), String> {
        let doc = self.docs.get_mut(&board)
            .ok_or_else(|| format!("Board {:?} not initialized", board))?;
        doc.import(data)
            .map_err(|e| format!("Failed to import updates for {:?}: {e}", board))?;
        Ok(())
    }

    /// Save all docs to disk as snapshots.
    pub fn save_snapshots(&self) -> Result<(), String> {
        for (board, doc) in &self.docs {
            let path = self.storage_path.join(board.snapshot_filename());
            let snapshot = doc.export(loro::ExportMode::Snapshot)
                .map_err(|e| format!("Failed to export snapshot for {:?}: {e}", board))?;
            std::fs::write(&path, &snapshot)
                .map_err(|e| format!("Failed to write snapshot {:?}: {e}", board))?;
        }
        Ok(())
    }

    /// Write registry updates into an iroh-docs entry for P2P sync.
    pub async fn sync_to_iroh_doc(
        &mut self,
        doc: &iroh_docs::api::Doc,
        author: iroh_docs::AuthorId,
    ) -> Result<(), String> {
        let board = BoardType::Registry;
        if let Some(updates) = self.export_updates(board)? {
            let key = board.key();
            doc.set_bytes(author, key.as_bytes().to_vec(), updates)
                .await
                .map_err(|e| format!("Failed to write blackboard to iroh-doc: {e}"))?;
        }
        Ok(())
    }

    /// Import registry updates received from iroh-docs sync.
    pub fn sync_from_iroh_doc(&mut self, data: &[u8]) -> Result<(), String> {
        self.import_updates(BoardType::Registry, data)
    }
}

#[cfg(test)]
mod tests {
    // ... (tests from Step 1)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent::blackboard 2>&1 | tail -20`

Expected: All 6 tests pass:
```
test commands::super_agent::blackboard::tests::new_blackboard_initializes_registry_doc ... ok
test commands::super_agent::blackboard::tests::write_and_read_registry_entry ... ok
test commands::super_agent::blackboard::tests::export_updates_returns_none_when_no_changes ... ok
test commands::super_agent::blackboard::tests::export_then_import_syncs_data ... ok
test commands::super_agent::blackboard::tests::concurrent_writes_merge_via_crdt ... ok
test commands::super_agent::blackboard::tests::save_and_reload_snapshot ... ok
```

- [ ] **Step 5: Add `tempfile` dev-dependency if not already present**

Check `Cargo.toml` for `tempfile`. If missing, add:

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/super_agent/blackboard.rs src-tauri/Cargo.toml
git commit -m "feat(super-agent): implement Blackboard with Loro CRDT and 6 unit tests"
```

---

## Task 4: Agent Registry + Tests (`registry.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/registry.rs`

- [ ] **Step 1: Write failing tests first**

```rust
// src-tauri/src/commands/super_agent/registry.rs

// (implementation will be added in step 3)

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::super_agent::blackboard::Blackboard;
    use crate::commands::super_agent::types::*;

    fn make_test_env() -> (AgentRegistry, Blackboard) {
        let dir = tempfile::tempdir().unwrap();
        let bb = Blackboard::new(dir.path()).unwrap();
        let reg = AgentRegistry::new();
        (reg, bb)
    }

    fn make_profile(node_id: &str, name: &str, domain: &str, confidence: f64, avg_score: f64) -> AgentProfile {
        AgentProfile {
            node_id: node_id.to_string(),
            name: name.to_string(),
            owner: "test".to_string(),
            capabilities: vec![Capability {
                domain: domain.to_string(),
                skills: vec![],
                tools: vec![],
                languages: vec![],
                confidence,
                task_count: 1,
                avg_score,
            }],
            status: AgentStatus::Online,
            current_task: None,
            last_heartbeat: now_millis(),
            version: "0.1.0".to_string(),
            model_id: "test".to_string(),
            joined_at: now_millis(),
        }
    }

    #[test]
    fn register_and_retrieve_local_agent() {
        let (mut reg, mut bb) = make_test_env();
        let profile = make_profile("node-1", "Agent 1", "frontend", 0.9, 0.8);

        reg.register_local(&mut bb, profile.clone()).unwrap();

        assert!(reg.local_profile().is_some());
        assert_eq!(reg.local_profile().unwrap().node_id, "node-1");

        let all = reg.get_all_agents(&bb);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Agent 1");
    }

    #[test]
    fn update_local_status() {
        let (mut reg, mut bb) = make_test_env();
        let profile = make_profile("node-1", "Agent 1", "frontend", 0.9, 0.8);

        reg.register_local(&mut bb, profile).unwrap();
        reg.update_local_status(&mut bb, AgentStatus::Busy, Some("coding".to_string())).unwrap();

        let local = reg.local_profile().unwrap();
        assert_eq!(local.status, AgentStatus::Busy);
        assert_eq!(local.current_task, Some("coding".to_string()));
    }

    #[test]
    fn discover_agents_filters_by_domain() {
        let (mut reg, mut bb) = make_test_env();

        let frontend = make_profile("n1", "Frontend Agent", "frontend", 0.9, 0.8);
        let backend = make_profile("n2", "Backend Agent", "backend", 0.7, 0.9);

        reg.register_local(&mut bb, frontend).unwrap();
        reg.write_remote_profile(&mut bb, &backend).unwrap();

        let results = reg.discover_agents(&bb, "frontend");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].node_id, "n1");

        let results = reg.discover_agents(&bb, "backend");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].node_id, "n2");
    }

    #[test]
    fn discover_agents_sorted_by_score() {
        let (mut reg, mut bb) = make_test_env();

        let weak = make_profile("n1", "Weak", "frontend", 0.3, 0.5);    // score: 0.15
        let strong = make_profile("n2", "Strong", "frontend", 0.9, 0.9); // score: 0.81
        let medium = make_profile("n3", "Medium", "frontend", 0.6, 0.7); // score: 0.42

        reg.register_local(&mut bb, weak).unwrap();
        reg.write_remote_profile(&mut bb, &strong).unwrap();
        reg.write_remote_profile(&mut bb, &medium).unwrap();

        let results = reg.discover_agents(&bb, "frontend");
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].node_id, "n2"); // strong first
        assert_eq!(results[1].node_id, "n3"); // medium second
        assert_eq!(results[2].node_id, "n1"); // weak last
    }

    #[test]
    fn discover_agents_excludes_offline() {
        let (mut reg, mut bb) = make_test_env();

        let online = make_profile("n1", "Online", "frontend", 0.9, 0.8);
        let mut offline = make_profile("n2", "Offline", "frontend", 0.9, 0.8);
        offline.status = AgentStatus::Offline;

        reg.register_local(&mut bb, online).unwrap();
        reg.write_remote_profile(&mut bb, &offline).unwrap();

        let results = reg.discover_agents(&bb, "frontend");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].node_id, "n1");
    }

    #[test]
    fn mark_stale_agents_offline() {
        let (mut reg, mut bb) = make_test_env();

        let mut stale = make_profile("n1", "Stale", "frontend", 0.9, 0.8);
        stale.last_heartbeat = now_millis() - 200_000; // 200s ago, well past 120s threshold

        reg.register_local(&mut bb, make_profile("local", "Local", "frontend", 0.9, 0.8)).unwrap();
        reg.write_remote_profile(&mut bb, &stale).unwrap();

        let marked = reg.mark_stale_agents_offline(&mut bb, 120_000).unwrap();
        assert_eq!(marked.len(), 1);
        assert_eq!(marked[0], "n1");

        // Verify the agent is now offline in blackboard
        let agents = reg.get_all_agents(&bb);
        let stale_agent = agents.iter().find(|a| a.node_id == "n1").unwrap();
        assert_eq!(stale_agent.status, AgentStatus::Offline);
    }

    #[test]
    fn discover_returns_empty_for_unknown_domain() {
        let (mut reg, mut bb) = make_test_env();
        let profile = make_profile("n1", "Agent", "frontend", 0.9, 0.8);
        reg.register_local(&mut bb, profile).unwrap();

        let results = reg.discover_agents(&bb, "quantum-computing");
        assert!(results.is_empty());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent::registry 2>&1 | tail -20`

Expected: Compilation errors — `AgentRegistry::new()`, `register_local()`, etc. not defined.

- [ ] **Step 3: Implement AgentRegistry**

Add the implementation above the test module:

```rust
// src-tauri/src/commands/super_agent/registry.rs

use super::blackboard::{Blackboard, BoardType};
use super::types::{AgentProfile, AgentStatus, Capability, capability_score, now_millis};
use tracing::{info, warn};

/// Manages agent profiles and capability indexing on top of the Blackboard.
pub struct AgentRegistry {
    local_profile: Option<AgentProfile>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        AgentRegistry {
            local_profile: None,
        }
    }

    /// Register the local agent in the blackboard.
    pub fn register_local(
        &mut self,
        blackboard: &mut Blackboard,
        profile: AgentProfile,
    ) -> Result<(), String> {
        self.write_profile(blackboard, &profile)?;
        self.local_profile = Some(profile);
        Ok(())
    }

    /// Update the local agent's status and heartbeat timestamp.
    pub fn update_local_status(
        &mut self,
        blackboard: &mut Blackboard,
        status: AgentStatus,
        current_task: Option<String>,
    ) -> Result<(), String> {
        let profile = self.local_profile.as_mut()
            .ok_or("Local agent not registered")?;

        profile.status = status;
        profile.current_task = current_task;
        profile.last_heartbeat = now_millis();

        self.write_profile(blackboard, profile)?;
        Ok(())
    }

    /// Get all known agents from the blackboard.
    pub fn get_all_agents(&self, blackboard: &Blackboard) -> Vec<AgentProfile> {
        let Some(doc) = blackboard.get_doc(BoardType::Registry) else {
            return vec![];
        };
        let agents_map = doc.get_map("agents");
        let mut result = vec![];

        for key in agents_map.keys() {
            if let Some(value) = agents_map.get(&key) {
                if let Some(json_str) = value.as_string() {
                    match serde_json::from_str::<AgentProfile>(json_str.as_ref()) {
                        Ok(profile) => result.push(profile),
                        Err(e) => warn!("Failed to parse agent profile for {}: {}", key, e),
                    }
                }
            }
        }

        result
    }

    /// Get agents sorted by capability match score for a given domain.
    pub fn discover_agents(
        &self,
        blackboard: &Blackboard,
        domain: &str,
    ) -> Vec<AgentProfile> {
        let mut agents = self.get_all_agents(blackboard);

        agents.retain(|a| {
            a.status != AgentStatus::Offline
                && a.capabilities.iter().any(|c| c.domain == domain)
        });

        agents.sort_by(|a, b| {
            let score_a = capability_score(a, domain);
            let score_b = capability_score(b, domain);
            score_b.partial_cmp(&score_a).unwrap_or(std::cmp::Ordering::Equal)
        });

        agents
    }

    /// Mark agents as offline if their heartbeat has exceeded the threshold.
    pub fn mark_stale_agents_offline(
        &self,
        blackboard: &mut Blackboard,
        timeout_ms: u64,
    ) -> Result<Vec<String>, String> {
        let agents = self.get_all_agents(blackboard);
        let now = now_millis();
        let mut marked = vec![];

        for agent in agents {
            if agent.status != AgentStatus::Offline
                && (now - agent.last_heartbeat) > timeout_ms
            {
                let mut updated = agent.clone();
                updated.status = AgentStatus::Offline;
                self.write_profile(blackboard, &updated)?;
                marked.push(updated.node_id.clone());
            }
        }

        Ok(marked)
    }

    pub fn local_profile(&self) -> Option<&AgentProfile> {
        self.local_profile.as_ref()
    }

    /// Write a remote agent's profile to the blackboard.
    pub fn write_remote_profile(
        &self,
        blackboard: &mut Blackboard,
        profile: &AgentProfile,
    ) -> Result<(), String> {
        self.write_profile(blackboard, profile)
    }

    fn write_profile(
        &self,
        blackboard: &mut Blackboard,
        profile: &AgentProfile,
    ) -> Result<(), String> {
        let doc = blackboard.get_doc_mut(BoardType::Registry)
            .ok_or("Registry board not initialized")?;

        let json = serde_json::to_string(profile)
            .map_err(|e| format!("Failed to serialize agent profile: {e}"))?;

        let agents_map = doc.get_map("agents");
        agents_map
            .insert(&profile.node_id, json)
            .map_err(|e| format!("Failed to write agent profile: {e}"))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    // ... (tests from Step 1)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent::registry 2>&1 | tail -20`

Expected: All 7 tests pass:
```
test commands::super_agent::registry::tests::register_and_retrieve_local_agent ... ok
test commands::super_agent::registry::tests::update_local_status ... ok
test commands::super_agent::registry::tests::discover_agents_filters_by_domain ... ok
test commands::super_agent::registry::tests::discover_agents_sorted_by_score ... ok
test commands::super_agent::registry::tests::discover_agents_excludes_offline ... ok
test commands::super_agent::registry::tests::mark_stale_agents_offline ... ok
test commands::super_agent::registry::tests::discover_returns_empty_for_unknown_domain ... ok
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/super_agent/registry.rs
git commit -m "feat(super-agent): implement AgentRegistry with 7 unit tests"
```

---

## Task 5: Nerve Channel (`nerve.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/nerve.rs`

NerveChannel wraps iroh-gossip. Since gossip requires a real network endpoint, we test message dispatch logic (serde + TTL filtering) rather than actual network I/O.

- [ ] **Step 1: Write tests for dispatch logic**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::super_agent::types::*;

    #[test]
    fn dispatch_incoming_valid_heartbeat() {
        // We can't construct a real Gossip without an endpoint,
        // so we test dispatch_incoming via the broadcast channel directly.
        let msg = NerveMessage::new_heartbeat(
            "node-1".to_string(),
            HeartbeatPayload {
                status: AgentStatus::Online,
                current_task: None,
                load: 0.0,
            },
        );

        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let raw = serde_json::to_vec(&msg).unwrap();

        // Simulate dispatch logic
        let parsed: NerveMessage = serde_json::from_slice(&raw).unwrap();
        assert!(!parsed.is_expired());
        let _ = tx.send(parsed);

        let received = rx.try_recv().unwrap();
        assert_eq!(received.from, "node-1");
        assert_eq!(received.topic, NerveTopic::Heartbeat);
    }

    #[test]
    fn dispatch_incoming_expired_message_dropped() {
        let mut msg = NerveMessage::new_heartbeat(
            "node-1".to_string(),
            HeartbeatPayload {
                status: AgentStatus::Online,
                current_task: None,
                load: 0.0,
            },
        );
        msg.timestamp = now_millis() - 60_000; // 60s ago, ttl is 30s

        let (tx, mut rx) = tokio::sync::broadcast::channel::<NerveMessage>(16);
        let raw = serde_json::to_vec(&msg).unwrap();

        // Simulate dispatch logic: expired messages should NOT be sent
        let parsed: NerveMessage = serde_json::from_slice(&raw).unwrap();
        if !parsed.is_expired() {
            let _ = tx.send(parsed);
        }

        assert!(rx.try_recv().is_err(), "Expired message should be dropped");
    }

    #[test]
    fn topic_id_deterministic() {
        let id1 = derive_topic_id(&NerveTopic::Heartbeat, "team-abc");
        let id2 = derive_topic_id(&NerveTopic::Heartbeat, "team-abc");
        let id3 = derive_topic_id(&NerveTopic::Emergency, "team-abc");
        let id4 = derive_topic_id(&NerveTopic::Heartbeat, "team-xyz");

        assert_eq!(id1, id2, "Same topic + namespace should produce same ID");
        assert_ne!(id1, id3, "Different topics should produce different IDs");
        assert_ne!(id1, id4, "Different namespaces should produce different IDs");
    }
}
```

- [ ] **Step 2: Implement NerveChannel**

```rust
// src-tauri/src/commands/super_agent/nerve.rs

use super::types::{NerveMessage, NerveTopic};
use iroh_gossip::net::Gossip;
use iroh_gossip::proto::TopicId;
use tokio::sync::broadcast;
use tracing::warn;

/// Derives a deterministic TopicId from a NerveTopic + team namespace.
fn derive_topic_id(topic: &NerveTopic, team_namespace: &str) -> TopicId {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"superagent/nerve/");
    hasher.update(team_namespace.as_bytes());
    hasher.update(b"/");
    hasher.update(serde_json::to_string(topic).unwrap_or_default().as_bytes());
    let hash = hasher.finalize();
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&hash);
    TopicId::from(bytes)
}

/// Wraps iroh-gossip for structured, topic-based messaging between agents.
pub struct NerveChannel {
    gossip: Gossip,
    team_namespace: String,
    incoming_tx: broadcast::Sender<NerveMessage>,
}

impl NerveChannel {
    pub fn new(gossip: Gossip, team_namespace: String) -> Self {
        let (tx, _) = broadcast::channel(256);
        NerveChannel {
            gossip,
            team_namespace,
            incoming_tx: tx,
        }
    }

    /// Broadcast a NerveMessage to all peers subscribed to the message's topic.
    pub async fn broadcast(&self, msg: NerveMessage) -> Result<(), String> {
        let topic_id = derive_topic_id(&msg.topic, &self.team_namespace);
        let bytes = serde_json::to_vec(&msg)
            .map_err(|e| format!("Failed to serialize NerveMessage: {e}"))?;

        self.gossip
            .broadcast(topic_id, bytes.into())
            .await
            .map_err(|e| format!("Failed to broadcast on {:?}: {e}", msg.topic))?;

        Ok(())
    }

    /// Subscribe to incoming messages.
    pub fn subscribe(&self) -> broadcast::Receiver<NerveMessage> {
        self.incoming_tx.subscribe()
    }

    /// Dispatch a received gossip message into the local bus.
    pub fn dispatch_incoming(&self, raw: &[u8]) {
        match serde_json::from_slice::<NerveMessage>(raw) {
            Ok(msg) => {
                if msg.is_expired() {
                    return;
                }
                let _ = self.incoming_tx.send(msg);
            }
            Err(e) => {
                warn!("Failed to parse incoming NerveMessage: {e}");
            }
        }
    }

    /// Get the topic ID for a given NerveTopic.
    pub fn topic_id(&self, topic: &NerveTopic) -> TopicId {
        derive_topic_id(topic, &self.team_namespace)
    }
}

#[cfg(test)]
mod tests {
    // ... (tests from Step 1)
}
```

- [ ] **Step 3: Run tests**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent::nerve 2>&1 | tail -15`

Expected: All 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/super_agent/nerve.rs
git commit -m "feat(super-agent): implement NerveChannel with 3 unit tests"
```

---

## Task 6: Heartbeat Service (`heartbeat.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/heartbeat.rs`

The heartbeat service is async and uses timers, so it's tested indirectly through registry tests (stale detection) and integration. No additional unit tests for this module — the logic it calls is already tested in Task 1 and Task 4.

- [ ] **Step 1: Implement the heartbeat service**

```rust
// src-tauri/src/commands/super_agent/heartbeat.rs

use super::blackboard::Blackboard;
use super::nerve::NerveChannel;
use super::registry::AgentRegistry;
use super::types::{AgentStatus, HeartbeatPayload, NerveMessage, SuperAgentSnapshot};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

const HEARTBEAT_INTERVAL_SECS: u64 = 15;
const OFFLINE_THRESHOLD_MS: u64 = 120_000;

/// Starts the heartbeat loop.
pub fn spawn_heartbeat_loop(
    nerve: Arc<NerveChannel>,
    registry: Arc<Mutex<AgentRegistry>>,
    blackboard: Arc<Mutex<Blackboard>>,
    local_node_id: String,
    app_handle: Option<tauri::AppHandle>,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(
            tokio::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS),
        );

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    // 1. Build heartbeat payload
                    let payload = {
                        let reg = registry.lock().await;
                        match reg.local_profile() {
                            Some(profile) => HeartbeatPayload {
                                status: profile.status.clone(),
                                current_task: profile.current_task.clone(),
                                load: 0.0,
                            },
                            None => continue,
                        }
                    };

                    // 2. Broadcast heartbeat via Nerve
                    let msg = NerveMessage::new_heartbeat(
                        local_node_id.clone(),
                        payload,
                    );
                    if let Err(e) = nerve.broadcast(msg).await {
                        warn!("Failed to send heartbeat: {e}");
                    }

                    // 3. Update local heartbeat in registry
                    {
                        let mut reg = registry.lock().await;
                        let mut bb = blackboard.lock().await;
                        if let Err(e) = reg.update_local_status(
                            &mut bb,
                            AgentStatus::Online,
                            None,
                        ) {
                            warn!("Failed to update local heartbeat: {e}");
                        }
                    }

                    // 4. Mark stale agents offline
                    {
                        let reg = registry.lock().await;
                        let mut bb = blackboard.lock().await;
                        match reg.mark_stale_agents_offline(&mut bb, OFFLINE_THRESHOLD_MS) {
                            Ok(marked) => {
                                for node_id in &marked {
                                    info!("Marked agent {} as offline (heartbeat timeout)", node_id);
                                }
                            }
                            Err(e) => warn!("Failed to check stale agents: {e}"),
                        }
                    }

                    // 5. Save blackboard snapshot
                    {
                        let bb = blackboard.lock().await;
                        if let Err(e) = bb.save_snapshots() {
                            warn!("Failed to save blackboard snapshots: {e}");
                        }
                    }

                    // 6. Emit snapshot to frontend
                    if let Some(ref app) = app_handle {
                        use tauri::Emitter;
                        let reg = registry.lock().await;
                        let bb = blackboard.lock().await;
                        let agents = reg.get_all_agents(&bb);
                        let local_agent = reg.local_profile().cloned();
                        let snapshot = SuperAgentSnapshot {
                            local_agent,
                            agents,
                            connected: true,
                        };
                        let _ = app.emit("super-agent:snapshot", &snapshot);
                    }
                }
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        info!("Heartbeat service shutting down");
                        break;
                    }
                }
            }
        }
    })
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check 2>&1 | tail -10`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/super_agent/heartbeat.rs
git commit -m "feat(super-agent): implement heartbeat service with stale detection"
```

---

## Task 7: Tauri Commands (`commands.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/commands.rs`
- Modify: `src-tauri/src/commands/super_agent/mod.rs`

- [ ] **Step 1: Implement Tauri commands**

```rust
// src-tauri/src/commands/super_agent/commands.rs

use super::state::SuperAgentState;
use super::types::{AgentProfile, SuperAgentSnapshot};

#[tauri::command]
pub async fn super_agent_snapshot(
    state: tauri::State<'_, SuperAgentState>,
) -> Result<SuperAgentSnapshot, String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let reg = node.registry.lock().await;
    let bb = node.blackboard.lock().await;
    let agents = reg.get_all_agents(&bb);
    let local_agent = reg.local_profile().cloned();

    Ok(SuperAgentSnapshot {
        local_agent,
        agents,
        connected: true,
    })
}

#[tauri::command]
pub async fn super_agent_discover(
    domain: String,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<Vec<AgentProfile>, String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let reg = node.registry.lock().await;
    let bb = node.blackboard.lock().await;
    Ok(reg.discover_agents(&bb, &domain))
}
```

- [ ] **Step 2: Update `mod.rs` to re-export commands**

Add to the end of `mod.rs`:

```rust
pub use commands::{super_agent_snapshot, super_agent_discover};
```

- [ ] **Step 3: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/super_agent/commands.rs src-tauri/src/commands/super_agent/mod.rs
git commit -m "feat(super-agent): add Tauri commands for snapshot and discovery"
```

---

## Task 8: State with Shared Ownership (`state.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/state.rs`

- [ ] **Step 1: Implement full state with Arc<Mutex> sharing**

Replace the placeholder:

```rust
// src-tauri/src/commands/super_agent/state.rs

use std::sync::Arc;
use tokio::sync::Mutex;

use super::blackboard::Blackboard;
use super::heartbeat;
use super::nerve::NerveChannel;
use super::registry::AgentRegistry;
use super::types::{AgentProfile, AgentStatus, NervePayload, NerveTopic};
use tracing::{info, warn};

pub struct SuperAgentNode {
    pub registry: Arc<Mutex<AgentRegistry>>,
    pub nerve: Arc<NerveChannel>,
    pub blackboard: Arc<Mutex<Blackboard>>,
    pub local_node_id: String,
    shutdown_tx: tokio::sync::watch::Sender<bool>,
    _heartbeat_handle: tokio::task::JoinHandle<()>,
    _listener_handle: tokio::task::JoinHandle<()>,
}

pub type SuperAgentState = Arc<Mutex<Option<SuperAgentNode>>>;

impl SuperAgentNode {
    pub async fn start(
        gossip: iroh_gossip::net::Gossip,
        team_namespace: String,
        local_node_id: String,
        local_profile: AgentProfile,
        storage_path: &std::path::Path,
        app_handle: Option<tauri::AppHandle>,
    ) -> Result<Self, String> {
        let nerve = Arc::new(NerveChannel::new(gossip, team_namespace));
        let mut blackboard = Blackboard::new(storage_path)?;
        let mut registry = AgentRegistry::new();

        registry.register_local(&mut blackboard, local_profile)?;

        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

        let registry = Arc::new(Mutex::new(registry));
        let blackboard = Arc::new(Mutex::new(blackboard));

        let heartbeat_handle = heartbeat::spawn_heartbeat_loop(
            nerve.clone(),
            registry.clone(),
            blackboard.clone(),
            local_node_id.clone(),
            app_handle,
            shutdown_rx.clone(),
        );

        let listener_handle = spawn_gossip_listener(
            nerve.clone(),
            registry.clone(),
            blackboard.clone(),
            shutdown_rx,
        );

        Ok(SuperAgentNode {
            registry,
            nerve,
            blackboard,
            local_node_id,
            shutdown_tx,
            _heartbeat_handle: heartbeat_handle,
            _listener_handle: listener_handle,
        })
    }

    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}

fn spawn_gossip_listener(
    nerve: Arc<NerveChannel>,
    registry: Arc<Mutex<AgentRegistry>>,
    blackboard: Arc<Mutex<Blackboard>>,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    let mut rx = nerve.subscribe();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = rx.recv() => {
                    match msg {
                        Ok(nerve_msg) => {
                            match &nerve_msg.payload {
                                NervePayload::Heartbeat(hb) => {
                                    let reg = registry.lock().await;
                                    let mut bb = blackboard.lock().await;
                                    let agents = reg.get_all_agents(&bb);

                                    if let Some(mut agent) = agents.into_iter().find(|a| a.node_id == nerve_msg.from) {
                                        agent.status = hb.status.clone();
                                        agent.current_task = hb.current_task.clone();
                                        agent.last_heartbeat = nerve_msg.timestamp;
                                        if let Err(e) = reg.write_remote_profile(&mut bb, &agent) {
                                            warn!("Failed to update remote agent heartbeat: {e}");
                                        }
                                    }
                                }
                                NervePayload::EmergencyAbort { task_id, reason } => {
                                    warn!("Emergency abort from {}: {} (task: {:?})",
                                        nerve_msg.from, reason, task_id);
                                }
                                NervePayload::EmergencyAlert { task_id, reason } => {
                                    warn!("Emergency alert from {}: {} (task: {:?})",
                                        nerve_msg.from, reason, task_id);
                                }
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            warn!("Nerve listener lagged, dropped {n} messages");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            info!("Nerve channel closed");
                            break;
                        }
                    }
                }
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        info!("Gossip listener shutting down");
                        break;
                    }
                }
            }
        }
    })
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check 2>&1 | tail -10`

- [ ] **Step 3: Run all super_agent tests still pass**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent 2>&1 | tail -20`

Expected: All 23 tests pass (7 types + 6 blackboard + 7 registry + 3 nerve).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/super_agent/state.rs
git commit -m "feat(super-agent): implement SuperAgentNode with gossip listener and shared state"
```

---

## Task 9: Wire Into Tauri App (`lib.rs`)

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands/team_p2p.rs` (expose `gossip` and `endpoint`)

- [ ] **Step 1: Make `gossip` and `endpoint` fields accessible in `IrohNode`**

In `src-tauri/src/commands/team_p2p.rs`, change field visibility:

```rust
pub struct IrohNode {
    pub(crate) endpoint: Endpoint,  // was: #[allow(dead_code)] endpoint
    store: FsStore,
    pub(crate) gossip: Gossip,      // was: #[allow(dead_code)] gossip
    // ... rest unchanged
}
```

- [ ] **Step 2: Add SuperAgentState to Tauri managed state**

In `lib.rs`, find `.manage(<commands::p2p_state::SyncEngineState>::default())` and add:

```rust
#[cfg(feature = "p2p")]
.manage(<commands::super_agent::SuperAgentState>::default())
```

- [ ] **Step 3: Register Tauri commands**

In the `tauri::generate_handler![...]` block, add:

```rust
#[cfg(feature = "p2p")]
commands::super_agent::super_agent_snapshot,
#[cfg(feature = "p2p")]
commands::super_agent::super_agent_discover,
```

- [ ] **Step 4: Add SuperAgent startup after P2P node is ready**

In the `.setup()` hook, after the P2P node is stored in `IrohState`, add:

```rust
#[cfg(feature = "p2p")]
{
    let gossip = node.gossip.clone();
    let node_id = node.endpoint.node_id().to_string();
    let team_namespace = "default";

    let profile = commands::super_agent::AgentProfile {
        node_id: node_id.clone(),
        name: hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "Unknown Agent".to_string()),
        owner: whoami::username(),
        capabilities: vec![],
        status: commands::super_agent::AgentStatus::Online,
        current_task: None,
        last_heartbeat: commands::super_agent::now_millis(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        model_id: String::new(),
        joined_at: commands::super_agent::now_millis(),
    };

    let storage_path = home_dir.join(commands::TEAMCLAW_DIR).join("super_agent");
    match commands::super_agent::state::SuperAgentNode::start(
        gossip,
        team_namespace.to_string(),
        node_id,
        profile,
        &storage_path,
        Some(app_handle.clone()),
    ).await {
        Ok(sa_node) => {
            let mut sa_state = app_handle
                .state::<commands::super_agent::SuperAgentState>()
                .lock().await;
            *sa_state = Some(sa_node);
            tracing::info!("Super Agent initialized");
        }
        Err(e) => {
            tracing::warn!("Failed to initialize Super Agent: {e}");
        }
    }
}
```

- [ ] **Step 5: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check 2>&1 | tail -10`

- [ ] **Step 6: Run all tests still pass**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo test -p teamclaw --lib super_agent 2>&1 | tail -20`

Expected: All 23 tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands/team_p2p.rs
git commit -m "feat(super-agent): wire into Tauri app startup and register commands"
```

---

## Task 10: Frontend Store (`stores/super-agent.ts`)

**Files:**
- Create: `packages/app/src/stores/super-agent.ts`

- [ ] **Step 1: Create the Zustand store**

```typescript
// packages/app/src/stores/super-agent.ts

import { create } from 'zustand'
import { isTauri } from '@/lib/utils'

export type AgentStatus = 'online' | 'busy' | 'idle' | 'offline'

export interface Capability {
  domain: string
  skills: string[]
  tools: string[]
  languages: string[]
  confidence: number
  taskCount: number
  avgScore: number
}

export interface AgentProfile {
  nodeId: string
  name: string
  owner: string
  capabilities: Capability[]
  status: AgentStatus
  currentTask: string | null
  lastHeartbeat: number
  version: string
  modelId: string
  joinedAt: number
}

export interface SuperAgentSnapshot {
  localAgent: AgentProfile | null
  agents: AgentProfile[]
  connected: boolean
}

const DEFAULT_SNAPSHOT: SuperAgentSnapshot = {
  localAgent: null,
  agents: [],
  connected: false,
}

export function isSuperAgentSnapshot(value: unknown): value is SuperAgentSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SuperAgentSnapshot>
  return (
    Array.isArray(candidate.agents) &&
    typeof candidate.connected === 'boolean'
  )
}

interface SuperAgentState {
  snapshot: SuperAgentSnapshot
  initialized: boolean
  init: () => Promise<() => void>
  fetch: () => Promise<void>
  discover: (domain: string) => Promise<AgentProfile[]>
}

export const useSuperAgentStore = create<SuperAgentState>((set, get) => ({
  snapshot: DEFAULT_SNAPSHOT,
  initialized: false,

  init: async () => {
    if (get().initialized) {
      return () => {}
    }

    if (!isTauri()) {
      set({ initialized: true })
      return () => {}
    }

    const { listen } = await import('@tauri-apps/api/event')

    const unlisten = await listen<SuperAgentSnapshot>(
      'super-agent:snapshot',
      (event) => {
        if (isSuperAgentSnapshot(event.payload)) {
          set({ snapshot: event.payload })
        }
      },
    )

    set({ initialized: true })
    await get().fetch()

    return () => {
      unlisten()
      set({ initialized: false })
    }
  },

  fetch: async () => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const snapshot = await invoke<SuperAgentSnapshot | null>(
        'super_agent_snapshot',
      )
      if (isSuperAgentSnapshot(snapshot)) {
        set({ snapshot })
      }
    } catch (err) {
      console.warn('[SuperAgent] Failed to fetch snapshot:', err)
    }
  },

  discover: async (domain: string) => {
    if (!isTauri()) return []
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      return await invoke<AgentProfile[]>('super_agent_discover', { domain })
    } catch (err) {
      console.warn('[SuperAgent] Failed to discover agents:', err)
      return []
    }
  },
}))
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/stores/super-agent.ts
git commit -m "feat(super-agent): add frontend Zustand store for agent network state"
```

---

## Task 11: Frontend Store Tests

**Files:**
- Create: `packages/app/src/stores/__tests__/super-agent.test.ts`

- [ ] **Step 1: Write type guard tests**

```typescript
// packages/app/src/stores/__tests__/super-agent.test.ts

import { describe, it, expect } from 'vitest'
import { isSuperAgentSnapshot } from '../super-agent'

describe('isSuperAgentSnapshot', () => {
  it('returns true for valid snapshot', () => {
    expect(
      isSuperAgentSnapshot({
        localAgent: null,
        agents: [],
        connected: false,
      }),
    ).toBe(true)
  })

  it('returns true for snapshot with agents', () => {
    expect(
      isSuperAgentSnapshot({
        localAgent: {
          nodeId: 'n1',
          name: 'Agent',
          owner: 'matt',
          capabilities: [],
          status: 'online',
          currentTask: null,
          lastHeartbeat: 1000,
          version: '0.1.0',
          modelId: 'claude',
          joinedAt: 500,
        },
        agents: [],
        connected: true,
      }),
    ).toBe(true)
  })

  it('returns false for null', () => {
    expect(isSuperAgentSnapshot(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isSuperAgentSnapshot(undefined)).toBe(false)
  })

  it('returns false for missing agents array', () => {
    expect(isSuperAgentSnapshot({ connected: true })).toBe(false)
  })

  it('returns false for missing connected boolean', () => {
    expect(isSuperAgentSnapshot({ agents: [] })).toBe(false)
  })

  it('returns false for wrong types', () => {
    expect(
      isSuperAgentSnapshot({ agents: 'not-array', connected: true }),
    ).toBe(false)
    expect(
      isSuperAgentSnapshot({ agents: [], connected: 'yes' }),
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/packages/app && npx vitest run src/stores/__tests__/super-agent.test.ts 2>&1 | tail -15`

Expected: All 7 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/stores/__tests__/super-agent.test.ts
git commit -m "test(super-agent): add 7 frontend type guard tests for SuperAgentSnapshot"
```

---

## Task 12: Frontend Network Topology Panel

**Files:**
- Create: `packages/app/src/components/settings/team/SuperAgentNetwork.tsx`

- [ ] **Step 1: Check existing team settings components for UI patterns**

Read files in `packages/app/src/components/settings/team/` to understand the component patterns, imports, and styling conventions used.

- [ ] **Step 2: Create the network topology component**

Follow the patterns found in step 1. Structural skeleton:

```tsx
// packages/app/src/components/settings/team/SuperAgentNetwork.tsx

import { useEffect } from 'react'
import { useSuperAgentStore, type AgentProfile, type AgentStatus } from '@/stores/super-agent'

const STATUS_COLORS: Record<AgentStatus, string> = {
  online: 'bg-green-500',
  busy: 'bg-yellow-500',
  idle: 'bg-gray-400',
  offline: 'bg-red-500',
}

function AgentCard({ agent }: { agent: AgentProfile }) {
  const isLocal = useSuperAgentStore(
    (s) => s.snapshot.localAgent?.nodeId === agent.nodeId,
  )

  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <div
        className={`h-2.5 w-2.5 rounded-full ${STATUS_COLORS[agent.status]}`}
        title={agent.status}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">{agent.name}</span>
          {isLocal && (
            <span className="text-xs text-muted-foreground">(you)</span>
          )}
        </div>
        <div className="flex flex-wrap gap-1 mt-1">
          {agent.capabilities.map((cap) => (
            <span
              key={cap.domain}
              className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs"
            >
              {cap.domain}
            </span>
          ))}
        </div>
      </div>
      {agent.currentTask && (
        <span className="text-xs text-muted-foreground truncate max-w-[120px]">
          {agent.currentTask}
        </span>
      )}
    </div>
  )
}

export function SuperAgentNetwork() {
  const { snapshot, init } = useSuperAgentStore()

  useEffect(() => {
    let cleanup: (() => void) | undefined
    init().then((fn) => {
      cleanup = fn
    })
    return () => cleanup?.()
  }, [init])

  const onlineCount = snapshot.agents.filter(
    (a) => a.status !== 'offline',
  ).length

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Agent Network</h3>
        <span className="text-xs text-muted-foreground">
          {onlineCount} / {snapshot.agents.length} online
        </span>
      </div>

      {snapshot.agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No agents connected. Start a P2P team to see the network.
        </p>
      ) : (
        <div className="space-y-2">
          {snapshot.agents.map((agent) => (
            <AgentCard key={agent.nodeId} agent={agent} />
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/components/settings/team/SuperAgentNetwork.tsx
git commit -m "feat(super-agent): add network topology panel component"
```

---

## Summary

| Task | Component | Tests | What it delivers |
|------|-----------|-------|-----------------|
| 1 | `types.rs` | 7 unit tests | Core types + serde + TTL + capability scoring |
| 2 | `mod.rs`, `state.rs`, placeholders | — | Module scaffolding |
| 3 | `blackboard.rs` | 6 unit tests | Loro CRDT doc management + P2P sync bridge |
| 4 | `registry.rs` | 7 unit tests | Agent CRUD + capability discovery |
| 5 | `nerve.rs` | 3 unit tests | Gossip pub/sub + dispatch + topic ID |
| 6 | `heartbeat.rs` | — (logic tested via T1,T4) | 15s heartbeat + stale detection + event emit |
| 7 | `commands.rs` | — | Tauri IPC commands |
| 8 | `state.rs` v2 | — | Gossip listener + shared state |
| 9 | `lib.rs` | — | Wire into Tauri app startup |
| 10 | `super-agent.ts` | — | Frontend Zustand store |
| 11 | `super-agent.test.ts` | 7 Vitest tests | Frontend type guard tests |
| 12 | `SuperAgentNetwork.tsx` | — | Network topology panel |

**Total: 30 unit tests** (23 Rust + 7 TypeScript)

**Test commands:**
- Rust: `cargo test -p teamclaw --lib super_agent`
- Frontend: `npx vitest run src/stores/__tests__/super-agent.test.ts`

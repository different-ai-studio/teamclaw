# Super Agent Phase 1: Neural Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Layer 0 (Agent Identity & Capability Registry) and Layer 1 (Neural Fabric — Nerve Channel + Blackboard) so that agents can see each other, broadcast heartbeats, and maintain a persistent shared registry via CRDT.

**Architecture:** New `super_agent` Rust module alongside existing `team_p2p`. Layer 0 stores `AgentProfile` + `Capability` in a Loro CRDT doc (`registry.loro`) synced as a special entry in the existing iroh-docs P2P channel. Layer 1 adds gossip-based `NerveMessage` broadcasting (heartbeat + emergency topics) and a `Blackboard` abstraction over Loro docs. Frontend gets a new Zustand store and network topology panel.

**Tech Stack:** Rust (iroh 0.97, iroh-gossip 0.97, loro 1, serde, tokio), TypeScript (Zustand, Tauri IPC), React

---

## File Structure

### Rust Backend (`src-tauri/src/commands/super_agent/`)

| File | Responsibility |
|------|---------------|
| `mod.rs` | Module root, re-exports public types and Tauri commands |
| `types.rs` | Core data types: `AgentProfile`, `Capability`, `NerveMessage`, `NerveTopic`, all payload types |
| `registry.rs` | Layer 0: `AgentRegistry` — manages `registry.loro` Loro doc, agent CRUD, capability indexing, discovery queries |
| `nerve.rs` | Layer 1: `NerveChannel` — wraps iroh-gossip for topic-based pub/sub, message encoding/decoding, TTL filtering |
| `blackboard.rs` | Layer 1: `Blackboard` — manages Loro docs, handles serialization to/from iroh-docs entries, provides read/write API |
| `heartbeat.rs` | Heartbeat service: 15s timer, status detection, offline marking |
| `commands.rs` | Tauri `#[tauri::command]` functions exposed to frontend |
| `state.rs` | `SuperAgentState` type alias (`Arc<Mutex<Option<SuperAgentNode>>>`) and feature-gate shim |

### Frontend (`packages/app/src/`)

| File | Responsibility |
|------|---------------|
| `stores/super-agent.ts` | Zustand store: `AgentProfile[]`, connection status, Tauri event listener |
| `components/settings/team/SuperAgentNetwork.tsx` | Network topology panel: agent list with status badges and capability tags |

---

## Task 1: Core Types (`types.rs`)

**Files:**
- Create: `src-tauri/src/commands/super_agent/types.rs`

- [ ] **Step 1: Create the types file with all data structures**

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
    pub last_heartbeat: u64, // Unix timestamp millis
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

impl NerveMessage {
    pub fn is_expired(&self) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        now > self.timestamp + (self.ttl * 1000)
    }

    pub fn new_heartbeat(from: String, payload: HeartbeatPayload) -> Self {
        Self {
            id: nanoid::nanoid!(),
            topic: NerveTopic::Heartbeat,
            from,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            ttl: 30,
            payload: NervePayload::Heartbeat(payload),
        }
    }

    pub fn new_emergency_alert(from: String, task_id: Option<String>, reason: String) -> Self {
        Self {
            id: nanoid::nanoid!(),
            topic: NerveTopic::Emergency,
            from,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            ttl: 120,
            payload: NervePayload::EmergencyAlert { task_id, reason },
        }
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check 2>&1 | tail -5`

Note: This won't compile yet until `mod.rs` is created in Task 2. Just verify the file has no syntax errors by reading it.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/super_agent/types.rs
git commit -m "feat(super-agent): add core types for Layer 0 and Layer 1"
```

---

## Task 2: Module Structure (`mod.rs`, `state.rs`)

**Files:**
- Create: `src-tauri/src/commands/super_agent/mod.rs`
- Create: `src-tauri/src/commands/super_agent/state.rs`
- Modify: `src-tauri/src/commands/mod.rs` (add module declaration)

- [ ] **Step 1: Create the module root**

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

- [ ] **Step 2: Create the state shim**

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
    /// The local agent's node_id (iroh Ed25519 public key).
    pub local_node_id: String,
}

pub type SuperAgentState = Arc<Mutex<Option<SuperAgentNode>>>;
```

- [ ] **Step 3: Register the module in `commands/mod.rs`**

Add below the existing `#[cfg(feature = "p2p")] pub mod team_p2p;` line:

```rust
#[cfg(feature = "p2p")]
pub mod super_agent;
```

- [ ] **Step 4: Verify compilation**

This will fail because `registry`, `nerve`, `blackboard`, `heartbeat`, and `commands` modules don't exist yet. Create empty placeholder files:

```rust
// src-tauri/src/commands/super_agent/registry.rs
pub struct AgentRegistry;

// src-tauri/src/commands/super_agent/nerve.rs
pub struct NerveChannel;

// src-tauri/src/commands/super_agent/blackboard.rs
pub struct Blackboard;

// src-tauri/src/commands/super_agent/heartbeat.rs
// (empty for now)

// src-tauri/src/commands/super_agent/commands.rs
// (empty for now)
```

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check 2>&1 | tail -10`

Expected: Compilation succeeds (possibly with unused warnings, which is fine).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/super_agent/ src-tauri/src/commands/mod.rs
git commit -m "feat(super-agent): scaffold module structure with state management"
```

---

## Task 3: Blackboard (`blackboard.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/blackboard.rs`

The Blackboard wraps Loro docs and handles serialization to/from iroh-docs entries. For Phase 1, only `registry.loro` is needed.

- [ ] **Step 1: Implement the Blackboard**

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
/// Each board is a separate Loro doc, persisted locally as snapshots
/// and synced via iroh-docs entries (serialized Loro updates).
pub struct Blackboard {
    docs: HashMap<BoardType, LoroDoc>,
    /// Last exported version vector per board, for incremental exports.
    last_exported_version: HashMap<BoardType, Vec<u8>>,
    /// Local storage path for snapshots.
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

        // Initialize registry doc (load from snapshot if exists)
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

        // Update version vector
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
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check 2>&1 | tail -10`

Expected: Compiles (with unused warnings).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/super_agent/blackboard.rs
git commit -m "feat(super-agent): implement Blackboard with Loro CRDT doc management"
```

---

## Task 4: Agent Registry (`registry.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/registry.rs`

- [ ] **Step 1: Implement the AgentRegistry**

```rust
// src-tauri/src/commands/super_agent/registry.rs

use super::blackboard::{Blackboard, BoardType};
use super::types::{AgentProfile, AgentStatus, Capability};
use tracing::{info, warn};

/// Manages agent profiles and capability indexing on top of the Blackboard.
/// All reads/writes go through the registry.loro Loro doc.
pub struct AgentRegistry {
    /// The local agent's profile, kept in memory for fast access.
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

        // Filter to online agents with matching domain
        agents.retain(|a| {
            a.status != AgentStatus::Offline
                && a.capabilities.iter().any(|c| c.domain == domain)
        });

        // Sort by confidence × avgScore (descending)
        agents.sort_by(|a, b| {
            let score_a = capability_score(a, domain);
            let score_b = capability_score(b, domain);
            score_b.partial_cmp(&score_a).unwrap_or(std::cmp::Ordering::Equal)
        });

        agents
    }

    /// Mark an agent as offline if its heartbeat has exceeded the threshold.
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

    /// Write a remote agent's profile to the blackboard (e.g., from heartbeat updates).
    pub fn write_remote_profile(
        &self,
        blackboard: &mut Blackboard,
        profile: &AgentProfile,
    ) -> Result<(), String> {
        self.write_profile(blackboard, profile)
    }

    // ─── Private helpers ───────────────────────────────────────────────────

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

fn capability_score(agent: &AgentProfile, domain: &str) -> f64 {
    agent
        .capabilities
        .iter()
        .find(|c| c.domain == domain)
        .map(|c| c.confidence * c.avg_score)
        .unwrap_or(0.0)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check 2>&1 | tail -10`

Expected: Compiles.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/super_agent/registry.rs
git commit -m "feat(super-agent): implement AgentRegistry with capability discovery"
```

---

## Task 5: Nerve Channel (`nerve.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/nerve.rs`

The Nerve Channel wraps iroh-gossip for topic-based pub/sub. For Phase 1, it only handles `heartbeat` and `emergency` topics.

- [ ] **Step 1: Implement the NerveChannel**

```rust
// src-tauri/src/commands/super_agent/nerve.rs

use super::types::{NerveMessage, NerveTopic};
use iroh_gossip::net::Gossip;
use iroh_gossip::proto::TopicId;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::broadcast;
use tracing::{info, warn};

/// Derives a deterministic TopicId from a NerveTopic + team namespace.
/// This ensures all agents on the same team subscribe to the same gossip topics.
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
    /// Local broadcast channel for received messages (fanout to internal consumers).
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

    /// Subscribe to incoming messages. Returns a broadcast receiver.
    pub fn subscribe(&self) -> broadcast::Receiver<NerveMessage> {
        self.incoming_tx.subscribe()
    }

    /// Get the sender for dispatching received gossip messages into the local bus.
    /// Called by the gossip listener loop when raw bytes arrive.
    pub fn dispatch_incoming(&self, raw: &[u8]) {
        match serde_json::from_slice::<NerveMessage>(raw) {
            Ok(msg) => {
                if msg.is_expired() {
                    return; // silently drop expired messages
                }
                let _ = self.incoming_tx.send(msg);
            }
            Err(e) => {
                warn!("Failed to parse incoming NerveMessage: {e}");
            }
        }
    }

    /// Get the topic ID for a given NerveTopic (used to join gossip topics).
    pub fn topic_id(&self, topic: &NerveTopic) -> TopicId {
        derive_topic_id(topic, &self.team_namespace)
    }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check 2>&1 | tail -10`

Expected: Compiles.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/super_agent/nerve.rs
git commit -m "feat(super-agent): implement NerveChannel with gossip-based pub/sub"
```

---

## Task 6: Heartbeat Service (`heartbeat.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/heartbeat.rs`

- [ ] **Step 1: Implement the heartbeat service**

```rust
// src-tauri/src/commands/super_agent/heartbeat.rs

use super::blackboard::Blackboard;
use super::nerve::NerveChannel;
use super::registry::AgentRegistry;
use super::types::{AgentStatus, HeartbeatPayload, NerveMessage, NervePayload};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

const HEARTBEAT_INTERVAL_SECS: u64 = 15;
/// If no heartbeat received for this duration, mark agent offline.
const OFFLINE_THRESHOLD_MS: u64 = 120_000; // 2 minutes

/// Starts the heartbeat loop. Sends periodic heartbeats via Nerve Channel
/// and marks stale agents offline in the registry.
///
/// Returns a `JoinHandle` that can be aborted to stop the service.
pub fn spawn_heartbeat_loop(
    nerve: Arc<NerveChannel>,
    registry: Arc<Mutex<AgentRegistry>>,
    blackboard: Arc<Mutex<Blackboard>>,
    local_node_id: String,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(
            tokio::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS),
        );

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    // 1. Send heartbeat via Nerve Channel
                    let payload = {
                        let reg = registry.lock().await;
                        match reg.local_profile() {
                            Some(profile) => HeartbeatPayload {
                                status: profile.status.clone(),
                                current_task: profile.current_task.clone(),
                                load: 0.0, // TODO: compute actual load in Phase 2
                            },
                            None => continue,
                        }
                    };

                    let msg = NerveMessage::new_heartbeat(
                        local_node_id.clone(),
                        payload,
                    );

                    if let Err(e) = nerve.broadcast(msg).await {
                        warn!("Failed to send heartbeat: {e}");
                    }

                    // 2. Update local heartbeat timestamp in registry
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

                    // 3. Check for stale agents and mark them offline
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

                    // 4. Save blackboard snapshot periodically (piggyback on heartbeat)
                    {
                        let bb = blackboard.lock().await;
                        if let Err(e) = bb.save_snapshots() {
                            warn!("Failed to save blackboard snapshots: {e}");
                        }
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

Expected: Compiles.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/super_agent/heartbeat.rs
git commit -m "feat(super-agent): implement heartbeat service with stale agent detection"
```

---

## Task 7: Tauri Commands (`commands.rs`)

**Files:**
- Modify: `src-tauri/src/commands/super_agent/commands.rs`

- [ ] **Step 1: Implement Tauri commands**

```rust
// src-tauri/src/commands/super_agent/commands.rs

use super::state::SuperAgentState;
use super::types::{AgentProfile, SuperAgentSnapshot};

/// Get the current super-agent network snapshot (all agents + local status).
#[tauri::command]
pub async fn super_agent_snapshot(
    state: tauri::State<'_, SuperAgentState>,
) -> Result<SuperAgentSnapshot, String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let agents = node.registry.get_all_agents(&node.blackboard);
    let local_agent = node.registry.local_profile().cloned();

    Ok(SuperAgentSnapshot {
        local_agent,
        agents,
        connected: true,
    })
}

/// Discover agents matching a capability domain, sorted by score.
#[tauri::command]
pub async fn super_agent_discover(
    domain: String,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<Vec<AgentProfile>, String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    Ok(node.registry.discover_agents(&node.blackboard, &domain))
}
```

- [ ] **Step 2: Update `mod.rs` to re-export commands**

Add to the end of `src-tauri/src/commands/super_agent/mod.rs`:

```rust
pub use commands::{super_agent_snapshot, super_agent_discover};
```

- [ ] **Step 3: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check 2>&1 | tail -10`

Expected: Compiles.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/super_agent/commands.rs src-tauri/src/commands/super_agent/mod.rs
git commit -m "feat(super-agent): add Tauri commands for snapshot and discovery"
```

---

## Task 8: Wire Into Tauri App (`lib.rs`)

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add SuperAgentState to Tauri managed state**

Find the line `.manage(<commands::p2p_state::SyncEngineState>::default())` in `lib.rs` and add below it:

```rust
#[cfg(feature = "p2p")]
.manage(<commands::super_agent::SuperAgentState>::default())
```

- [ ] **Step 2: Register Tauri commands in the invoke handler**

Find the `tauri::generate_handler![...]` block. Add the super-agent commands alongside the existing P2P commands:

```rust
#[cfg(feature = "p2p")]
commands::super_agent::super_agent_snapshot,
#[cfg(feature = "p2p")]
commands::super_agent::super_agent_discover,
```

- [ ] **Step 3: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check 2>&1 | tail -10`

Expected: Compiles with the new commands registered.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(super-agent): wire SuperAgentState and commands into Tauri app"
```

---

## Task 9: Frontend Store (`stores/super-agent.ts`)

**Files:**
- Create: `packages/app/src/stores/super-agent.ts`

- [ ] **Step 1: Create the Zustand store**

```typescript
// packages/app/src/stores/super-agent.ts

import { create } from 'zustand'
import { isTauri } from '@/lib/utils'

// Types must match Rust backend's types exactly

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

function isSuperAgentSnapshot(value: unknown): value is SuperAgentSnapshot {
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

## Task 10: Frontend Network Topology Panel

**Files:**
- Create: `packages/app/src/components/settings/team/SuperAgentNetwork.tsx`

- [ ] **Step 1: Check existing team settings components for patterns**

Read a few files in `packages/app/src/components/settings/team/` to understand the UI framework (Tailwind? shadcn? custom?) and component patterns before writing the panel.

- [ ] **Step 2: Create the network topology component**

This component renders a list of connected agents with status indicators and capability tags. Exact styling should follow the patterns found in step 1. Below is the structural skeleton:

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

## Task 11: Integration — Gossip Listener Loop

**Files:**
- Modify: `src-tauri/src/commands/super_agent/state.rs` (add initialization logic)

This task wires the Nerve Channel to actually listen for incoming gossip messages and update the registry when heartbeats arrive from other agents.

- [ ] **Step 1: Add initialization and gossip listener to `state.rs`**

```rust
// Replace the contents of src-tauri/src/commands/super_agent/state.rs

use std::sync::Arc;
use tokio::sync::Mutex;

use super::blackboard::Blackboard;
use super::heartbeat;
use super::nerve::NerveChannel;
use super::registry::AgentRegistry;
use super::types::{AgentProfile, AgentStatus, NervePayload, NerveTopic};
use tracing::{info, warn};

/// Runtime state for the Super Agent subsystem.
pub struct SuperAgentNode {
    pub registry: AgentRegistry,
    pub nerve: Arc<NerveChannel>,
    pub blackboard: Blackboard,
    pub local_node_id: String,
    shutdown_tx: tokio::sync::watch::Sender<bool>,
    _heartbeat_handle: tokio::task::JoinHandle<()>,
    _listener_handle: tokio::task::JoinHandle<()>,
}

pub type SuperAgentState = Arc<Mutex<Option<SuperAgentNode>>>;

impl SuperAgentNode {
    /// Initialize the Super Agent subsystem using the existing iroh gossip instance.
    pub async fn start(
        gossip: iroh_gossip::net::Gossip,
        team_namespace: String,
        local_node_id: String,
        local_profile: AgentProfile,
        storage_path: &std::path::Path,
    ) -> Result<Self, String> {
        let nerve = Arc::new(NerveChannel::new(gossip, team_namespace));
        let mut blackboard = Blackboard::new(storage_path)?;
        let mut registry = AgentRegistry::new();

        // Register local agent
        registry.register_local(&mut blackboard, local_profile)?;

        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

        // Wrap registry and blackboard in Arc<Mutex> for shared access
        let registry_arc = Arc::new(Mutex::new(registry));
        let blackboard_arc = Arc::new(Mutex::new(blackboard));

        // Start heartbeat service
        let heartbeat_handle = heartbeat::spawn_heartbeat_loop(
            nerve.clone(),
            registry_arc.clone(),
            blackboard_arc.clone(),
            local_node_id.clone(),
            shutdown_rx.clone(),
        );

        // Start gossip listener
        let listener_handle = spawn_gossip_listener(
            nerve.clone(),
            registry_arc.clone(),
            blackboard_arc.clone(),
            shutdown_rx,
        );

        // Unwrap the Arc<Mutex<>> back to owned values for storage
        // (heartbeat/listener hold their own Arc clones)
        let registry = Arc::try_unwrap(registry_arc)
            .map_err(|_| "Failed to unwrap registry Arc")?
            .into_inner();
        let blackboard = Arc::try_unwrap(blackboard_arc)
            .map_err(|_| "Failed to unwrap blackboard Arc")?
            .into_inner();

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

/// Listens for incoming Nerve messages and processes them.
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
                                    // Update the remote agent's status in registry
                                    let mut reg = registry.lock().await;
                                    let mut bb = blackboard.lock().await;
                                    let agents = reg.get_all_agents(&bb);

                                    if let Some(mut agent) = agents.into_iter().find(|a| a.node_id == nerve_msg.from) {
                                        agent.status = hb.status.clone();
                                        agent.current_task = hb.current_task.clone();
                                        agent.last_heartbeat = nerve_msg.timestamp;
                                        // Write updated profile back to blackboard
                                        if let Err(e) = reg.write_remote_profile(&mut bb, &agent) {
                                            warn!("Failed to update remote agent heartbeat: {e}");
                                        }
                                    }
                                    // If agent is unknown, it will appear on next
                                    // blackboard sync from iroh-docs
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
                            info!("Nerve channel closed, exiting listener");
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

Expected: Compiles. There may be warnings about the `registry` and `blackboard` fields not being used through `SuperAgentNode` directly (since heartbeat/listener hold clones). This is expected — the commands in `commands.rs` will access them.

**Important:** The current `commands.rs` accesses `node.registry` and `node.blackboard` directly, but now heartbeat/listener also hold Arc clones. This creates a design tension. For Phase 1, the simplest fix is to make `registry` and `blackboard` in `SuperAgentNode` also be `Arc<Mutex<>>`:

Update `SuperAgentNode`:
```rust
pub struct SuperAgentNode {
    pub registry: Arc<Mutex<AgentRegistry>>,
    pub nerve: Arc<NerveChannel>,
    pub blackboard: Arc<Mutex<Blackboard>>,
    pub local_node_id: String,
    shutdown_tx: tokio::sync::watch::Sender<bool>,
    _heartbeat_handle: tokio::task::JoinHandle<()>,
    _listener_handle: tokio::task::JoinHandle<()>,
}
```

And update the `start()` method to NOT unwrap the Arcs — just store them directly.

Then update `commands.rs` to lock the mutexes:

```rust
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

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/super_agent/
git commit -m "feat(super-agent): wire gossip listener and fix shared state with Arc<Mutex>"
```

---

## Task 12: Integration — Startup Hook in `lib.rs`

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add SuperAgent startup after P2P node is ready**

Find the P2P startup code in `lib.rs` (in the `.setup()` hook, after `IrohNode::new_default()` succeeds). Add the SuperAgent initialization right after the iroh node is created and stored:

```rust
// After the P2P node is stored in IrohState, initialize SuperAgent
#[cfg(feature = "p2p")]
{
    let gossip = node.gossip.clone(); // Need to make gossip pub(crate) in IrohNode
    let node_id = node.endpoint.node_id().to_string();
    let team_namespace = "default"; // Use namespace from P2pConfig when available

    let profile = commands::super_agent::AgentProfile {
        node_id: node_id.clone(),
        name: hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "Unknown Agent".to_string()),
        owner: whoami::username(),
        capabilities: vec![],
        status: commands::super_agent::AgentStatus::Online,
        current_task: None,
        last_heartbeat: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        version: env!("CARGO_PKG_VERSION").to_string(),
        model_id: String::new(),
        joined_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    };

    let storage_path = home_dir.join(commands::TEAMCLAW_DIR).join("super_agent");
    match commands::super_agent::state::SuperAgentNode::start(
        gossip,
        team_namespace.to_string(),
        node_id,
        profile,
        &storage_path,
    ).await {
        Ok(sa_node) => {
            let mut sa_state = app_handle.state::<commands::super_agent::SuperAgentState>().lock().await;
            *sa_state = Some(sa_node);
            info!("Super Agent initialized");
        }
        Err(e) => {
            warn!("Failed to initialize Super Agent: {e}");
        }
    }
}
```

- [ ] **Step 2: Make `gossip` field accessible**

In `src-tauri/src/commands/team_p2p.rs`, change the `gossip` field visibility from private to `pub(crate)`:

```rust
pub struct IrohNode {
    #[allow(dead_code)]
    endpoint: Endpoint,
    // ...
    pub(crate) gossip: Gossip,  // was: gossip: Gossip
    // ...
}
```

Also make `endpoint` accessible:
```rust
    pub(crate) endpoint: Endpoint,  // was: endpoint: Endpoint
```

- [ ] **Step 3: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check 2>&1 | tail -10`

Expected: Compiles.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands/team_p2p.rs
git commit -m "feat(super-agent): wire startup hook into Tauri app initialization"
```

---

## Task 13: Emit Snapshot Events to Frontend

**Files:**
- Modify: `src-tauri/src/commands/super_agent/heartbeat.rs`

- [ ] **Step 1: Add Tauri event emission to heartbeat loop**

The heartbeat loop should emit `super-agent:snapshot` events to the frontend. Modify `spawn_heartbeat_loop` to accept an optional `AppHandle` and emit after each heartbeat cycle:

Add a new parameter to `spawn_heartbeat_loop`:

```rust
pub fn spawn_heartbeat_loop(
    nerve: Arc<NerveChannel>,
    registry: Arc<Mutex<AgentRegistry>>,
    blackboard: Arc<Mutex<Blackboard>>,
    local_node_id: String,
    app_handle: Option<tauri::AppHandle>,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
```

After the stale-agent check, add:

```rust
    // 5. Emit snapshot to frontend
    if let Some(ref app) = app_handle {
        use tauri::Emitter;
        let reg = registry.lock().await;
        let bb = blackboard.lock().await;
        let agents = reg.get_all_agents(&bb);
        let local_agent = reg.local_profile().cloned();
        let snapshot = super::types::SuperAgentSnapshot {
            local_agent,
            agents,
            connected: true,
        };
        let _ = app.emit("super-agent:snapshot", &snapshot);
    }
```

- [ ] **Step 2: Update `state.rs` to pass AppHandle**

Add `app_handle: Option<tauri::AppHandle>` to `SuperAgentNode::start()` and pass it through to `spawn_heartbeat_loop`.

- [ ] **Step 3: Update `lib.rs` startup to pass `app_handle`**

Pass `Some(app_handle.clone())` when calling `SuperAgentNode::start()`.

- [ ] **Step 4: Verify compilation**

Run: `cd /Volumes/openbeta/workspace/teamclaw-super-agent/src-tauri && cargo check 2>&1 | tail -10`

Expected: Compiles.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/super_agent/ src-tauri/src/lib.rs
git commit -m "feat(super-agent): emit snapshot events to frontend on heartbeat"
```

---

## Task 14: Blackboard ↔ iroh-docs Sync

**Files:**
- Modify: `src-tauri/src/commands/super_agent/blackboard.rs`

This task adds the bridge between Blackboard Loro docs and iroh-docs entries, so registry state syncs across P2P peers.

- [ ] **Step 1: Add sync methods to Blackboard**

```rust
impl Blackboard {
    /// Write the registry Loro doc updates into the iroh-docs entry
    /// so it gets synced to other peers.
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
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/commands/super_agent/blackboard.rs
git commit -m "feat(super-agent): add iroh-docs bridge for Blackboard P2P sync"
```

---

## Summary

| Task | Component | What it delivers |
|------|-----------|-----------------|
| 1 | `types.rs` | Core data structures for L0 + L1 |
| 2 | `mod.rs`, `state.rs` | Module scaffolding |
| 3 | `blackboard.rs` | Loro doc management + persistence |
| 4 | `registry.rs` | Agent CRUD + capability discovery |
| 5 | `nerve.rs` | Gossip-based pub/sub messaging |
| 6 | `heartbeat.rs` | 15s heartbeat + stale detection |
| 7 | `commands.rs` | Tauri IPC commands |
| 8 | `lib.rs` | Wire into Tauri app |
| 9 | `super-agent.ts` | Frontend Zustand store |
| 10 | `SuperAgentNetwork.tsx` | Network topology panel |
| 11 | `state.rs` v2 | Gossip listener + shared state |
| 12 | `lib.rs` v2 | Startup hook integration |
| 13 | `heartbeat.rs` v2 | Frontend event emission |
| 14 | `blackboard.rs` v2 | iroh-docs P2P sync bridge |

After all 14 tasks, the system will:
- **L0**: Each agent declares identity + capabilities, stored in a CRDT registry
- **L1**: Agents exchange heartbeats every 15s via gossip, stale agents auto-marked offline, registry synced via iroh-docs
- **Frontend**: Network topology panel shows all agents with status badges and capability tags, updated in real-time

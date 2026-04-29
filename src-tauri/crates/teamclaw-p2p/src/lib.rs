//! teamclaw-p2p: P2P team sync via iroh-docs.
//!
//! This crate contains:
//! - IrohNode: iroh endpoint with blobs, gossip, and docs
//! - SyncEngine: tracks P2P sync state (peers, files, health)
//! - P2P config read/write
//! - Member management (add/remove/update, manifest read/write)
//! - Bidirectional sync engine (doc↔disk watchers, reconciliation)
//! - Trash file management
//!
//! Tauri command wrappers remain in the main crate.
#![allow(clippy::too_many_arguments)]

pub mod trash;

// Re-export iroh types that consumers may need
pub use iroh;
pub use iroh_blobs;
pub use iroh_docs;
pub use iroh_gossip;

use teamclaw_sync::{FileSyncStatus, MemberRole, SyncFileStatus, TeamManifest, TeamMember};

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Instant, SystemTime};
use tokio::sync::{Mutex, RwLock};

use iroh::{Endpoint, SecretKey};
use iroh_blobs::store::fs::FsStore;
use iroh_blobs::BlobsProtocol;
use iroh_gossip::net::Gossip;

// ─── Event handler trait ─────────────────────────────────────────────────

/// Trait for handling P2P events. The main crate implements this with Tauri's
/// AppHandle to emit events to the frontend. Pure logic code calls these
/// methods instead of depending on tauri directly.
pub trait P2pEventHandler: Send + Sync + 'static {
    /// Emit engine state snapshot to the frontend.
    fn emit_engine_state(&self, snapshot: &EngineSnapshot);
    /// Emit that secrets have changed (triggers reload).
    fn emit_secrets_changed(&self);
    /// Reload shared secrets from disk.
    fn reload_shared_secrets(&self);
    /// Emit that a member has left the team.
    fn emit_member_left(&self, node_id: &str, name: &str);
    /// Emit that the team has been dissolved.
    fn emit_team_dissolved(&self);
    /// Emit that the members list has changed.
    fn emit_members_changed(&self);
    /// Emit that this node has been kicked from the team.
    fn emit_kicked(&self, node_id: &str);
    /// Emit that this node's role has changed.
    fn emit_role_changed(&self, role: &MemberRole);
}

// ─── Constants ───────────────────────────────────────────────────────────

/// Tombstone marker for deleted files.
/// Iroh rejects empty blobs, so we use a non-empty sentinel value.
const TOMBSTONE_MARKER: &[u8] = b"__TOMBSTONE__";

/// Check whether a doc entry represents a deleted file (tombstone).
/// Handles both the new marker and legacy empty entries for backwards compatibility.
fn is_tombstone(content: &[u8]) -> bool {
    content.is_empty() || content == TOMBSTONE_MARKER
}

/// Default storage path for iroh node state
const IROH_STORAGE_DIR: &str = concat!(".", env!("APP_SHORT_NAME"), "/iroh");
/// Filename for the persisted Ed25519 secret key
const SECRET_KEY_FILE: &str = "secret_key";

// ─── SyncEngine types ──────────────────────────────────────────────────────

/// Connection status for an individual peer, derived from elapsed time since last activity.
#[derive(Serialize, Deserialize, PartialEq, Clone, Debug)]
#[serde(rename_all = "lowercase")]
pub enum PeerConnection {
    Active,
    Stale,
    Lost,
    Unknown,
}

/// Tracks the local mtime at the moment a file was last synced, enabling safe reconciliation.
#[derive(Debug, Clone)]
pub struct FileSyncRecord {
    pub local_mtime_at_sync: SystemTime,
}

/// Runtime state for a single peer. Not serializable because it contains `Instant`.
#[derive(Debug, Clone)]
pub struct PeerState {
    pub node_id: String,
    pub name: String,
    pub role: MemberRole,
    pub last_activity: Option<Instant>,
    pub entries_sent: u64,
    pub entries_received: u64,
}

impl PeerState {
    /// Derive connection quality from elapsed time since last activity.
    pub fn connection(&self) -> PeerConnection {
        match self.last_activity {
            Some(t) => {
                let elapsed = t.elapsed().as_secs();
                if elapsed < 30 {
                    PeerConnection::Active
                } else if elapsed <= 120 {
                    PeerConnection::Stale
                } else {
                    PeerConnection::Lost
                }
            }
            None => PeerConnection::Unknown,
        }
    }
}

/// High-level status of the sync engine.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EngineStatus {
    Connected,
    Disconnected,
    Reconnecting,
}

/// Health of the event stream between this node and the iroh document.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum StreamHealth {
    Healthy,
    Dead,
    Restarting,
}

/// Serializable projection of `PeerState` for the frontend.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub node_id: String,
    pub name: String,
    pub role: MemberRole,
    pub connection: PeerConnection,
    pub last_seen_secs_ago: u64,
    pub entries_sent: u64,
    pub entries_received: u64,
}

/// Serializable snapshot of the entire sync engine state, sent to the frontend.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EngineSnapshot {
    pub status: EngineStatus,
    pub stream_health: StreamHealth,
    pub uptime_secs: u64,
    pub restart_count: u32,
    pub last_sync_at: Option<String>,
    pub peers: Vec<PeerInfo>,
    pub synced_files: u32,
    pub pending_files: u32,
}

/// Central state for the P2P sync engine. Not serializable (contains `Instant`).
pub struct SyncEngine {
    pub status: EngineStatus,
    pub stream_health: StreamHealth,
    pub started_at: Instant,
    pub restart_count: u32,
    pub last_sync_at: Option<String>,
    pub peers: HashMap<String, PeerState>,
    pub file_sync_records: HashMap<String, FileSyncRecord>,
    pub synced_files: u32,
    pub pending_files: u32,
}

impl Default for SyncEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncEngine {
    /// Create a new engine in disconnected state.
    pub fn new() -> Self {
        Self {
            status: EngineStatus::Disconnected,
            stream_health: StreamHealth::Dead,
            started_at: Instant::now(),
            restart_count: 0,
            last_sync_at: None,
            peers: HashMap::new(),
            file_sync_records: HashMap::new(),
            synced_files: 0,
            pending_files: 0,
        }
    }

    /// Build a serializable snapshot of the current engine state.
    pub fn snapshot(&self) -> EngineSnapshot {
        let peers: Vec<PeerInfo> = self
            .peers
            .values()
            .map(|p| PeerInfo {
                node_id: p.node_id.clone(),
                name: p.name.clone(),
                role: p.role.clone(),
                connection: p.connection(),
                last_seen_secs_ago: p.last_activity.map(|t| t.elapsed().as_secs()).unwrap_or(0),
                entries_sent: p.entries_sent,
                entries_received: p.entries_received,
            })
            .collect();

        EngineSnapshot {
            status: self.status.clone(),
            stream_health: self.stream_health.clone(),
            uptime_secs: self.started_at.elapsed().as_secs(),
            restart_count: self.restart_count,
            last_sync_at: self.last_sync_at.clone(),
            peers,
            synced_files: self.synced_files,
            pending_files: self.pending_files,
        }
    }

    /// Record that a sync round with `node_id` has finished.
    pub fn record_sync_finished(&mut self, node_id: &str, sent: u64, received: u64) {
        if let Some(peer) = self.peers.get_mut(node_id) {
            peer.entries_sent += sent;
            peer.entries_received += received;
            peer.last_activity = Some(Instant::now());
        }
        self.last_sync_at = Some(chrono::Utc::now().to_rfc3339());
    }

    /// Record that a neighbor (peer) has come online.
    pub fn record_neighbor_up(&mut self, node_id: &str) {
        if let Some(peer) = self.peers.get_mut(node_id) {
            peer.last_activity = Some(Instant::now());
        }
    }

    /// Populate the peers map from the on-disk members manifest.
    pub fn load_peers_from_manifest(&mut self, team_dir: &str) -> Result<(), String> {
        if let Some(manifest) = read_members_manifest(team_dir)? {
            for member in &manifest.members {
                self.peers
                    .entry(member.node_id.clone())
                    .or_insert_with(|| PeerState {
                        node_id: member.node_id.clone(),
                        name: member.name.clone(),
                        role: member.role.clone(),
                        last_activity: None,
                        entries_sent: 0,
                        entries_received: 0,
                    });
            }
        }
        Ok(())
    }

    /// Record that a file has been synced with the given local mtime.
    pub fn record_file_synced(&mut self, key: String, mtime: SystemTime) {
        self.file_sync_records.insert(
            key,
            FileSyncRecord {
                local_mtime_at_sync: mtime,
            },
        );
    }
}

pub fn disconnected_engine_snapshot(mut snapshot: EngineSnapshot) -> EngineSnapshot {
    snapshot.status = EngineStatus::Disconnected;
    snapshot.stream_health = StreamHealth::Dead;
    snapshot.last_sync_at = None;
    snapshot.peers.clear();
    snapshot.synced_files = 0;
    snapshot.pending_files = 0;
    snapshot
}

/// Shared, async-safe handle to the sync engine.
pub type SyncEngineState = Arc<Mutex<SyncEngine>>;

/// Load or generate a persistent Ed25519 secret key at `storage_path/secret_key`.
fn load_or_create_secret_key(storage_path: &Path) -> Result<SecretKey, String> {
    let key_path = storage_path.join(SECRET_KEY_FILE);

    if key_path.exists() {
        let bytes =
            std::fs::read(&key_path).map_err(|e| format!("Failed to read secret key: {}", e))?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| "Secret key file has invalid length (expected 32 bytes)".to_string())?;
        return Ok(SecretKey::from_bytes(&bytes));
    }

    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| format!("Failed to generate random bytes: {}", e))?;
    let key = SecretKey::from_bytes(&bytes);
    std::fs::create_dir_all(storage_path)
        .map_err(|e| format!("Failed to create iroh storage dir: {}", e))?;
    std::fs::write(&key_path, key.to_bytes())
        .map_err(|e| format!("Failed to write secret key: {}", e))?;
    Ok(key)
}

/// Wraps an iroh endpoint with blobs, gossip, and docs for P2P team file sync.
pub struct IrohNode {
    #[allow(dead_code)]
    endpoint: Endpoint,
    store: FsStore,
    #[allow(dead_code)]
    gossip: Gossip,
    docs: iroh_docs::protocol::Docs,
    router: iroh::protocol::Router,
    pub author: iroh_docs::AuthorId,
    /// Currently active team document (set after create/join)
    pub active_doc: Option<iroh_docs::api::Doc>,
    /// Paths being written by remote sync — suppresses fs watcher feedback loop
    suppressed_paths: Arc<Mutex<HashMap<std::path::PathBuf, Instant>>>,
    /// Incremented on reconnect/disconnect to signal stale sync tasks to exit.
    sync_generation_tx: tokio::sync::watch::Sender<u64>,
    sync_generation_rx: tokio::sync::watch::Receiver<u64>,
    /// Protects concurrent reads/writes of _team/members.json across sync tasks.
    manifest_lock: Arc<RwLock<()>>,
}

impl IrohNode {
    /// Create and start a new iroh node with persistent storage at the given path.
    pub async fn new(storage_path: &Path) -> Result<Self, String> {
        let t0 = std::time::Instant::now();
        let blob_path = storage_path.join("blobs");
        let docs_path = storage_path.join("docs");
        std::fs::create_dir_all(&blob_path)
            .map_err(|e| format!("Failed to create iroh blob dir: {}", e))?;
        std::fs::create_dir_all(&docs_path)
            .map_err(|e| format!("Failed to create iroh docs dir: {}", e))?;

        eprintln!("[P2P] Loading blob store...");
        let store = FsStore::load(&blob_path)
            .await
            .map_err(|e| format!("Failed to create iroh blob store: {}", e))?;
        eprintln!(
            "[P2P] Blob store loaded ({:.0}ms)",
            t0.elapsed().as_millis()
        );

        let secret_key = load_or_create_secret_key(storage_path)?;
        eprintln!("[P2P] Binding endpoint...");
        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(secret_key)
            .bind()
            .await
            .map_err(|e| format!("Failed to bind iroh endpoint: {}", e))?;
        eprintln!("[P2P] Endpoint bound ({:.0}ms)", t0.elapsed().as_millis());

        let gossip = Gossip::builder().spawn(endpoint.clone());

        let blobs_store: iroh_blobs::api::Store = store.clone().into();

        eprintln!("[P2P] Starting docs engine...");
        let docs = iroh_docs::protocol::Docs::persistent(docs_path)
            .spawn(endpoint.clone(), blobs_store.clone(), gossip.clone())
            .await
            .map_err(|e| format!("Failed to start docs engine: {}", e))?;
        eprintln!(
            "[P2P] Docs engine started ({:.0}ms)",
            t0.elapsed().as_millis()
        );

        let author = docs
            .author_default()
            .await
            .map_err(|e| format!("Failed to get default author: {}", e))?;

        let blobs_protocol = BlobsProtocol::new(&store, None);
        let router = iroh::protocol::Router::builder(endpoint.clone())
            .accept(iroh_blobs::ALPN, blobs_protocol)
            .accept(iroh_gossip::net::GOSSIP_ALPN, gossip.clone())
            .accept(iroh_docs::ALPN, docs.clone())
            .spawn();

        let (gen_tx, gen_rx) = tokio::sync::watch::channel(0u64);

        eprintln!("[P2P] Node ready ({:.0}ms total)", t0.elapsed().as_millis());

        Ok(IrohNode {
            endpoint,
            store,
            gossip,
            docs,
            router,
            author,
            active_doc: None,
            suppressed_paths: Arc::new(Mutex::new(HashMap::new())),
            sync_generation_tx: gen_tx,
            sync_generation_rx: gen_rx,
            manifest_lock: Arc::new(RwLock::new(())),
        })
    }

    /// Create a new iroh node using the default storage path (~/.teamclaw/iroh/).
    pub async fn new_default() -> Result<Self, String> {
        let home = dirs_or_default();
        let storage_path = Path::new(&home).join(IROH_STORAGE_DIR);
        Self::new(&storage_path).await
    }

    /// Check if the node is running.
    #[allow(dead_code)]
    pub fn is_running(&self) -> bool {
        !self.router.endpoint().is_closed()
    }

    /// Gracefully shut down the iroh node.
    #[allow(dead_code)]
    pub async fn shutdown(mut self) {
        self.bump_sync_generation();
        if let Some(doc) = self.active_doc.take() {
            if tokio::time::timeout(std::time::Duration::from_secs(5), doc.leave())
                .await
                .is_err()
            {
                eprintln!("[P2P] Timed out leaving active doc during shutdown");
            }
        }
        if tokio::time::timeout(std::time::Duration::from_secs(5), self.router.shutdown())
            .await
            .is_err()
        {
            eprintln!("[P2P] Timed out shutting down iroh router");
        }
    }

    /// Bump the sync generation, causing all running sync tasks to exit.
    /// Returns the new generation value.
    pub fn bump_sync_generation(&self) -> u64 {
        let new_gen = *self.sync_generation_rx.borrow() + 1;
        let _ = self.sync_generation_tx.send(new_gen);
        eprintln!("[P2P] Bumped sync generation to {}", new_gen);
        new_gen
    }

    /// Get the router's endpoint reference.
    pub fn endpoint(&self) -> &Endpoint {
        self.router.endpoint()
    }

    /// Get a clone of the store.
    pub fn store(&self) -> &FsStore {
        &self.store
    }

    /// Get the docs engine reference.
    pub fn docs(&self) -> &iroh_docs::protocol::Docs {
        &self.docs
    }
}

/// Get the user's home directory, falling back to /tmp.
fn dirs_or_default() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
}

/// Derive workspace path from team_dir by stripping the team repo suffix.
pub fn workspace_path_from_team_dir(team_dir: &str, team_repo_dir: &str) -> String {
    team_dir
        .strip_suffix(&format!("/{}", team_repo_dir))
        .unwrap_or(team_dir)
        .to_string()
}

fn resolve_team_entry_path(team_dir: &str, key: &str) -> Result<std::path::PathBuf, String> {
    use std::path::Component;

    let rel = Path::new(key);
    if rel.is_absolute() {
        return Err(format!("absolute path is not allowed: {}", key));
    }

    let mut normalized = std::path::PathBuf::new();
    for component in rel.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("path traversal is not allowed: {}", key));
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err(format!("empty path is not allowed: {}", key));
    }

    Ok(Path::new(team_dir).join(normalized))
}

fn persist_local_role_from_team_dir(
    team_dir: &str,
    role: &MemberRole,
    teamclaw_dir: &str,
    config_file_name: &str,
    team_repo_dir: &str,
) -> Result<(), String> {
    let workspace_path = workspace_path_from_team_dir(team_dir, team_repo_dir);
    let mut config =
        read_p2p_config(&workspace_path, teamclaw_dir, config_file_name)?.unwrap_or_default();
    config.role = Some(role.clone());
    write_p2p_config(
        &workspace_path,
        Some(&config),
        teamclaw_dir,
        config_file_name,
    )
}

/// Tauri managed state for the iroh node.
pub type IrohState = Arc<Mutex<Option<IrohNode>>>;

// ─── Device Identity ─────────────────────────────────────────────────────

/// Get the hex-encoded NodeId (Ed25519 public key) from an IrohNode.
pub fn get_node_id(node: &IrohNode) -> String {
    node.router.endpoint().addr().id.to_string()
}

/// Device metadata for display in team member list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub node_id: String,
    pub platform: String,
    pub arch: String,
    pub hostname: String,
}

/// Collect local device metadata (platform, arch, hostname).
pub fn get_device_metadata() -> DeviceInfo {
    let hostname = gethostname::gethostname().to_string_lossy().to_string();
    DeviceInfo {
        node_id: String::new(), // filled by caller with actual NodeId
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        hostname,
    }
}

// ─── File Helpers ────────────────────────────────────────────────────────

/// Collect all files recursively from a directory, returning (relative_path, content) pairs.
const MAX_SYNC_FILE_SIZE: u64 = 50 * 1024 * 1024; // 50 MB
const MAX_TOTAL_SYNC_SIZE: u64 = 500 * 1024 * 1024; // 500 MB total

pub fn collect_files(base: &Path, dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut total_size: u64 = 0;
    if !dir.exists() {
        return files;
    }

    // Build gitignore matcher with hardcoded global excludes (same as OSS/Git)
    // plus any .gitignore files in the team directory tree
    let gitignore = {
        let mut builder = ignore::gitignore::GitignoreBuilder::new(dir);

        // Global excludes — build artifacts / caches / local-only dirs
        const GLOBAL_EXCLUDES: &[&str] = &[
            ".trash/",
            ".DS_Store",
            "node_modules/",
            ".git/",
            "target/",
            "dist/",
            "build/",
            "out/",
            ".cache/",
            ".turbo/",
            ".next/",
            ".nuxt/",
            ".output/",
            "__pycache__/",
            ".venv/",
            "venv/",
            ".tox/",
            "vendor/",
            ".gradle/",
            ".m2/",
            "*.log",
            "*.tmp",
        ];
        for pattern in GLOBAL_EXCLUDES {
            let _ = builder.add_line(None, pattern);
        }

        let root_gi = dir.join(".gitignore");
        if root_gi.exists() {
            let _ = builder.add(root_gi);
        }
        // Also check subdirectories for .gitignore files
        for subdir in &["skills", "knowledge", ".mcp"] {
            let sub_gi = dir.join(subdir).join(".gitignore");
            if sub_gi.exists() {
                let _ = builder.add(&sub_gi);
            }
        }
        builder.build().unwrap_or_else(|_| {
            ignore::gitignore::GitignoreBuilder::new(dir)
                .build()
                .unwrap()
        })
    };

    'outer: for entry in walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();

        // Apply gitignore rules
        if gitignore
            .matched(path, entry.file_type().is_dir())
            .is_ignore()
        {
            continue;
        }

        if entry.file_type().is_file() {
            // Skip files larger than MAX_SYNC_FILE_SIZE to avoid memory spikes
            if let Ok(meta) = entry.metadata() {
                if meta.len() > MAX_SYNC_FILE_SIZE {
                    eprintln!(
                        "[P2P] Skipping large file ({} MB): {}",
                        meta.len() / (1024 * 1024),
                        path.display()
                    );
                    continue;
                }
                if total_size + meta.len() > MAX_TOTAL_SYNC_SIZE {
                    eprintln!(
                        "[P2P] Reached cumulative size limit ({} MB), stopping collection",
                        MAX_TOTAL_SYNC_SIZE / (1024 * 1024)
                    );
                    break 'outer;
                }
            }
            if let Ok(content) = std::fs::read(path) {
                if let Ok(rel) = path.strip_prefix(base) {
                    total_size += content.len() as u64;
                    files.push((rel.to_string_lossy().to_string(), content));
                }
            }
        }
    }
    files
}

/// Scaffold the teamclaw-team directory with default structure if it doesn't exist or is empty.
pub fn scaffold_team_dir(team_dir: &str) -> Result<(), String> {
    let team_path = Path::new(team_dir);

    let is_empty = !team_path.exists()
        || team_path
            .read_dir()
            .map(|mut d| d.next().is_none())
            .unwrap_or(true);

    if !is_empty {
        return Ok(());
    }

    let dirs = ["skills", ".mcp", "knowledge", "_feedback"];
    for d in &dirs {
        std::fs::create_dir_all(team_path.join(d))
            .map_err(|e| format!("Failed to create {}: {}", d, e))?;
    }

    let readme_path = team_path.join("README.md");
    if !readme_path.exists() {
        let readme = "# TeamClaw Team Drive\n\nShared team resources.\n\n## Structure\n\n- `skills/` - Shared agent skills\n- `.mcp/` - MCP server configurations\n- `knowledge/` - Shared knowledge base\n- `_feedback/` - Member feedback summaries (auto-synced)\n";
        std::fs::write(&readme_path, readme)
            .map_err(|e| format!("Failed to write README.md: {}", e))?;
    }

    Ok(())
}

// ─── Create / Join (iroh-docs) ──────────────────────────────────────────

/// Create a team: create an iroh-docs document, write files, return a stable DocTicket.
pub async fn create_team(
    node: &mut IrohNode,
    team_dir: &str,
    workspace_path: &str,
    team_name: Option<String>,
    owner_name: Option<String>,
    owner_email: Option<String>,
    event_handler: Option<Arc<dyn P2pEventHandler>>,
    engine: SyncEngineState,
    teamclaw_dir: &str,
    config_file_name: &str,
    team_repo_dir: &str,
) -> Result<String, String> {
    scaffold_team_dir(team_dir)?;

    let node_id = get_node_id(node);
    let info = get_device_metadata();

    // Write _team/team.json with team metadata
    let team_info = serde_json::json!({
        "teamName": team_name.as_deref().unwrap_or(""),
        "ownerName": owner_name.as_deref().unwrap_or(""),
        "ownerEmail": owner_email.as_deref().unwrap_or(""),
        "ownerNodeId": &node_id,
        "createdAt": chrono::Utc::now().to_rfc3339(),
    });
    let team_info_dir = Path::new(team_dir).join("_team");
    std::fs::create_dir_all(&team_info_dir).ok();
    std::fs::write(
        team_info_dir.join("team.json"),
        serde_json::to_string_pretty(&team_info).unwrap_or_default(),
    )
    .map_err(|e| format!("Failed to write team.json: {}", e))?;

    let owner_member = TeamMember {
        node_id: node_id.clone(),
        name: owner_name.unwrap_or_default(),
        role: MemberRole::Owner,
        shortcuts_role: Vec::new(),
        label: info.hostname.clone(),
        platform: info.platform,
        arch: info.arch,
        hostname: info.hostname,
        added_at: chrono::Utc::now().to_rfc3339(),
    };

    write_members_manifest(team_dir, &node_id, std::slice::from_ref(&owner_member))?;

    // Create a new iroh-docs document
    let doc = node
        .docs
        .create()
        .await
        .map_err(|e| format!("Failed to create doc: {}", e))?;

    // Write all files from team_dir into the document
    let files = collect_files(Path::new(team_dir), Path::new(team_dir));
    for (key, content) in &files {
        doc.set_bytes(node.author, key.clone(), content.clone())
            .await
            .map_err(|e| format!("Failed to write '{}' to doc: {}", key, e))?;
    }

    // Write author→node mapping so stats can resolve AuthorId back to NodeId
    let author_meta_key = format!("_meta/authors/{}", node.author);
    doc.set_bytes(node.author, author_meta_key, node_id.as_bytes().to_vec())
        .await
        .map_err(|e| format!("Failed to write author meta: {}", e))?;

    // Generate a stable DocTicket (Write mode so joiners can write back)
    let ticket = doc
        .share(
            iroh_docs::api::protocol::ShareMode::Write,
            iroh_docs::api::protocol::AddrInfoOptions::RelayAndAddresses,
        )
        .await
        .map_err(|e| format!("Failed to share doc: {}", e))?;

    let ticket_str = ticket.to_string();
    let namespace_id = doc.id().to_string();

    eprintln!(
        "[Team] Created team doc namespace={}",
        &namespace_id[..10.min(namespace_id.len())]
    );

    // Start background sync
    let team_dir_owned = team_dir.to_string();
    let node_id_for_sync = node_id.clone();
    start_sync_tasks(
        &doc,
        node.author,
        &node.store,
        &team_dir_owned,
        node.suppressed_paths.clone(),
        Arc::new(Mutex::new(MemberRole::Owner)),
        node_id_for_sync,
        Some(node_id.clone()),
        event_handler,
        node.router.endpoint().clone(),
        None,           // ticket not needed for owner — peers connect to us
        None,           // seed_endpoint resolved later on reconnect
        HashMap::new(), // no cached peers yet for new team
        Some(workspace_path.to_string()),
        engine,
        node.sync_generation_rx.clone(),
        *node.sync_generation_rx.borrow(),
        node.manifest_lock.clone(),
        teamclaw_dir,
        config_file_name,
        team_repo_dir,
    );

    node.active_doc = Some(doc);

    // Update P2P config with ownership
    let mut config =
        read_p2p_config(workspace_path, teamclaw_dir, config_file_name)?.unwrap_or_default();
    config.enabled = true;
    config.publish_enabled = true;
    config.owner_node_id = Some(node_id);
    config.allowed_members = vec![owner_member];
    config.namespace_id = Some(namespace_id);
    config.doc_ticket = Some(ticket_str.clone());
    config.role = Some(MemberRole::Owner);
    write_p2p_config(
        workspace_path,
        Some(&config),
        teamclaw_dir,
        config_file_name,
    )?;

    Ok(ticket_str)
}

/// Join a team drive by importing a DocTicket. Auto-syncs bidirectionally.
///
/// Flow: import doc → sync manifest → check authorization → if rejected, close doc and clean up.
/// This ensures unauthorized devices never start background sync or persist config.
pub async fn join_team_drive(
    node: &mut IrohNode,
    ticket_str: &str,
    team_dir: &str,
    workspace_path: &str,
    event_handler: Option<Arc<dyn P2pEventHandler>>,
    engine: SyncEngineState,
    teamclaw_dir: &str,
    config_file_name: &str,
    team_repo_dir: &str,
) -> Result<String, String> {
    use std::str::FromStr;

    let ticket = iroh_docs::DocTicket::from_str(ticket_str)
        .map_err(|_| "Invalid ticket format".to_string())?;

    // Import the document — this joins peers and starts syncing
    let doc = node
        .docs
        .import(ticket)
        .await
        .map_err(|e| format!("Failed to import doc: {}", e))?;

    // Wait for initial sync — best-effort, up to 10s.
    let joiner_node_id = get_node_id(node);
    let mut file_count = 0;
    let mut auth_status = "pending"; // "authorized" | "rejected" | "pending"
    for attempt in 1..=10 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        file_count =
            write_doc_entries_to_disk(&doc, &node.store, team_dir, event_handler.as_deref())
                .await
                .unwrap_or(0);

        // If the manifest synced, check authorization eagerly
        match check_join_authorization(team_dir, &joiner_node_id) {
            Ok(()) => {
                eprintln!("[P2P] Authorized after {}s", attempt);
                auth_status = "authorized";
                break;
            }
            Err(ref e) if e.contains("no members manifest") => {
                eprintln!("[P2P] Waiting for manifest... ({}s)", attempt);
            }
            Err(ref auth_err) => {
                eprintln!("[P2P] Authorization denied: {}", auth_err);
                auth_status = "rejected";
                break;
            }
        }

        if file_count > 0 && attempt >= 3 {
            eprintln!(
                "[P2P] Got {} files after {}s, proceeding",
                file_count, attempt
            );
            break;
        }
    }

    // Only hard-reject if the manifest was present and we're not in it
    if auth_status == "rejected" {
        let _ = doc.close().await;
        let _ = std::fs::remove_dir_all(team_dir);
        return Err(format!(
            "Not authorized — share your Device ID with the team owner: {}",
            joiner_node_id
        ));
    }

    if auth_status == "pending" {
        eprintln!(
            "[P2P] Manifest not yet synced — proceeding with join (auth deferred to reconnect). Device: {}",
            joiner_node_id
        );
    }

    // Write author→node mapping so stats can resolve AuthorId back to NodeId
    let author_meta_key = format!("_meta/authors/{}", node.author);
    doc.set_bytes(
        node.author,
        author_meta_key,
        joiner_node_id.as_bytes().to_vec(),
    )
    .await
    .map_err(|e| format!("Failed to write author meta: {}", e))?;

    let namespace_id = doc.id().to_string();

    let existing_config =
        read_p2p_config(workspace_path, teamclaw_dir, config_file_name)?.unwrap_or_default();
    let manifest = read_members_manifest(team_dir)?;
    let joiner_role = manifest
        .as_ref()
        .and_then(|m| {
            m.members
                .iter()
                .find(|mem| mem.node_id == joiner_node_id)
                .map(|mem| mem.role.clone())
        })
        .or_else(|| existing_config.role.clone())
        .unwrap_or(MemberRole::Editor);
    let manifest_owner = manifest
        .map(|m| m.owner_node_id)
        .or_else(|| existing_config.owner_node_id.clone());

    // Reconcile offline edits (primarily for re-join scenarios)
    let is_owner = manifest_owner.as_deref() == Some(&joiner_node_id);
    let temp_engine: Arc<Mutex<SyncEngine>> = Arc::new(Mutex::new(SyncEngine::new()));
    if let Err(e) = reconcile_disk_and_doc(
        &doc,
        &node.store,
        node.author,
        team_dir,
        is_owner,
        &joiner_role,
        &temp_engine,
        event_handler.as_deref(),
        team_repo_dir,
    )
    .await
    {
        eprintln!("[P2P] Reconcile failed: {} (continuing)", e);
    }

    // Resolve seed endpoint if seed_url is configured
    let existing_config =
        read_p2p_config(workspace_path, teamclaw_dir, config_file_name)?.unwrap_or_default();
    let seed_ep = if let Some(ref seed_url) = existing_config.seed_url {
        resolve_seed_endpoint(
            seed_url,
            workspace_path,
            &existing_config,
            teamclaw_dir,
            config_file_name,
        )
        .await
    } else {
        None
    };

    // Start background sync
    let team_dir_owned = team_dir.to_string();
    let node_id_for_sync = joiner_node_id.clone();
    start_sync_tasks(
        &doc,
        node.author,
        &node.store,
        &team_dir_owned,
        node.suppressed_paths.clone(),
        Arc::new(Mutex::new(joiner_role.clone())),
        node_id_for_sync,
        manifest_owner.clone(),
        event_handler,
        node.router.endpoint().clone(),
        Some(ticket_str.to_string()),
        seed_ep,
        HashMap::new(), // no cached peers yet for new joiner
        Some(workspace_path.to_string()),
        engine,
        node.sync_generation_rx.clone(),
        *node.sync_generation_rx.borrow(),
        node.manifest_lock.clone(),
        teamclaw_dir,
        config_file_name,
        team_repo_dir,
    );

    node.active_doc = Some(doc);

    // Save config
    let mut config =
        read_p2p_config(workspace_path, teamclaw_dir, config_file_name)?.unwrap_or_default();
    config.enabled = true;
    config.namespace_id = Some(namespace_id);
    config.doc_ticket = Some(ticket_str.to_string());

    config.role = Some(joiner_role);
    if manifest_owner.is_some() {
        config.owner_node_id = manifest_owner;
    }
    config.last_sync_at = Some(chrono::Utc::now().to_rfc3339());
    write_p2p_config(
        workspace_path,
        Some(&config),
        teamclaw_dir,
        config_file_name,
    )?;

    Ok(format!("Synced {} files from team drive", file_count))
}

/// Read all doc entries and write them to disk. Returns file count.
async fn write_doc_entries_to_disk(
    doc: &iroh_docs::api::Doc,
    store: &FsStore,
    team_dir: &str,
    event_handler: Option<&dyn P2pEventHandler>,
) -> Result<usize, String> {
    use futures_lite::StreamExt;
    use std::pin::pin;

    let blobs_store: iroh_blobs::api::Store = store.clone().into();
    let query = iroh_docs::store::Query::single_latest_per_key().build();
    let entries = doc
        .get_many(query)
        .await
        .map_err(|e| format!("Failed to query doc entries: {}", e))?;
    let mut entries = pin!(entries);

    let team_path = Path::new(team_dir);
    std::fs::create_dir_all(team_path).map_err(|e| format!("Failed to create team dir: {}", e))?;

    let mut file_count = 0;
    let mut secrets_changed = false;
    while let Some(entry_result) = entries.next().await {
        let entry = entry_result.map_err(|e| format!("Failed to read entry: {}", e))?;
        let key = String::from_utf8_lossy(entry.key()).to_string();
        let content_hash = entry.content_hash();

        let content = blobs_store
            .blobs()
            .get_bytes(content_hash)
            .await
            .map_err(|e| format!("Failed to read content for '{}': {}", key, e))?;

        let file_path = match resolve_team_entry_path(team_dir, &key) {
            Ok(path) => path,
            Err(e) => {
                eprintln!("[P2P] Skipping unsafe doc key '{}': {}", key, e);
                continue;
            }
        };

        // Skip tombstones (deleted files)
        if is_tombstone(&content) {
            if file_path.exists() {
                if let Err(e) = trash::trash_file(Path::new(team_dir), &key) {
                    eprintln!("[P2P] Failed to trash before delete {}: {}", key, e);
                }
                let _ = std::fs::remove_file(&file_path);
            }
            continue;
        }

        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        if file_path.exists() {
            if let Err(e) = trash::trash_file(Path::new(team_dir), &key) {
                eprintln!("[P2P] Failed to trash before overwrite {}: {}", key, e);
            }
        }
        std::fs::write(&file_path, &content)
            .map_err(|e| format!("Failed to write '{}': {}", key, e))?;
        if key.starts_with("_secrets/") {
            secrets_changed = true;
        }
        file_count += 1;
    }

    if secrets_changed {
        if let Some(handler) = event_handler {
            handler.reload_shared_secrets();
            handler.emit_secrets_changed();
        }
    }

    Ok(file_count)
}

/// Reconcile local files with iroh doc at startup.
/// Uploads local-only files, downloads remote-only files.
/// For conflicts (both differ), local wins (local-first rule).
async fn reconcile_disk_and_doc(
    doc: &iroh_docs::api::Doc,
    store: &FsStore,
    author: iroh_docs::AuthorId,
    team_dir: &str,
    is_owner: bool,
    role: &MemberRole,
    engine: &Arc<Mutex<SyncEngine>>,
    event_handler: Option<&dyn P2pEventHandler>,
    _team_repo_dir: &str,
) -> Result<(usize, usize), String> {
    use futures_lite::StreamExt;

    let blobs_store: iroh_blobs::api::Store = store.clone().into();
    let team_path = Path::new(team_dir);
    let mut uploaded = 0usize;
    let mut downloaded = 0usize;
    let mut secrets_changed = false;

    // 1. Collect local files
    let local_files = collect_files(team_path, team_path);
    let mut local_map: std::collections::HashMap<String, Vec<u8>> =
        local_files.into_iter().collect();

    // 2. Collect doc entries and reconcile
    let query = iroh_docs::store::Query::single_latest_per_key().build();
    let entries = doc
        .get_many(query)
        .await
        .map_err(|e| format!("Failed to query doc: {}", e))?;
    let mut entries = std::pin::pin!(entries);

    while let Some(Ok(entry)) = entries.next().await {
        let key = String::from_utf8_lossy(entry.key()).to_string();

        // Skip internal keys
        if key.starts_with("_meta/") {
            local_map.remove(&key);
            continue;
        }

        let file_path = match resolve_team_entry_path(team_dir, &key) {
            Ok(path) => path,
            Err(e) => {
                eprintln!("[P2P][reconcile] Skipping unsafe doc key '{}': {}", key, e);
                continue;
            }
        };

        if let Some(local_content) = local_map.remove(&key) {
            // Check if remote is a tombstone — if so, delete local file
            if let Ok(remote_content) = blobs_store.blobs().get_bytes(entry.content_hash()).await {
                if is_tombstone(&remote_content) {
                    eprintln!(
                        "[P2P][reconcile] Remote tombstone -> deleting local: {}",
                        key
                    );
                    if let Err(e) = trash::trash_file(Path::new(team_dir), &key) {
                        eprintln!(
                            "[P2P][reconcile] Failed to trash before delete {}: {}",
                            key, e
                        );
                    }
                    let _ = std::fs::remove_file(&file_path);
                    continue;
                }
            }
            // Both exist — check if they differ
            let local_hash = iroh_blobs::Hash::new(&local_content);
            if local_hash != entry.content_hash() {
                if *role == MemberRole::Viewer {
                    continue;
                }
                if key == "_team/members.json" && !is_owner {
                    continue;
                }

                // Check if local file was modified since last sync
                let local_was_edited = {
                    let eng = engine.lock().await;
                    if let Some(record) = eng.file_sync_records.get(&key) {
                        match std::fs::metadata(&file_path).and_then(|m| m.modified()) {
                            Ok(current_mtime) => current_mtime > record.local_mtime_at_sync,
                            Err(_) => false,
                        }
                    } else {
                        is_owner
                    }
                };

                if local_was_edited {
                    let content = if local_content.is_empty() {
                        vec![b'\n']
                    } else {
                        local_content
                    };
                    if let Err(e) = doc.set_bytes(author, key.clone(), content).await {
                        eprintln!("[P2P][reconcile] Failed to upload {}: {}", key, e);
                    } else {
                        eprintln!(
                            "[P2P][reconcile] Conflict -> local wins (edited offline): {}",
                            key
                        );
                        uploaded += 1;
                    }
                } else {
                    if let Ok(content) = blobs_store.blobs().get_bytes(entry.content_hash()).await {
                        if !is_tombstone(&content) {
                            if let Err(e) = trash::trash_file(Path::new(team_dir), &key) {
                                eprintln!(
                                    "[P2P][reconcile] Failed to trash before overwrite {}: {}",
                                    key, e
                                );
                            }
                            if let Some(parent) = file_path.parent() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                            if let Err(e) = std::fs::write(&file_path, &content) {
                                eprintln!("[P2P][reconcile] Failed to write {}: {}", key, e);
                            } else {
                                eprintln!(
                                    "[P2P][reconcile] Conflict -> remote wins (local stale): {}",
                                    key
                                );
                                downloaded += 1;
                            }
                        }
                    }
                }
            }
        } else {
            // Remote only — download to disk (or delete if tombstone)
            if let Ok(content) = blobs_store.blobs().get_bytes(entry.content_hash()).await {
                if is_tombstone(&content) {
                    continue;
                }
                if let Some(parent) = file_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::write(&file_path, &content) {
                    eprintln!("[P2P][reconcile] Failed to write {}: {}", key, e);
                } else {
                    if key.starts_with("_secrets/") {
                        secrets_changed = true;
                    }
                    downloaded += 1;
                }
            }
        }
    }

    if secrets_changed {
        if let Some(handler) = event_handler {
            handler.reload_shared_secrets();
            handler.emit_secrets_changed();
        }
    }

    // 3. Local-only files — upload to doc
    if *role != MemberRole::Viewer {
        for (key, content) in &local_map {
            if key.starts_with("_meta/") {
                continue;
            }
            if key == "_team/members.json" && !is_owner && *role == MemberRole::Viewer {
                continue;
            }
            let content = if content.is_empty() {
                vec![b'\n']
            } else {
                content.clone()
            };
            if let Err(e) = doc.set_bytes(author, key.clone(), content).await {
                eprintln!("[P2P][reconcile] Failed to upload {}: {}", key, e);
            } else {
                uploaded += 1;
            }
        }
    }

    eprintln!(
        "[P2P][reconcile] Done: {} uploaded, {} downloaded",
        uploaded, downloaded
    );
    Ok((uploaded, downloaded))
}

/// Publish (re-sync) current files into the active doc.
pub async fn publish_team_drive(
    node: &IrohNode,
    team_dir: &str,
    workspace_path: &str,
    teamclaw_dir: &str,
    config_file_name: &str,
) -> Result<String, String> {
    let config =
        read_p2p_config(workspace_path, teamclaw_dir, config_file_name)?.unwrap_or_default();
    if config.role == Some(MemberRole::Viewer) {
        return Err("Viewers cannot publish to the team drive".to_string());
    }

    let doc = node
        .active_doc
        .as_ref()
        .ok_or("No active team document. Create or join a team first.")?;

    let team_path = Path::new(team_dir);
    scaffold_team_dir(team_dir)?;

    let files = collect_files(team_path, team_path);
    for (key, content) in &files {
        doc.set_bytes(node.author, key.clone(), content.clone())
            .await
            .map_err(|e| format!("Failed to sync '{}': {}", key, e))?;
    }

    Ok(format!("Synced {} files to team drive", files.len()))
}

/// Rotate the namespace — create a new document and migrate content.
pub async fn rotate_namespace(
    node: &mut IrohNode,
    team_dir: &str,
    workspace_path: &str,
    engine: SyncEngineState,
    teamclaw_dir: &str,
    config_file_name: &str,
    team_repo_dir: &str,
) -> Result<String, String> {
    let previous_config =
        read_p2p_config(workspace_path, teamclaw_dir, config_file_name)?.unwrap_or_default();
    let previous_manifest = read_members_manifest(team_dir)?;
    let previous_team_info =
        std::fs::read(Path::new(team_dir).join("_team").join("team.json")).ok();

    // Stop the old namespace's watchers before we reuse the same team dir.
    node.bump_sync_generation();

    // Close existing doc
    if let Some(old_doc) = node.active_doc.take() {
        let _ = old_doc.leave().await;
    }

    // Re-create as owner in a new namespace.
    let ticket = create_team(
        node,
        team_dir,
        workspace_path,
        None,
        None,
        None,
        None,
        engine,
        teamclaw_dir,
        config_file_name,
        team_repo_dir,
    )
    .await?;

    let owner_node_id = previous_manifest
        .as_ref()
        .map(|manifest| manifest.owner_node_id.clone())
        .or_else(|| previous_config.owner_node_id.clone())
        .unwrap_or_else(|| get_node_id(node));

    // Restore previous manifest (with updated namespace)
    if let Some(manifest) = &previous_manifest {
        write_members_manifest(team_dir, &owner_node_id, &manifest.members)?;
    }
    // Restore previous team.json
    if let Some(team_info) = previous_team_info {
        let _ = std::fs::write(
            Path::new(team_dir).join("_team").join("team.json"),
            team_info,
        );
    }

    // Update config with previous members
    let mut config =
        read_p2p_config(workspace_path, teamclaw_dir, config_file_name)?.unwrap_or_default();
    if let Some(manifest) = previous_manifest {
        config.allowed_members = manifest.members;
    }
    config.owner_node_id = Some(owner_node_id);
    write_p2p_config(
        workspace_path,
        Some(&config),
        teamclaw_dir,
        config_file_name,
    )?;

    Ok(ticket)
}

// ─── Seed endpoint resolution ────────────────────────────────────────────

async fn fetch_seed_endpoint(seed_url: &str) -> Option<iroh::EndpointAddr> {
    let url = format!("{}/node-id", seed_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;

    let resp = client.get(&url).send().await.ok()?;
    let json: serde_json::Value = resp.json().await.ok()?;

    let node_id_str = json.get("nodeId")?.as_str()?;
    let id = node_id_str.parse::<iroh::EndpointId>().ok()?;

    let mut addrs = std::collections::BTreeSet::new();

    if let Some(relay) = json.get("relayUrl").and_then(|v| v.as_str()) {
        if let Ok(url) = relay.parse::<iroh::RelayUrl>() {
            addrs.insert(iroh::TransportAddr::Relay(url));
        }
    }

    if let Some(arr) = json.get("addrs").and_then(|v| v.as_array()) {
        for addr_val in arr {
            if let Some(addr_str) = addr_val.as_str() {
                if let Ok(sock) = addr_str.parse::<std::net::SocketAddr>() {
                    addrs.insert(iroh::TransportAddr::Ip(sock));
                }
            }
        }
    }

    if addrs.is_empty() {
        return None;
    }

    eprintln!(
        "[P2P] Fetched seed endpoint: {} ({} addrs)",
        &node_id_str[..10.min(node_id_str.len())],
        addrs.len()
    );
    Some(iroh::EndpointAddr { id, addrs })
}

fn build_seed_addr_from_cache(config: &P2pConfig) -> Option<iroh::EndpointAddr> {
    let node_id_str = config.seed_iroh_node_id.as_ref()?;
    let id = node_id_str.parse::<iroh::EndpointId>().ok()?;
    let mut addrs = std::collections::BTreeSet::new();
    if let Some(ref relay) = config.seed_iroh_relay_url {
        if let Ok(url) = relay.parse::<iroh::RelayUrl>() {
            addrs.insert(iroh::TransportAddr::Relay(url));
        }
    }
    if let Some(ref addr_list) = config.seed_iroh_addrs {
        for addr_str in addr_list {
            if let Ok(sock) = addr_str.parse::<std::net::SocketAddr>() {
                addrs.insert(iroh::TransportAddr::Ip(sock));
            }
        }
    }
    if addrs.is_empty() {
        return None;
    }
    Some(iroh::EndpointAddr { id, addrs })
}

fn cache_seed_endpoint(
    workspace_path: &str,
    addr: &iroh::EndpointAddr,
    teamclaw_dir: &str,
    config_file_name: &str,
) -> Result<(), String> {
    let mut cfg =
        read_p2p_config(workspace_path, teamclaw_dir, config_file_name)?.unwrap_or_default();
    cfg.seed_iroh_node_id = Some(addr.id.to_string());
    cfg.seed_iroh_relay_url = addr.addrs.iter().find_map(|a| {
        if let iroh::TransportAddr::Relay(url) = a {
            Some(url.to_string())
        } else {
            None
        }
    });
    cfg.seed_iroh_addrs = Some(
        addr.addrs
            .iter()
            .filter_map(|a| {
                if let iroh::TransportAddr::Ip(sock) = a {
                    Some(sock.to_string())
                } else {
                    None
                }
            })
            .collect(),
    );
    write_p2p_config(workspace_path, Some(&cfg), teamclaw_dir, config_file_name)
}

async fn resolve_seed_endpoint(
    seed_url: &str,
    workspace_path: &str,
    config: &P2pConfig,
    teamclaw_dir: &str,
    config_file_name: &str,
) -> Option<iroh::EndpointAddr> {
    match fetch_seed_endpoint(seed_url).await {
        Some(addr) => {
            let _ = cache_seed_endpoint(workspace_path, &addr, teamclaw_dir, config_file_name);
            Some(addr)
        }
        None => {
            eprintln!("[P2P] Seed fetch failed, using cached endpoint");
            build_seed_addr_from_cache(config)
        }
    }
}

async fn collect_sync_peers(
    ep: &Endpoint,
    ticket_peers: &[iroh::EndpointAddr],
    team_dir: &str,
    seed_endpoint: Option<&iroh::EndpointAddr>,
    cached_peer_addrs: &HashMap<String, Vec<String>>,
) -> Vec<iroh::EndpointAddr> {
    let mut peers = Vec::new();
    if let Some(seed) = seed_endpoint {
        peers.push(seed.clone());
    }
    for tp in ticket_peers {
        if !peers.iter().any(|p| p.id == tp.id) {
            peers.push(tp.clone());
        }
    }
    if let Ok(Some(manifest)) = read_members_manifest(team_dir) {
        for member in &manifest.members {
            if peers.iter().any(|p| p.id.to_string() == member.node_id) {
                continue;
            }
            if let Ok(id) = member.node_id.parse::<iroh::EndpointId>() {
                let mut addrs = std::collections::BTreeSet::new();
                if let Some(info) = ep.remote_info(id).await {
                    for addr_info in info.addrs() {
                        addrs.insert(addr_info.addr().clone());
                    }
                }
                if addrs.is_empty() {
                    if let Some(cached) = cached_peer_addrs.get(&member.node_id) {
                        for addr_str in cached {
                            if let Ok(sock) = addr_str.parse::<std::net::SocketAddr>() {
                                addrs.insert(iroh::TransportAddr::Ip(sock));
                            }
                        }
                    }
                }
                if !addrs.is_empty() {
                    peers.push(iroh::EndpointAddr { id, addrs });
                }
            }
        }
    }
    peers
}

// ─── Sync Coordinator ───────────────────────────────────────────────────

async fn run_sync_coordinator(
    doc: iroh_docs::api::Doc,
    endpoint: Endpoint,
    team_dir: String,
    doc_ticket: Option<String>,
    seed_endpoint: Option<iroh::EndpointAddr>,
    mut cached_addrs: HashMap<String, Vec<String>>,
    workspace_path: Option<String>,
    engine: Arc<Mutex<SyncEngine>>,
    event_handler: Option<Arc<dyn P2pEventHandler>>,
    teamclaw_dir: String,
    config_file_name: String,
) {
    use futures_lite::StreamExt;
    use iroh_docs::engine::LiveEvent;
    let seed_ref = seed_endpoint.as_ref();

    let mut ticket_peers: Vec<iroh::EndpointAddr> = Vec::new();
    if let Some(ref ticket_str) = doc_ticket {
        if let Ok(ticket) = ticket_str.trim().parse::<iroh_docs::DocTicket>() {
            ticket_peers = ticket.nodes;
        }
    }

    let ep = endpoint;

    // Do an initial sync shortly after startup
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    {
        let peers =
            collect_sync_peers(&ep, &ticket_peers, &team_dir, seed_ref, &cached_addrs).await;
        if !peers.is_empty() {
            if let Err(e) = doc.start_sync(peers.clone()).await {
                eprintln!("[P2P][sync] Initial sync failed: {}", e);
            } else {
                eprintln!(
                    "[P2P][sync] Initial sync triggered with {} peers",
                    peers.len()
                );
            }
        }
    }

    let mut events = match doc.subscribe().await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[P2P][sync] Failed to subscribe for sync events: {}", e);
            return;
        }
    };

    let mut fallback = tokio::time::interval(std::time::Duration::from_secs(300));
    fallback.tick().await;

    loop {
        tokio::select! {
            event = events.next() => {
                match event {
                    Some(Ok(LiveEvent::NeighborUp(peer_key))) => {
                        let peer_id: iroh::EndpointId = peer_key;
                        let peer_id_str = peer_id.to_string();
                        eprintln!("[P2P][sync] NeighborUp: {}", &peer_id_str[..10]);
                        engine.lock().await.record_neighbor_up(&peer_id_str);
                        if let Some(ref handler) = event_handler {
                            handler.emit_engine_state(&engine.lock().await.snapshot());
                        }
                        if let Some(info) = ep.remote_info(peer_id).await {
                            let mut addrs = std::collections::BTreeSet::new();
                            for addr_info in info.addrs() {
                                addrs.insert(addr_info.addr().clone());
                            }
                            if !addrs.is_empty() {
                                let peer_addr = iroh::EndpointAddr { id: peer_id, addrs };
                                let _ = doc.start_sync(vec![peer_addr]).await;
                            }
                        }
                    }
                    Some(Ok(LiveEvent::SyncFinished(ev))) => {
                        let peer_id_str = ev.peer.to_string();
                        if let Ok(details) = &ev.result {
                            if details.entries_received > 0 || details.entries_sent > 0 {
                                eprintln!(
                                    "[P2P][sync] SyncFinished peer={} sent={} recv={}",
                                    &peer_id_str[..10],
                                    details.entries_sent,
                                    details.entries_received
                                );
                            }
                            engine.lock().await.record_sync_finished(
                                &peer_id_str,
                                details.entries_sent as u64,
                                details.entries_received as u64,
                            );
                            if let Some(ref handler) = event_handler {
                                handler.emit_engine_state(&engine.lock().await.snapshot());
                            }
                        }
                        let peer_id: iroh::EndpointId = ev.peer;
                        if let Some(info) = ep.remote_info(peer_id).await {
                            let addrs: Vec<String> = info.addrs()
                                .filter_map(|a| match a.addr() {
                                    iroh::TransportAddr::Ip(sock) => Some(sock.to_string()),
                                    _ => None,
                                })
                                .collect();
                            if !addrs.is_empty() {
                                cached_addrs.insert(peer_id.to_string(), addrs);
                            }
                        }
                    }
                    Some(Err(e)) => {
                        let err_str = e.to_string();
                        if err_str.contains("closed") || err_str.contains("shutdown") {
                            eprintln!("[P2P][sync] Event stream closed (fatal): {}", e);
                            break;
                        }
                        eprintln!("[P2P][sync] Event stream error (transient): {}", e);
                    }
                    None => {
                        eprintln!("[P2P][sync] Event stream ended");
                        break;
                    }
                    _ => {}
                }
            }
            _ = fallback.tick() => {
                let peers = collect_sync_peers(&ep, &ticket_peers, &team_dir, seed_ref, &cached_addrs).await;
                if !peers.is_empty() {
                    for peer in &peers {
                        let addrs: Vec<String> = peer.addrs.iter()
                            .filter_map(|a| match a {
                                iroh::TransportAddr::Ip(sock) => Some(sock.to_string()),
                                _ => None,
                            })
                            .collect();
                        if !addrs.is_empty() {
                            cached_addrs.insert(peer.id.to_string(), addrs);
                        }
                    }
                    if let Some(ref ws) = workspace_path {
                        if let Ok(fresh_ticket) = doc.share(
                            iroh_docs::api::protocol::ShareMode::Write,
                            iroh_docs::api::protocol::AddrInfoOptions::RelayAndAddresses,
                        ).await {
                            let mut enriched = fresh_ticket;
                            for peer in &peers {
                                if enriched.nodes.len() >= 5 {
                                    break;
                                }
                                if !enriched.nodes.iter().any(|n| n.id == peer.id) {
                                    enriched.nodes.push(peer.clone());
                                }
                            }
                            if let Ok(Some(mut cfg)) = read_p2p_config(ws, &teamclaw_dir, &config_file_name) {
                                cfg.doc_ticket = Some(enriched.to_string());
                                cfg.cached_peer_addrs = cached_addrs.clone();
                                let _ = write_p2p_config(ws, Some(&cfg), &teamclaw_dir, &config_file_name);
                            }
                        } else {
                            if let Ok(Some(mut cfg)) = read_p2p_config(ws, &teamclaw_dir, &config_file_name) {
                                cfg.cached_peer_addrs = cached_addrs.clone();
                                let _ = write_p2p_config(ws, Some(&cfg), &teamclaw_dir, &config_file_name);
                            }
                        }
                    }
                    match doc.start_sync(peers.clone()).await {
                        Ok(()) => eprintln!(
                            "[P2P][sync] Fallback sync with {} peers",
                            peers.len()
                        ),
                        Err(e) => eprintln!("[P2P][sync] Fallback sync failed: {}", e),
                    }
                }
            }
        }
    }
}

// ─── Background sync tasks ─────────────────────────────────────────────

/// Emit the current engine snapshot via the event handler.
async fn emit_engine_state_via(
    event_handler: &Option<Arc<dyn P2pEventHandler>>,
    engine: &Arc<Mutex<SyncEngine>>,
) {
    if let Some(ref handler) = event_handler {
        let snapshot = engine.lock().await.snapshot();
        handler.emit_engine_state(&snapshot);
    }
}

async fn lookup_author_node_id(
    doc: &iroh_docs::api::Doc,
    blobs_store: &iroh_blobs::api::Store,
    author_id: &str,
) -> Option<String> {
    use futures_lite::StreamExt;

    let author_key = format!("_meta/authors/{}", author_id);
    let query = iroh_docs::store::Query::single_latest_per_key()
        .key_prefix(author_key.as_str())
        .build();
    let entries = doc.get_many(query).await.ok()?;
    let mut entries = std::pin::pin!(entries);

    while let Some(Ok(entry)) = entries.next().await {
        if String::from_utf8_lossy(entry.key()) != author_key {
            continue;
        }
        let content = blobs_store
            .blobs()
            .get_bytes(entry.content_hash())
            .await
            .ok()?;
        return Some(String::from_utf8_lossy(&content).to_string());
    }

    None
}

/// Write content to a file path while suppressing fs watcher feedback.
async fn write_and_suppress(
    file_path: &std::path::Path,
    content: &[u8],
    suppressed_paths: &Arc<Mutex<HashMap<std::path::PathBuf, Instant>>>,
) {
    {
        let mut suppressed = suppressed_paths.lock().await;
        suppressed.insert(file_path.to_path_buf(), Instant::now());
    }

    if let Some(parent) = file_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(file_path, content) {
        eprintln!("[P2P] Failed to write '{}': {}", file_path.display(), e);
    }

    let suppressed_clone = suppressed_paths.clone();
    let file_path_clone = file_path.to_path_buf();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let mut suppressed = suppressed_clone.lock().await;
        suppressed.remove(&file_path_clone);
    });
}

/// Watch doc for remote inserts and write them to disk.
async fn doc_to_disk_watcher(
    doc: iroh_docs::api::Doc,
    blobs_store: iroh_blobs::api::Store,
    team_dir: String,
    suppressed_paths: Arc<Mutex<HashMap<std::path::PathBuf, Instant>>>,
    my_role: Arc<Mutex<MemberRole>>,
    my_node_id: String,
    owner_node_id: Option<String>,
    event_handler: Option<Arc<dyn P2pEventHandler>>,
    engine: Arc<Mutex<SyncEngine>>,
    manifest_lock: Arc<RwLock<()>>,
    teamclaw_dir: String,
    config_file_name: String,
    team_repo_dir: String,
) {
    use futures_lite::StreamExt;
    use iroh_docs::engine::LiveEvent;
    use std::collections::HashMap;

    let mut events = match doc.subscribe().await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[P2P] Failed to subscribe to doc events: {}", e);
            return;
        }
    };

    let mut author_to_node: HashMap<String, String> = HashMap::new();
    let mut node_to_role: HashMap<String, MemberRole> = HashMap::new();
    let mut my_last_known_role: Option<MemberRole> = None;

    let query = iroh_docs::store::Query::single_latest_per_key()
        .key_prefix("_meta/authors/")
        .build();
    if let Ok(entries) = doc.get_many(query).await {
        let mut entries = std::pin::pin!(entries);
        while let Some(Ok(entry)) = entries.next().await {
            let author_id = String::from_utf8_lossy(entry.key())
                .trim_start_matches("_meta/authors/")
                .to_string();
            if let Ok(content) = blobs_store.blobs().get_bytes(entry.content_hash()).await {
                let node_id = String::from_utf8_lossy(&content).to_string();
                author_to_node.insert(author_id, node_id);
            }
        }
    }

    {
        let _guard = manifest_lock.read().await;
        if let Ok(Some(manifest)) = read_members_manifest(&team_dir) {
            for member in &manifest.members {
                node_to_role.insert(member.node_id.clone(), member.role.clone());
            }
        }
    }

    let mut pending_content: HashMap<iroh_blobs::Hash, (String, String)> = HashMap::new();
    let mut consecutive_errors: u32 = 0;

    while let Some(event_result) = events.next().await {
        let event = match event_result {
            Ok(e) => {
                consecutive_errors = 0;
                e
            }
            Err(e) => {
                consecutive_errors += 1;
                let err_str = e.to_string();
                if consecutive_errors >= 3
                    || err_str.contains("closed")
                    || err_str.contains("shutdown")
                {
                    eprintln!(
                        "[P2P][doc\u{2192}disk] Fatal event stream error (count={}): {}",
                        consecutive_errors, e
                    );
                    break;
                }
                eprintln!("[P2P][doc\u{2192}disk] Transient event stream error: {}", e);
                continue;
            }
        };

        match event {
            LiveEvent::InsertRemote {
                entry,
                content_status,
                ..
            } => {
                let key = String::from_utf8_lossy(entry.key()).to_string();
                let author_id_str = entry.author().to_string();

                if content_status != iroh_docs::ContentStatus::Complete {
                    pending_content
                        .insert(entry.content_hash(), (key.clone(), author_id_str.clone()));
                    continue;
                }

                // Process complete content
                process_remote_entry(
                    &doc,
                    &blobs_store,
                    &key,
                    &author_id_str,
                    entry.content_hash(),
                    &team_dir,
                    &suppressed_paths,
                    &my_role,
                    &my_node_id,
                    &owner_node_id,
                    &event_handler,
                    &engine,
                    &manifest_lock,
                    &mut author_to_node,
                    &mut node_to_role,
                    &mut my_last_known_role,
                    &teamclaw_dir,
                    &config_file_name,
                    &team_repo_dir,
                )
                .await;
            }
            LiveEvent::ContentReady { hash } => {
                let (key, author_id_str) = if let Some(entry) = pending_content.remove(&hash) {
                    entry
                } else {
                    let query = iroh_docs::store::Query::single_latest_per_key().build();
                    let mut found = None;
                    if let Ok(entries) = doc.get_many(query).await {
                        let mut entries = std::pin::pin!(entries);
                        while let Some(Ok(entry)) = entries.next().await {
                            if entry.content_hash() == hash {
                                found = Some((
                                    String::from_utf8_lossy(entry.key()).to_string(),
                                    entry.author().to_string(),
                                ));
                                break;
                            }
                        }
                    }
                    let Some(entry) = found else {
                        continue;
                    };
                    entry
                };

                process_remote_entry(
                    &doc,
                    &blobs_store,
                    &key,
                    &author_id_str,
                    hash,
                    &team_dir,
                    &suppressed_paths,
                    &my_role,
                    &my_node_id,
                    &owner_node_id,
                    &event_handler,
                    &engine,
                    &manifest_lock,
                    &mut author_to_node,
                    &mut node_to_role,
                    &mut my_last_known_role,
                    &teamclaw_dir,
                    &config_file_name,
                    &team_repo_dir,
                )
                .await;
            }
            _ => {}
        }
    }
    eprintln!(
        "[P2P][doc\u{2192}disk] Event loop exited! pending_content had {} unresolved entries",
        pending_content.len()
    );
}

/// Process a single remote entry (shared between InsertRemote and ContentReady).
#[allow(clippy::too_many_arguments)]
async fn process_remote_entry(
    doc: &iroh_docs::api::Doc,
    blobs_store: &iroh_blobs::api::Store,
    key: &str,
    author_id_str: &str,
    content_hash: iroh_blobs::Hash,
    team_dir: &str,
    suppressed_paths: &Arc<Mutex<HashMap<std::path::PathBuf, Instant>>>,
    my_role: &Arc<Mutex<MemberRole>>,
    my_node_id: &str,
    owner_node_id: &Option<String>,
    event_handler: &Option<Arc<dyn P2pEventHandler>>,
    engine: &Arc<Mutex<SyncEngine>>,
    manifest_lock: &Arc<RwLock<()>>,
    author_to_node: &mut HashMap<String, String>,
    node_to_role: &mut HashMap<String, MemberRole>,
    my_last_known_role: &mut Option<MemberRole>,
    teamclaw_dir: &str,
    config_file_name: &str,
    team_repo_dir: &str,
) {
    // Update author map if this is an _meta/authors/ entry
    if key.starts_with("_meta/authors/") {
        if let Ok(content) = blobs_store.blobs().get_bytes(content_hash).await {
            let node_id = String::from_utf8_lossy(&content).to_string();
            let aid = key.trim_start_matches("_meta/authors/").to_string();
            author_to_node.insert(aid, node_id);
        }
        match resolve_team_entry_path(team_dir, key) {
            Ok(file_path) => {
                if let Ok(content) = blobs_store.blobs().get_bytes(content_hash).await {
                    if is_tombstone(&content) {
                        let _ = std::fs::remove_file(&file_path);
                    } else {
                        write_and_suppress(&file_path, &content, suppressed_paths).await;
                    }
                }
            }
            Err(e) => {
                eprintln!("[P2P] Skipping unsafe doc key '{}': {}", key, e);
            }
        }
        return;
    }

    // Resolve author → node_id
    let mut writer_node_id = author_to_node.get(author_id_str).cloned();
    if writer_node_id.is_none() {
        if let Some(node_id) = lookup_author_node_id(doc, blobs_store, author_id_str).await {
            author_to_node.insert(author_id_str.to_string(), node_id.clone());
            writer_node_id = Some(node_id);
        }
    }

    // Handle _team/left/<node_id>
    if key.starts_with("_team/left/") {
        let leaving_node_id = key.trim_start_matches("_team/left/").to_string();
        let writer_is_member = writer_node_id.as_deref() == Some(leaving_node_id.as_str());
        let we_are_owner = owner_node_id.as_deref() == Some(my_node_id);

        if writer_is_member && we_are_owner {
            let workspace_path = workspace_path_from_team_dir(team_dir, team_repo_dir);
            let leaving_name = node_to_role
                .keys()
                .find(|k| *k == &leaving_node_id)
                .and_then(|_| read_members_manifest(team_dir).ok().flatten())
                .and_then(|m| {
                    m.members
                        .into_iter()
                        .find(|mem| mem.node_id == leaving_node_id)
                        .map(|mem| mem.name)
                })
                .unwrap_or_else(|| leaving_node_id[..8.min(leaving_node_id.len())].to_string());

            match remove_member_from_team(
                &workspace_path,
                team_dir,
                my_node_id,
                &leaving_node_id,
                teamclaw_dir,
                config_file_name,
            ) {
                Ok(()) => {
                    eprintln!("[P2P] Auto-removed departed member: {}", leaving_node_id);
                    {
                        let _guard = manifest_lock.read().await;
                        if let Ok(Some(manifest)) = read_members_manifest(team_dir) {
                            node_to_role.clear();
                            for member in &manifest.members {
                                node_to_role.insert(member.node_id.clone(), member.role.clone());
                            }
                        }
                    }
                    if let Some(ref handler) = event_handler {
                        handler.emit_member_left(&leaving_node_id, &leaving_name);
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[P2P] Failed to auto-remove departed member {}: {}",
                        leaving_node_id, e
                    );
                }
            }
        }

        if let Ok(content) = blobs_store.blobs().get_bytes(content_hash).await {
            match resolve_team_entry_path(team_dir, key) {
                Ok(file_path) => {
                    write_and_suppress(&file_path, &content, suppressed_paths).await;
                }
                Err(e) => {
                    eprintln!("[P2P] Skipping unsafe doc key '{}': {}", key, e);
                }
            }
        }
        return;
    }

    // Handle _team/dissolved
    if key == "_team/dissolved" {
        let we_are_owner = owner_node_id.as_deref() == Some(my_node_id);
        if !we_are_owner {
            eprintln!("[P2P] Team has been dissolved by owner \u{2014} disconnecting");
            if let Some(ref handler) = event_handler {
                handler.emit_team_dissolved();
            }
            // Note: the event loop will break after returning from this function
            // because doc_to_disk_watcher checks for this condition.
        }
        return;
    }

    // Validate _team/members.json writes: only accept from owner or editor
    if key == "_team/members.json" {
        let writer_role = writer_node_id
            .as_ref()
            .and_then(|w| node_to_role.get(w.as_str()).cloned());
        let is_privileged_write = match (&writer_node_id, owner_node_id) {
            (Some(writer), Some(owner)) if writer == owner => true,
            (None, _) if author_to_node.is_empty() => true,
            _ => matches!(
                writer_role,
                Some(MemberRole::Owner) | Some(MemberRole::Editor)
            ),
        };
        if !is_privileged_write {
            eprintln!(
                "[P2P] Rejected members.json write from non-privileged node: {:?}",
                writer_node_id
            );
            return;
        }
        if let Ok(content) = blobs_store.blobs().get_bytes(content_hash).await {
            match resolve_team_entry_path(team_dir, key) {
                Ok(file_path) => {
                    write_and_suppress(&file_path, &content, suppressed_paths).await;
                    let manifest_opt = {
                        let _guard = manifest_lock.read().await;
                        read_members_manifest(team_dir).ok().flatten()
                    };
                    if let Some(manifest) = manifest_opt {
                        node_to_role.clear();
                        for member in &manifest.members {
                            node_to_role.insert(member.node_id.clone(), member.role.clone());
                        }

                        if let Some(ref handler) = event_handler {
                            handler.emit_members_changed();
                        }

                        let still_member = manifest.members.iter().any(|m| m.node_id == my_node_id);
                        let we_are_owner = owner_node_id.as_deref() == Some(my_node_id);
                        if !still_member && !we_are_owner {
                            eprintln!(
                                "[P2P] We have been removed from the team \u{2014} disconnecting"
                            );
                            if let Some(ref handler) = event_handler {
                                handler.emit_kicked(my_node_id);
                            }
                            return;
                        }

                        if let Some(my_member) =
                            manifest.members.iter().find(|m| m.node_id == my_node_id)
                        {
                            let new_role = my_member.role.clone();
                            {
                                let mut current_role = my_role.lock().await;
                                *current_role = new_role.clone();
                            }
                            if let Err(e) = persist_local_role_from_team_dir(
                                team_dir,
                                &new_role,
                                teamclaw_dir,
                                config_file_name,
                                team_repo_dir,
                            ) {
                                eprintln!("[P2P] Failed to persist local role update: {}", e);
                            }
                            if my_last_known_role.as_ref() != Some(&new_role) {
                                if my_last_known_role.is_some() {
                                    if let Some(ref handler) = event_handler {
                                        handler.emit_role_changed(&new_role);
                                    }
                                }
                                *my_last_known_role = Some(new_role);
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[P2P] Skipping unsafe doc key '{}': {}", key, e);
                }
            }
        }
        return;
    }

    // For all other keys: check writer's role
    if let Some(writer) = &writer_node_id {
        let writer_role = node_to_role
            .get(writer)
            .cloned()
            .unwrap_or(MemberRole::Editor);
        if writer_role == MemberRole::Viewer {
            eprintln!("[P2P] Rejected write from viewer {}: {}", writer, key);
            return;
        }
    } else if !author_to_node.is_empty() {
        eprintln!(
            "[P2P] Rejected write from unknown author {}: {}",
            author_id_str, key
        );
        return;
    }

    // Normal write
    match resolve_team_entry_path(team_dir, key) {
        Ok(file_path) => {
            if let Ok(content) = blobs_store.blobs().get_bytes(content_hash).await {
                if is_tombstone(&content) {
                    eprintln!("[P2P][doc\u{2192}disk] Deleting (tombstone): {}", key);
                    let _ = std::fs::remove_file(&file_path);
                } else {
                    eprintln!(
                        "[P2P][doc\u{2192}disk] Writing: {} ({} bytes)",
                        key,
                        content.len()
                    );
                    write_and_suppress(&file_path, &content, suppressed_paths).await;
                    if let Ok(mtime) = std::fs::metadata(&file_path).and_then(|m| m.modified()) {
                        engine
                            .lock()
                            .await
                            .record_file_synced(key.to_string(), mtime);
                    }
                }
            }
            if key.starts_with("_secrets/") {
                if let Some(ref handler) = event_handler {
                    handler.reload_shared_secrets();
                    handler.emit_secrets_changed();
                }
            }
        }
        Err(e) => {
            eprintln!("[P2P] Skipping unsafe doc key '{}': {}", key, e);
        }
    }
}

/// Watch filesystem for local changes and write them to the doc.
async fn disk_to_doc_watcher(
    doc: iroh_docs::api::Doc,
    blobs_store: iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
    team_dir: String,
    suppressed_paths: Arc<Mutex<HashMap<std::path::PathBuf, Instant>>>,
    my_role: Arc<Mutex<MemberRole>>,
    my_node_id: String,
    owner_node_id: Option<String>,
    engine: Arc<Mutex<SyncEngine>>,
    manifest_lock: Arc<RwLock<()>>,
) {
    use notify::{RecursiveMode, Watcher};

    let (tx, mut rx) = tokio::sync::mpsc::channel::<notify::Event>(256);

    let mut watcher = match notify::recommended_watcher(move |res: Result<notify::Event, _>| {
        if let Ok(event) = res {
            let _ = tx.blocking_send(event);
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[P2P] Failed to create fs watcher: {}", e);
            return;
        }
    };

    if let Err(e) = watcher.watch(Path::new(&team_dir), RecursiveMode::Recursive) {
        eprintln!("[P2P] Failed to watch team dir: {}", e);
        return;
    }

    let _watcher = watcher;

    loop {
        let event = match rx.recv().await {
            Some(e) => e,
            None => break,
        };

        let mut events = vec![event];
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        while let Ok(e) = rx.try_recv() {
            events.push(e);
        }

        for event in events {
            match event.kind {
                notify::EventKind::Create(_) | notify::EventKind::Modify(_) => {
                    for path in &event.paths {
                        {
                            let mut suppressed = suppressed_paths.lock().await;
                            if let Some(inserted_at) = suppressed.get(path) {
                                if inserted_at.elapsed().as_secs() < 10 {
                                    continue;
                                }
                                suppressed.remove(path);
                            }
                        }

                        if !path.is_file() {
                            continue;
                        }

                        if let Ok(rel) = path.strip_prefix(&team_dir) {
                            let rel_path = rel.to_string_lossy().to_string();

                            if rel_path == "_team/members.json" {
                                let _guard = manifest_lock.read().await;
                                if let Ok(Some(manifest)) = read_members_manifest(&team_dir) {
                                    if let Some(me) =
                                        manifest.members.iter().find(|m| m.node_id == my_node_id)
                                    {
                                        let mut role = my_role.lock().await;
                                        *role = me.role.clone();
                                    }
                                }
                            }

                            {
                                let role = my_role.lock().await;
                                if *role == MemberRole::Viewer {
                                    continue;
                                }
                            }

                            if rel_path == "_team/members.json" {
                                let is_owner =
                                    owner_node_id.as_deref().is_some_and(|owner| owner == my_node_id);
                                if !is_owner {
                                    continue;
                                }
                            }

                            let key = rel_path;
                            if let Ok(content) = std::fs::read(path) {
                                let content = if content.is_empty() {
                                    vec![b'\n']
                                } else {
                                    content
                                };
                                if let Err(e) = doc.set_bytes(author, key.clone(), content).await {
                                    eprintln!("[P2P] Failed to sync local change '{}': {}", key, e);
                                } else {
                                    if let Ok(mtime) =
                                        std::fs::metadata(path).and_then(|m| m.modified())
                                    {
                                        engine.lock().await.record_file_synced(key.clone(), mtime);
                                    }
                                }
                                if path
                                    .file_name()
                                    .is_some_and(|n| n.eq_ignore_ascii_case("SKILL.md"))
                                {
                                    increment_skills_count(&doc, &blobs_store, author).await;
                                }
                            }
                        }
                    }
                }
                notify::EventKind::Remove(_) => {
                    for path in &event.paths {
                        if let Ok(rel) = path.strip_prefix(&team_dir) {
                            let rel_path = rel.to_string_lossy().to_string();

                            {
                                let role = my_role.lock().await;
                                if *role == MemberRole::Viewer {
                                    continue;
                                }
                            }

                            let key = rel_path;
                            if let Err(e) = doc
                                .set_bytes(author, key.clone(), TOMBSTONE_MARKER.to_vec())
                                .await
                            {
                                eprintln!("[P2P] Failed to write tombstone for '{}': {}", key, e);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

/// Start background tasks for bidirectional sync between doc and filesystem.
#[allow(clippy::too_many_arguments)]
fn start_sync_tasks(
    doc: &iroh_docs::api::Doc,
    author: iroh_docs::AuthorId,
    store: &FsStore,
    team_dir: &str,
    suppressed_paths: Arc<Mutex<HashMap<std::path::PathBuf, Instant>>>,
    my_role: Arc<Mutex<MemberRole>>,
    my_node_id: String,
    owner_node_id: Option<String>,
    event_handler: Option<Arc<dyn P2pEventHandler>>,
    endpoint: Endpoint,
    doc_ticket: Option<String>,
    seed_endpoint: Option<iroh::EndpointAddr>,
    cached_peer_addrs: HashMap<String, Vec<String>>,
    workspace_path: Option<String>,
    engine: Arc<Mutex<SyncEngine>>,
    mut generation_rx: tokio::sync::watch::Receiver<u64>,
    my_generation: u64,
    manifest_lock: Arc<RwLock<()>>,
    teamclaw_dir: &str,
    config_file_name: &str,
    team_repo_dir: &str,
) {
    let doc = doc.clone();
    let store = store.clone();
    let team_dir = team_dir.to_string();
    let teamclaw_dir = teamclaw_dir.to_string();
    let config_file_name = config_file_name.to_string();
    let team_repo_dir = team_repo_dir.to_string();

    tokio::spawn(async move {
        // Initialize engine
        {
            let mut eng = engine.lock().await;
            eng.status = EngineStatus::Connected;
            eng.started_at = Instant::now();
            if let Err(e) = eng.load_peers_from_manifest(&team_dir) {
                eprintln!("[P2P][engine] Failed to load peers from manifest: {}", e);
            }
        }
        emit_engine_state_via(&event_handler, &engine).await;

        let mut restart_count: u32 = 0;

        loop {
            if *generation_rx.borrow() != my_generation {
                eprintln!(
                    "[P2P][engine] Generation {} is stale (current={}), exiting supervisor",
                    my_generation,
                    *generation_rx.borrow()
                );
                let mut eng = engine.lock().await;
                eng.stream_health = StreamHealth::Dead;
                break;
            }

            let _ = generation_rx.borrow_and_update();

            {
                let mut eng = engine.lock().await;
                eng.stream_health = if restart_count == 0 {
                    StreamHealth::Healthy
                } else {
                    StreamHealth::Restarting
                };
                eng.restart_count = restart_count;
            }
            emit_engine_state_via(&event_handler, &engine).await;

            let blobs_store: iroh_blobs::api::Store = store.clone().into();

            // Spawn Task A: doc → disk
            let doc_a = doc.clone();
            let blobs_a = blobs_store.clone();
            let team_dir_a = team_dir.clone();
            let suppressed_a = suppressed_paths.clone();
            let my_role_a = my_role.clone();
            let my_node_id_a = my_node_id.clone();
            let owner_node_id_a = owner_node_id.clone();
            let event_handler_a = event_handler.clone();
            let engine_a = engine.clone();
            let manifest_lock_a = manifest_lock.clone();
            let teamclaw_dir_a = teamclaw_dir.clone();
            let config_file_name_a = config_file_name.clone();
            let team_repo_dir_a = team_repo_dir.clone();
            let task_a = tokio::spawn(async move {
                doc_to_disk_watcher(
                    doc_a,
                    blobs_a,
                    team_dir_a,
                    suppressed_a,
                    my_role_a,
                    my_node_id_a,
                    owner_node_id_a,
                    event_handler_a,
                    engine_a,
                    manifest_lock_a,
                    teamclaw_dir_a,
                    config_file_name_a,
                    team_repo_dir_a,
                )
                .await;
                "doc_to_disk"
            });

            // Spawn Task B: disk → doc
            let doc_b = doc.clone();
            let blobs_b: iroh_blobs::api::Store = store.clone().into();
            let team_dir_b = team_dir.clone();
            let suppressed_b = suppressed_paths.clone();
            let my_role_b = my_role.clone();
            let my_node_id_b = my_node_id.clone();
            let owner_node_id_b = owner_node_id.clone();
            let engine_b = engine.clone();
            let manifest_lock_b = manifest_lock.clone();
            let task_b = tokio::spawn(async move {
                disk_to_doc_watcher(
                    doc_b,
                    blobs_b,
                    author,
                    team_dir_b,
                    suppressed_b,
                    my_role_b,
                    my_node_id_b,
                    owner_node_id_b,
                    engine_b,
                    manifest_lock_b,
                )
                .await;
                "disk_to_doc"
            });

            // Spawn Task C: sync coordinator
            let doc_c = doc.clone();
            let team_dir_c = team_dir.clone();
            let ep_c = endpoint.clone();
            let doc_ticket_c = doc_ticket.clone();
            let seed_ep_c = seed_endpoint.clone();
            let cached_addrs_c = cached_peer_addrs.clone();
            let ws_path_c = workspace_path.clone();
            let engine_c = engine.clone();
            let event_handler_c = event_handler.clone();
            let teamclaw_dir_c = teamclaw_dir.clone();
            let config_file_name_c = config_file_name.clone();
            let task_c = tokio::spawn(async move {
                run_sync_coordinator(
                    doc_c,
                    ep_c,
                    team_dir_c,
                    doc_ticket_c,
                    seed_ep_c,
                    cached_addrs_c,
                    ws_path_c,
                    engine_c,
                    event_handler_c,
                    teamclaw_dir_c,
                    config_file_name_c,
                )
                .await;
                "sync_coordinator"
            });

            let abort_a = task_a.abort_handle();
            let abort_b = task_b.abort_handle();
            let abort_c = task_c.abort_handle();

            let (which, generation_changed) = tokio::select! {
                result = task_a => (result.unwrap_or("doc_to_disk (panic)"), false),
                result = task_b => (result.unwrap_or("disk_to_doc (panic)"), false),
                result = task_c => (result.unwrap_or("sync_coordinator (panic)"), false),
                changed = generation_rx.changed() => {
                    let label = if changed.is_ok() {
                        "generation_changed"
                    } else {
                        "generation_closed"
                    };
                    (label, true)
                }
            };

            abort_a.abort();
            abort_b.abort();
            abort_c.abort();

            if generation_changed || *generation_rx.borrow() != my_generation {
                eprintln!(
                    "[P2P][engine] Generation {} changed while '{}' was running, exiting supervisor",
                    my_generation, which
                );
                let mut eng = engine.lock().await;
                eng.stream_health = StreamHealth::Dead;
                break;
            }

            restart_count += 1;
            eprintln!(
                "[P2P][engine] Task '{}' exited \u{2014} restarting all in 3s (restart #{})",
                which, restart_count
            );

            {
                let mut eng = engine.lock().await;
                eng.stream_health = StreamHealth::Dead;
                eng.restart_count = restart_count;
            }
            emit_engine_state_via(&event_handler, &engine).await;

            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => {}
                _ = generation_rx.changed() => {
                    eprintln!(
                        "[P2P][engine] Generation changed during restart sleep, exiting supervisor"
                    );
                    let mut eng = engine.lock().await;
                    eng.stream_health = StreamHealth::Dead;
                    break;
                }
            }

            {
                let mut eng = engine.lock().await;
                eng.stream_health = StreamHealth::Restarting;
            }
            emit_engine_state_via(&event_handler, &engine).await;
        }

        {
            let mut suppressed = suppressed_paths.lock().await;
            suppressed.clear();
            eprintln!("[P2P][engine] Cleared suppressed paths on supervisor exit");
        }
    });
}

// ─── Authorization ──────────────────────────────────────────────────────

/// Check if a device is authorized to join the team by reading `_team/members.json`.
pub fn check_join_authorization(team_dir: &str, joiner_node_id: &str) -> Result<(), String> {
    match read_members_manifest(team_dir)? {
        None => Err(format!(
            "Not authorized \u{2014} no members manifest found. Share your Device ID with the team owner: {}",
            joiner_node_id
        )),
        Some(manifest) => {
            if manifest.members.iter().any(|m| m.node_id == joiner_node_id) {
                Ok(())
            } else {
                Err(format!(
                    "Not authorized \u{2014} share your Device ID with the team owner: {}",
                    joiner_node_id
                ))
            }
        }
    }
}

// ─── P2P Configuration ────────────────────────────────────────────────────

/// A subscribed P2P ticket entry (kept for backward compat).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pTicketEntry {
    pub ticket: String,
    pub label: String,
    pub added_at: String,
}

/// P2P configuration stored in teamclaw.json under "p2p" key.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct P2pConfig {
    pub enabled: bool,
    #[serde(default)]
    pub tickets: Vec<P2pTicketEntry>,
    #[serde(default)]
    pub publish_enabled: bool,
    pub last_sync_at: Option<String>,
    #[serde(default)]
    pub owner_node_id: Option<String>,
    #[serde(default)]
    pub allowed_members: Vec<TeamMember>,
    #[serde(default)]
    pub namespace_id: Option<String>,
    #[serde(default)]
    pub doc_ticket: Option<String>,
    #[serde(default)]
    pub role: Option<MemberRole>,
    #[serde(default)]
    pub seed_url: Option<String>,
    #[serde(default)]
    pub team_secret: Option<String>,
    #[serde(default)]
    pub seed_iroh_node_id: Option<String>,
    #[serde(default)]
    pub seed_iroh_relay_url: Option<String>,
    #[serde(default)]
    pub seed_iroh_addrs: Option<Vec<String>>,
    #[serde(default)]
    pub cached_peer_addrs: HashMap<String, Vec<String>>,
}

/// Clear the p2p field from teamclaw.json and remove team directory.
pub fn clear_p2p_and_team_dir(
    workspace_path: &str,
    teamclaw_dir: &str,
    config_file_name: &str,
    team_repo_dir: &str,
) -> Result<(), String> {
    let config_path = Path::new(workspace_path)
        .join(teamclaw_dir)
        .join(config_file_name);
    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {}", config_file_name, e))?;
        if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(obj) = json.as_object_mut() {
                obj.remove("p2p");
            }
            std::fs::write(&config_path, serde_json::to_string_pretty(&json).unwrap())
                .map_err(|e| format!("Failed to write {}: {}", config_file_name, e))?;
        }
    }

    let team_dir = format!("{}/{}", workspace_path, team_repo_dir);
    let team_path = Path::new(&team_dir);
    if team_path.exists() {
        if let Err(e) = trash::trash_all_files(team_path) {
            eprintln!("[P2P] Failed to trash team files before removal: {}", e);
        }

        let trash_src = team_path.join(".trash");
        let trash_tmp = Path::new(workspace_path)
            .join(teamclaw_dir)
            .join(".trash-backup");
        let has_trash = trash_src.exists();
        if has_trash {
            let _ = std::fs::rename(&trash_src, &trash_tmp);
        }

        std::fs::remove_dir_all(&team_dir)
            .map_err(|e| format!("Failed to remove team directory: {}", e))?;

        if has_trash {
            std::fs::create_dir_all(&team_dir).ok();
            let _ = std::fs::rename(&trash_tmp, &trash_src);
        }
    }

    Ok(())
}

/// Read P2P config from teamclaw.json in the workspace.
pub fn read_p2p_config(
    workspace_path: &str,
    teamclaw_dir: &str,
    config_file_name: &str,
) -> Result<Option<P2pConfig>, String> {
    let config_path = format!("{}/{}/{}", workspace_path, teamclaw_dir, config_file_name);

    if !Path::new(&config_path).exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read {}: {}", config_file_name, e))?;

    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {}", config_file_name, e))?;

    match json.get("p2p") {
        Some(p2p_val) => {
            let config: P2pConfig = serde_json::from_value(p2p_val.clone())
                .map_err(|e| format!("Failed to parse p2p config: {}", e))?;
            Ok(Some(config))
        }
        None => Ok(None),
    }
}

/// Write P2P config to teamclaw.json, preserving other fields.
pub fn write_p2p_config(
    workspace_path: &str,
    config: Option<&P2pConfig>,
    teamclaw_dir: &str,
    config_file_name: &str,
) -> Result<(), String> {
    let teamclaw_dir_path = format!("{}/{}", workspace_path, teamclaw_dir);
    let _ = std::fs::create_dir_all(&teamclaw_dir_path);
    let config_path = format!("{}/{}", teamclaw_dir_path, config_file_name);

    let mut json: serde_json::Value = if Path::new(&config_path).exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {}", config_file_name, e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse {}: {}", config_file_name, e))?
    } else {
        serde_json::json!({
            "$schema": "https://opencode.ai/config.json"
        })
    };

    if let Some(p2p_config) = config {
        let p2p_val = serde_json::to_value(p2p_config)
            .map_err(|e| format!("Failed to serialize p2p config: {}", e))?;
        json.as_object_mut()
            .ok_or_else(|| format!("{} is not an object", config_file_name))?
            .insert("p2p".to_string(), p2p_val);
    } else {
        json.as_object_mut()
            .ok_or_else(|| format!("{} is not an object", config_file_name))?
            .remove("p2p");
    }

    let content = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write {}: {}", config_file_name, e))
}

// ─── Team Members Manifest ───────────────────────────────────────────────

/// Write the team members manifest to `<team_dir>/_team/members.json`.
pub fn write_members_manifest(
    team_dir: &str,
    owner_node_id: &str,
    members: &[TeamMember],
) -> Result<(), String> {
    let manifest_dir = Path::new(team_dir).join("_team");
    std::fs::create_dir_all(&manifest_dir)
        .map_err(|e| format!("Failed to create _team dir: {}", e))?;

    let manifest = TeamManifest {
        owner_node_id: owner_node_id.to_string(),
        members: members.to_vec(),
    };

    let content = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize manifest: {}", e))?;

    std::fs::write(manifest_dir.join("members.json"), content)
        .map_err(|e| format!("Failed to write members.json: {}", e))
}

/// Read the team members manifest from `<team_dir>/_team/members.json`.
pub fn read_members_manifest(team_dir: &str) -> Result<Option<TeamManifest>, String> {
    let manifest_path = Path::new(team_dir).join("_team").join("members.json");
    if !manifest_path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read members.json: {}", e))?;

    let manifest: TeamManifest = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse members.json: {}", e))?;

    Ok(Some(manifest))
}

// ─── Leave / Disconnect / Dissolve (pure logic) ─────────────────────────

/// Leave the team as a non-owner member.
pub async fn leave_team_for_workspace(
    iroh_state: &IrohState,
    workspace_path: &str,
    teamclaw_dir: &str,
    config_file_name: &str,
    team_repo_dir: &str,
) -> Result<(), String> {
    let config =
        read_p2p_config(workspace_path, teamclaw_dir, config_file_name)?.unwrap_or_default();
    if config.role == Some(MemberRole::Owner) {
        return Err(
            "Team owners cannot leave \u{2014} use Dissolve Team to end the team".to_string(),
        );
    }

    let mut guard = iroh_state.lock().await;
    if let Some(node) = guard.as_mut() {
        let my_node_id = get_node_id(node);
        if let Some(doc) = &node.active_doc {
            let leave_key = format!("_team/left/{}", my_node_id);
            let _ = doc
                .set_bytes(
                    node.author,
                    leave_key,
                    chrono::Utc::now().to_rfc3339().into_bytes(),
                )
                .await;
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        }
        if let Some(doc) = node.active_doc.take() {
            let _ = doc.leave().await;
        }
    }
    drop(guard);

    clear_p2p_and_team_dir(
        workspace_path,
        teamclaw_dir,
        config_file_name,
        team_repo_dir,
    )?;

    Ok(())
}

/// Disconnect from the team (owner checks already done by caller).
pub async fn disconnect_source_for_workspace(
    iroh_state: &IrohState,
    workspace_path: &str,
    teamclaw_dir: &str,
    config_file_name: &str,
    team_repo_dir: &str,
) -> Result<(), String> {
    if let Ok(Some(config)) = read_p2p_config(workspace_path, teamclaw_dir, config_file_name) {
        let guard = iroh_state.lock().await;
        if let Some(node) = guard.as_ref() {
            let my_node_id = get_node_id(node);
            if config.owner_node_id.as_deref() == Some(&my_node_id)
                && config.allowed_members.len() > 1
            {
                return Err(
                    "\u{56e2}\u{961f}\u{8fd8}\u{6709}\u{5176}\u{4ed6}\u{6210}\u{5458}\u{ff0c}\u{8bf7}\u{5148}\u{79fb}\u{9664}\u{6240}\u{6709}\u{6210}\u{5458}\u{6216}\u{8f6c}\u{8ba9}\u{7ba1}\u{7406}\u{5458}\u{89d2}\u{8272}\u{540e}\u{518d}\u{65ad}\u{5f00}".to_string()
                );
            }
        }
        drop(guard);
    }

    let mut guard = iroh_state.lock().await;
    if let Some(node) = guard.as_mut() {
        node.bump_sync_generation();
        if let Some(doc) = node.active_doc.take() {
            let _ = doc.leave().await;
        }
    }
    drop(guard);

    clear_p2p_and_team_dir(
        workspace_path,
        teamclaw_dir,
        config_file_name,
        team_repo_dir,
    )?;

    Ok(())
}

/// Dissolve the team (owner only).
pub async fn dissolve_team_for_workspace(
    iroh_state: &IrohState,
    workspace_path: &str,
    teamclaw_dir: &str,
    config_file_name: &str,
    team_repo_dir: &str,
) -> Result<(), String> {
    let config =
        read_p2p_config(workspace_path, teamclaw_dir, config_file_name)?.unwrap_or_default();
    if config.role != Some(MemberRole::Owner) {
        return Err("Only the team owner can dissolve the team".to_string());
    }

    let mut guard = iroh_state.lock().await;
    if let Some(node) = guard.as_mut() {
        if let Some(doc) = &node.active_doc {
            let _ = doc
                .set_bytes(
                    node.author,
                    "_team/dissolved",
                    chrono::Utc::now().to_rfc3339().into_bytes(),
                )
                .await;
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        if let Some(doc) = node.active_doc.take() {
            let _ = doc.leave().await;
        }
    }
    drop(guard);

    clear_p2p_and_team_dir(
        workspace_path,
        teamclaw_dir,
        config_file_name,
        team_repo_dir,
    )?;

    Ok(())
}

// ─── Team Member Management ─────────────────────────────────────────────

/// Add a member to the team allowlist.
pub fn add_member_to_team(
    workspace_path: &str,
    team_dir: &str,
    caller_node_id: &str,
    member: TeamMember,
    teamclaw_dir: &str,
    config_file_name: &str,
) -> Result<(), String> {
    let mut config =
        read_p2p_config(workspace_path, teamclaw_dir, config_file_name)?.unwrap_or_default();

    let owner_id = config
        .owner_node_id
        .as_deref()
        .ok_or("No team owner configured")?;

    let manifest = read_members_manifest(team_dir).ok().flatten();
    let mut members = if let Some(ref m) = manifest {
        m.members.clone()
    } else {
        config.allowed_members.clone()
    };

    let is_owner = owner_id == caller_node_id;
    let is_manager = members.iter().any(|m| {
        m.node_id == caller_node_id && matches!(m.role, MemberRole::Owner | MemberRole::Manager)
    });
    if !is_owner && !is_manager {
        return Err("Only team owner or manager can add new members".to_string());
    }

    if members.iter().any(|m| m.node_id == member.node_id) {
        return Err("Member already exists".to_string());
    }

    members.push(member);

    config.allowed_members = members.clone();
    write_p2p_config(
        workspace_path,
        Some(&config),
        teamclaw_dir,
        config_file_name,
    )?;
    write_members_manifest(team_dir, owner_id, &members)?;

    Ok(())
}

/// Remove a member from the team allowlist.
pub fn remove_member_from_team(
    workspace_path: &str,
    team_dir: &str,
    caller_node_id: &str,
    target_node_id: &str,
    teamclaw_dir: &str,
    config_file_name: &str,
) -> Result<(), String> {
    let mut config =
        read_p2p_config(workspace_path, teamclaw_dir, config_file_name)?.unwrap_or_default();

    let owner_id = config
        .owner_node_id
        .as_deref()
        .ok_or("No team owner configured")?;
    let manifest = read_members_manifest(team_dir).ok().flatten();
    let mut members = if let Some(ref m) = manifest {
        m.members.clone()
    } else {
        config.allowed_members.clone()
    };

    let is_owner = owner_id == caller_node_id;
    let caller_role = members
        .iter()
        .find(|m| m.node_id == caller_node_id)
        .map(|m| &m.role);
    let is_manager = matches!(
        caller_role,
        Some(MemberRole::Owner) | Some(MemberRole::Manager)
    );
    if !is_owner && !is_manager {
        return Err("Only team owner or manager can remove members".to_string());
    }

    if target_node_id == owner_id {
        return Err("Cannot remove the team owner".to_string());
    }

    if !is_owner {
        let target_role = members
            .iter()
            .find(|m| m.node_id == target_node_id)
            .map(|m| &m.role);
        if matches!(
            target_role,
            Some(MemberRole::Owner) | Some(MemberRole::Manager)
        ) {
            return Err("Managers can only remove editors and viewers".to_string());
        }
    }

    let before_len = members.len();
    members.retain(|m| m.node_id != target_node_id);
    if members.len() == before_len {
        return Err("Member not found".to_string());
    }

    config.allowed_members = members.clone();
    write_p2p_config(
        workspace_path,
        Some(&config),
        teamclaw_dir,
        config_file_name,
    )?;
    write_members_manifest(team_dir, owner_id, &members)?;

    Ok(())
}

/// Update a member's role.
pub fn update_member_role(
    workspace_path: &str,
    team_dir: &str,
    caller_node_id: &str,
    target_node_id: &str,
    new_role: MemberRole,
    teamclaw_dir: &str,
    config_file_name: &str,
) -> Result<(), String> {
    let mut config =
        read_p2p_config(workspace_path, teamclaw_dir, config_file_name)?.unwrap_or_default();

    let owner_id = config
        .owner_node_id
        .as_deref()
        .ok_or("No team owner configured")?;
    let manifest = read_members_manifest(team_dir).ok().flatten();
    let mut members = if let Some(ref m) = manifest {
        m.members.clone()
    } else {
        config.allowed_members.clone()
    };

    let is_owner = owner_id == caller_node_id;
    let caller_role = members
        .iter()
        .find(|m| m.node_id == caller_node_id)
        .map(|m| m.role.clone());
    let is_manager = matches!(
        caller_role,
        Some(MemberRole::Owner) | Some(MemberRole::Manager)
    );

    if !is_owner && !is_manager {
        return Err("Only team owner or manager can change roles".to_string());
    }

    if target_node_id == caller_node_id {
        return Err("Cannot change your own role".to_string());
    }

    if target_node_id == owner_id {
        return Err("Cannot change the owner's role".to_string());
    }

    let target_role = members
        .iter()
        .find(|m| m.node_id == target_node_id)
        .map(|m| m.role.clone());

    if !is_owner {
        if matches!(new_role, MemberRole::Owner | MemberRole::Manager) {
            return Err("Only the owner can promote to manager".to_string());
        }
        if matches!(target_role, Some(MemberRole::Manager)) {
            return Err("Managers cannot change another manager's role".to_string());
        }
    }

    if matches!(new_role, MemberRole::Owner) {
        return Err("Cannot assign the owner role".to_string());
    }

    let member = members
        .iter_mut()
        .find(|m| m.node_id == target_node_id)
        .ok_or("Member not found")?;
    member.role = new_role;

    config.allowed_members = members.clone();
    write_p2p_config(
        workspace_path,
        Some(&config),
        teamclaw_dir,
        config_file_name,
    )?;
    write_members_manifest(team_dir, owner_id, &members)?;

    Ok(())
}

// ─── Reconnect ──────────────────────────────────────────────────────────

/// Reconnect to an existing team document on app restart.
pub async fn reconnect_team_for_workspace(
    node: &mut IrohNode,
    workspace_path: &str,
    event_handler: Option<Arc<dyn P2pEventHandler>>,
    engine: SyncEngineState,
    teamclaw_dir: &str,
    config_file_name: &str,
    team_repo_dir: &str,
) -> Result<(), String> {
    let config = read_p2p_config(workspace_path, teamclaw_dir, config_file_name)?;
    let config = match config {
        Some(c) if c.enabled && c.namespace_id.is_some() => c,
        _ => return Ok(()),
    };

    if node.active_doc.is_some() {
        return Ok(());
    }

    node.bump_sync_generation();

    let my_node_id = get_node_id(node);
    let is_owner = config
        .owner_node_id
        .as_deref()
        .is_some_and(|owner| owner == my_node_id);

    let ticket_str = config.doc_ticket.as_ref().ok_or_else(|| {
        "No saved ticket \u{2014} cannot reconnect. Please rejoin the team.".to_string()
    })?;
    let ticket = ticket_str
        .trim()
        .parse::<iroh_docs::DocTicket>()
        .map_err(|_| "Invalid saved ticket \u{2014} please rejoin the team.".to_string())?;
    let doc = node
        .docs
        .import(ticket)
        .await
        .map_err(|e| format!("Failed to import doc: {}", e))?;

    let team_dir = format!("{}/{}", workspace_path, team_repo_dir);

    if !is_owner {
        match check_join_authorization(&team_dir, &my_node_id) {
            Ok(()) => {}
            Err(ref e) if e.contains("no members manifest found") => {
                eprintln!(
                    "[P2P] Members manifest not found locally, skipping auth check (will sync from peers)"
                );
            }
            Err(auth_err) => {
                let _ = doc.close().await;
                return Err(format!("Reconnect rejected: {}", auth_err));
            }
        }
    }

    let my_role = config.role.clone().unwrap_or({
        if is_owner {
            MemberRole::Owner
        } else {
            MemberRole::Editor
        }
    });

    let temp_engine: Arc<Mutex<SyncEngine>> = Arc::new(Mutex::new(SyncEngine::new()));
    if let Err(e) = reconcile_disk_and_doc(
        &doc,
        &node.store,
        node.author,
        &team_dir,
        is_owner,
        &my_role,
        &temp_engine,
        event_handler.as_deref(),
        team_repo_dir,
    )
    .await
    {
        eprintln!("[P2P] Reconcile failed: {} (continuing)", e);
    }

    let seed_ep = if let Some(ref seed_url) = config.seed_url {
        resolve_seed_endpoint(
            seed_url,
            workspace_path,
            &config,
            teamclaw_dir,
            config_file_name,
        )
        .await
    } else {
        None
    };

    start_sync_tasks(
        &doc,
        node.author,
        &node.store,
        &team_dir,
        node.suppressed_paths.clone(),
        Arc::new(Mutex::new(my_role)),
        my_node_id,
        config.owner_node_id.clone(),
        event_handler,
        node.router.endpoint().clone(),
        config.doc_ticket.clone(),
        seed_ep,
        config.cached_peer_addrs.clone(),
        Some(workspace_path.to_string()),
        engine,
        node.sync_generation_rx.clone(),
        *node.sync_generation_rx.borrow(),
        node.manifest_lock.clone(),
        teamclaw_dir,
        config_file_name,
        team_repo_dir,
    );

    node.active_doc = Some(doc);

    Ok(())
}

// ─── P2P Sync Status ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pSyncStatus {
    pub connected: bool,
    pub role: Option<MemberRole>,
    pub doc_ticket: Option<String>,
    pub namespace_id: Option<String>,
    pub last_sync_at: Option<String>,
    pub members: Vec<TeamMember>,
    pub owner_node_id: Option<String>,
    pub seed_url: Option<String>,
    pub team_secret: Option<String>,
}

// ─── Skills Contribution Tracking ────────────────────────────────────────

async fn increment_skills_count(
    doc: &iroh_docs::api::Doc,
    blobs_store: &iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
) {
    let count_key = format!("_meta/skills_count/{}", author);

    let current: u64 = match doc.get_exact(author, count_key.as_bytes(), false).await {
        Ok(Some(entry)) if entry.content_len() > 0 => {
            match blobs_store.blobs().get_bytes(entry.content_hash()).await {
                Ok(bytes) => String::from_utf8_lossy(&bytes).trim().parse().unwrap_or(0),
                Err(_) => 0,
            }
        }
        _ => 0,
    };

    let new_count = current + 1;
    if let Err(e) = doc
        .set_bytes(author, count_key, new_count.to_string().into_bytes())
        .await
    {
        eprintln!("[P2P] Failed to increment skills count: {}", e);
    }
}

/// Per-member skills contribution stats for the leaderboard.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsContribution {
    pub node_id: String,
    pub author_id: String,
    pub edit_count: u64,
}

/// Query skills leaderboard from the active iroh-docs document.
pub async fn query_skills_leaderboard(node: &IrohNode) -> Result<Vec<SkillsContribution>, String> {
    use futures_lite::StreamExt;
    use std::collections::HashMap;
    use std::pin::pin;

    let doc = node.active_doc.as_ref().ok_or("No active team document")?;
    let blobs_store: iroh_blobs::api::Store = node.store.clone().into();

    let author_query = iroh_docs::store::Query::key_prefix("_meta/authors/").build();
    let entries = doc
        .get_many(author_query)
        .await
        .map_err(|e| format!("Failed to query author meta: {}", e))?;
    let mut entries = pin!(entries);

    let mut author_to_node: HashMap<String, String> = HashMap::new();
    while let Some(Ok(entry)) = entries.next().await {
        let key = String::from_utf8_lossy(entry.key()).to_string();
        if let Some(author_id) = key.strip_prefix("_meta/authors/") {
            if let Ok(content) = blobs_store.blobs().get_bytes(entry.content_hash()).await {
                let node_id = String::from_utf8_lossy(&content).to_string();
                author_to_node.insert(author_id.to_string(), node_id);
            }
        }
    }

    let count_query = iroh_docs::store::Query::key_prefix("_meta/skills_count/").build();
    let entries = doc
        .get_many(count_query)
        .await
        .map_err(|e| format!("Failed to query skills counts: {}", e))?;
    let mut entries = pin!(entries);

    let mut results: Vec<SkillsContribution> = Vec::new();
    while let Some(Ok(entry)) = entries.next().await {
        let key = String::from_utf8_lossy(entry.key()).to_string();
        if let Some(author_id) = key.strip_prefix("_meta/skills_count/") {
            let count: u64 = if entry.content_len() > 0 {
                match blobs_store.blobs().get_bytes(entry.content_hash()).await {
                    Ok(bytes) => String::from_utf8_lossy(&bytes).trim().parse().unwrap_or(0),
                    Err(_) => 0,
                }
            } else {
                0
            };

            let node_id = author_to_node
                .get(author_id)
                .cloned()
                .unwrap_or_else(|| author_id.to_string());

            results.push(SkillsContribution {
                node_id,
                author_id: author_id.to_string(),
                edit_count: count,
            });
        }
    }

    results.sort_by_key(|result| std::cmp::Reverse(result.edit_count));
    Ok(results)
}

/// Get files sync status by comparing local files with doc entries.
pub async fn get_files_sync_status(
    node: &IrohNode,
    team_dir: &str,
) -> Result<Vec<FileSyncStatus>, String> {
    use futures_lite::StreamExt;

    let doc = node
        .active_doc
        .as_ref()
        .ok_or_else(|| "No active team document".to_string())?;

    let query = iroh_docs::store::Query::single_latest_per_key().build();
    let entries = doc
        .get_many(query)
        .await
        .map_err(|e| format!("Failed to query doc: {}", e))?;
    let mut entries = std::pin::pin!(entries);

    let tombstone_hash = iroh_blobs::Hash::new(TOMBSTONE_MARKER);
    let mut doc_hashes: std::collections::HashMap<String, iroh_blobs::Hash> =
        std::collections::HashMap::new();
    while let Some(Ok(entry)) = entries.next().await {
        let key = String::from_utf8_lossy(entry.key()).to_string();
        if entry.content_len() == 0
            || entry.content_hash() == tombstone_hash
            || key.starts_with("_meta/")
            || key.starts_with("_team/")
        {
            continue;
        }
        doc_hashes.insert(key, entry.content_hash());
    }

    let team_path = std::path::Path::new(team_dir);
    let local_files = collect_files(team_path, team_path);
    let mut result = Vec::new();

    for (rel_path, content) in &local_files {
        if rel_path.starts_with("_meta/") || rel_path.starts_with("_team/") {
            continue;
        }

        let local_hash = iroh_blobs::Hash::new(content);
        let status = match doc_hashes.get(rel_path) {
            Some(doc_hash) if *doc_hash == local_hash => SyncFileStatus::Synced,
            Some(_) => SyncFileStatus::Modified,
            None => SyncFileStatus::New,
        };

        result.push(FileSyncStatus {
            path: rel_path.clone(),
            doc_type: String::new(),
            status,
        });
    }

    Ok(result)
}

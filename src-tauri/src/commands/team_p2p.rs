// P2P team sync via iroh-docs - bidirectional document-based file sharing

use super::team_unified::{MemberRole, TeamManifest, TeamMember};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::{Instant, SystemTime};
use tokio::sync::Mutex;

use iroh::{Endpoint, SecretKey};
use iroh_blobs::store::fs::FsStore;
use iroh_blobs::BlobsProtocol;
use iroh_gossip::net::Gossip;

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
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "lowercase")]
pub enum EngineStatus {
    Connected,
    Disconnected,
    Reconnecting,
}

/// Health of the event stream between this node and the iroh document.
#[derive(Serialize, Deserialize, Clone, Debug)]
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
                last_seen_secs_ago: p
                    .last_activity
                    .map(|t| t.elapsed().as_secs())
                    .unwrap_or(0),
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
        self.file_sync_records
            .insert(key, FileSyncRecord { local_mtime_at_sync: mtime });
    }
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
    pub(crate) author: iroh_docs::AuthorId,
    /// Currently active team document (set after create/join)
    pub(crate) active_doc: Option<iroh_docs::api::Doc>,
    /// Paths being written by remote sync — suppresses fs watcher feedback loop
    suppressed_paths: Arc<Mutex<HashSet<std::path::PathBuf>>>,
}

impl IrohNode {
    /// Create and start a new iroh node with persistent storage at the given path.
    pub async fn new(storage_path: &Path) -> Result<Self, String> {
        let blob_path = storage_path.join("blobs");
        let docs_path = storage_path.join("docs");
        std::fs::create_dir_all(&blob_path)
            .map_err(|e| format!("Failed to create iroh blob dir: {}", e))?;
        std::fs::create_dir_all(&docs_path)
            .map_err(|e| format!("Failed to create iroh docs dir: {}", e))?;

        let store = FsStore::load(&blob_path)
            .await
            .map_err(|e| format!("Failed to create iroh blob store: {}", e))?;

        let secret_key = load_or_create_secret_key(storage_path)?;
        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(secret_key)
            .bind()
            .await
            .map_err(|e| format!("Failed to bind iroh endpoint: {}", e))?;

        let gossip = Gossip::builder().spawn(endpoint.clone());

        let blobs_store: iroh_blobs::api::Store = store.clone().into();

        let docs = iroh_docs::protocol::Docs::persistent(docs_path)
            .spawn(endpoint.clone(), blobs_store.clone(), gossip.clone())
            .await
            .map_err(|e| format!("Failed to start docs engine: {}", e))?;

        // Get or create a persistent default author
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

        Ok(IrohNode {
            endpoint,
            store,
            gossip,
            docs,
            router,
            author,
            active_doc: None,
            suppressed_paths: Arc::new(Mutex::new(HashSet::new())),
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
    pub async fn shutdown(self) {
        self.router.shutdown().await.ok();
    }
}

/// Get the user's home directory, falling back to /tmp.
fn dirs_or_default() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
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

#[tauri::command]
pub async fn get_device_info(
    iroh_state: tauri::State<'_, IrohState>,
) -> Result<DeviceInfo, String> {
    let guard = iroh_state.lock().await;
    let node = guard.as_ref().ok_or("P2P node not running")?;
    let mut info = get_device_metadata();
    info.node_id = get_node_id(node);
    Ok(info)
}

#[tauri::command]
pub async fn get_device_node_id(iroh_state: tauri::State<'_, IrohState>) -> Result<String, String> {
    let guard = iroh_state.lock().await;
    let node = guard.as_ref().ok_or("P2P node not running")?;
    Ok(get_node_id(node))
}

// ─── File Helpers ────────────────────────────────────────────────────────

/// Collect all files recursively from a directory, returning (relative_path, content) pairs.
const MAX_SYNC_FILE_SIZE: u64 = 50 * 1024 * 1024; // 50 MB
const MAX_TOTAL_SYNC_SIZE: u64 = 500 * 1024 * 1024; // 500 MB total

fn collect_files(base: &Path, dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut total_size: u64 = 0;
    if !dir.exists() {
        return files;
    }
    'outer: for entry in walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            // Skip files larger than MAX_SYNC_FILE_SIZE to avoid memory spikes
            if let Ok(meta) = entry.metadata() {
                if meta.len() > MAX_SYNC_FILE_SIZE {
                    eprintln!(
                        "[P2P] Skipping large file ({} MB): {}",
                        meta.len() / (1024 * 1024),
                        entry.path().display()
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
            if let Ok(content) = std::fs::read(entry.path()) {
                if let Ok(rel) = entry.path().strip_prefix(base) {
                    total_size += content.len() as u64;
                    files.push((rel.to_string_lossy().to_string(), content));
                }
            }
        }
    }
    files
}

// Re-use shared scaffold from team.rs
use super::team::scaffold_team_dir;

// ─── Create / Join (iroh-docs) ──────────────────────────────────────────

/// Create a team: create an iroh-docs document, write files, return a stable DocTicket.
pub async fn create_team(
    node: &mut IrohNode,
    team_dir: &str,
    workspace_path: &str,
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
    team_name: Option<String>,
    owner_name: Option<String>,
    owner_email: Option<String>,
    app_handle: Option<tauri::AppHandle>,
) -> Result<String, String> {
    scaffold_team_dir(team_dir)?;

    // Write LLM config to .teamclaw/teamclaw.json
    let llm_config =
        crate::commands::team::build_llm_config(llm_base_url, llm_model, llm_model_name);
    crate::commands::team::write_llm_config(workspace_path, Some(&llm_config))?;
    println!(
        "[Team P2P] Wrote LLM config to {}/{}",
        super::TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME
    );

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
        label: info.hostname.clone(),
        platform: info.platform,
        arch: info.arch,
        hostname: info.hostname,
        added_at: chrono::Utc::now().to_rfc3339(),
    };

    write_members_manifest(team_dir, &node_id, &[owner_member.clone()])?;

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
        app_handle,
        node.router.endpoint().clone(),
        None,           // ticket not needed for owner — peers connect to us
        None,           // seed_endpoint resolved later on reconnect
        HashMap::new(), // no cached peers yet for new team
        Some(workspace_path.to_string()),
    );

    node.active_doc = Some(doc);

    // Update P2P config with ownership
    let mut config = read_p2p_config(workspace_path)?.unwrap_or_default();
    config.enabled = true;
    config.publish_enabled = true;
    config.owner_node_id = Some(node_id);
    config.allowed_members = vec![owner_member];
    config.namespace_id = Some(namespace_id);
    config.doc_ticket = Some(ticket_str.clone());
    config.role = Some(MemberRole::Owner);
    write_p2p_config(workspace_path, Some(&config))?;

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
    app_handle: Option<tauri::AppHandle>,
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
    // Authorization is deferred: the ticket itself grants initial access.
    // Full member-list authorization is enforced on reconnect (when the
    // manifest has had time to sync to disk).
    let joiner_node_id = get_node_id(node);
    let mut file_count = 0;
    let mut auth_status = "pending"; // "authorized" | "rejected" | "pending"
    for attempt in 1..=10 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        file_count = write_doc_entries_to_disk(&doc, &node.store, team_dir)
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
                // Keep waiting — manifest hasn't synced yet
            }
            Err(ref auth_err) => {
                eprintln!("[P2P] Authorization denied: {}", auth_err);
                auth_status = "rejected";
                break;
            }
        }

        // If we've synced some files, no need to wait the full 10s
        if file_count > 0 && attempt >= 3 {
            eprintln!("[P2P] Got {} files after {}s, proceeding", file_count, attempt);
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

    // MCP configs are auto-discovered via hot reload from teamclaw-team/.mcp/

    let namespace_id = doc.id().to_string();

    // Read joiner's role and owner_node_id from manifest (single read)
    let manifest = read_members_manifest(team_dir)?;
    let joiner_role = manifest
        .as_ref()
        .and_then(|m| {
            m.members
                .iter()
                .find(|mem| mem.node_id == joiner_node_id)
                .map(|mem| mem.role.clone())
        })
        .unwrap_or(MemberRole::Editor);
    let manifest_owner = manifest.map(|m| m.owner_node_id);

    // Reconcile offline edits (primarily for re-join scenarios)
    let is_owner = manifest_owner.as_deref() == Some(&joiner_node_id);
    if let Err(e) = reconcile_disk_and_doc(
        &doc,
        &node.store,
        node.author,
        team_dir,
        is_owner,
        &joiner_role,
    )
    .await
    {
        eprintln!("[P2P] Reconcile failed: {} (continuing)", e);
    }

    // Resolve seed endpoint if seed_url is configured
    let existing_config = read_p2p_config(workspace_path)?.unwrap_or_default();
    let seed_ep = if let Some(ref seed_url) = existing_config.seed_url {
        resolve_seed_endpoint(seed_url, workspace_path, &existing_config).await
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
        app_handle,
        node.router.endpoint().clone(),
        Some(ticket_str.to_string()),
        seed_ep,
        HashMap::new(), // no cached peers yet for new joiner
        Some(workspace_path.to_string()),
    );

    node.active_doc = Some(doc);

    // Save config
    let mut config = read_p2p_config(workspace_path)?.unwrap_or_default();
    config.enabled = true;
    config.namespace_id = Some(namespace_id);
    config.doc_ticket = Some(ticket_str.to_string());

    config.role = Some(joiner_role);
    config.owner_node_id = manifest_owner;
    config.last_sync_at = Some(chrono::Utc::now().to_rfc3339());
    write_p2p_config(workspace_path, Some(&config))?;

    Ok(format!("Synced {} files from team drive", file_count))
}

/// Read all doc entries and write them to disk. Returns file count.
async fn write_doc_entries_to_disk(
    doc: &iroh_docs::api::Doc,
    store: &FsStore,
    team_dir: &str,
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
    while let Some(entry_result) = entries.next().await {
        let entry = entry_result.map_err(|e| format!("Failed to read entry: {}", e))?;
        let key = String::from_utf8_lossy(entry.key()).to_string();
        let content_hash = entry.content_hash();

        let content = blobs_store
            .blobs()
            .get_bytes(content_hash)
            .await
            .map_err(|e| format!("Failed to read content for '{}': {}", key, e))?;

        // Skip tombstones (deleted files)
        if is_tombstone(&content) {
            let file_path = team_path.join(&key);
            if file_path.exists() {
                let _ = std::fs::remove_file(&file_path);
            }
            continue;
        }

        let file_path = team_path.join(&key);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&file_path, &content)
            .map_err(|e| format!("Failed to write '{}': {}", key, e))?;
        file_count += 1;
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
) -> Result<(usize, usize), String> {
    use futures_lite::StreamExt;

    let blobs_store: iroh_blobs::api::Store = store.clone().into();
    let team_path = Path::new(team_dir);
    let mut uploaded = 0usize;
    let mut downloaded = 0usize;

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

        if let Some(local_content) = local_map.remove(&key) {
            // Check if remote is a tombstone — if so, delete local file
            if let Ok(remote_content) = blobs_store.blobs().get_bytes(entry.content_hash()).await {
                if is_tombstone(&remote_content) {
                    let file_path = team_path.join(&key);
                    eprintln!("[P2P][reconcile] Remote tombstone -> deleting local: {}", key);
                    let _ = std::fs::remove_file(&file_path);
                    continue;
                }
            }
            // Both exist — check if they differ
            let local_hash = iroh_blobs::Hash::new(&local_content);
            if local_hash != entry.content_hash() {
                // Local wins: upload local version
                if *role != MemberRole::Viewer {
                    if key == "_team/members.json" && !is_owner && *role == MemberRole::Viewer {
                        continue;
                    }
                    let content = if local_content.is_empty() {
                        vec![b'\n']
                    } else {
                        local_content
                    };
                    if let Err(e) = doc.set_bytes(author, key.clone(), content).await {
                        eprintln!("[P2P][reconcile] Failed to upload {}: {}", key, e);
                    } else {
                        eprintln!("[P2P][reconcile] Conflict -> local wins: {}", key);
                        uploaded += 1;
                    }
                }
            }
        } else {
            // Remote only — download to disk (or delete if tombstone)
            if let Ok(content) = blobs_store.blobs().get_bytes(entry.content_hash()).await {
                if is_tombstone(&content) {
                    continue;
                }
                let file_path = team_path.join(&key);
                if let Some(parent) = file_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::write(&file_path, &content) {
                    eprintln!("[P2P][reconcile] Failed to write {}: {}", key, e);
                } else {
                    downloaded += 1;
                }
            }
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
/// Used when the user manually triggers a sync or after file changes.
pub async fn publish_team_drive(
    node: &IrohNode,
    team_dir: &str,
    workspace_path: &str,
) -> Result<String, String> {
    // Check caller's role
    let config = read_p2p_config(workspace_path)?.unwrap_or_default();
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
/// Used when a ticket is compromised and needs regeneration.
pub async fn rotate_namespace(
    node: &mut IrohNode,
    team_dir: &str,
    workspace_path: &str,
) -> Result<String, String> {
    // Close existing doc
    if let Some(old_doc) = node.active_doc.take() {
        let _ = old_doc.leave().await;
    }

    // Re-create as owner
    create_team(
        node,
        team_dir,
        workspace_path,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
}

// ─── Background Sync Tasks ──────────────────────────────────────────────

/// Fetch the seed node's iroh EndpointAddr via its HTTP API.
/// Returns None on any failure (timeout, parse error, seed unreachable).
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

/// Build seed EndpointAddr from cached config fields.
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

/// Save seed endpoint info to P2pConfig cache.
fn cache_seed_endpoint(workspace_path: &str, addr: &iroh::EndpointAddr) -> Result<(), String> {
    let mut cfg = read_p2p_config(workspace_path)?.unwrap_or_default();
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
    write_p2p_config(workspace_path, Some(&cfg))
}

/// Resolve the seed endpoint: try fresh HTTP fetch, fallback to cache.
async fn resolve_seed_endpoint(
    seed_url: &str,
    workspace_path: &str,
    config: &P2pConfig,
) -> Option<iroh::EndpointAddr> {
    match fetch_seed_endpoint(seed_url).await {
        Some(addr) => {
            let _ = cache_seed_endpoint(workspace_path, &addr);
            Some(addr)
        }
        None => {
            eprintln!("[P2P] Seed fetch failed, using cached endpoint");
            build_seed_addr_from_cache(config)
        }
    }
}

/// Collect known peer addresses from ticket + endpoint cache + members manifest.
async fn collect_sync_peers(
    ep: &Endpoint,
    ticket_peers: &[iroh::EndpointAddr],
    team_dir: &str,
    seed_endpoint: Option<&iroh::EndpointAddr>,
    cached_peer_addrs: &HashMap<String, Vec<String>>,
) -> Vec<iroh::EndpointAddr> {
    let mut peers = Vec::new();
    // 1. Seed (highest priority — always online)
    if let Some(seed) = seed_endpoint {
        peers.push(seed.clone());
    }
    // 2. Ticket peers (owner's address)
    for tp in ticket_peers {
        if !peers.iter().any(|p| p.id == tp.id) {
            peers.push(tp.clone());
        }
    }
    // 3. Members from manifest — try live info first, fall back to cached addrs
    if let Ok(Some(manifest)) = read_members_manifest(team_dir) {
        for member in &manifest.members {
            if peers.iter().any(|p| p.id.to_string() == member.node_id) {
                continue;
            }
            if let Ok(id) = member.node_id.parse::<iroh::EndpointId>() {
                // Try live endpoint info first
                let mut addrs = std::collections::BTreeSet::new();
                if let Some(info) = ep.remote_info(id).await {
                    for addr_info in info.addrs() {
                        addrs.insert(addr_info.addr().clone());
                    }
                }
                // Fall back to cached addresses if live info is empty
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

/// Start background tasks for bidirectional sync between doc and filesystem.
fn start_sync_tasks(
    doc: &iroh_docs::api::Doc,
    author: iroh_docs::AuthorId,
    store: &FsStore,
    team_dir: &str,
    suppressed_paths: Arc<Mutex<HashSet<std::path::PathBuf>>>,
    my_role: Arc<Mutex<MemberRole>>,
    my_node_id: String,
    owner_node_id: Option<String>,
    app_handle: Option<tauri::AppHandle>,
    endpoint: Endpoint,
    doc_ticket: Option<String>,
    seed_endpoint: Option<iroh::EndpointAddr>,
    cached_peer_addrs: HashMap<String, Vec<String>>,
    workspace_path: Option<String>,
) {
    let blobs_store: iroh_blobs::api::Store = store.clone().into();
    let team_dir_a = team_dir.to_string();
    let doc_a = doc.clone();
    let suppressed_a = suppressed_paths.clone();

    // Task A: remote doc changes → disk
    let my_node_id_a = my_node_id.clone();
    let owner_node_id_a = owner_node_id.clone();
    tokio::spawn(async move {
        doc_to_disk_watcher(
            doc_a,
            blobs_store,
            team_dir_a,
            suppressed_a,
            my_node_id_a,
            owner_node_id_a,
            app_handle,
        )
        .await;
    });

    // Task B: local disk changes → doc (with blob store for skills counting)
    let doc_b = doc.clone();
    let blobs_store_b: iroh_blobs::api::Store = store.clone().into();
    let team_dir_b = team_dir.to_string();
    let suppressed_b = suppressed_paths;
    tokio::spawn(async move {
        disk_to_doc_watcher(
            doc_b,
            blobs_store_b,
            author,
            team_dir_b,
            suppressed_b,
            my_role,
            my_node_id,
            owner_node_id,
        )
        .await;
    });

    // Task C: event-driven + fallback periodic sync.
    // Listens for NeighborUp/SyncFinished events to register new peers with gossip,
    // and falls back to a periodic sync every 5 minutes for resilience.
    let doc_c = doc.clone();
    let _doc_c2 = doc.clone();
    let team_dir_c = team_dir.to_string();
    let seed_ep = seed_endpoint;
    let mut cached_addrs = cached_peer_addrs;
    let ws_path = workspace_path;
    tokio::spawn(async move {
        use futures_lite::StreamExt;
        use iroh_docs::engine::LiveEvent;
        let seed_ref = seed_ep.as_ref();

        // Parse ticket peers (the owner's address for joiners).
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
                collect_sync_peers(&ep, &ticket_peers, &team_dir_c, seed_ref, &cached_addrs).await;
            if !peers.is_empty() {
                if let Err(e) = doc_c.start_sync(peers.clone()).await {
                    eprintln!("[P2P][sync] Initial sync failed: {}", e);
                } else {
                    eprintln!(
                        "[P2P][sync] Initial sync triggered with {} peers",
                        peers.len()
                    );
                }
            }
        }

        // Subscribe to doc events for NeighborUp
        let mut events = match doc_c.subscribe().await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[P2P][sync] Failed to subscribe for sync events: {}", e);
                return;
            }
        };

        // Fallback timer: sync every 5 minutes
        let mut fallback = tokio::time::interval(std::time::Duration::from_secs(300));
        fallback.tick().await; // skip first immediate tick

        loop {
            tokio::select! {
                event = events.next() => {
                    match event {
                        Some(Ok(LiveEvent::NeighborUp(peer_key))) => {
                            // New peer appeared in gossip — trigger sync with them
                            let peer_id: iroh::EndpointId = peer_key;
                            eprintln!("[P2P][sync] NeighborUp: {}", &peer_id.to_string()[..10]);
                            if let Some(info) = ep.remote_info(peer_id).await {
                                let mut addrs = std::collections::BTreeSet::new();
                                for addr_info in info.addrs() {
                                    addrs.insert(addr_info.addr().clone());
                                }
                                if !addrs.is_empty() {
                                    let peer_addr = iroh::EndpointAddr { id: peer_id, addrs };
                                    let _ = doc_c.start_sync(vec![peer_addr]).await;
                                }
                            }
                        }
                        Some(Ok(LiveEvent::SyncFinished(ev))) => {
                            if let Ok(details) = &ev.result {
                                if details.entries_received > 0 || details.entries_sent > 0 {
                                    eprintln!(
                                        "[P2P][sync] SyncFinished peer={} sent={} recv={}",
                                        &ev.peer.to_string()[..10],
                                        details.entries_sent,
                                        details.entries_received
                                    );
                                }
                            }
                            // Cache the peer's address for future LAN reconnection
                            let peer_id: iroh::EndpointId = ev.peer;
                            if let Some(info) = ep.remote_info(peer_id).await {
                                let addrs: Vec<String> = info.addrs()
                                    .filter_map(|a| match a.addr() {
                                        iroh::TransportAddr::Ip(sock) => Some(sock.to_string()),
                                        _ => None, // skip relay addrs
                                    })
                                    .collect();
                                if !addrs.is_empty() {
                                    cached_addrs.insert(peer_id.to_string(), addrs);
                                }
                            }
                        }
                        Some(Err(_)) | None => {
                            // Stream ended or error — break out
                            eprintln!("[P2P][sync] Event stream ended");
                            break;
                        }
                        _ => {} // Ignore other events
                    }
                }
                _ = fallback.tick() => {
                    // Fallback: sync with all known peers every 5 minutes
                    let peers = collect_sync_peers(&ep, &ticket_peers, &team_dir_c, seed_ref, &cached_addrs).await;
                    if !peers.is_empty() {
                        // Update cache from collected peers (IP addrs only)
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
                        // Refresh ticket with a few known peers so new joiners
                        // can connect to ANY online member, not just the owner.
                        // Cap at 5 peers to keep the ticket string small.
                        if let Some(ref ws) = ws_path {
                            if let Ok(fresh_ticket) = doc_c.share(
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
                                if let Ok(Some(mut cfg)) = read_p2p_config(ws) {
                                    cfg.doc_ticket = Some(enriched.to_string());
                                    cfg.cached_peer_addrs = cached_addrs.clone();
                                    let _ = write_p2p_config(ws, Some(&cfg));
                                }
                            } else {
                                // Ticket refresh failed — still persist cached addrs
                                if let Ok(Some(mut cfg)) = read_p2p_config(ws) {
                                    cfg.cached_peer_addrs = cached_addrs.clone();
                                    let _ = write_p2p_config(ws, Some(&cfg));
                                }
                            }
                        }
                        match doc_c.start_sync(peers.clone()).await {
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
    });
}

/// Write content to a file path while suppressing fs watcher feedback.
async fn write_and_suppress(
    file_path: &std::path::Path,
    content: &[u8],
    suppressed_paths: &Arc<Mutex<HashSet<std::path::PathBuf>>>,
) {
    {
        let mut suppressed = suppressed_paths.lock().await;
        suppressed.insert(file_path.to_path_buf());
    }

    if let Some(parent) = file_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(file_path, content) {
        eprintln!("[P2P] Failed to write '{}': {}", file_path.display(), e);
    }

    // Remove suppression after a delay (3s to avoid feedback loops on rapid saves)
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
    suppressed_paths: Arc<Mutex<HashSet<std::path::PathBuf>>>,
    my_node_id: String,
    owner_node_id: Option<String>,
    app_handle: Option<tauri::AppHandle>,
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

    // Build AuthorId → NodeId map from _meta/authors/* entries
    let mut author_to_node: HashMap<String, String> = HashMap::new();
    let mut node_to_role: HashMap<String, MemberRole> = HashMap::new();
    let mut my_last_known_role: Option<MemberRole> = None;

    // Pre-load author map from doc
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

    // Pre-load role map from _team/members.json
    if let Ok(Some(manifest)) = read_members_manifest(&team_dir) {
        for member in &manifest.members {
            node_to_role.insert(member.node_id.clone(), member.role.clone());
        }
    }

    // Track entries whose content hasn't been downloaded yet.
    // When ContentReady fires we do an O(1) lookup instead of scanning all entries.
    let mut pending_content: HashMap<iroh_blobs::Hash, (String, String)> = HashMap::new();

    while let Some(event_result) = events.next().await {
        let event = match event_result {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[P2P][doc→disk] Event stream error: {}", e);
                continue;
            }
        };

        match event {
            LiveEvent::InsertRemote {
                entry,
                content_status,
                ..
            } => {
                let key_preview = String::from_utf8_lossy(entry.key()).to_string();
                eprintln!(
                    "[P2P][doc→disk] InsertRemote key={} status={:?} len={}",
                    key_preview,
                    content_status,
                    entry.content_len()
                );
                let key = key_preview;
                let author_id_str = entry.author().to_string();

                if content_status != iroh_docs::ContentStatus::Complete {
                    // Content not yet downloaded — remember it for ContentReady
                    pending_content.insert(
                        entry.content_hash(),
                        (key.clone(), author_id_str.clone()),
                    );
                    eprintln!(
                        "[P2P][doc→disk] Queued for ContentReady: {} (pending={})",
                        key,
                        pending_content.len()
                    );
                    continue;
                }

                // Update author map if this is an _meta/authors/ entry
                if key.starts_with("_meta/authors/") {
                    if let Ok(content) = blobs_store.blobs().get_bytes(entry.content_hash()).await {
                        let node_id = String::from_utf8_lossy(&content).to_string();
                        let aid = key.trim_start_matches("_meta/authors/").to_string();
                        author_to_node.insert(aid, node_id);
                    }
                    // Still write to disk
                    let file_path = Path::new(&team_dir).join(&key);
                    if let Ok(content) = blobs_store.blobs().get_bytes(entry.content_hash()).await {
                        if is_tombstone(&content) {
                            let _ = std::fs::remove_file(&file_path);
                        } else {
                            write_and_suppress(&file_path, &content, &suppressed_paths).await;
                        }
                    }
                    continue;
                }

                // Resolve author → node_id
                let writer_node_id = author_to_node.get(&author_id_str).cloned();

                // Handle _team/left/<node_id>: member voluntarily left the team
                if key.starts_with("_team/left/") {
                    let leaving_node_id = key.trim_start_matches("_team/left/").to_string();
                    // Verify the writer IS the departing member (not someone forging a leave)
                    let writer_is_member =
                        writer_node_id.as_deref() == Some(leaving_node_id.as_str());
                    // Only auto-remove if WE are the owner
                    let we_are_owner = owner_node_id.as_deref() == Some(my_node_id.as_str());

                    if writer_is_member && we_are_owner {
                        // workspace_path = team_dir without trailing /teamclaw-team
                        let workspace_path = team_dir
                            .strip_suffix(&format!("/{}", super::TEAM_REPO_DIR))
                            .unwrap_or(&team_dir)
                            .to_string();
                        // Look up member name before removing (for notification)
                        let leaving_name = node_to_role
                            .keys()
                            .find(|k| *k == &leaving_node_id)
                            .and_then(|_| read_members_manifest(&team_dir).ok().flatten())
                            .and_then(|m| {
                                m.members
                                    .into_iter()
                                    .find(|mem| mem.node_id == leaving_node_id)
                                    .map(|mem| mem.name)
                            })
                            .unwrap_or_else(|| {
                                leaving_node_id[..8.min(leaving_node_id.len())].to_string()
                            });

                        match remove_member_from_team(
                            &workspace_path,
                            &team_dir,
                            &my_node_id,
                            &leaving_node_id,
                        ) {
                            Ok(()) => {
                                eprintln!(
                                    "[P2P] Auto-removed departed member: {}",
                                    leaving_node_id
                                );
                                // Refresh role cache
                                if let Ok(Some(manifest)) = read_members_manifest(&team_dir) {
                                    node_to_role.clear();
                                    for member in &manifest.members {
                                        node_to_role
                                            .insert(member.node_id.clone(), member.role.clone());
                                    }
                                }
                                // Emit Tauri event so the owner's UI can show a notification
                                if let Some(ref app) = app_handle {
                                    use tauri::Emitter;
                                    let _ = app.emit(
                                        "team:member-left",
                                        serde_json::json!({
                                            "nodeId": leaving_node_id,
                                            "name": leaving_name,
                                        }),
                                    );
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

                    // Write tombstone file to disk regardless
                    if let Ok(content) = blobs_store.blobs().get_bytes(entry.content_hash()).await {
                        let file_path = Path::new(&team_dir).join(&key);
                        write_and_suppress(&file_path, &content, &suppressed_paths).await;
                    }
                    continue;
                }

                // Handle _team/dissolved: owner dissolved the team
                if key == "_team/dissolved" {
                    let we_are_owner = owner_node_id.as_deref() == Some(my_node_id.as_str());
                    if !we_are_owner {
                        eprintln!("[P2P] Team has been dissolved by owner — disconnecting");
                        if let Some(ref app) = app_handle {
                            use tauri::Emitter;
                            let _ = app.emit("team:dissolved", serde_json::json!({}));
                        }
                        // Stop watching — the frontend will handle cleanup
                        break;
                    }
                    continue;
                }

                // Validate _team/members.json writes: only accept from owner or editor
                if key == "_team/members.json" {
                    let writer_role = writer_node_id
                        .as_ref()
                        .and_then(|w| node_to_role.get(w.as_str()).cloned());
                    let is_privileged_write = match (&writer_node_id, &owner_node_id) {
                        (Some(writer), Some(owner)) if writer == owner => true,
                        (None, _) if author_to_node.is_empty() => true, // bootstrap: no authors known yet
                        _ => matches!(writer_role, Some(MemberRole::Owner) | Some(MemberRole::Editor)),
                    };
                    if !is_privileged_write {
                        eprintln!(
                            "[P2P] Rejected members.json write from non-privileged node: {:?}",
                            writer_node_id
                        );
                        continue;
                    }
                    // Write to disk and update role cache
                    if let Ok(content) = blobs_store.blobs().get_bytes(entry.content_hash()).await {
                        let file_path = Path::new(&team_dir).join(&key);
                        write_and_suppress(&file_path, &content, &suppressed_paths).await;
                        // Refresh role cache
                        if let Ok(Some(manifest)) = read_members_manifest(&team_dir) {
                            node_to_role.clear();
                            for member in &manifest.members {
                                node_to_role.insert(member.node_id.clone(), member.role.clone());
                            }

                            // Notify UI that the member list changed
                            if let Some(ref app) = app_handle {
                                use tauri::Emitter;
                                let _ = app.emit("team:members-changed", serde_json::json!({}));
                            }

                            // Check if we've been kicked (not in the list anymore)
                            let still_member =
                                manifest.members.iter().any(|m| m.node_id == my_node_id);
                            let we_are_owner =
                                owner_node_id.as_deref() == Some(my_node_id.as_str());
                            if !still_member && !we_are_owner {
                                eprintln!(
                                    "[P2P] We have been removed from the team — disconnecting"
                                );
                                if let Some(ref app) = app_handle {
                                    use tauri::Emitter;
                                    let _ = app.emit(
                                        "team:kicked",
                                        serde_json::json!({
                                            "nodeId": my_node_id,
                                        }),
                                    );
                                }
                                // Stop watching — the frontend will handle cleanup
                                break;
                            }

                            // Check if our role changed and notify (only when it actually changes)
                            if let Some(my_member) =
                                manifest.members.iter().find(|m| m.node_id == my_node_id)
                            {
                                let new_role = my_member.role.clone();
                                if my_last_known_role.as_ref() != Some(&new_role) {
                                    if my_last_known_role.is_some() {
                                        // Only notify after the first load (skip initial set)
                                        if let Some(ref app) = app_handle {
                                            use tauri::Emitter;
                                            let _ = app.emit(
                                                "team:role-changed",
                                                serde_json::json!({
                                                    "role": new_role,
                                                }),
                                            );
                                        }
                                    }
                                    my_last_known_role = Some(new_role);
                                }
                            }
                        }
                    }
                    continue;
                }

                // For all other keys: check writer's role
                if let Some(writer) = &writer_node_id {
                    let writer_role = node_to_role
                        .get(writer)
                        .cloned()
                        .unwrap_or(MemberRole::Editor);
                    if writer_role == MemberRole::Viewer {
                        eprintln!("[P2P] Rejected write from viewer {}: {}", writer, key);
                        continue;
                    }
                } else if !author_to_node.is_empty() {
                    // Unknown author and we already have author mappings — reject
                    eprintln!(
                        "[P2P] Rejected write from unknown author {}: {}",
                        author_id_str, key
                    );
                    continue;
                }
                // If author_to_node is empty, this is bootstrap — allow

                // Normal write
                let file_path = Path::new(&team_dir).join(&key);
                if let Ok(content) = blobs_store.blobs().get_bytes(entry.content_hash()).await {
                    if is_tombstone(&content) {
                        eprintln!("[P2P][doc→disk] Deleting (tombstone): {}", key);
                        let _ = std::fs::remove_file(&file_path);
                    } else {
                        eprintln!("[P2P][doc→disk] Writing: {} ({} bytes)", key, content.len());
                        write_and_suppress(&file_path, &content, &suppressed_paths).await;
                    }
                } else {
                    eprintln!("[P2P][doc→disk] Failed to get blob for: {}", key);
                }
            }
            LiveEvent::ContentReady { hash } => {
                // O(1) lookup from the pending map built during InsertRemote
                let (key, author_id_str) = if let Some(entry) = pending_content.remove(&hash) {
                    eprintln!(
                        "[P2P][doc→disk] ContentReady: {} (remaining pending={})",
                        entry.0,
                        pending_content.len()
                    );
                    entry
                } else {
                    // Fallback: hash not in pending map (e.g. entry existed before subscribe).
                    // Scan doc entries to find the key — slower but correct.
                    eprintln!(
                        "[P2P][doc→disk] ContentReady for unknown hash, falling back to doc scan"
                    );
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

                // Apply same role + owner checks as InsertRemote
                // Validate _team/members.json: only accept from owner or editor
                if key == "_team/members.json" {
                    let writer_node = author_to_node.get(&author_id_str);
                    let writer_role = writer_node
                        .and_then(|w| node_to_role.get(w.as_str()).cloned());
                    let is_privileged_write = match (writer_node, &owner_node_id) {
                        (Some(writer), Some(owner)) if writer == owner => true,
                        (None, _) if author_to_node.is_empty() => true, // bootstrap
                        _ => matches!(writer_role, Some(MemberRole::Owner) | Some(MemberRole::Editor)),
                    };
                    if !is_privileged_write {
                        eprintln!(
                            "[P2P] Rejected ContentReady members.json from non-privileged node: {:?}",
                            writer_node
                        );
                        continue;
                    }
                    // Privileged write — write to disk and update role cache
                    if let Ok(content) = blobs_store.blobs().get_bytes(hash).await {
                        let file_path = Path::new(&team_dir).join(&key);
                        write_and_suppress(&file_path, &content, &suppressed_paths).await;
                        if let Ok(Some(manifest)) = read_members_manifest(&team_dir) {
                            node_to_role.clear();
                            for member in &manifest.members {
                                node_to_role
                                    .insert(member.node_id.clone(), member.role.clone());
                            }
                            if let Some(ref app) = app_handle {
                                use tauri::Emitter;
                                let _ =
                                    app.emit("team:members-changed", serde_json::json!({}));
                            }
                        }
                    }
                    continue;
                }

                if let Some(writer) = author_to_node.get(&author_id_str) {
                    let writer_role = node_to_role
                        .get(writer)
                        .cloned()
                        .unwrap_or(MemberRole::Editor);
                    if writer_role == MemberRole::Viewer {
                        eprintln!(
                            "[P2P] Rejected ContentReady from viewer {}: {}",
                            writer, key
                        );
                        continue;
                    }
                } else if !author_to_node.is_empty() {
                    eprintln!(
                        "[P2P] Rejected ContentReady from unknown author: {}",
                        key
                    );
                    continue;
                }

                let file_path = Path::new(&team_dir).join(&key);
                if let Ok(content) = blobs_store.blobs().get_bytes(hash).await {
                    if is_tombstone(&content) {
                        eprintln!("[P2P][ContentReady] Deleting (tombstone): {}", key);
                        let _ = std::fs::remove_file(&file_path);
                    } else {
                        eprintln!("[P2P][ContentReady] Writing: {} ({} bytes)", key, content.len());
                        write_and_suppress(&file_path, &content, &suppressed_paths).await;
                    }
                }
            }
            _ => {}
        }
    }
    eprintln!(
        "[P2P][doc→disk] Event loop exited! pending_content had {} unresolved entries",
        pending_content.len()
    );
}

/// Watch filesystem for local changes and write them to the doc.
async fn disk_to_doc_watcher(
    doc: iroh_docs::api::Doc,
    blobs_store: iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
    team_dir: String,
    suppressed_paths: Arc<Mutex<HashSet<std::path::PathBuf>>>,
    my_role: Arc<Mutex<MemberRole>>,
    my_node_id: String,
    owner_node_id: Option<String>,
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

    // Keep watcher alive by holding it
    let _watcher = watcher;

    // Debounce: collect events for 500ms before processing
    loop {
        let event = match rx.recv().await {
            Some(e) => e,
            None => break,
        };

        // Collect any additional events within debounce window
        let mut events = vec![event];
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        while let Ok(e) = rx.try_recv() {
            events.push(e);
        }

        for event in events {
            match event.kind {
                notify::EventKind::Create(_) | notify::EventKind::Modify(_) => {
                    for path in &event.paths {
                        // Skip suppressed paths (written by remote sync)
                        {
                            let suppressed = suppressed_paths.lock().await;
                            if suppressed.contains(path) {
                                continue;
                            }
                        }

                        if !path.is_file() {
                            continue;
                        }

                        if let Ok(rel) = path.strip_prefix(&team_dir) {
                            let rel_path = rel.to_string_lossy().to_string();

                            // Refresh my_role if the members manifest changed
                            if rel_path == "_team/members.json" {
                                if let Ok(Some(manifest)) = read_members_manifest(&team_dir) {
                                    if let Some(me) =
                                        manifest.members.iter().find(|m| m.node_id == my_node_id)
                                    {
                                        let mut role = my_role.lock().await;
                                        *role = me.role.clone();
                                        eprintln!("[P2P] My role updated to: {:?}", *role);
                                    }
                                }
                            }

                            // Check if we have write permission
                            {
                                let role = my_role.lock().await;
                                if *role == MemberRole::Viewer {
                                    eprintln!("[P2P] Skipping upload (viewer mode): {}", rel_path);
                                    continue;
                                }
                            }

                            // Only the owner may upload _team/members.json
                            // — non-owner writes pollute the doc with stale
                            // entries that can cause "not in allowList" rejections.
                            if rel_path == "_team/members.json" {
                                let is_owner = owner_node_id
                                    .as_deref()
                                    .map_or(false, |owner| owner == my_node_id);
                                if !is_owner {
                                    eprintln!(
                                        "[P2P] Skipping upload (non-owner): _team/members.json"
                                    );
                                    continue;
                                }
                            }

                            let key = rel_path;
                            if let Ok(content) = std::fs::read(path) {
                                // Iroh rejects empty blobs; use a single newline as placeholder
                                let content = if content.is_empty() {
                                    vec![b'\n']
                                } else {
                                    content
                                };
                                eprintln!(
                                    "[P2P][disk→doc] Syncing: {} ({} bytes)",
                                    key,
                                    content.len()
                                );
                                if let Err(e) = doc.set_bytes(author, key.clone(), content).await {
                                    eprintln!("[P2P] Failed to sync local change '{}': {}", key, e);
                                }
                                // Track skill file contributions for leaderboard
                                if path
                                    .file_name()
                                    .map_or(false, |n| n.eq_ignore_ascii_case("SKILL.md"))
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

                            // Check if we have write permission
                            {
                                let role = my_role.lock().await;
                                if *role == MemberRole::Viewer {
                                    eprintln!("[P2P] Skipping upload (viewer mode): {}", rel_path);
                                    continue;
                                }
                            }

                            let key = rel_path;
                            // Write tombstone marker (iroh rejects empty blobs)
                            eprintln!("[P2P][disk→doc] Deleting (tombstone): {}", key);
                            if let Err(e) = doc.set_bytes(author, key.clone(), TOMBSTONE_MARKER.to_vec()).await {
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

// ─── Authorization ──────────────────────────────────────────────────────

/// Check if a device is authorized to join the team by reading `_team/members.json`.
/// Rejects if manifest is missing or if the joiner is not listed.
pub fn check_join_authorization(team_dir: &str, joiner_node_id: &str) -> Result<(), String> {
    match read_members_manifest(team_dir)? {
        None => Err(format!(
            "Not authorized — no members manifest found. Share your Device ID with the team owner: {}",
            joiner_node_id
        )),
        Some(manifest) => {
            if manifest.members.iter().any(|m| m.node_id == joiner_node_id) {
                Ok(())
            } else {
                Err(format!(
                    "Not authorized — share your Device ID with the team owner: {}",
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
    /// The iroh-docs namespace ID for the team document (hex string)
    #[serde(default)]
    pub namespace_id: Option<String>,
    /// Stable DocTicket for sharing (only set by owner)
    #[serde(default)]
    pub doc_ticket: Option<String>,
    /// Role in the team: owner, editor, or viewer
    #[serde(default)]
    pub role: Option<MemberRole>,
    /// Seed node URL for team discovery and applications
    #[serde(default)]
    pub seed_url: Option<String>,
    #[serde(default)]
    pub team_secret: Option<String>,
    /// Cached seed node iroh endpoint ID (hex string)
    #[serde(default)]
    pub seed_iroh_node_id: Option<String>,
    /// Cached seed node relay URL
    #[serde(default)]
    pub seed_iroh_relay_url: Option<String>,
    /// Cached seed node direct socket addresses
    #[serde(default)]
    pub seed_iroh_addrs: Option<Vec<String>>,
    /// Cached peer addresses for LAN reconnection (node_id → list of socket addrs)
    #[serde(default)]
    pub cached_peer_addrs: HashMap<String, Vec<String>>,
}

/// Clear the p2p field from .teamclaw/teamclaw.json and remove teamclaw-team/ directory.
/// Preserves iroh keys, llm config, and other fields in teamclaw.json.
fn clear_p2p_and_team_dir(workspace_path: &str) -> Result<(), String> {
    let config_path = Path::new(workspace_path)
        .join(crate::commands::TEAMCLAW_DIR)
        .join(super::CONFIG_FILE_NAME);
    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {}", super::CONFIG_FILE_NAME, e))?;
        if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(obj) = json.as_object_mut() {
                obj.remove("p2p");
            }
            std::fs::write(&config_path, serde_json::to_string_pretty(&json).unwrap())
                .map_err(|e| format!("Failed to write {}: {}", super::CONFIG_FILE_NAME, e))?;
        }
    }

    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
    if Path::new(&team_dir).exists() {
        std::fs::remove_dir_all(&team_dir)
            .map_err(|e| format!("Failed to remove team directory: {}", e))?;
    }

    Ok(())
}

/// Read P2P config from teamclaw.json in the workspace.
pub fn read_p2p_config(workspace_path: &str) -> Result<Option<P2pConfig>, String> {
    let config_path = format!(
        "{}/{}/{}",
        workspace_path,
        crate::commands::TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME
    );

    if !Path::new(&config_path).exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read {}: {}", super::CONFIG_FILE_NAME, e))?;

    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {}", super::CONFIG_FILE_NAME, e))?;

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
pub fn write_p2p_config(workspace_path: &str, config: Option<&P2pConfig>) -> Result<(), String> {
    let teamclaw_dir = format!("{}/{}", workspace_path, crate::commands::TEAMCLAW_DIR);
    let _ = std::fs::create_dir_all(&teamclaw_dir);
    let config_path = format!("{}/{}", teamclaw_dir, super::CONFIG_FILE_NAME);

    let mut json: serde_json::Value = if Path::new(&config_path).exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {}", super::CONFIG_FILE_NAME, e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse {}: {}", super::CONFIG_FILE_NAME, e))?
    } else {
        serde_json::json!({
            "$schema": "https://opencode.ai/config.json"
        })
    };

    if let Some(p2p_config) = config {
        let p2p_val = serde_json::to_value(p2p_config)
            .map_err(|e| format!("Failed to serialize p2p config: {}", e))?;
        json.as_object_mut()
            .ok_or_else(|| format!("{} is not an object", super::CONFIG_FILE_NAME))?
            .insert("p2p".to_string(), p2p_val);
    } else {
        json.as_object_mut()
            .ok_or_else(|| format!("{} is not an object", super::CONFIG_FILE_NAME))?
            .remove("p2p");
    }

    let content = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write {}: {}", super::CONFIG_FILE_NAME, e))
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

// ─── Leave Team (member) ─────────────────────────────────────────────────

/// Leave the team as a non-owner member.
/// Writes a leave tombstone to the P2P doc so the owner is notified,
/// then disconnects and removes all local team data.
#[tauri::command]
pub async fn p2p_leave_team(
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    // Owner must use p2p_dissolve_team instead
    let config = read_p2p_config(&workspace_path)?.unwrap_or_default();
    if config.role == Some(MemberRole::Owner) {
        return Err("Team owners cannot leave — use Dissolve Team to end the team".to_string());
    }

    // Write leave tombstone so the owner's sync detects the departure
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
            // Brief pause to let tombstone propagate
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        }
        if let Some(doc) = node.active_doc.take() {
            let _ = doc.leave().await;
        }
    }
    drop(guard);

    clear_p2p_and_team_dir(&workspace_path)?;

    Ok(())
}

// ─── Disconnect ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn p2p_disconnect_source(
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    // Prevent owner from disconnecting if there are other members
    if let Ok(Some(config)) = read_p2p_config(&workspace_path) {
        let guard = iroh_state.lock().await;
        if let Some(node) = guard.as_ref() {
            let my_node_id = get_node_id(node);
            if config.owner_node_id.as_deref() == Some(&my_node_id)
                && config.allowed_members.len() > 1
            {
                return Err(
                    "团队还有其他成员，请先移除所有成员或转让管理员角色后再断开".to_string()
                );
            }
        }
        drop(guard);
    }

    // Close active doc
    let mut guard = iroh_state.lock().await;
    if let Some(node) = guard.as_mut() {
        if let Some(doc) = node.active_doc.take() {
            let _ = doc.leave().await;
        }
    }
    drop(guard);

    clear_p2p_and_team_dir(&workspace_path)?;

    Ok(())
}

/// Dissolve the team. Only the owner can call this.
/// Writes a tombstone to notify other members, then cleans up local data.
#[tauri::command]
pub async fn p2p_dissolve_team(
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    // Only owner can dissolve
    let config = read_p2p_config(&workspace_path)?.unwrap_or_default();
    if config.role != Some(MemberRole::Owner) {
        return Err("Only the team owner can dissolve the team".to_string());
    }

    // Write tombstone to doc so other members know team is dissolved
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
            // Brief pause to let tombstone propagate
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        if let Some(doc) = node.active_doc.take() {
            let _ = doc.leave().await;
        }
    }
    drop(guard);

    clear_p2p_and_team_dir(&workspace_path)?;

    Ok(())
}

// ─── Team Member Management ─────────────────────────────────────────────

/// Add a member to the team allowlist. Only the owner can call this.
pub fn add_member_to_team(
    workspace_path: &str,
    team_dir: &str,
    caller_node_id: &str,
    member: TeamMember,
) -> Result<(), String> {
    let mut config = read_p2p_config(workspace_path)?.unwrap_or_default();

    let owner_id = config
        .owner_node_id
        .as_deref()
        .ok_or("No team owner configured")?;

    // Use the synced manifest as the authoritative member list when available,
    // since joiners don't have allowed_members in their local config.
    let manifest = read_members_manifest(team_dir).ok().flatten();
    let mut members = if let Some(ref m) = manifest {
        m.members.clone()
    } else {
        config.allowed_members.clone()
    };

    // Any existing member (owner or editor) can add new members.
    let is_owner = owner_id == caller_node_id;
    let is_member = members
        .iter()
        .any(|m| m.node_id == caller_node_id && matches!(m.role, MemberRole::Owner | MemberRole::Editor));
    if !is_owner && !is_member {
        return Err("Only team members can add new members".to_string());
    }

    if members.iter().any(|m| m.node_id == member.node_id) {
        return Err("Member already exists".to_string());
    }

    eprintln!(
        "[Team] Adding member node_id={} to team (total will be {}) by={}",
        &member.node_id,
        members.len() + 1,
        &caller_node_id[..10.min(caller_node_id.len())]
    );

    members.push(member);

    // Update local config
    config.allowed_members = members.clone();
    write_p2p_config(workspace_path, Some(&config))?;
    eprintln!(
        "[Team] P2P config written with {} members",
        config.allowed_members.len()
    );

    // Always use owner_node_id for manifest (it's the canonical owner field)
    write_members_manifest(team_dir, owner_id, &members)?;
    eprintln!(
        "[Team] members.json written to {}/{}/_team/members.json",
        workspace_path,
        super::TEAM_REPO_DIR
    );

    // Verify the write
    match read_members_manifest(team_dir) {
        Ok(Some(m)) => eprintln!(
            "[Team] Verified: members.json has {} members",
            m.members.len()
        ),
        Ok(None) => eprintln!("[Team] ERROR: members.json not found after write!"),
        Err(e) => eprintln!("[Team] ERROR: failed to re-read members.json: {}", e),
    }

    Ok(())
}

/// Remove a member from the team allowlist. Owner or editor can call this.
pub fn remove_member_from_team(
    workspace_path: &str,
    team_dir: &str,
    caller_node_id: &str,
    target_node_id: &str,
) -> Result<(), String> {
    let mut config = read_p2p_config(workspace_path)?.unwrap_or_default();

    let owner_id = config
        .owner_node_id
        .as_deref()
        .ok_or("No team owner configured")?;
    // Use manifest as authoritative member list when available
    let manifest = read_members_manifest(team_dir).ok().flatten();
    let mut members = if let Some(ref m) = manifest {
        m.members.clone()
    } else {
        config.allowed_members.clone()
    };

    let is_owner = owner_id == caller_node_id;
    let is_editor = members
        .iter()
        .any(|m| m.node_id == caller_node_id && matches!(m.role, MemberRole::Owner | MemberRole::Editor));
    if !is_owner && !is_editor {
        return Err("Only team members (owner or editor) can manage members".to_string());
    }

    if target_node_id == caller_node_id {
        return Err("Cannot remove the team owner".to_string());
    }

    let before_len = members.len();
    members.retain(|m| m.node_id != target_node_id);
    if members.len() == before_len {
        return Err("Member not found".to_string());
    }

    config.allowed_members = members.clone();
    write_p2p_config(workspace_path, Some(&config))?;
    write_members_manifest(team_dir, owner_id, &members)?;

    Ok(())
}

/// Update a member's role. Owner or editor can call this.
pub fn update_member_role(
    workspace_path: &str,
    team_dir: &str,
    caller_node_id: &str,
    target_node_id: &str,
    new_role: MemberRole,
) -> Result<(), String> {
    let mut config = read_p2p_config(workspace_path)?.unwrap_or_default();

    let owner_id = config
        .owner_node_id
        .as_deref()
        .ok_or("No team owner configured")?;
    // Use manifest as authoritative member list when available
    let manifest = read_members_manifest(team_dir).ok().flatten();
    let mut members = if let Some(ref m) = manifest {
        m.members.clone()
    } else {
        config.allowed_members.clone()
    };

    let is_owner = owner_id == caller_node_id;
    let is_editor = members
        .iter()
        .any(|m| m.node_id == caller_node_id && matches!(m.role, MemberRole::Owner | MemberRole::Editor));
    if !is_owner && !is_editor {
        return Err("Only team members (owner or editor) can manage members".to_string());
    }

    if target_node_id == caller_node_id {
        return Err("Cannot change the owner's role".to_string());
    }

    let member = members
        .iter_mut()
        .find(|m| m.node_id == target_node_id)
        .ok_or("Member not found")?;
    member.role = new_role;

    config.allowed_members = members.clone();
    write_p2p_config(workspace_path, Some(&config))?;
    write_members_manifest(team_dir, owner_id, &members)?;

    Ok(())
}

#[tauri::command]
pub async fn team_add_member(
    node_id: String,
    name: String,
    role: Option<String>,
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    let guard = iroh_state.lock().await;
    let node = guard.as_ref().ok_or("P2P node not running")?;
    let caller_id = get_node_id(node);
    drop(guard);

    let member_role = match role.as_deref() {
        Some("viewer") => MemberRole::Viewer,
        _ => MemberRole::Editor,
    };

    let member = TeamMember {
        node_id,
        name,
        role: member_role,
        label: String::new(),
        platform: String::new(),
        arch: String::new(),
        hostname: String::new(),
        added_at: chrono::Utc::now().to_rfc3339(),
    };

    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
    add_member_to_team(&workspace_path, &team_dir, &caller_id, member)?;

    // Also write updated manifest into the doc so it syncs
    let guard = iroh_state.lock().await;
    if let Some(node) = guard.as_ref() {
        if let Some(doc) = &node.active_doc {
            let manifest_path = format!(
                "{}/{}/_team/members.json",
                workspace_path,
                super::TEAM_REPO_DIR
            );
            match std::fs::read(&manifest_path) {
                Ok(content) => {
                    if let Err(e) = doc
                        .set_bytes(node.author, "_team/members.json", content)
                        .await
                    {
                        eprintln!("[Team] Failed to write members.json to iroh doc: {}", e);
                        return Err(format!("Member added locally but failed to sync: {}", e));
                    }
                    eprintln!("[Team] Updated members.json synced to iroh doc");
                }
                Err(e) => {
                    eprintln!("[Team] Failed to read members.json from disk: {}", e);
                    return Err(format!("Member added but manifest file unreadable: {}", e));
                }
            }
        } else {
            eprintln!("[Team] WARNING: No active doc — manifest won't sync to peers");
        }
    } else {
        eprintln!("[Team] WARNING: No iroh node — manifest won't sync to peers");
    }

    Ok(())
}

#[tauri::command]
pub async fn team_remove_member(
    node_id: String,
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    let guard = iroh_state.lock().await;
    let node = guard.as_ref().ok_or("P2P node not running")?;
    let caller_id = get_node_id(node);
    drop(guard);

    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
    remove_member_from_team(&workspace_path, &team_dir, &caller_id, &node_id)?;

    // Also write updated manifest into the doc so it syncs
    let guard = iroh_state.lock().await;
    if let Some(node) = guard.as_ref() {
        if let Some(doc) = &node.active_doc {
            let manifest_path = format!(
                "{}/{}/_team/members.json",
                workspace_path,
                super::TEAM_REPO_DIR
            );
            match std::fs::read(&manifest_path) {
                Ok(content) => {
                    if let Err(e) = doc
                        .set_bytes(node.author, "_team/members.json", content)
                        .await
                    {
                        eprintln!("[Team] Failed to write members.json to iroh doc: {}", e);
                    }
                }
                Err(e) => {
                    eprintln!("[Team] Failed to read members.json from disk: {}", e);
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn team_update_member_role(
    node_id: String,
    role: String,
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    let new_role = match role.as_str() {
        "viewer" => MemberRole::Viewer,
        "editor" => MemberRole::Editor,
        _ => return Err(format!("Invalid role: {}", role)),
    };

    // Get caller node_id, then drop guard (same pattern as team_add_member)
    let guard = iroh_state.lock().await;
    let node = guard.as_ref().ok_or("P2P node not running")?;
    let caller_node_id = get_node_id(node);
    drop(guard);

    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
    update_member_role(
        &workspace_path,
        &team_dir,
        &caller_node_id,
        &node_id,
        new_role,
    )?;

    // Re-acquire guard to sync updated manifest to iroh-docs
    let guard = iroh_state.lock().await;
    if let Some(node) = guard.as_ref() {
        if let Some(doc) = &node.active_doc {
            let manifest_path = format!(
                "{}/{}/_team/members.json",
                workspace_path,
                super::TEAM_REPO_DIR
            );
            if let Ok(content) = std::fs::read(&manifest_path) {
                let _ = doc
                    .set_bytes(node.author, "_team/members.json", content)
                    .await;
            }
        }
    }

    Ok(())
}

// ─── Tauri Commands: P2P ─────────────────────────────────────────────────

/// Check if teamclaw-team directory exists and has content.
/// Returns: { exists: bool, hasMembers: bool }
#[tauri::command]
pub async fn p2p_check_team_dir(
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<serde_json::Value, String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
    let exists = Path::new(&team_dir).exists();
    let has_members = Path::new(&team_dir)
        .join("_team")
        .join("members.json")
        .exists();

    Ok(serde_json::json!({
        "exists": exists,
        "hasMembers": has_members,
    }))
}

#[tauri::command]
pub async fn p2p_create_team(
    app: tauri::AppHandle,
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
    team_name: Option<String>,
    owner_name: Option<String>,
    owner_email: Option<String>,
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<String, String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    let mut guard = iroh_state.lock().await;
    let node = guard.as_mut().ok_or("P2P node not running")?;

    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
    create_team(
        node,
        &team_dir,
        &workspace_path,
        llm_base_url,
        llm_model,
        llm_model_name,
        team_name,
        owner_name,
        owner_email,
        Some(app),
    )
    .await
}

#[tauri::command]
pub async fn p2p_publish_drive(
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<String, String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    let mut guard = iroh_state.lock().await;
    let node = guard.as_mut().ok_or("P2P node not running")?;

    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);

    // If no active doc, create a team (first-time publish)
    if node.active_doc.is_none() {
        return create_team(
            node,
            &team_dir,
            &workspace_path,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
    }

    // Otherwise, sync current files into existing doc and return saved ticket
    publish_team_drive(node, &team_dir, &workspace_path).await?;

    let config = read_p2p_config(&workspace_path)?;
    config
        .and_then(|c| c.doc_ticket)
        .ok_or_else(|| "No ticket available".to_string())
}

#[tauri::command]
pub async fn p2p_join_drive(
    app: tauri::AppHandle,
    ticket: String,
    #[allow(unused_variables)] label: String,
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<String, String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    let mut guard = iroh_state.lock().await;
    let node = guard.as_mut().ok_or("P2P node not running")?;

    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
    let result = join_team_drive(node, &ticket, &team_dir, &workspace_path, Some(app)).await?;

    // Write LLM config to .teamclaw/teamclaw.json (same as oss_join_team and create_team)
    let llm_config =
        crate::commands::team::build_llm_config(llm_base_url, llm_model, llm_model_name);
    crate::commands::team::write_llm_config(&workspace_path, Some(&llm_config))?;

    Ok(result)
}

/// Reconnect to an existing team document on app restart.
#[tauri::command]
pub async fn p2p_reconnect(
    app: tauri::AppHandle,
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    let config = read_p2p_config(&workspace_path)?;
    let config = match config {
        Some(c) if c.enabled && c.namespace_id.is_some() => c,
        _ => return Ok(()), // No team to reconnect to
    };

    let _namespace_id_str = config.namespace_id.as_ref().unwrap();

    let mut guard = iroh_state.lock().await;
    let node = guard.as_mut().ok_or("P2P node not running")?;

    // Skip if already connected
    if node.active_doc.is_some() {
        return Ok(());
    }

    let my_node_id = get_node_id(node);
    let is_owner = config
        .owner_node_id
        .as_deref()
        .map_or(false, |owner| owner == my_node_id);

    // MUST use docs.import(ticket) — docs.open() does NOT accept incoming sync.
    // Without ticket import, this node is invisible to peers on LAN.
    let ticket_str = config
        .doc_ticket
        .as_ref()
        .ok_or_else(|| "No saved ticket — cannot reconnect. Please rejoin the team.".to_string())?;
    eprintln!(
        "[P2P] Reconnecting via ticket import (is_owner={})",
        is_owner
    );
    let ticket = ticket_str
        .trim()
        .parse::<iroh_docs::DocTicket>()
        .map_err(|_| "Invalid saved ticket — please rejoin the team.".to_string())?;
    let doc = node
        .docs
        .import(ticket)
        .await
        .map_err(|e| format!("Failed to import doc: {}", e))?;

    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);

    // Re-check authorization on reconnect (except for owner)
    if !is_owner {
        if let Err(auth_err) = check_join_authorization(&team_dir, &my_node_id) {
            let _ = doc.close().await;
            clear_p2p_and_team_dir(&workspace_path)?;
            return Err(format!("Reconnect rejected: {}", auth_err));
        }
    }

    let my_role = config.role.clone().unwrap_or(MemberRole::Editor);

    // Reconcile offline edits before starting watchers
    if let Err(e) = reconcile_disk_and_doc(
        &doc,
        &node.store,
        node.author,
        &team_dir,
        is_owner,
        &my_role,
    )
    .await
    {
        eprintln!("[P2P] Reconcile failed: {} (continuing)", e);
    }

    // Resolve seed endpoint (refresh cache, fallback to cached)
    let seed_ep = if let Some(ref seed_url) = config.seed_url {
        resolve_seed_endpoint(seed_url, &workspace_path, &config).await
    } else {
        None
    };

    // Start background sync
    start_sync_tasks(
        &doc,
        node.author,
        &node.store,
        &team_dir,
        node.suppressed_paths.clone(),
        Arc::new(Mutex::new(my_role)),
        my_node_id,
        config.owner_node_id.clone(),
        Some(app),
        node.router.endpoint().clone(),
        config.doc_ticket.clone(),
        seed_ep,
        config.cached_peer_addrs.clone(),
        Some(workspace_path.clone()),
    );

    node.active_doc = Some(doc);

    Ok(())
}

/// Regenerate the team ticket (namespace rotation). Owner only.
#[tauri::command]
pub async fn p2p_rotate_ticket(
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<String, String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    let mut guard = iroh_state.lock().await;
    let node = guard.as_mut().ok_or("P2P node not running")?;

    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
    rotate_namespace(node, &team_dir, &workspace_path).await
}

#[tauri::command]
pub async fn get_p2p_config(
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<Option<P2pConfig>, String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;
    read_p2p_config(&workspace_path)
}

#[tauri::command]
pub async fn save_p2p_config(
    config: P2pConfig,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;
    write_p2p_config(&workspace_path, Some(&config))
}

/// Get the current team sync status.
#[tauri::command]
pub async fn p2p_sync_status(
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<P2pSyncStatus, String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    let config = read_p2p_config(&workspace_path)?.unwrap_or_default();
    let guard = iroh_state.lock().await;
    // connected = active doc exists AND its namespace matches this workspace's config
    let connected = guard.as_ref().map_or(false, |n| {
        match (&n.active_doc, config.namespace_id.as_deref()) {
            (Some(doc), Some(config_ns)) => doc.id().to_string() == config_ns,
            _ => false,
        }
    });

    // Generate a fresh ticket from THIS member's perspective:
    // includes own address + up to 4 random other known peers.
    let member_ticket = if let Some(node) = guard.as_ref() {
        if let Some(doc) = &node.active_doc {
            match doc.share(
                iroh_docs::api::protocol::ShareMode::Write,
                iroh_docs::api::protocol::AddrInfoOptions::RelayAndAddresses,
            ).await {
                Ok(mut ticket) => {
                    // Collect other known peers from manifest + cache
                    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
                    let my_node_id = get_node_id(node);
                    let ep = node.router.endpoint();
                    let mut other_peers: Vec<iroh::EndpointAddr> = Vec::new();

                    if let Ok(Some(manifest)) = read_members_manifest(&team_dir) {
                        for member in &manifest.members {
                            if member.node_id == my_node_id {
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
                                    if let Some(cached) = config.cached_peer_addrs.get(&member.node_id) {
                                        for addr_str in cached {
                                            if let Ok(sock) = addr_str.parse::<std::net::SocketAddr>() {
                                                addrs.insert(iroh::TransportAddr::Ip(sock));
                                            }
                                        }
                                    }
                                }
                                if !addrs.is_empty() {
                                    other_peers.push(iroh::EndpointAddr { id, addrs });
                                }
                            }
                        }
                    }

                    // Shuffle using a simple timestamp-based seed to avoid
                    // adding rand as a dependency. Fisher-Yates lite.
                    {
                        let seed = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .subsec_nanos() as usize;
                        let len = other_peers.len();
                        for i in (1..len).rev() {
                            let j = (seed.wrapping_mul(i + 1).wrapping_add(7)) % (i + 1);
                            other_peers.swap(i, j);
                        }
                    }
                    for peer in other_peers.into_iter().take(4) {
                        if !ticket.nodes.iter().any(|n| n.id == peer.id) {
                            ticket.nodes.push(peer);
                        }
                    }

                    Some(ticket.to_string())
                }
                Err(_) => config.doc_ticket.clone(),
            }
        } else {
            config.doc_ticket.clone()
        }
    } else {
        config.doc_ticket.clone()
    };

    Ok(P2pSyncStatus {
        connected,
        role: config.role,
        doc_ticket: member_ticket,
        namespace_id: config.namespace_id,
        last_sync_at: config.last_sync_at,
        members: config.allowed_members,
        owner_node_id: config.owner_node_id,
        seed_url: config.seed_url,
        team_secret: config.team_secret,
    })
}

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

#[tauri::command]
pub async fn p2p_get_files_sync_status(
    iroh_state: tauri::State<'_, crate::commands::p2p_state::IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<Vec<crate::commands::oss_types::FileSyncStatus>, String> {
    use crate::commands::oss_types::{FileSyncStatus, SyncFileStatus};
    use futures_lite::StreamExt;

    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
    let team_path = std::path::Path::new(&team_dir);

    let guard = iroh_state.lock().await;
    let node = guard
        .as_ref()
        .ok_or_else(|| "P2P node not running".to_string())?;
    let doc = node
        .active_doc
        .as_ref()
        .ok_or_else(|| "No active team document".to_string())?;

    // 1. Query all doc entries to build hash map
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
        // Skip tombstones and metadata entries
        if entry.content_len() == 0
            || entry.content_hash() == tombstone_hash
            || key.starts_with("_meta/")
            || key.starts_with("_team/")
        {
            continue;
        }
        doc_hashes.insert(key, entry.content_hash());
    }

    // 2. Scan local files and compare
    let local_files = collect_files(team_path, team_path);
    let mut result = Vec::new();

    for (rel_path, content) in &local_files {
        // Skip metadata entries
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
            doc_type: String::new(), // P2P doesn't separate by doc_type
            status,
        });
    }

    Ok(result)
}

#[tauri::command]
pub async fn p2p_save_seed_config(
    seed_url: Option<String>,
    team_secret: Option<String>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set")?;

    let mut config = read_p2p_config(&workspace_path)?.unwrap_or_default();
    if let Some(url) = seed_url {
        config.seed_url = if url.is_empty() { None } else { Some(url) };
    }
    if let Some(secret) = team_secret {
        config.team_secret = if secret.is_empty() {
            None
        } else {
            Some(secret)
        };
    }
    write_p2p_config(&workspace_path, Some(&config))?;
    Ok(())
}

// ─── Skills Contribution Tracking ────────────────────────────────────────

/// Increment the SKILLS.md edit counter for the given author.
/// Stored at `_meta/skills_count/<author_id>` as a UTF-8 integer string.
/// Needs `blobs_store` to read the current count from the doc.
async fn increment_skills_count(
    doc: &iroh_docs::api::Doc,
    blobs_store: &iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
) {
    let count_key = format!("_meta/skills_count/{}", author);

    // Read current count from the doc
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

/// Query all `_meta/skills_count/*` entries and `_meta/authors/*` entries
/// from the active iroh-docs document to build a skills leaderboard.
async fn query_skills_leaderboard(node: &IrohNode) -> Result<Vec<SkillsContribution>, String> {
    use futures_lite::StreamExt;
    use std::collections::HashMap;
    use std::pin::pin;

    let doc = node.active_doc.as_ref().ok_or("No active team document")?;
    let blobs_store: iroh_blobs::api::Store = node.store.clone().into();

    // 1. Build author_id → node_id mapping from _meta/authors/* entries
    let author_query = iroh_docs::store::Query::key_prefix("_meta/authors/").build();
    let entries = doc
        .get_many(author_query)
        .await
        .map_err(|e| format!("Failed to query author meta: {}", e))?;
    let mut entries = pin!(entries);

    let mut author_to_node: HashMap<String, String> = HashMap::new();
    while let Some(Ok(entry)) = entries.next().await {
        let key = String::from_utf8_lossy(entry.key()).to_string();
        // key = "_meta/authors/<author_id>"
        if let Some(author_id) = key.strip_prefix("_meta/authors/") {
            if let Ok(content) = blobs_store.blobs().get_bytes(entry.content_hash()).await {
                let node_id = String::from_utf8_lossy(&content).to_string();
                author_to_node.insert(author_id.to_string(), node_id);
            }
        }
    }

    // 2. Read skills counts from _meta/skills_count/* entries
    let count_query = iroh_docs::store::Query::key_prefix("_meta/skills_count/").build();
    let entries = doc
        .get_many(count_query)
        .await
        .map_err(|e| format!("Failed to query skills counts: {}", e))?;
    let mut entries = pin!(entries);

    let mut results: Vec<SkillsContribution> = Vec::new();
    while let Some(Ok(entry)) = entries.next().await {
        let key = String::from_utf8_lossy(entry.key()).to_string();
        // key = "_meta/skills_count/<author_id>"
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

    // Sort by edit_count descending
    results.sort_by(|a, b| b.edit_count.cmp(&a.edit_count));
    Ok(results)
}

#[tauri::command]
pub async fn p2p_skills_leaderboard(
    iroh_state: tauri::State<'_, IrohState>,
) -> Result<Vec<SkillsContribution>, String> {
    let guard = iroh_state.lock().await;
    let node = guard.as_ref().ok_or("P2P node not running")?;
    query_skills_leaderboard(node).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_iroh_node_creates_and_shuts_down() {
        let tmp = tempfile::tempdir().unwrap();
        let node = IrohNode::new(tmp.path()).await.unwrap();
        assert!(node.is_running());
        node.shutdown().await;
    }

    #[test]
    fn test_iroh_state_type() {
        let state: IrohState = Arc::new(Mutex::new(None));
        assert!(state.try_lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_join_with_invalid_ticket_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let mut node = IrohNode::new(tmp.path()).await.unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();

        let result = join_team_drive(
            &mut node,
            "garbage-not-a-ticket",
            team_dir.to_str().unwrap(),
            tmp.path().to_str().unwrap(),
            None,
        )
        .await;
        assert!(result.is_err(), "should fail with invalid ticket");
        assert!(
            result.unwrap_err().contains("Invalid ticket"),
            "error should mention invalid ticket"
        );

        node.shutdown().await;
    }

    #[tokio::test]
    async fn test_create_team_produces_doc_ticket() {
        let tmp = tempfile::tempdir().unwrap();

        // Create a team dir with some skill files
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        let skills_dir = team_dir.join(".claude").join("skills").join("test-skill");
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(skills_dir.join("SKILL.md"), "# Test Skill\nHello").unwrap();

        let iroh_tmp = tempfile::tempdir().unwrap();
        let mut node = IrohNode::new(iroh_tmp.path()).await.unwrap();

        let ticket = create_team(
            &mut node,
            team_dir.to_str().unwrap(),
            tmp.path().to_str().unwrap(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert!(!ticket.is_empty(), "ticket should not be empty");
        // DocTicket should be parseable
        assert!(
            ticket.parse::<iroh_docs::DocTicket>().is_ok(),
            "should be a valid DocTicket"
        );

        // Verify config was written with new fields
        let config = read_p2p_config(tmp.path().to_str().unwrap())
            .unwrap()
            .unwrap();
        assert!(config.namespace_id.is_some());
        assert!(config.doc_ticket.is_some());
        assert_eq!(config.role, Some(MemberRole::Owner));

        node.shutdown().await;
    }

    #[test]
    fn test_disconnect_clears_config() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();

        let config = P2pConfig {
            enabled: true,
            namespace_id: Some("test-ns".to_string()),
            doc_ticket: Some("test-ticket".to_string()),
            role: Some(MemberRole::Owner),
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();

        // Simulate disconnect by clearing fields
        let mut config = read_p2p_config(workspace).unwrap().unwrap();
        config.enabled = false;
        config.namespace_id = None;
        config.doc_ticket = None;
        config.role = None;
        write_p2p_config(workspace, Some(&config)).unwrap();

        let loaded = read_p2p_config(workspace).unwrap().unwrap();
        assert!(!loaded.enabled);
        assert!(loaded.namespace_id.is_none());
        assert!(loaded.doc_ticket.is_none());
    }

    #[test]
    fn test_sync_detects_removal() {
        let tmp = tempfile::tempdir().unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();

        let member_id = "was-a-member-789";

        let members = vec![
            TeamMember {
                node_id: "owner-456".to_string(),
                name: String::new(),
                role: MemberRole::Owner,
                label: "Owner".to_string(),
                platform: "macos".to_string(),
                arch: "aarch64".to_string(),
                hostname: "mac".to_string(),
                added_at: "2026-01-01T00:00:00Z".to_string(),
            },
            TeamMember {
                node_id: member_id.to_string(),
                name: String::new(),
                role: MemberRole::Editor,
                label: "Member".to_string(),
                platform: "linux".to_string(),
                arch: "x86_64".to_string(),
                hostname: "dev".to_string(),
                added_at: "2026-01-02T00:00:00Z".to_string(),
            },
        ];
        write_members_manifest(team_dir.to_str().unwrap(), "owner-456", &members).unwrap();
        assert!(check_join_authorization(team_dir.to_str().unwrap(), member_id).is_ok());

        let members_after = vec![TeamMember {
            node_id: "owner-456".to_string(),
            name: String::new(),
            role: MemberRole::Owner,
            label: "Owner".to_string(),
            platform: "macos".to_string(),
            arch: "aarch64".to_string(),
            hostname: "mac".to_string(),
            added_at: "2026-01-01T00:00:00Z".to_string(),
        }];
        write_members_manifest(team_dir.to_str().unwrap(), "owner-456", &members_after).unwrap();

        let result = check_join_authorization(team_dir.to_str().unwrap(), member_id);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Not authorized"));
    }

    #[test]
    fn test_join_authorized_succeeds() {
        let tmp = tempfile::tempdir().unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();

        let joiner_id = "joiner-node-123";
        let members = vec![
            TeamMember {
                node_id: "owner-456".to_string(),
                name: String::new(),
                role: MemberRole::Owner,
                label: "Owner".to_string(),
                platform: "macos".to_string(),
                arch: "aarch64".to_string(),
                hostname: "mac".to_string(),
                added_at: "2026-01-01T00:00:00Z".to_string(),
            },
            TeamMember {
                node_id: joiner_id.to_string(),
                name: String::new(),
                role: MemberRole::Editor,
                label: "Joiner".to_string(),
                platform: "linux".to_string(),
                arch: "x86_64".to_string(),
                hostname: "dev".to_string(),
                added_at: "2026-01-02T00:00:00Z".to_string(),
            },
        ];
        write_members_manifest(team_dir.to_str().unwrap(), "owner-456", &members).unwrap();

        let result = check_join_authorization(team_dir.to_str().unwrap(), joiner_id);
        assert!(result.is_ok(), "authorized joiner should succeed");
    }

    #[test]
    fn test_join_unauthorized_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();

        let members = vec![TeamMember {
            node_id: "owner-456".to_string(),
            name: String::new(),
            role: MemberRole::Owner,
            label: "Owner".to_string(),
            platform: "macos".to_string(),
            arch: "aarch64".to_string(),
            hostname: "mac".to_string(),
            added_at: "2026-01-01T00:00:00Z".to_string(),
        }];
        write_members_manifest(team_dir.to_str().unwrap(), "owner-456", &members).unwrap();

        let result = check_join_authorization(team_dir.to_str().unwrap(), "unauthorized-789");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Not authorized"), "error: {}", err);
        assert!(
            err.contains("unauthorized-789"),
            "should include joiner's NodeId: {}",
            err
        );
    }

    #[test]
    fn test_join_no_manifest_returns_no_manifest_error() {
        // When manifest hasn't synced yet, check_join_authorization returns
        // a "no members manifest" error. The join flow treats this as
        // "pending" (not a hard rejection) and defers auth to reconnect.
        let tmp = tempfile::tempdir().unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();

        let result = check_join_authorization(team_dir.to_str().unwrap(), "any-node-id");
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("no members manifest"),
            "should indicate manifest is missing (join flow treats this as pending, not rejected)"
        );
    }

    #[test]
    fn test_remove_member_succeeds() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();

        let owner_id = "owner-123";
        let members = vec![
            TeamMember {
                node_id: owner_id.to_string(),
                name: String::new(),
                role: MemberRole::Owner,
                label: "Owner".to_string(),
                platform: "macos".to_string(),
                arch: "aarch64".to_string(),
                hostname: "mac".to_string(),
                added_at: "2026-01-01T00:00:00Z".to_string(),
            },
            TeamMember {
                node_id: "member-456".to_string(),
                name: String::new(),
                role: MemberRole::Editor,
                label: "Dev".to_string(),
                platform: "linux".to_string(),
                arch: "x86_64".to_string(),
                hostname: "dev".to_string(),
                added_at: "2026-01-02T00:00:00Z".to_string(),
            },
        ];
        let config = P2pConfig {
            enabled: true,
            owner_node_id: Some(owner_id.to_string()),
            allowed_members: members.clone(),
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();
        write_members_manifest(team_dir.to_str().unwrap(), owner_id, &members).unwrap();

        remove_member_from_team(
            workspace,
            team_dir.to_str().unwrap(),
            owner_id,
            "member-456",
        )
        .unwrap();

        let config = read_p2p_config(workspace).unwrap().unwrap();
        assert_eq!(config.allowed_members.len(), 1);
        assert_eq!(config.allowed_members[0].node_id, owner_id);
    }

    #[test]
    fn test_remove_self_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();

        let owner_id = "owner-123";
        let config = P2pConfig {
            enabled: true,
            owner_node_id: Some(owner_id.to_string()),
            allowed_members: vec![TeamMember {
                node_id: owner_id.to_string(),
                name: String::new(),
                role: MemberRole::Owner,
                label: "Owner".to_string(),
                platform: "macos".to_string(),
                arch: "aarch64".to_string(),
                hostname: "mac".to_string(),
                added_at: "2026-01-01T00:00:00Z".to_string(),
            }],
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();

        let result =
            remove_member_from_team(workspace, team_dir.to_str().unwrap(), owner_id, owner_id);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Cannot remove the team owner"));
    }

    #[test]
    fn test_remove_member_non_owner_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();

        let config = P2pConfig {
            enabled: true,
            owner_node_id: Some("real-owner".to_string()),
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();

        let result = remove_member_from_team(
            workspace,
            team_dir.to_str().unwrap(),
            "not-owner",
            "some-member",
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Only team members"));
    }

    #[test]
    fn test_add_member_succeeds_for_owner() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();

        let owner_id = "owner-node-123";
        let owner_member = TeamMember {
            node_id: owner_id.to_string(),
            name: String::new(),
            role: MemberRole::Owner,
            label: "Owner".to_string(),
            platform: "macos".to_string(),
            arch: "aarch64".to_string(),
            hostname: "mac".to_string(),
            added_at: "2026-01-01T00:00:00Z".to_string(),
        };
        let config = P2pConfig {
            enabled: true,
            publish_enabled: true,
            owner_node_id: Some(owner_id.to_string()),
            allowed_members: vec![owner_member.clone()],
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();
        write_members_manifest(team_dir.to_str().unwrap(), owner_id, &[owner_member]).unwrap();

        let new_member = TeamMember {
            node_id: "new-member-456".to_string(),
            name: "Alice".to_string(),
            role: MemberRole::Editor,
            label: "Developer".to_string(),
            platform: "linux".to_string(),
            arch: "x86_64".to_string(),
            hostname: "dev-box".to_string(),
            added_at: "2026-01-02T00:00:00Z".to_string(),
        };
        add_member_to_team(workspace, team_dir.to_str().unwrap(), owner_id, new_member).unwrap();

        let config = read_p2p_config(workspace).unwrap().unwrap();
        assert_eq!(config.allowed_members.len(), 2);

        let manifest = read_members_manifest(team_dir.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(manifest.members.len(), 2);
        assert_eq!(manifest.members[1].node_id, "new-member-456");
    }

    #[test]
    fn test_add_member_fails_for_stranger() {
        // A node that is neither owner nor an existing member cannot add members
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();

        let config = P2pConfig {
            enabled: true,
            owner_node_id: Some("real-owner".to_string()),
            allowed_members: vec![TeamMember {
                node_id: "real-owner".to_string(),
                name: "Owner".to_string(),
                role: MemberRole::Owner,
                label: "Owner".to_string(),
                platform: "macos".to_string(),
                arch: "aarch64".to_string(),
                hostname: "mac".to_string(),
                added_at: "2026-01-01T00:00:00Z".to_string(),
            }],
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();

        let member = TeamMember {
            node_id: "new-member".to_string(),
            name: String::new(),
            role: MemberRole::Editor,
            label: "Hacker".to_string(),
            platform: "linux".to_string(),
            arch: "x86_64".to_string(),
            hostname: "hack-box".to_string(),
            added_at: "2026-01-01T00:00:00Z".to_string(),
        };
        let result = add_member_to_team(
            workspace,
            team_dir.to_str().unwrap(),
            "stranger-not-in-team",
            member,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Only team members"));
    }

    #[test]
    fn test_add_member_succeeds_for_editor() {
        // An existing editor can add new members
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();

        let owner_id = "owner-123";
        let editor_id = "editor-456";
        let config = P2pConfig {
            enabled: true,
            owner_node_id: Some(owner_id.to_string()),
            allowed_members: vec![
                TeamMember {
                    node_id: owner_id.to_string(),
                    name: "Owner".to_string(),
                    role: MemberRole::Owner,
                    label: "Owner".to_string(),
                    platform: "macos".to_string(),
                    arch: "aarch64".to_string(),
                    hostname: "mac".to_string(),
                    added_at: "2026-01-01T00:00:00Z".to_string(),
                },
                TeamMember {
                    node_id: editor_id.to_string(),
                    name: "Editor".to_string(),
                    role: MemberRole::Editor,
                    label: "Dev".to_string(),
                    platform: "linux".to_string(),
                    arch: "x86_64".to_string(),
                    hostname: "dev".to_string(),
                    added_at: "2026-01-02T00:00:00Z".to_string(),
                },
            ],
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();
        write_members_manifest(
            team_dir.to_str().unwrap(),
            owner_id,
            &config.allowed_members,
        )
        .unwrap();

        let new_member = TeamMember {
            node_id: "new-member-789".to_string(),
            name: "Newbie".to_string(),
            role: MemberRole::Editor,
            label: "New".to_string(),
            platform: "linux".to_string(),
            arch: "x86_64".to_string(),
            hostname: "new-box".to_string(),
            added_at: "2026-01-03T00:00:00Z".to_string(),
        };
        add_member_to_team(workspace, team_dir.to_str().unwrap(), editor_id, new_member)
            .unwrap();

        let config = read_p2p_config(workspace).unwrap().unwrap();
        assert_eq!(config.allowed_members.len(), 3);

        let manifest = read_members_manifest(team_dir.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(manifest.members.len(), 3);
        assert_eq!(manifest.members[2].node_id, "new-member-789");
        // Manifest owner should still be the original owner
        assert_eq!(manifest.owner_node_id, owner_id);
    }

    #[test]
    fn test_add_member_fails_for_viewer() {
        // Viewers cannot add members
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();

        let owner_id = "owner-123";
        let viewer_id = "viewer-456";
        let config = P2pConfig {
            enabled: true,
            owner_node_id: Some(owner_id.to_string()),
            allowed_members: vec![
                TeamMember {
                    node_id: owner_id.to_string(),
                    name: "Owner".to_string(),
                    role: MemberRole::Owner,
                    label: "Owner".to_string(),
                    platform: "macos".to_string(),
                    arch: "aarch64".to_string(),
                    hostname: "mac".to_string(),
                    added_at: "2026-01-01T00:00:00Z".to_string(),
                },
                TeamMember {
                    node_id: viewer_id.to_string(),
                    name: "Viewer".to_string(),
                    role: MemberRole::Viewer,
                    label: "View".to_string(),
                    platform: "linux".to_string(),
                    arch: "x86_64".to_string(),
                    hostname: "view-box".to_string(),
                    added_at: "2026-01-02T00:00:00Z".to_string(),
                },
            ],
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();

        let new_member = TeamMember {
            node_id: "new-member".to_string(),
            name: String::new(),
            role: MemberRole::Editor,
            label: "New".to_string(),
            platform: "linux".to_string(),
            arch: "x86_64".to_string(),
            hostname: "new".to_string(),
            added_at: "2026-01-03T00:00:00Z".to_string(),
        };
        let result = add_member_to_team(
            workspace,
            team_dir.to_str().unwrap(),
            viewer_id,
            new_member,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Only team members"));
    }

    #[test]
    fn test_add_duplicate_member_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();

        let owner_id = "owner-123";
        let owner_member = TeamMember {
            node_id: owner_id.to_string(),
            name: String::new(),
            role: MemberRole::Owner,
            label: "Owner".to_string(),
            platform: "macos".to_string(),
            arch: "aarch64".to_string(),
            hostname: "mac".to_string(),
            added_at: "2026-01-01T00:00:00Z".to_string(),
        };
        let config = P2pConfig {
            enabled: true,
            owner_node_id: Some(owner_id.to_string()),
            allowed_members: vec![owner_member.clone()],
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();
        write_members_manifest(
            team_dir.to_str().unwrap(),
            owner_id,
            &[owner_member.clone()],
        )
        .unwrap();

        let result = add_member_to_team(
            workspace,
            team_dir.to_str().unwrap(),
            owner_id,
            owner_member,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("already exists"));
    }

    #[tokio::test]
    async fn test_create_team_sets_owner() {
        let tmp = tempfile::tempdir().unwrap();

        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        let skills_dir = team_dir.join(".claude").join("skills").join("test-skill");
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(skills_dir.join("SKILL.md"), "# Test Skill").unwrap();

        let iroh_tmp = tempfile::tempdir().unwrap();
        let mut node = IrohNode::new(iroh_tmp.path()).await.unwrap();

        let node_id = get_node_id(&node);
        let workspace = tmp.path().to_str().unwrap();

        let ticket = create_team(
            &mut node,
            team_dir.to_str().unwrap(),
            workspace,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert!(!ticket.is_empty(), "should return a ticket");

        let config = read_p2p_config(workspace).unwrap().unwrap();
        assert_eq!(config.owner_node_id.as_deref(), Some(node_id.as_str()));
        assert_eq!(config.allowed_members.len(), 1);
        assert_eq!(config.allowed_members[0].node_id, node_id);
        assert_eq!(config.role, Some(MemberRole::Owner));

        let manifest = read_members_manifest(team_dir.to_str().unwrap()).unwrap();
        assert!(manifest.is_some(), "manifest should exist");
        let manifest = manifest.unwrap();
        assert_eq!(manifest.owner_node_id, node_id);
        assert_eq!(manifest.members.len(), 1);

        node.shutdown().await;
    }

    #[test]
    fn test_write_and_read_members_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();

        let owner_id = "owner-node-id-123";
        let members = vec![
            TeamMember {
                node_id: owner_id.to_string(),
                name: "Owner".to_string(),
                role: MemberRole::Owner,
                label: "Owner".to_string(),
                platform: "macos".to_string(),
                arch: "aarch64".to_string(),
                hostname: "owner-mac".to_string(),
                added_at: "2026-01-01T00:00:00Z".to_string(),
            },
            TeamMember {
                node_id: "member-node-id-456".to_string(),
                name: "Dev".to_string(),
                role: MemberRole::Editor,
                label: "Developer".to_string(),
                platform: "linux".to_string(),
                arch: "x86_64".to_string(),
                hostname: "dev-box".to_string(),
                added_at: "2026-01-02T00:00:00Z".to_string(),
            },
        ];

        write_members_manifest(team_dir.to_str().unwrap(), owner_id, &members).unwrap();

        let manifest = read_members_manifest(team_dir.to_str().unwrap()).unwrap();
        assert!(manifest.is_some(), "manifest should exist");
        let manifest = manifest.unwrap();
        assert_eq!(manifest.owner_node_id, owner_id);
        assert_eq!(manifest.members.len(), 2);
        assert_eq!(manifest.members[0].node_id, owner_id);
        assert_eq!(manifest.members[1].label, "Developer");

        assert!(team_dir.join("_team").join("members.json").exists());
    }

    #[test]
    fn test_p2p_config_with_new_fields_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();

        let config = P2pConfig {
            enabled: true,
            tickets: vec![],
            publish_enabled: true,
            last_sync_at: None,
            owner_node_id: Some("abc123def456".to_string()),
            allowed_members: vec![TeamMember {
                node_id: "abc123def456".to_string(),
                name: "Alice".to_string(),
                role: MemberRole::Owner,
                label: "Owner Device".to_string(),
                platform: "macos".to_string(),
                arch: "aarch64".to_string(),
                hostname: "macbook-pro".to_string(),
                added_at: "2026-01-01T00:00:00Z".to_string(),
            }],
            namespace_id: Some("ns-123".to_string()),
            doc_ticket: Some("docticket-abc".to_string()),
            role: Some(MemberRole::Owner),
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();

        let loaded = read_p2p_config(workspace).unwrap().unwrap();
        assert_eq!(loaded.owner_node_id.as_deref(), Some("abc123def456"));
        assert_eq!(loaded.namespace_id.as_deref(), Some("ns-123"));
        assert_eq!(loaded.doc_ticket.as_deref(), Some("docticket-abc"));
        assert_eq!(loaded.role, Some(MemberRole::Owner));
    }

    #[test]
    fn test_get_device_info_returns_metadata() {
        let info = get_device_metadata();
        assert!(!info.platform.is_empty(), "platform should not be empty");
        assert!(!info.arch.is_empty(), "arch should not be empty");
        assert!(!info.hostname.is_empty(), "hostname should not be empty");
    }

    #[tokio::test]
    async fn test_get_node_id_returns_hex_string() {
        let tmp = tempfile::tempdir().unwrap();
        let node = IrohNode::new(tmp.path()).await.unwrap();

        let node_id = get_node_id(&node);
        assert!(!node_id.is_empty(), "NodeId should not be empty");
        assert!(
            node_id.len() >= 52,
            "NodeId should be a long hex string, got: {}",
            node_id
        );

        node.shutdown().await;
    }

    #[test]
    fn test_p2p_config_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();

        let config = P2pConfig {
            enabled: true,
            tickets: vec![P2pTicketEntry {
                ticket: "iroh://test123".to_string(),
                label: "Team Lead".to_string(),
                added_at: "2026-01-01T00:00:00Z".to_string(),
            }],
            publish_enabled: false,
            last_sync_at: Some("2026-01-01T00:00:00Z".to_string()),
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();

        let loaded = read_p2p_config(workspace).unwrap().unwrap();
        assert!(loaded.enabled);
        assert_eq!(loaded.tickets.len(), 1);
        assert_eq!(loaded.tickets[0].ticket, "iroh://test123");
        assert!(!loaded.publish_enabled);

        // Verify other config keys are preserved
        let config_path = format!(
            "{}/{}/{}",
            workspace,
            crate::commands::TEAMCLAW_DIR,
            crate::commands::CONFIG_FILE_NAME
        );
        let content = std::fs::read_to_string(&config_path).unwrap();
        let mut json: serde_json::Value = serde_json::from_str(&content).unwrap();
        json.as_object_mut().unwrap().insert(
            "team".to_string(),
            serde_json::json!({"gitUrl": "https://example.com/repo.git", "enabled": true}),
        );
        std::fs::write(&config_path, serde_json::to_string_pretty(&json).unwrap()).unwrap();

        let config2 = P2pConfig {
            enabled: false,
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config2)).unwrap();

        let content = std::fs::read_to_string(&config_path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert!(
            json.get("team").is_some(),
            "team config should be preserved"
        );
        assert!(json.get("p2p").is_some(), "p2p config should exist");
        assert_eq!(json["team"]["gitUrl"], "https://example.com/repo.git");
        assert_eq!(json["p2p"]["enabled"], false);
    }
}

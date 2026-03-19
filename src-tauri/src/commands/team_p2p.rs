// P2P team sync via iroh-docs - bidirectional document-based file sharing

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};

use iroh::Endpoint;
use iroh_blobs::store::fs::FsStore;
use iroh_blobs::BlobsProtocol;
use iroh_gossip::net::Gossip;

/// Default storage path for iroh node state
const IROH_STORAGE_DIR: &str = ".teamclaw/iroh";

/// Wraps an iroh endpoint with blobs, gossip, and docs for P2P team file sync.
pub struct IrohNode {
    #[allow(dead_code)]
    endpoint: Endpoint,
    store: FsStore,
    #[allow(dead_code)]
    gossip: Gossip,
    docs: iroh_docs::protocol::Docs,
    router: iroh::protocol::Router,
    author: iroh_docs::AuthorId,
    /// Currently active team document (set after create/join)
    active_doc: Option<iroh_docs::api::Doc>,
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

        let endpoint = Endpoint::builder()
            .bind()
            .await
            .map_err(|e| format!("Failed to bind iroh endpoint: {}", e))?;

        let gossip = Gossip::builder()
            .spawn(endpoint.clone());

        let blobs_store: iroh_blobs::api::Store = store.clone().into();

        let docs = iroh_docs::protocol::Docs::persistent(docs_path)
            .spawn(endpoint.clone(), blobs_store.clone(), gossip.clone())
            .await
            .map_err(|e| format!("Failed to start docs engine: {}", e))?;

        // Get or create a persistent default author
        let author = docs.author_default()
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
    let hostname = gethostname::gethostname()
        .to_string_lossy()
        .to_string();
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
pub async fn get_device_node_id(
    iroh_state: tauri::State<'_, IrohState>,
) -> Result<String, String> {
    let guard = iroh_state.lock().await;
    let node = guard.as_ref().ok_or("P2P node not running")?;
    Ok(get_node_id(node))
}

// ─── File Helpers ────────────────────────────────────────────────────────

/// Collect all files recursively from a directory, returning (relative_path, content) pairs.
fn collect_files(base: &Path, dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    if !dir.exists() {
        return files;
    }
    for entry in walkdir::WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            if let Ok(content) = std::fs::read(entry.path()) {
                if let Ok(rel) = entry.path().strip_prefix(base) {
                    files.push((rel.to_string_lossy().to_string(), content));
                }
            }
        }
    }
    files
}

/// Scaffold the teamclaw-team directory with default structure if it doesn't exist or is empty.
fn scaffold_team_dir(team_dir: &str) -> Result<(), String> {
    let team_path = Path::new(team_dir);

    // Always ensure teamclaw.yaml exists, even if directory already has content
    let teamclaw_yaml_path = team_path.join("teamclaw.yaml");
    let need_scaffold = !team_path.exists() || collect_files(team_path, team_path).is_empty();

    if !need_scaffold {
        // Directory exists with files, but still ensure teamclaw.yaml is present
        if !teamclaw_yaml_path.exists() {
            std::fs::write(&teamclaw_yaml_path, crate::commands::team::DEFAULT_TEAMCLAW_YAML)
                .map_err(|e| format!("Failed to write default teamclaw.yaml: {}", e))?;
            println!("[Team P2P] Created default teamclaw.yaml with team LLM config");
        }
        return Ok(());
    }

    let dirs = ["skills", ".mcp", "knowledge", "_feedback"];
    for d in &dirs {
        std::fs::create_dir_all(team_path.join(d))
            .map_err(|e| format!("Failed to create {}: {}", d, e))?;
    }

    let readme_path = team_path.join("README.md");
    if !readme_path.exists() {
        let readme = "# TeamClaw Team Drive\n\nShared team resources synced via P2P.\n\n## Structure\n\n- `skills/` - Shared agent skills\n- `.mcp/` - MCP server configurations\n- `knowledge/` - Shared knowledge base\n- `_feedback/` - Member feedback summaries (auto-synced)\n";
        std::fs::write(&readme_path, readme)
            .map_err(|e| format!("Failed to write README.md: {}", e))?;
    }

    // Write default teamclaw.yaml with team LLM config if not present
    if !teamclaw_yaml_path.exists() {
        std::fs::write(&teamclaw_yaml_path, crate::commands::team::DEFAULT_TEAMCLAW_YAML)
            .map_err(|e| format!("Failed to write default teamclaw.yaml: {}", e))?;
        println!("[Team P2P] Created default teamclaw.yaml with team LLM config");
    }

    Ok(())
}

// ─── Create / Join (iroh-docs) ──────────────────────────────────────────

/// Create a team: create an iroh-docs document, write files, return a stable DocTicket.
pub async fn create_team(
    node: &mut IrohNode,
    team_dir: &str,
    workspace_path: &str,
) -> Result<String, String> {
    scaffold_team_dir(team_dir)?;

    let node_id = get_node_id(node);
    let info = get_device_metadata();

    let owner_member = TeamMember {
        node_id: node_id.clone(),
        name: String::new(),
        label: info.hostname.clone(),
        platform: info.platform,
        arch: info.arch,
        hostname: info.hostname,
        added_at: chrono::Utc::now().to_rfc3339(),
    };

    write_members_manifest(team_dir, &node_id, &[owner_member.clone()])?;

    // Create a new iroh-docs document
    let doc = node.docs.create()
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
    let ticket = doc.share(
        iroh_docs::api::protocol::ShareMode::Write,
        iroh_docs::api::protocol::AddrInfoOptions::RelayAndAddresses,
    ).await.map_err(|e| format!("Failed to share doc: {}", e))?;

    let ticket_str = ticket.to_string();
    let namespace_id = doc.id().to_string();

    // Start background sync
    let team_dir_owned = team_dir.to_string();
    start_sync_tasks(&doc, node.author, &node.store, &team_dir_owned, node.suppressed_paths.clone());

    node.active_doc = Some(doc);

    // Update P2P config with ownership
    let mut config = read_p2p_config(workspace_path)?.unwrap_or_default();
    config.enabled = true;
    config.publish_enabled = true;
    config.owner_node_id = Some(node_id);
    config.allowed_members = vec![owner_member];
    config.namespace_id = Some(namespace_id);
    config.doc_ticket = Some(ticket_str.clone());
    config.role = Some("owner".to_string());
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
) -> Result<String, String> {
    use std::str::FromStr;

    let ticket = iroh_docs::DocTicket::from_str(ticket_str)
        .map_err(|_| "Invalid ticket format".to_string())?;

    // Import the document — this joins peers and starts syncing
    let doc = node.docs.import(ticket)
        .await
        .map_err(|e| format!("Failed to import doc: {}", e))?;

    // Wait for initial sync
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    // Read all entries and write to disk (need manifest for authorization check)
    let file_count = write_doc_entries_to_disk(&doc, &node.store, team_dir).await?;

    // Check authorization against the downloaded manifest.
    // If not authorized, close the doc and clean up downloaded files.
    let joiner_node_id = get_node_id(node);
    if let Err(auth_err) = check_join_authorization(team_dir, &joiner_node_id) {
        // Close the imported doc — do not keep syncing
        let _ = doc.close().await;
        // Clean up downloaded files
        let _ = std::fs::remove_dir_all(team_dir);
        return Err(auth_err);
    }

    // Write author→node mapping so stats can resolve AuthorId back to NodeId
    let author_meta_key = format!("_meta/authors/{}", node.author);
    doc.set_bytes(node.author, author_meta_key, joiner_node_id.as_bytes().to_vec())
        .await
        .map_err(|e| format!("Failed to write author meta: {}", e))?;

    // Sync MCP configs
    let _ = crate::commands::team::sync_team_mcp_configs(workspace_path);

    let namespace_id = doc.id().to_string();

    // Start background sync
    let team_dir_owned = team_dir.to_string();
    start_sync_tasks(&doc, node.author, &node.store, &team_dir_owned, node.suppressed_paths.clone());

    node.active_doc = Some(doc);

    // Save config
    let mut config = read_p2p_config(workspace_path)?.unwrap_or_default();
    config.enabled = true;
    config.namespace_id = Some(namespace_id);
    config.doc_ticket = Some(ticket_str.to_string());
    config.role = Some("member".to_string());
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
    let entries = doc.get_many(query)
        .await
        .map_err(|e| format!("Failed to query doc entries: {}", e))?;
    let mut entries = pin!(entries);

    let team_path = Path::new(team_dir);
    std::fs::create_dir_all(team_path)
        .map_err(|e| format!("Failed to create team dir: {}", e))?;

    let mut file_count = 0;
    while let Some(entry_result) = entries.next().await {
        let entry = entry_result.map_err(|e| format!("Failed to read entry: {}", e))?;
        let key = String::from_utf8_lossy(entry.key()).to_string();
        let content_hash = entry.content_hash();

        // Skip empty entries (tombstones for deleted files)
        if entry.content_len() == 0 {
            let file_path = team_path.join(&key);
            if file_path.exists() {
                let _ = std::fs::remove_file(&file_path);
            }
            continue;
        }

        let content = blobs_store.blobs().get_bytes(content_hash)
            .await
            .map_err(|e| format!("Failed to read content for '{}': {}", key, e))?;

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

/// Publish (re-sync) current files into the active doc.
/// Used when the user manually triggers a sync or after file changes.
pub async fn publish_team_drive(node: &IrohNode, team_dir: &str) -> Result<String, String> {
    let doc = node.active_doc.as_ref()
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
    create_team(node, team_dir, workspace_path).await
}

// ─── Background Sync Tasks ──────────────────────────────────────────────

/// Start background tasks for bidirectional sync between doc and filesystem.
fn start_sync_tasks(
    doc: &iroh_docs::api::Doc,
    author: iroh_docs::AuthorId,
    store: &FsStore,
    team_dir: &str,
    suppressed_paths: Arc<Mutex<HashSet<std::path::PathBuf>>>,
) {
    let blobs_store: iroh_blobs::api::Store = store.clone().into();
    let team_dir_a = team_dir.to_string();
    let doc_a = doc.clone();
    let suppressed_a = suppressed_paths.clone();

    // Task A: remote doc changes → disk
    tokio::spawn(async move {
        doc_to_disk_watcher(doc_a, blobs_store, team_dir_a, suppressed_a).await;
    });

    // Task B: local disk changes → doc (with blob store for skills counting)
    let doc_b = doc.clone();
    let blobs_store_b: iroh_blobs::api::Store = store.clone().into();
    let team_dir_b = team_dir.to_string();
    let suppressed_b = suppressed_paths;
    tokio::spawn(async move {
        disk_to_doc_watcher(doc_b, blobs_store_b, author, team_dir_b, suppressed_b).await;
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

    // Remove suppression after a short delay
    let suppressed_clone = suppressed_paths.clone();
    let file_path_clone = file_path.to_path_buf();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
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
) {
    use futures_lite::StreamExt;
    use iroh_docs::engine::LiveEvent;

    let mut events = match doc.subscribe().await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[P2P] Failed to subscribe to doc events: {}", e);
            return;
        }
    };

    while let Some(event_result) = events.next().await {
        let event = match event_result {
            Ok(e) => e,
            Err(_) => continue,
        };

        match event {
            LiveEvent::InsertRemote { entry, content_status, .. } => {
                // Only process if content is already available locally
                if content_status != iroh_docs::ContentStatus::Complete {
                    continue;
                }

                let key = String::from_utf8_lossy(entry.key()).to_string();
                let file_path = Path::new(&team_dir).join(&key);

                if entry.content_len() == 0 {
                    let _ = std::fs::remove_file(&file_path);
                    continue;
                }

                let content = match blobs_store.blobs().get_bytes(entry.content_hash()).await {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                write_and_suppress(&file_path, &content, &suppressed_paths).await;
            }
            LiveEvent::ContentReady { hash } => {
                // Content just became available — find matching entries and write to disk
                let query = iroh_docs::store::Query::single_latest_per_key().build();
                if let Ok(entries) = doc.get_many(query).await {
                    let mut entries = std::pin::pin!(entries);
                    while let Some(Ok(entry)) = entries.next().await {
                        if entry.content_hash() == hash {
                            let key = String::from_utf8_lossy(entry.key()).to_string();
                            let file_path = Path::new(&team_dir).join(&key);

                            if let Ok(content) = blobs_store.blobs().get_bytes(hash).await {
                                write_and_suppress(&file_path, &content, &suppressed_paths).await;
                            }
                            break;
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

/// Watch filesystem for local changes and write them to the doc.
async fn disk_to_doc_watcher(
    doc: iroh_docs::api::Doc,
    blobs_store: iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
    team_dir: String,
    suppressed_paths: Arc<Mutex<HashSet<std::path::PathBuf>>>,
) {
    use notify::{Watcher, RecursiveMode};

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
                            let key = rel.to_string_lossy().to_string();
                            if let Ok(content) = std::fs::read(path) {
                                if let Err(e) = doc.set_bytes(author, key.clone(), content).await {
                                    eprintln!("[P2P] Failed to sync local change '{}': {}", key, e);
                                }
                                // Track skill file contributions for leaderboard
                                if path.file_name().map_or(false, |n| {
                                    n.eq_ignore_ascii_case("SKILL.md")
                                }) {
                                    increment_skills_count(&doc, &blobs_store, author).await;
                                }
                            }
                        }
                    }
                }
                notify::EventKind::Remove(_) => {
                    for path in &event.paths {
                        if let Ok(rel) = path.strip_prefix(&team_dir) {
                            let key = rel.to_string_lossy().to_string();
                            // Write empty content as tombstone
                            let _ = doc.set_bytes(author, key, Vec::<u8>::new()).await;
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
/// Returns Ok(()) if authorized or if no manifest exists (backwards compatibility).
pub fn check_join_authorization(team_dir: &str, joiner_node_id: &str) -> Result<(), String> {
    match read_members_manifest(team_dir)? {
        None => Ok(()), // No manifest = backwards compatible, allow all
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

/// A team member entry in the allowlist.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub node_id: String,
    /// Human-readable display name for this member (e.g. "Alice", "Bob")
    #[serde(default)]
    pub name: String,
    pub label: String,
    pub platform: String,
    pub arch: String,
    pub hostname: String,
    pub added_at: String,
}

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
    /// Role in the team: "owner" or "member"
    #[serde(default)]
    pub role: Option<String>,
}

/// Read P2P config from teamclaw.json in the workspace.
pub fn read_p2p_config(workspace_path: &str) -> Result<Option<P2pConfig>, String> {
    let config_path = format!("{}/{}/teamclaw.json", workspace_path, crate::commands::TEAMCLAW_DIR);

    if !Path::new(&config_path).exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read teamclaw.json: {}", e))?;

    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse teamclaw.json: {}", e))?;

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
) -> Result<(), String> {
    let teamclaw_dir = format!("{}/{}", workspace_path, crate::commands::TEAMCLAW_DIR);
    let _ = std::fs::create_dir_all(&teamclaw_dir);
    let config_path = format!("{}/teamclaw.json", teamclaw_dir);

    let mut json: serde_json::Value = if Path::new(&config_path).exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read teamclaw.json: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse teamclaw.json: {}", e))?
    } else {
        serde_json::json!({
            "$schema": "https://opencode.ai/config.json"
        })
    };

    if let Some(p2p_config) = config {
        let p2p_val = serde_json::to_value(p2p_config)
            .map_err(|e| format!("Failed to serialize p2p config: {}", e))?;
        json.as_object_mut()
            .ok_or("teamclaw.json is not an object")?
            .insert("p2p".to_string(), p2p_val);
    } else {
        json.as_object_mut()
            .ok_or("teamclaw.json is not an object")?
            .remove("p2p");
    }

    let content = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write teamclaw.json: {}", e))
}

// ─── Team Members Manifest ───────────────────────────────────────────────

/// The `_team/members.json` manifest stored in the team drive.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamManifest {
    pub owner_node_id: String,
    pub members: Vec<TeamMember>,
}

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

// ─── Disconnect ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn p2p_disconnect_source(
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set")?;

    // Close active doc
    let mut guard = iroh_state.lock().await;
    if let Some(node) = guard.as_mut() {
        if let Some(doc) = node.active_doc.take() {
            let _ = doc.leave().await;
        }
    }
    drop(guard);

    let mut config = read_p2p_config(&workspace_path)?.unwrap_or_default();
    config.enabled = false;
    config.namespace_id = None;
    config.doc_ticket = None;
    config.role = None;
    write_p2p_config(&workspace_path, Some(&config))?;

    // Remove teamclaw-team directory
    let team_dir = format!("{}/teamclaw-team", workspace_path);
    if Path::new(&team_dir).exists() {
        std::fs::remove_dir_all(&team_dir)
            .map_err(|e| format!("Failed to remove team directory: {}", e))?;
    }

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

    let owner_id = config.owner_node_id.as_deref()
        .ok_or("No team owner configured")?;
    if owner_id != caller_node_id {
        return Err("Only the team owner can manage members".to_string());
    }

    if config.allowed_members.iter().any(|m| m.node_id == member.node_id) {
        return Err("Member already exists".to_string());
    }

    config.allowed_members.push(member);
    write_p2p_config(workspace_path, Some(&config))?;

    write_members_manifest(
        team_dir,
        caller_node_id,
        &config.allowed_members,
    )?;

    Ok(())
}

/// Remove a member from the team allowlist. Only the owner can call this.
pub fn remove_member_from_team(
    workspace_path: &str,
    team_dir: &str,
    caller_node_id: &str,
    target_node_id: &str,
) -> Result<(), String> {
    let mut config = read_p2p_config(workspace_path)?.unwrap_or_default();

    let owner_id = config.owner_node_id.as_deref()
        .ok_or("No team owner configured")?;
    if owner_id != caller_node_id {
        return Err("Only the team owner can manage members".to_string());
    }

    if target_node_id == caller_node_id {
        return Err("Cannot remove the team owner".to_string());
    }

    let before_len = config.allowed_members.len();
    config.allowed_members.retain(|m| m.node_id != target_node_id);
    if config.allowed_members.len() == before_len {
        return Err("Member not found".to_string());
    }

    write_p2p_config(workspace_path, Some(&config))?;
    write_members_manifest(team_dir, caller_node_id, &config.allowed_members)?;

    Ok(())
}

#[tauri::command]
pub async fn team_add_member(
    node_id: String,
    name: String,
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set")?;

    let guard = iroh_state.lock().await;
    let node = guard.as_ref().ok_or("P2P node not running")?;
    let caller_id = get_node_id(node);
    drop(guard);

    let member = TeamMember {
        node_id,
        name,
        label: String::new(),
        platform: String::new(),
        arch: String::new(),
        hostname: String::new(),
        added_at: chrono::Utc::now().to_rfc3339(),
    };

    let team_dir = format!("{}/teamclaw-team", workspace_path);
    add_member_to_team(&workspace_path, &team_dir, &caller_id, member)?;

    // Also write updated manifest into the doc so it syncs
    let guard = iroh_state.lock().await;
    if let Some(node) = guard.as_ref() {
        if let Some(doc) = &node.active_doc {
            let manifest_path = format!("{}/teamclaw-team/_team/members.json", workspace_path);
            if let Ok(content) = std::fs::read(&manifest_path) {
                let _ = doc.set_bytes(node.author, "_team/members.json", content).await;
            }
        }
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
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set")?;

    let guard = iroh_state.lock().await;
    let node = guard.as_ref().ok_or("P2P node not running")?;
    let caller_id = get_node_id(node);
    drop(guard);

    let team_dir = format!("{}/teamclaw-team", workspace_path);
    remove_member_from_team(&workspace_path, &team_dir, &caller_id, &node_id)?;

    // Also write updated manifest into the doc so it syncs
    let guard = iroh_state.lock().await;
    if let Some(node) = guard.as_ref() {
        if let Some(doc) = &node.active_doc {
            let manifest_path = format!("{}/teamclaw-team/_team/members.json", workspace_path);
            if let Ok(content) = std::fs::read(&manifest_path) {
                let _ = doc.set_bytes(node.author, "_team/members.json", content).await;
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
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set")?;

    let team_dir = format!("{}/teamclaw-team", workspace_path);
    let exists = Path::new(&team_dir).exists();
    let has_members = Path::new(&team_dir).join("_team").join("members.json").exists();

    Ok(serde_json::json!({
        "exists": exists,
        "hasMembers": has_members,
    }))
}

#[tauri::command]
pub async fn p2p_create_team(
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<String, String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set")?;

    let mut guard = iroh_state.lock().await;
    let node = guard.as_mut().ok_or("P2P node not running")?;

    let team_dir = format!("{}/teamclaw-team", workspace_path);
    create_team(node, &team_dir, &workspace_path).await
}

#[tauri::command]
pub async fn p2p_publish_drive(
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<String, String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set")?;

    let mut guard = iroh_state.lock().await;
    let node = guard.as_mut().ok_or("P2P node not running")?;

    let team_dir = format!("{}/teamclaw-team", workspace_path);

    // If no active doc, create a team (first-time publish)
    if node.active_doc.is_none() {
        return create_team(node, &team_dir, &workspace_path).await;
    }

    // Otherwise, sync current files into existing doc and return saved ticket
    publish_team_drive(node, &team_dir).await?;

    let config = read_p2p_config(&workspace_path)?;
    config
        .and_then(|c| c.doc_ticket)
        .ok_or_else(|| "No ticket available".to_string())
}

#[tauri::command]
pub async fn p2p_join_drive(
    ticket: String,
    #[allow(unused_variables)]
    label: String,
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<String, String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set")?;

    let mut guard = iroh_state.lock().await;
    let node = guard.as_mut().ok_or("P2P node not running")?;

    let team_dir = format!("{}/teamclaw-team", workspace_path);
    join_team_drive(node, &ticket, &team_dir, &workspace_path).await
}

/// Reconnect to an existing team document on app restart.
#[tauri::command]
pub async fn p2p_reconnect(
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set")?;

    let config = read_p2p_config(&workspace_path)?;
    let config = match config {
        Some(c) if c.enabled && c.namespace_id.is_some() => c,
        _ => return Ok(()), // No team to reconnect to
    };

    let namespace_id_str = config.namespace_id.as_ref().unwrap();

    let mut guard = iroh_state.lock().await;
    let node = guard.as_mut().ok_or("P2P node not running")?;

    // Skip if already connected
    if node.active_doc.is_some() {
        return Ok(());
    }

    // Try to open the existing document from local storage
    let namespace_id = namespace_id_str.parse::<iroh_docs::NamespaceId>()
        .map_err(|e| format!("Invalid namespace ID: {}", e))?;

    let doc = node.docs.open(namespace_id)
        .await
        .map_err(|e| format!("Failed to open doc: {}", e))?
        .ok_or("Team document not found in local storage")?;

    // Start background sync
    let team_dir = format!("{}/teamclaw-team", workspace_path);
    start_sync_tasks(&doc, node.author, &node.store, &team_dir, node.suppressed_paths.clone());

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
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set")?;

    let mut guard = iroh_state.lock().await;
    let node = guard.as_mut().ok_or("P2P node not running")?;

    let team_dir = format!("{}/teamclaw-team", workspace_path);
    rotate_namespace(node, &team_dir, &workspace_path).await
}

#[tauri::command]
pub async fn get_p2p_config(
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<Option<P2pConfig>, String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
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
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
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
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set")?;

    let config = read_p2p_config(&workspace_path)?.unwrap_or_default();
    let guard = iroh_state.lock().await;
    let has_active_doc = guard.as_ref().map_or(false, |n| n.active_doc.is_some());

    Ok(P2pSyncStatus {
        connected: has_active_doc,
        role: config.role,
        doc_ticket: config.doc_ticket,
        namespace_id: config.namespace_id,
        last_sync_at: config.last_sync_at,
        members: config.allowed_members,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pSyncStatus {
    pub connected: bool,
    pub role: Option<String>,
    pub doc_ticket: Option<String>,
    pub namespace_id: Option<String>,
    pub last_sync_at: Option<String>,
    pub members: Vec<TeamMember>,
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
                Ok(bytes) => String::from_utf8_lossy(&bytes)
                    .trim()
                    .parse()
                    .unwrap_or(0),
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
async fn query_skills_leaderboard(
    node: &IrohNode,
) -> Result<Vec<SkillsContribution>, String> {
    use futures_lite::StreamExt;
    use std::collections::HashMap;
    use std::pin::pin;

    let doc = node
        .active_doc
        .as_ref()
        .ok_or("No active team document")?;
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
                    Ok(bytes) => String::from_utf8_lossy(&bytes)
                        .trim()
                        .parse()
                        .unwrap_or(0),
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
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();

        let result = join_team_drive(&mut node, "garbage-not-a-ticket", team_dir.to_str().unwrap(), tmp.path().to_str().unwrap()).await;
        assert!(result.is_err(), "should fail with invalid ticket");
        assert!(result.unwrap_err().contains("Invalid ticket"), "error should mention invalid ticket");

        node.shutdown().await;
    }

    #[tokio::test]
    async fn test_create_team_produces_doc_ticket() {
        let tmp = tempfile::tempdir().unwrap();

        // Create a team dir with some skill files
        let team_dir = tmp.path().join("teamclaw-team");
        let skills_dir = team_dir.join(".claude").join("skills").join("test-skill");
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(skills_dir.join("SKILL.md"), "# Test Skill\nHello").unwrap();

        let iroh_tmp = tempfile::tempdir().unwrap();
        let mut node = IrohNode::new(iroh_tmp.path()).await.unwrap();

        let ticket = create_team(
            &mut node,
            team_dir.to_str().unwrap(),
            tmp.path().to_str().unwrap(),
        ).await.unwrap();

        assert!(!ticket.is_empty(), "ticket should not be empty");
        // DocTicket should be parseable
        assert!(ticket.parse::<iroh_docs::DocTicket>().is_ok(), "should be a valid DocTicket");

        // Verify config was written with new fields
        let config = read_p2p_config(tmp.path().to_str().unwrap()).unwrap().unwrap();
        assert!(config.namespace_id.is_some());
        assert!(config.doc_ticket.is_some());
        assert_eq!(config.role.as_deref(), Some("owner"));

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
            role: Some("owner".to_string()),
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
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();

        let member_id = "was-a-member-789";

        let members = vec![
            TeamMember { node_id: "owner-456".to_string(), name: String::new(), label: "Owner".to_string(), platform: "macos".to_string(), arch: "aarch64".to_string(), hostname: "mac".to_string(), added_at: "2026-01-01T00:00:00Z".to_string() },
            TeamMember { node_id: member_id.to_string(), name: String::new(), label: "Member".to_string(), platform: "linux".to_string(), arch: "x86_64".to_string(), hostname: "dev".to_string(), added_at: "2026-01-02T00:00:00Z".to_string() },
        ];
        write_members_manifest(team_dir.to_str().unwrap(), "owner-456", &members).unwrap();
        assert!(check_join_authorization(team_dir.to_str().unwrap(), member_id).is_ok());

        let members_after = vec![
            TeamMember { node_id: "owner-456".to_string(), name: String::new(), label: "Owner".to_string(), platform: "macos".to_string(), arch: "aarch64".to_string(), hostname: "mac".to_string(), added_at: "2026-01-01T00:00:00Z".to_string() },
        ];
        write_members_manifest(team_dir.to_str().unwrap(), "owner-456", &members_after).unwrap();

        let result = check_join_authorization(team_dir.to_str().unwrap(), member_id);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Not authorized"));
    }

    #[test]
    fn test_join_authorized_succeeds() {
        let tmp = tempfile::tempdir().unwrap();
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();

        let joiner_id = "joiner-node-123";
        let members = vec![
            TeamMember { node_id: "owner-456".to_string(), name: String::new(), label: "Owner".to_string(), platform: "macos".to_string(), arch: "aarch64".to_string(), hostname: "mac".to_string(), added_at: "2026-01-01T00:00:00Z".to_string() },
            TeamMember { node_id: joiner_id.to_string(), name: String::new(), label: "Joiner".to_string(), platform: "linux".to_string(), arch: "x86_64".to_string(), hostname: "dev".to_string(), added_at: "2026-01-02T00:00:00Z".to_string() },
        ];
        write_members_manifest(team_dir.to_str().unwrap(), "owner-456", &members).unwrap();

        let result = check_join_authorization(team_dir.to_str().unwrap(), joiner_id);
        assert!(result.is_ok(), "authorized joiner should succeed");
    }

    #[test]
    fn test_join_unauthorized_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();

        let members = vec![
            TeamMember { node_id: "owner-456".to_string(), name: String::new(), label: "Owner".to_string(), platform: "macos".to_string(), arch: "aarch64".to_string(), hostname: "mac".to_string(), added_at: "2026-01-01T00:00:00Z".to_string() },
        ];
        write_members_manifest(team_dir.to_str().unwrap(), "owner-456", &members).unwrap();

        let result = check_join_authorization(team_dir.to_str().unwrap(), "unauthorized-789");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Not authorized"), "error: {}", err);
        assert!(err.contains("unauthorized-789"), "should include joiner's NodeId: {}", err);
    }

    #[test]
    fn test_join_no_manifest_succeeds() {
        let tmp = tempfile::tempdir().unwrap();
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();

        let result = check_join_authorization(team_dir.to_str().unwrap(), "any-node-id");
        assert!(result.is_ok(), "should succeed without manifest (backwards compat)");
    }

    #[test]
    fn test_remove_member_succeeds() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();

        let owner_id = "owner-123";
        let members = vec![
            TeamMember { node_id: owner_id.to_string(), name: String::new(), label: "Owner".to_string(), platform: "macos".to_string(), arch: "aarch64".to_string(), hostname: "mac".to_string(), added_at: "2026-01-01T00:00:00Z".to_string() },
            TeamMember { node_id: "member-456".to_string(), name: String::new(), label: "Dev".to_string(), platform: "linux".to_string(), arch: "x86_64".to_string(), hostname: "dev".to_string(), added_at: "2026-01-02T00:00:00Z".to_string() },
        ];
        let config = P2pConfig {
            enabled: true,
            owner_node_id: Some(owner_id.to_string()),
            allowed_members: members.clone(),
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();
        write_members_manifest(team_dir.to_str().unwrap(), owner_id, &members).unwrap();

        remove_member_from_team(workspace, team_dir.to_str().unwrap(), owner_id, "member-456").unwrap();

        let config = read_p2p_config(workspace).unwrap().unwrap();
        assert_eq!(config.allowed_members.len(), 1);
        assert_eq!(config.allowed_members[0].node_id, owner_id);
    }

    #[test]
    fn test_remove_self_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();

        let owner_id = "owner-123";
        let config = P2pConfig {
            enabled: true,
            owner_node_id: Some(owner_id.to_string()),
            allowed_members: vec![TeamMember { node_id: owner_id.to_string(), name: String::new(), label: "Owner".to_string(), platform: "macos".to_string(), arch: "aarch64".to_string(), hostname: "mac".to_string(), added_at: "2026-01-01T00:00:00Z".to_string() }],
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();

        let result = remove_member_from_team(workspace, team_dir.to_str().unwrap(), owner_id, owner_id);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Cannot remove the team owner"));
    }

    #[test]
    fn test_remove_member_non_owner_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();

        let config = P2pConfig {
            enabled: true,
            owner_node_id: Some("real-owner".to_string()),
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();

        let result = remove_member_from_team(workspace, team_dir.to_str().unwrap(), "not-owner", "some-member");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Only the team owner"));
    }

    #[test]
    fn test_add_member_succeeds_for_owner() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();

        let owner_id = "owner-node-123";
        let owner_member = TeamMember {
            node_id: owner_id.to_string(),
            name: String::new(),
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
            label: "Developer".to_string(),
            platform: "linux".to_string(),
            arch: "x86_64".to_string(),
            hostname: "dev-box".to_string(),
            added_at: "2026-01-02T00:00:00Z".to_string(),
        };
        add_member_to_team(workspace, team_dir.to_str().unwrap(), owner_id, new_member).unwrap();

        let config = read_p2p_config(workspace).unwrap().unwrap();
        assert_eq!(config.allowed_members.len(), 2);

        let manifest = read_members_manifest(team_dir.to_str().unwrap()).unwrap().unwrap();
        assert_eq!(manifest.members.len(), 2);
        assert_eq!(manifest.members[1].node_id, "new-member-456");
    }

    #[test]
    fn test_add_member_fails_for_non_owner() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();

        let config = P2pConfig {
            enabled: true,
            owner_node_id: Some("real-owner".to_string()),
            ..Default::default()
        };
        write_p2p_config(workspace, Some(&config)).unwrap();

        let member = TeamMember {
            node_id: "new-member".to_string(),
            name: String::new(),
            label: "Hacker".to_string(),
            platform: "linux".to_string(),
            arch: "x86_64".to_string(),
            hostname: "hack-box".to_string(),
            added_at: "2026-01-01T00:00:00Z".to_string(),
        };
        let result = add_member_to_team(workspace, team_dir.to_str().unwrap(), "not-the-owner", member);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Only the team owner"));
    }

    #[test]
    fn test_add_duplicate_member_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();

        let owner_id = "owner-123";
        let owner_member = TeamMember {
            node_id: owner_id.to_string(),
            name: String::new(),
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
        write_members_manifest(team_dir.to_str().unwrap(), owner_id, &[owner_member.clone()]).unwrap();

        let result = add_member_to_team(workspace, team_dir.to_str().unwrap(), owner_id, owner_member);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("already exists"));
    }

    #[tokio::test]
    async fn test_create_team_sets_owner() {
        let tmp = tempfile::tempdir().unwrap();

        let team_dir = tmp.path().join("teamclaw-team");
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
        ).await.unwrap();

        assert!(!ticket.is_empty(), "should return a ticket");

        let config = read_p2p_config(workspace).unwrap().unwrap();
        assert_eq!(config.owner_node_id.as_deref(), Some(node_id.as_str()));
        assert_eq!(config.allowed_members.len(), 1);
        assert_eq!(config.allowed_members[0].node_id, node_id);
        assert_eq!(config.role.as_deref(), Some("owner"));

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
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();

        let owner_id = "owner-node-id-123";
        let members = vec![
            TeamMember {
                node_id: owner_id.to_string(),
                name: "Owner".to_string(),
                label: "Owner".to_string(),
                platform: "macos".to_string(),
                arch: "aarch64".to_string(),
                hostname: "owner-mac".to_string(),
                added_at: "2026-01-01T00:00:00Z".to_string(),
            },
            TeamMember {
                node_id: "member-node-id-456".to_string(),
                name: "Dev".to_string(),
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
                label: "Owner Device".to_string(),
                platform: "macos".to_string(),
                arch: "aarch64".to_string(),
                hostname: "macbook-pro".to_string(),
                added_at: "2026-01-01T00:00:00Z".to_string(),
            }],
            namespace_id: Some("ns-123".to_string()),
            doc_ticket: Some("docticket-abc".to_string()),
            role: Some("owner".to_string()),
        };
        write_p2p_config(workspace, Some(&config)).unwrap();

        let loaded = read_p2p_config(workspace).unwrap().unwrap();
        assert_eq!(loaded.owner_node_id.as_deref(), Some("abc123def456"));
        assert_eq!(loaded.namespace_id.as_deref(), Some("ns-123"));
        assert_eq!(loaded.doc_ticket.as_deref(), Some("docticket-abc"));
        assert_eq!(loaded.role.as_deref(), Some("owner"));
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
        assert!(node_id.len() >= 52, "NodeId should be a long hex string, got: {}", node_id);

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
        let config_path = format!("{}/{}/teamclaw.json", workspace, crate::commands::TEAMCLAW_DIR);
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
        assert!(json.get("team").is_some(), "team config should be preserved");
        assert!(json.get("p2p").is_some(), "p2p config should exist");
        assert_eq!(json["team"]["gitUrl"], "https://example.com/repo.git");
        assert_eq!(json["p2p"]["enabled"], false);
    }
}

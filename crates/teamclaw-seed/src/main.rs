// teamclaw-seed: Multi-tenant always-on Iroh seed node for TeamClaw P2P team sync.
//
// Usage:
//   teamclaw-seed [--data-dir <PATH>] [--port <PORT>] [--api-key <KEY>]
//
// Public endpoints (require team secret):
//   GET  /health                                     — node status
//   GET  /node-id                                    — seed node ID
//   POST /teams/:id/ticket  { "teamSecret": "..." }  — get DocTicket
//   POST /teams/:id/apply        { "teamSecret": "...", "nodeId": "...", ... }
//   POST /teams/:id/applications { "teamSecret": "..." }  — list pending applications
//   POST /teams/:id/applications/:nid/approve { "teamSecret": "..." }
//   POST /teams/:id/applications/:nid/reject  { "teamSecret": "..." }
//
// Admin endpoints (require `Authorization: Bearer <API_KEY>`):
//   POST   /admin/teams  { "ticket": "...", "label": "...", "teamSecret": "..." }
//   DELETE /admin/teams/:namespace_id
//   GET    /admin/teams
//   GET    /admin/teams/:namespace_id/applications
//   POST   /admin/teams/:namespace_id/applications/:node_id/approve
//   DELETE /admin/teams/:namespace_id/applications/:node_id

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use iroh::{Endpoint, SecretKey};
use iroh_blobs::store::fs::FsStore;
use iroh_blobs::BlobsProtocol;
use iroh_gossip::net::Gossip;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

// ─── Config ──────────────────────────────────────────────────────────────

struct Config {
    data_dir: PathBuf,
    port: u16,
    api_key: Option<String>,
}

fn parse_config() -> Config {
    let mut args = std::env::args().skip(1);
    let mut data_dir: Option<PathBuf> = None;
    let mut port: u16 = 9090;
    let mut api_key: Option<String> = std::env::var("SEED_API_KEY").ok();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" | "-d" => data_dir = args.next().map(PathBuf::from),
            "--port" | "-p" => {
                port = args.next().and_then(|s| s.parse().ok()).unwrap_or(9090);
            }
            "--api-key" | "-k" => api_key = args.next(),
            "--help" | "-h" => {
                eprintln!(
                    "teamclaw-seed: Multi-tenant Iroh seed node for TeamClaw\n\n\
                     Usage:\n  \
                       teamclaw-seed [--data-dir <PATH>] [--port <PORT>] [--api-key <KEY>]\n\n\
                     Options:\n  \
                       --data-dir, -d  Storage directory (default: ~/.teamclaw-seed/)\n  \
                       --port, -p      HTTP API port (default: 9090)\n  \
                       --api-key, -k   API key for admin endpoints (or SEED_API_KEY env var)\n\n\
                     Public API (require team secret):\n  \
                       GET  /health\n  \
                       GET  /node-id\n  \
                       POST /teams/:id/ticket    Get DocTicket\n  \
                       POST /teams/:id/apply     Submit join application\n\n\
                     Admin API (require Bearer token):\n  \
                       POST   /admin/teams                           Add team\n  \
                       GET    /admin/teams                           List teams\n  \
                       DELETE /admin/teams/:id                       Remove team\n  \
                       GET    /admin/teams/:id/applications          List applications\n  \
                       POST   /admin/teams/:id/applications/:nid/approve\n  \
                       DELETE /admin/teams/:id/applications/:nid     Reject"
                );
                std::process::exit(0);
            }
            _ => {
                eprintln!("Unknown argument: {}", arg);
                std::process::exit(1);
            }
        }
    }

    let data_dir = data_dir.unwrap_or_else(|| {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        PathBuf::from(home).join(".teamclaw-seed")
    });

    Config {
        data_dir,
        port,
        api_key,
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

// ─── Iroh Node ───────────────────────────────────────────────────────────

struct SeedNode {
    #[allow(dead_code)]
    endpoint: Endpoint,
    #[allow(dead_code)]
    store: FsStore,
    #[allow(dead_code)]
    gossip: Gossip,
    docs: iroh_docs::protocol::Docs,
    router: iroh::protocol::Router,
}

impl SeedNode {
    async fn new(storage_path: &Path) -> Result<Self, String> {
        let blob_path = storage_path.join("blobs");
        let docs_path = storage_path.join("docs");
        std::fs::create_dir_all(&blob_path)
            .map_err(|e| format!("Failed to create blob dir: {}", e))?;
        std::fs::create_dir_all(&docs_path)
            .map_err(|e| format!("Failed to create docs dir: {}", e))?;

        let store = FsStore::load(&blob_path)
            .await
            .map_err(|e| format!("Failed to create blob store: {}", e))?;

        let secret_key = load_or_create_secret_key(storage_path)?;
        let endpoint = Endpoint::builder()
            .secret_key(secret_key)
            .bind()
            .await
            .map_err(|e| format!("Failed to bind endpoint: {}", e))?;

        let gossip = Gossip::builder().spawn(endpoint.clone());
        let blobs_store: iroh_blobs::api::Store = store.clone().into();

        let docs = iroh_docs::protocol::Docs::persistent(docs_path)
            .spawn(endpoint.clone(), blobs_store.clone(), gossip.clone())
            .await
            .map_err(|e| format!("Failed to start docs engine: {}", e))?;

        let blobs_protocol = BlobsProtocol::new(&store, None);
        let router = iroh::protocol::Router::builder(endpoint.clone())
            .accept(iroh_blobs::ALPN, blobs_protocol)
            .accept(iroh_gossip::net::GOSSIP_ALPN, gossip.clone())
            .accept(iroh_docs::ALPN, docs.clone())
            .spawn();

        Ok(SeedNode {
            endpoint,
            store,
            gossip,
            docs,
            router,
        })
    }

    fn node_id(&self) -> String {
        self.router.endpoint().addr().id.to_string()
    }
}

fn load_or_create_secret_key(storage_path: &Path) -> Result<SecretKey, String> {
    let key_path = storage_path.join("secret_key");

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
        .map_err(|e| format!("Failed to create storage dir: {}", e))?;
    std::fs::write(&key_path, key.to_bytes())
        .map_err(|e| format!("Failed to write secret key: {}", e))?;
    Ok(key)
}

// ─── Team Registry (persisted to disk) ──────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TeamEntry {
    namespace_id: String,
    ticket: String,
    label: String,
    /// SHA-256 hash of the team secret
    team_secret_hash: String,
    added_at: String,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct TeamRegistry {
    teams: Vec<TeamEntry>,
}

fn registry_path(data_dir: &Path) -> PathBuf {
    data_dir.join("teams.json")
}

fn load_registry(data_dir: &Path) -> TeamRegistry {
    let path = registry_path(data_dir);
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(reg) = serde_json::from_str(&content) {
                return reg;
            }
        }
    }
    TeamRegistry::default()
}

fn save_registry(data_dir: &Path, registry: &TeamRegistry) -> Result<(), String> {
    let path = registry_path(data_dir);
    let content = serde_json::to_string_pretty(registry)
        .map_err(|e| format!("Failed to serialize registry: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write registry: {}", e))
}

// ─── Applications (persisted per team) ──────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Application {
    node_id: String,
    name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    platform: String,
    #[serde(default)]
    arch: String,
    #[serde(default)]
    hostname: String,
    applied_at: String,
}

fn applications_path(data_dir: &Path, namespace_id: &str) -> PathBuf {
    data_dir
        .join("applications")
        .join(format!("{}.json", namespace_id))
}

fn load_applications(data_dir: &Path, namespace_id: &str) -> Vec<Application> {
    let path = applications_path(data_dir, namespace_id);
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(apps) = serde_json::from_str(&content) {
                return apps;
            }
        }
    }
    Vec::new()
}

fn save_applications(
    data_dir: &Path,
    namespace_id: &str,
    apps: &[Application],
) -> Result<(), String> {
    let path = applications_path(data_dir, namespace_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let content = serde_json::to_string_pretty(apps)
        .map_err(|e| format!("Failed to serialize applications: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write applications: {}", e))
}

// ─── Per-Team Sync Stats ────────────────────────────────────────────────

#[derive(Default, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TeamStats {
    entries_synced: u64,
    bytes_synced: u64,
    blobs_ready: u64,
    peers_seen: u64,
}

// ─── Blob Sync Loop (per team) ──────────────────────────────────────────

async fn blob_sync_loop(
    namespace_id: String,
    doc: iroh_docs::api::Doc,
    stats: Arc<Mutex<TeamStats>>,
) {
    use futures_lite::StreamExt;
    use iroh_docs::engine::LiveEvent;

    let mut events = match doc.subscribe().await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[seed:{}] Failed to subscribe: {}", &namespace_id[..8], e);
            return;
        }
    };

    let ns_short = &namespace_id[..8];
    eprintln!("[seed:{}] Sync loop started", ns_short);

    while let Some(event_result) = events.next().await {
        let event = match event_result {
            Ok(e) => e,
            Err(_) => continue,
        };

        match event {
            LiveEvent::InsertRemote {
                entry,
                content_status,
                ..
            } => {
                let key = String::from_utf8_lossy(entry.key()).to_string();
                let status_str = match content_status {
                    iroh_docs::ContentStatus::Complete => "complete",
                    iroh_docs::ContentStatus::Incomplete => "downloading",
                    iroh_docs::ContentStatus::Missing => "missing",
                };
                eprintln!(
                    "[seed:{}] {} ({} bytes, {})",
                    ns_short,
                    key,
                    entry.content_len(),
                    status_str,
                );
                let mut s = stats.lock().await;
                s.entries_synced += 1;
                s.bytes_synced += entry.content_len();
            }
            LiveEvent::ContentReady { hash } => {
                eprintln!("[seed:{}] ContentReady: {}", ns_short, hash);
                let mut s = stats.lock().await;
                s.blobs_ready += 1;
            }
            LiveEvent::NeighborUp(node_id) => {
                eprintln!("[seed:{}] Peer connected: {}", ns_short, node_id);
                let mut s = stats.lock().await;
                s.peers_seen += 1;
            }
            LiveEvent::NeighborDown(node_id) => {
                eprintln!("[seed:{}] Peer disconnected: {}", ns_short, node_id);
            }
            _ => {}
        }
    }

    eprintln!("[seed:{}] Sync loop ended", ns_short);
}

// ─── Shared App State ───────────────────────────────────────────────────

struct AppState {
    node: SeedNode,
    data_dir: PathBuf,
    api_key: Option<String>,
    /// namespace_id → (TeamEntry, stats, sync task handle)
    teams: Mutex<HashMap<String, ActiveTeam>>,
}

struct ActiveTeam {
    entry: TeamEntry,
    stats: Arc<Mutex<TeamStats>>,
    #[allow(dead_code)]
    handle: tokio::task::JoinHandle<()>,
}

impl AppState {
    /// Verify team secret against stored hash. Returns team entry if valid.
    async fn verify_team_secret(
        &self,
        namespace_id: &str,
        team_secret: &str,
    ) -> Result<TeamEntry, StatusCode> {
        let teams = self.teams.lock().await;
        let active = teams.get(namespace_id).ok_or(StatusCode::NOT_FOUND)?;
        let hash = sha256_hex(team_secret);
        if hash != active.entry.team_secret_hash {
            return Err(StatusCode::FORBIDDEN);
        }
        Ok(active.entry.clone())
    }

    /// Import a ticket, start syncing, persist to registry.
    async fn add_team(
        &self,
        ticket_str: &str,
        label: &str,
        team_secret: &str,
    ) -> Result<TeamEntry, String> {
        let ticket = ticket_str
            .trim()
            .parse::<iroh_docs::DocTicket>()
            .map_err(|_| "Invalid ticket format".to_string())?;

        let doc = self
            .node
            .docs
            .import(ticket)
            .await
            .map_err(|e| format!("Failed to import doc: {}", e))?;

        let namespace_id = doc.id().to_string();

        // Check for duplicate
        {
            let teams = self.teams.lock().await;
            if teams.contains_key(&namespace_id) {
                return Err(format!("Team {} already registered", &namespace_id[..8]));
            }
        }

        let entry = TeamEntry {
            namespace_id: namespace_id.clone(),
            ticket: ticket_str.to_string(),
            label: label.to_string(),
            team_secret_hash: sha256_hex(team_secret),
            added_at: chrono::Utc::now().to_rfc3339(),
        };

        let stats = Arc::new(Mutex::new(TeamStats::default()));
        let stats_clone = stats.clone();
        let ns_clone = namespace_id.clone();
        let handle = tokio::spawn(blob_sync_loop(ns_clone, doc, stats_clone));

        let active = ActiveTeam {
            entry: entry.clone(),
            stats,
            handle,
        };

        {
            let mut teams = self.teams.lock().await;
            teams.insert(namespace_id.clone(), active);
        }

        // Persist
        let mut registry = load_registry(&self.data_dir);
        registry.teams.push(entry.clone());
        save_registry(&self.data_dir, &registry)?;

        eprintln!("[seed] Added team: {} ({})", label, &namespace_id[..8]);
        Ok(entry)
    }

    /// Reset a team's secret. Requires the old secret for verification.
    async fn reset_team_secret(
        &self,
        namespace_id: &str,
        old_secret: &str,
        new_secret: &str,
    ) -> Result<(), String> {
        let new_hash = sha256_hex(new_secret);

        // Update in-memory
        {
            let mut teams = self.teams.lock().await;
            let active = teams
                .get_mut(namespace_id)
                .ok_or_else(|| "Team not found".to_string())?;
            if active.entry.team_secret_hash != sha256_hex(old_secret) {
                return Err("Invalid team secret".to_string());
            }
            active.entry.team_secret_hash = new_hash.clone();
        }

        // Persist
        let mut registry = load_registry(&self.data_dir);
        if let Some(entry) = registry
            .teams
            .iter_mut()
            .find(|t| t.namespace_id == namespace_id)
        {
            entry.team_secret_hash = new_hash;
        }
        save_registry(&self.data_dir, &registry)?;

        eprintln!("[seed:{}] Team secret reset", &namespace_id[..8]);
        Ok(())
    }

    /// Remove a team, stop syncing, remove from registry.
    async fn remove_team(&self, namespace_id: &str) -> Result<(), String> {
        let active = {
            let mut teams = self.teams.lock().await;
            teams
                .remove(namespace_id)
                .ok_or_else(|| format!("Team {} not found", namespace_id))?
        };

        active.handle.abort();

        // Persist
        let mut registry = load_registry(&self.data_dir);
        registry.teams.retain(|t| t.namespace_id != namespace_id);
        save_registry(&self.data_dir, &registry)?;

        eprintln!("[seed] Removed team: {}", &namespace_id[..8]);
        Ok(())
    }

    /// Reconnect all teams from the persisted registry on startup.
    async fn restore_teams(&self) {
        let registry = load_registry(&self.data_dir);
        for entry in &registry.teams {
            let ns = &entry.namespace_id;
            if let Ok(namespace_id) = ns.parse::<iroh_docs::NamespaceId>() {
                let doc = match self.node.docs.open(namespace_id).await {
                    Ok(Some(doc)) => {
                        eprintln!("[seed] Reopened: {} ({})", entry.label, &ns[..8]);
                        doc
                    }
                    _ => match entry
                        .ticket
                        .trim()
                        .parse::<iroh_docs::DocTicket>()
                        .ok()
                    {
                        Some(ticket) => match self.node.docs.import(ticket).await {
                            Ok(doc) => {
                                eprintln!(
                                    "[seed] Re-imported: {} ({})",
                                    entry.label,
                                    &ns[..8]
                                );
                                doc
                            }
                            Err(e) => {
                                eprintln!(
                                    "[seed] Failed to restore {} ({}): {}",
                                    entry.label,
                                    &ns[..8],
                                    e
                                );
                                continue;
                            }
                        },
                        None => {
                            eprintln!(
                                "[seed] Invalid ticket for {} ({})",
                                entry.label,
                                &ns[..8]
                            );
                            continue;
                        }
                    },
                };

                let stats = Arc::new(Mutex::new(TeamStats::default()));
                let stats_clone = stats.clone();
                let ns_clone = ns.clone();
                let handle = tokio::spawn(blob_sync_loop(ns_clone, doc, stats_clone));

                let active = ActiveTeam {
                    entry: entry.clone(),
                    stats,
                    handle,
                };

                let mut teams = self.teams.lock().await;
                teams.insert(ns.clone(), active);
            }
        }
    }
}

// ─── HTTP API ───────────────────────────────────────────────────────────

use axum::{
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    routing::{delete, get, post},
    Json, Router,
};

fn check_admin_auth(headers: &HeaderMap, api_key: &Option<String>) -> Result<(), StatusCode> {
    let Some(expected) = api_key else {
        return Ok(());
    };
    let header = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if header == format!("Bearer {}", expected) {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn json_err(status: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(serde_json::json!({ "error": msg })))
}

// ─── Public Endpoints ───────────────────────────────────────────────────

async fn handle_health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let teams = state.teams.lock().await;
    Json(serde_json::json!({
        "status": "ok",
        "nodeId": state.node.node_id(),
        "teamsCount": teams.len(),
    }))
}

async fn handle_node_id(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "nodeId": state.node.node_id(),
    }))
}

/// POST /teams/:id/ticket — get DocTicket (requires team secret)
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TicketRequest {
    team_secret: String,
}

async fn handle_get_ticket(
    State(state): State<Arc<AppState>>,
    AxumPath(namespace_id): AxumPath<String>,
    Json(body): Json<TicketRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let entry = state
        .verify_team_secret(&namespace_id, &body.team_secret)
        .await
        .map_err(|s| match s {
            StatusCode::NOT_FOUND => json_err(s, "Team not found"),
            _ => json_err(s, "Invalid team secret"),
        })?;

    Ok(Json(serde_json::json!({
        "ticket": entry.ticket,
        "label": entry.label,
        "seedNodeId": state.node.node_id(),
    })))
}

/// POST /teams/:id/apply — submit join application (requires team secret)
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyRequest {
    team_secret: String,
    node_id: String,
    name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    platform: String,
    #[serde(default)]
    arch: String,
    #[serde(default)]
    hostname: String,
}

async fn handle_apply(
    State(state): State<Arc<AppState>>,
    AxumPath(namespace_id): AxumPath<String>,
    Json(body): Json<ApplyRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    state
        .verify_team_secret(&namespace_id, &body.team_secret)
        .await
        .map_err(|s| match s {
            StatusCode::NOT_FOUND => json_err(s, "Team not found"),
            _ => json_err(s, "Invalid team secret"),
        })?;

    let mut apps = load_applications(&state.data_dir, &namespace_id);

    // Reject duplicate
    if apps.iter().any(|a| a.node_id == body.node_id) {
        return Err(json_err(
            StatusCode::CONFLICT,
            "Application already submitted",
        ));
    }

    let app = Application {
        node_id: body.node_id.clone(),
        name: body.name,
        email: body.email,
        note: body.note,
        platform: body.platform,
        arch: body.arch,
        hostname: body.hostname,
        applied_at: chrono::Utc::now().to_rfc3339(),
    };

    apps.push(app);
    save_applications(&state.data_dir, &namespace_id, &apps)
        .map_err(|e| json_err(StatusCode::INTERNAL_SERVER_ERROR, &e))?;

    eprintln!(
        "[seed:{}] New application from {}",
        &namespace_id[..8],
        &body.node_id
    );

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// POST /teams/:id/reset-secret — reset team secret (requires old secret)
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetSecretRequest {
    team_secret: String,
    new_team_secret: String,
}

async fn handle_reset_secret(
    State(state): State<Arc<AppState>>,
    AxumPath(namespace_id): AxumPath<String>,
    Json(body): Json<ResetSecretRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    state
        .reset_team_secret(&namespace_id, &body.team_secret, &body.new_team_secret)
        .await
        .map_err(|e| {
            if e.contains("not found") {
                json_err(StatusCode::NOT_FOUND, &e)
            } else {
                json_err(StatusCode::FORBIDDEN, &e)
            }
        })?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

// ─── Owner Application Endpoints ────────────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnerApplicationRequest {
    team_secret: String,
}

/// POST /teams/:id/applications — list pending applications (requires team secret)
async fn handle_owner_list_applications(
    State(state): State<Arc<AppState>>,
    AxumPath(namespace_id): AxumPath<String>,
    Json(body): Json<OwnerApplicationRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    state
        .verify_team_secret(&namespace_id, &body.team_secret)
        .await
        .map_err(|s| match s {
            StatusCode::NOT_FOUND => json_err(s, "Team not found"),
            _ => json_err(s, "Invalid team secret"),
        })?;

    let apps = load_applications(&state.data_dir, &namespace_id);
    Ok(Json(serde_json::json!({ "applications": apps })))
}

/// POST /teams/:id/applications/:node_id/approve — approve application (requires team secret)
async fn handle_owner_approve_application(
    State(state): State<Arc<AppState>>,
    AxumPath((namespace_id, node_id)): AxumPath<(String, String)>,
    Json(body): Json<OwnerApplicationRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    state
        .verify_team_secret(&namespace_id, &body.team_secret)
        .await
        .map_err(|s| match s {
            StatusCode::NOT_FOUND => json_err(s, "Team not found"),
            _ => json_err(s, "Invalid team secret"),
        })?;

    let mut apps = load_applications(&state.data_dir, &namespace_id);
    let app = apps.iter().find(|a| a.node_id == node_id).cloned();

    let app = app.ok_or_else(|| json_err(StatusCode::NOT_FOUND, "Application not found"))?;

    apps.retain(|a| a.node_id != node_id);
    save_applications(&state.data_dir, &namespace_id, &apps)
        .map_err(|e| json_err(StatusCode::INTERNAL_SERVER_ERROR, &e))?;

    eprintln!(
        "[seed:{}] Owner approved application: {}",
        &namespace_id[..8],
        &node_id
    );

    Ok(Json(serde_json::to_value(&app).unwrap_or_default()))
}

/// POST /teams/:id/applications/:node_id/reject — reject application (requires team secret)
async fn handle_owner_reject_application(
    State(state): State<Arc<AppState>>,
    AxumPath((namespace_id, node_id)): AxumPath<(String, String)>,
    Json(body): Json<OwnerApplicationRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    state
        .verify_team_secret(&namespace_id, &body.team_secret)
        .await
        .map_err(|s| match s {
            StatusCode::NOT_FOUND => json_err(s, "Team not found"),
            _ => json_err(s, "Invalid team secret"),
        })?;

    let mut apps = load_applications(&state.data_dir, &namespace_id);
    let before = apps.len();
    apps.retain(|a| a.node_id != node_id);

    if apps.len() == before {
        return Err(json_err(StatusCode::NOT_FOUND, "Application not found"));
    }

    save_applications(&state.data_dir, &namespace_id, &apps)
        .map_err(|e| json_err(StatusCode::INTERNAL_SERVER_ERROR, &e))?;

    eprintln!(
        "[seed:{}] Owner rejected application: {}",
        &namespace_id[..8],
        &node_id
    );

    Ok(Json(serde_json::json!({ "ok": true })))
}

// ─── Admin Endpoints ────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddTeamRequest {
    ticket: String,
    #[serde(default)]
    label: String,
    team_secret: String,
}

async fn handle_admin_add_team(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<AddTeamRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_admin_auth(&headers, &state.api_key)?;
    match state
        .add_team(&body.ticket, &body.label, &body.team_secret)
        .await
    {
        Ok(entry) => Ok(Json(serde_json::json!({
            "ok": true,
            "namespaceId": entry.namespace_id,
            "label": entry.label,
            "nodeId": state.node.node_id(),
        }))),
        Err(e) => Ok(Json(serde_json::json!({ "ok": false, "error": e }))),
    }
}

async fn handle_admin_remove_team(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(namespace_id): AxumPath<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_admin_auth(&headers, &state.api_key)?;
    match state.remove_team(&namespace_id).await {
        Ok(()) => Ok(Json(serde_json::json!({ "ok": true }))),
        Err(e) => Ok(Json(serde_json::json!({ "ok": false, "error": e }))),
    }
}

async fn handle_admin_list_teams(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_admin_auth(&headers, &state.api_key)?;
    let teams = state.teams.lock().await;
    let mut list = Vec::new();
    for (ns, active) in teams.iter() {
        let stats = active.stats.lock().await;
        let app_count = load_applications(&state.data_dir, ns).len();
        list.push(serde_json::json!({
            "namespaceId": ns,
            "label": active.entry.label,
            "addedAt": active.entry.added_at,
            "pendingApplications": app_count,
            "stats": *stats,
        }));
    }
    Ok(Json(serde_json::json!({
        "nodeId": state.node.node_id(),
        "teams": list,
    })))
}

async fn handle_admin_list_applications(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(namespace_id): AxumPath<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_admin_auth(&headers, &state.api_key)?;
    let apps = load_applications(&state.data_dir, &namespace_id);
    Ok(Json(serde_json::json!({ "applications": apps })))
}

async fn handle_admin_approve_application(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath((namespace_id, node_id)): AxumPath<(String, String)>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_admin_auth(&headers, &state.api_key)?;

    let mut apps = load_applications(&state.data_dir, &namespace_id);
    let app = apps.iter().find(|a| a.node_id == node_id).cloned();

    if app.is_none() {
        return Ok(Json(
            serde_json::json!({ "ok": false, "error": "Application not found" }),
        ));
    }

    // Remove from pending
    apps.retain(|a| a.node_id != node_id);
    let _ = save_applications(&state.data_dir, &namespace_id, &apps);

    eprintln!(
        "[seed:{}] Approved application: {}",
        &namespace_id[..8],
        &node_id
    );

    // NOTE: The actual member addition to _team/members.json must be done
    // by the team owner via the TeamClaw desktop app. This endpoint only
    // removes the application from the pending list.

    Ok(Json(serde_json::json!({
        "ok": true,
        "approved": app.unwrap(),
    })))
}

async fn handle_admin_reject_application(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath((namespace_id, node_id)): AxumPath<(String, String)>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_admin_auth(&headers, &state.api_key)?;

    let mut apps = load_applications(&state.data_dir, &namespace_id);
    let before = apps.len();
    apps.retain(|a| a.node_id != node_id);

    if apps.len() == before {
        return Ok(Json(
            serde_json::json!({ "ok": false, "error": "Application not found" }),
        ));
    }

    let _ = save_applications(&state.data_dir, &namespace_id, &apps);

    eprintln!(
        "[seed:{}] Rejected application: {}",
        &namespace_id[..8],
        &node_id
    );

    Ok(Json(serde_json::json!({ "ok": true })))
}

// ─── Main ───────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let config = parse_config();

    eprintln!("[seed] Starting TeamClaw seed node (multi-tenant)...");
    eprintln!("[seed] Data dir: {}", config.data_dir.display());
    eprintln!(
        "[seed] Admin API key: {}",
        if config.api_key.is_some() {
            "configured"
        } else {
            "NONE (unauthenticated!)"
        }
    );

    std::fs::create_dir_all(&config.data_dir).expect("Failed to create data dir");

    let node = SeedNode::new(&config.data_dir)
        .await
        .unwrap_or_else(|e| {
            eprintln!("[seed] Fatal: {}", e);
            std::process::exit(1);
        });

    eprintln!("[seed] Node ID: {}", node.node_id());

    let state = Arc::new(AppState {
        node,
        data_dir: config.data_dir,
        api_key: config.api_key,
        teams: Mutex::new(HashMap::new()),
    });

    // Restore previously registered teams
    state.restore_teams().await;

    // Build router
    let app = Router::new()
        // Public endpoints
        .route("/health", get(handle_health))
        .route("/node-id", get(handle_node_id))
        .route("/teams/{namespace_id}/ticket", post(handle_get_ticket))
        .route("/teams/{namespace_id}/apply", post(handle_apply))
        .route("/teams/{namespace_id}/reset-secret", post(handle_reset_secret))
        .route(
            "/teams/{namespace_id}/applications",
            post(handle_owner_list_applications),
        )
        .route(
            "/teams/{namespace_id}/applications/{node_id}/approve",
            post(handle_owner_approve_application),
        )
        .route(
            "/teams/{namespace_id}/applications/{node_id}/reject",
            post(handle_owner_reject_application),
        )
        // Admin endpoints
        .route("/admin/teams", post(handle_admin_add_team))
        .route("/admin/teams", get(handle_admin_list_teams))
        .route(
            "/admin/teams/{namespace_id}",
            delete(handle_admin_remove_team),
        )
        .route(
            "/admin/teams/{namespace_id}/applications",
            get(handle_admin_list_applications),
        )
        .route(
            "/admin/teams/{namespace_id}/applications/{node_id}/approve",
            post(handle_admin_approve_application),
        )
        .route(
            "/admin/teams/{namespace_id}/applications/{node_id}",
            delete(handle_admin_reject_application),
        )
        .with_state(state.clone());

    let addr = format!("0.0.0.0:{}", config.port);
    eprintln!("[seed] HTTP API at http://{}", addr);
    eprintln!("[seed]   Public:");
    eprintln!("[seed]     GET  /health");
    eprintln!("[seed]     GET  /node-id");
    eprintln!("[seed]     POST /teams/:id/ticket");
    eprintln!("[seed]     POST /teams/:id/apply");
    eprintln!("[seed]     POST /teams/:id/reset-secret");
    eprintln!("[seed]     POST /teams/:id/applications");
    eprintln!("[seed]     POST /teams/:id/applications/:nid/approve");
    eprintln!("[seed]     POST /teams/:id/applications/:nid/reject");
    eprintln!("[seed]   Admin (requires Bearer token):");
    eprintln!("[seed]     POST   /admin/teams");
    eprintln!("[seed]     GET    /admin/teams");
    eprintln!("[seed]     DELETE /admin/teams/:id");
    eprintln!("[seed]     GET    /admin/teams/:id/applications");
    eprintln!("[seed]     POST   /admin/teams/:id/applications/:nid/approve");
    eprintln!("[seed]     DELETE /admin/teams/:id/applications/:nid");

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind port");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
            eprintln!("\n[seed] Shutting down...");
        })
        .await
        .ok();

    eprintln!("[seed] Shutdown complete.");
}

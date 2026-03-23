use crate::commands::oss_types::*;
use crate::commands::team::TEAM_REPO_DIR;
use crate::commands::TEAMCLAW_DIR;

use aws_sdk_s3::primitives::ByteStream;
use chrono::Utc;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::Mutex;
use tracing::{info, warn};

const KEYRING_SERVICE: &str = "teamclaw-oss";
const TOKEN_REFRESH_MARGIN_SECS: i64 = 300; // refresh 5 min before expiry

// ---------------------------------------------------------------------------
// OssSyncManager
// ---------------------------------------------------------------------------

pub struct OssSyncManager {
    s3_client: Option<aws_sdk_s3::Client>,
    credentials: Option<OssCredentials>,
    oss_config: Option<OssConfig>,
    fc_endpoint: String,

    skills_doc: loro::LoroDoc,
    mcp_doc: loro::LoroDoc,
    knowledge_doc: loro::LoroDoc,

    team_id: String,
    node_id: String,
    team_secret: String,
    role: MemberRole,
    known_files: HashMap<DocType, HashSet<String>>,

    poll_interval: Duration,
    #[allow(dead_code)]
    workspace_path: String,
    team_dir: PathBuf,
    loro_cache_dir: PathBuf,
    connected: bool,
    syncing: bool,
    last_sync_at: Option<String>,
    app_handle: Option<tauri::AppHandle>,
}

pub struct OssSyncState {
    pub manager: Arc<Mutex<Option<OssSyncManager>>>,
    pub poll_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl Default for OssSyncState {
    fn default() -> Self {
        Self {
            manager: Arc::new(Mutex::new(None)),
            poll_handle: Arc::new(Mutex::new(None)),
        }
    }
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

impl OssSyncManager {
    pub fn new(
        team_id: String,
        node_id: String,
        team_secret: String,
        fc_endpoint: String,
        workspace_path: String,
        poll_interval: Duration,
        app_handle: Option<tauri::AppHandle>,
    ) -> Self {
        let team_dir = Path::new(&workspace_path).join(TEAM_REPO_DIR);
        let loro_cache_dir = Path::new(&workspace_path).join(TEAMCLAW_DIR).join("loro");

        let mut known_files = HashMap::new();
        for dt in DocType::all() {
            known_files.insert(dt, HashSet::new());
        }

        Self {
            s3_client: None,
            credentials: None,
            oss_config: None,
            fc_endpoint,
            skills_doc: loro::LoroDoc::new(),
            mcp_doc: loro::LoroDoc::new(),
            knowledge_doc: loro::LoroDoc::new(),
            team_id,
            node_id,
            team_secret,
            role: MemberRole::Editor,
            known_files,
            poll_interval,
            workspace_path,
            team_dir,
            loro_cache_dir,
            connected: false,
            syncing: false,
            last_sync_at: None,
            app_handle,
        }
    }

    // -----------------------------------------------------------------------
    // Accessors / Mutators (used by oss_commands)
    // -----------------------------------------------------------------------

    pub fn team_id(&self) -> &str {
        &self.team_id
    }

    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    pub fn workspace_path(&self) -> &str {
        &self.workspace_path
    }

    pub fn set_credentials(&mut self, creds: OssCredentials, oss: OssConfig) {
        self.s3_client = Some(Self::create_s3_client(&creds, &oss));
        self.credentials = Some(creds);
        self.oss_config = Some(oss);
        self.connected = true;
    }

    pub fn role(&self) -> MemberRole {
        self.role.clone()
    }

    pub fn set_role(&mut self, role: MemberRole) {
        self.role = role;
    }

    pub fn set_last_sync_at(&mut self, ts: Option<String>) {
        self.last_sync_at = ts;
    }

    // -----------------------------------------------------------------------
    // S3 Client
    // -----------------------------------------------------------------------

    fn create_s3_client(creds: &OssCredentials, config: &OssConfig) -> aws_sdk_s3::Client {
        let credentials = aws_sdk_s3::config::Credentials::new(
            &creds.access_key_id,
            &creds.access_key_secret,
            Some(creds.security_token.clone()),
            None,
            "oss-sts",
        );

        let s3_config = aws_sdk_s3::config::Builder::new()
            .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest())
            .endpoint_url(&config.endpoint)
            .region(aws_sdk_s3::config::Region::new(config.region.clone()))
            .credentials_provider(credentials)
            .force_path_style(false)
            .build();

        aws_sdk_s3::Client::from_conf(s3_config)
    }

    pub async fn refresh_token_if_needed(&mut self) -> Result<(), String> {
        let creds = match &self.credentials {
            Some(c) => c,
            None => return Ok(()),
        };

        let expiration = chrono::DateTime::parse_from_rfc3339(&creds.expiration)
            .map_err(|e| format!("Failed to parse token expiration: {e}"))?;

        let now = Utc::now();
        let remaining = expiration.signed_duration_since(now).num_seconds();

        if remaining > TOKEN_REFRESH_MARGIN_SECS {
            return Ok(());
        }

        info!("OSS STS token nearing expiry ({remaining}s left), refreshing...");

        let body = serde_json::json!({
            "teamId": self.team_id,
            "teamSecret": self.team_secret,
            "nodeId": self.node_id,
        });

        let resp = self.call_fc("/token", &body).await?;

        self.credentials = Some(resp.credentials.clone());
        self.oss_config = Some(resp.oss.clone());
        self.s3_client = Some(Self::create_s3_client(&resp.credentials, &resp.oss));

        self.role =
            serde_json::from_str(&format!("\"{}\"", resp.role)).unwrap_or(MemberRole::Editor);

        info!("OSS STS token refreshed successfully");
        Ok(())
    }

    pub async fn call_fc(&self, path: &str, body: &Value) -> Result<FcResponse, String> {
        let url = format!("{}{}", self.fc_endpoint, path);
        let client = reqwest::Client::new();

        let max_retries = 3u32;
        let mut attempt = 0u32;

        loop {
            let response = client
                .post(&url)
                .json(body)
                .send()
                .await
                .map_err(|e| format!("FC request to {path} failed: {e}"))?;

            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                attempt += 1;
                if attempt > max_retries {
                    return Err(format!(
                        "FC request to {path} rate-limited after {max_retries} retries"
                    ));
                }
                let delay_secs = 2u64.pow(attempt); // 2s, 4s, 8s
                warn!(
                    "FC request to {path} returned 429, retrying in {delay_secs}s (attempt {attempt}/{max_retries})"
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
                continue;
            }

            if !response.status().is_success() {
                let status = response.status();
                let text = response
                    .text()
                    .await
                    .unwrap_or_else(|_| "unknown".to_string());
                return Err(format!("FC request to {path} returned {status}: {text}"));
            }

            return response
                .json::<FcResponse>()
                .await
                .map_err(|e| format!("FC response parse error for {path}: {e}"));
        }
    }

    // -----------------------------------------------------------------------
    // S3 Operations
    // -----------------------------------------------------------------------

    fn bucket(&self) -> Result<&str, String> {
        self.oss_config
            .as_ref()
            .map(|c| c.bucket.as_str())
            .ok_or_else(|| "OSS config not set".to_string())
    }

    fn client(&self) -> Result<&aws_sdk_s3::Client, String> {
        self.s3_client
            .as_ref()
            .ok_or_else(|| "S3 client not initialized".to_string())
    }

    pub async fn s3_put(&self, key: &str, body: &[u8]) -> Result<(), String> {
        let client = self.client()?;
        let bucket = self.bucket()?;

        client
            .put_object()
            .bucket(bucket)
            .key(key)
            .body(ByteStream::from(body.to_vec()))
            .send()
            .await
            .map_err(|e| format!("S3 PUT {key} failed: {e:?}"))?;

        Ok(())
    }

    pub async fn s3_get(&self, key: &str) -> Result<Vec<u8>, String> {
        let client = self.client()?;
        let bucket = self.bucket()?;

        let resp = client
            .get_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| format!("S3 GET {key} failed: {e}"))?;

        let data = resp
            .body
            .collect()
            .await
            .map_err(|e| format!("S3 GET {key} body read failed: {e}"))?;

        Ok(data.into_bytes().to_vec())
    }

    async fn s3_list(&self, prefix: &str) -> Result<Vec<String>, String> {
        let client = self.client()?;
        let bucket = self.bucket()?;

        let mut keys: Vec<String> = Vec::new();
        let mut continuation_token: Option<String> = None;

        loop {
            let mut req = client.list_objects_v2().bucket(bucket).prefix(prefix);

            if let Some(token) = &continuation_token {
                req = req.continuation_token(token);
            }

            let resp = req
                .send()
                .await
                .map_err(|e| format!("S3 LIST {prefix} failed: {e}"))?;

            for obj in resp.contents() {
                if let Some(key) = obj.key() {
                    keys.push(key.to_string());
                }
            }

            if resp.is_truncated() == Some(true) {
                continuation_token = resp.next_continuation_token().map(|s| s.to_string());
            } else {
                break;
            }
        }

        keys.sort();
        Ok(keys)
    }

    async fn s3_delete(&self, key: &str) -> Result<(), String> {
        let client = self.client()?;
        let bucket = self.bucket()?;

        client
            .delete_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| format!("S3 DELETE {key} failed: {e}"))?;

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Loro Document Operations
    // -----------------------------------------------------------------------

    fn get_doc(&self, doc_type: DocType) -> &loro::LoroDoc {
        match doc_type {
            DocType::Skills => &self.skills_doc,
            DocType::Mcp => &self.mcp_doc,
            DocType::Knowledge => &self.knowledge_doc,
        }
    }

    fn get_doc_mut(&mut self, doc_type: DocType) -> &mut loro::LoroDoc {
        match doc_type {
            DocType::Skills => &mut self.skills_doc,
            DocType::Mcp => &mut self.mcp_doc,
            DocType::Knowledge => &mut self.knowledge_doc,
        }
    }

    fn scan_local_files(dir: &Path) -> Result<HashMap<String, Vec<u8>>, String> {
        let mut result = HashMap::new();

        if !dir.exists() {
            return Ok(result);
        }

        fn walk(
            base: &Path,
            current: &Path,
            result: &mut HashMap<String, Vec<u8>>,
        ) -> Result<(), String> {
            let entries = std::fs::read_dir(current)
                .map_err(|e| format!("Failed to read dir {}: {e}", current.display()))?;

            for entry in entries {
                let entry = entry.map_err(|e| format!("Dir entry error: {e}"))?;
                let path = entry.path();
                let name = entry.file_name();
                let name_str = name.to_string_lossy();

                // Skip hidden files/dirs
                if name_str.starts_with('.') {
                    continue;
                }

                if path.is_dir() {
                    walk(base, &path, result)?;
                } else {
                    let rel = path
                        .strip_prefix(base)
                        .map_err(|e| format!("Path strip error: {e}"))?;
                    let rel_str = rel.to_string_lossy().to_string();
                    let content = std::fs::read(&path)
                        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
                    result.insert(rel_str, content);
                }
            }
            Ok(())
        }

        walk(dir, dir, &mut result)?;
        Ok(result)
    }

    fn compute_hash(content: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(content);
        format!("{:x}", hasher.finalize())
    }

    fn detect_local_changes(
        &self,
        doc_type: DocType,
        local_files: &HashMap<String, Vec<u8>>,
    ) -> Vec<String> {
        let doc = self.get_doc(doc_type);
        let mut changed = Vec::new();

        // TODO: The exact Loro API for reading map entries may need adjustment after compilation.
        // Try to get the "files" map from the doc to compare hashes.
        let files_map = doc.get_map("files");

        for (path, content) in local_files {
            let local_hash = Self::compute_hash(content);

            // Check if the file exists in the doc with the same hash
            let needs_update = match files_map.get(path) {
                Some(loro::ValueOrContainer::Container(loro::Container::Map(entry_map))) => {
                    let deep = entry_map.get_deep_value();
                    if let loro::LoroValue::Map(entry) = deep {
                        match entry.get("hash") {
                            Some(loro::LoroValue::String(h)) => h.as_ref() != local_hash,
                            _ => true,
                        }
                    } else {
                        true
                    }
                }
                _ => true,
            };

            if needs_update {
                changed.push(path.clone());
            }
        }

        changed
    }

    fn write_doc_to_disk(&self, doc_type: DocType) -> Result<(), String> {
        let doc = self.get_doc(doc_type);
        let dir = self.team_dir.join(doc_type.dir_name());

        // Ensure the directory exists
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create dir {}: {e}", dir.display()))?;

        let files_map = doc.get_map("files");

        // Collect files that should exist on disk from the LoroDoc
        let mut doc_files: HashSet<String> = HashSet::new();

        // TODO: The exact iteration API for LoroMap may differ. This uses a
        // reasonable approach — adjust after verifying the loro v1 API.
        let map_value = files_map.get_deep_value();
        if let loro::LoroValue::Map(entries) = map_value {
            for (path, value) in entries.iter() {
                if let loro::LoroValue::Map(entry) = value {
                    let deleted = match entry.get("deleted") {
                        Some(loro::LoroValue::Bool(b)) => *b,
                        _ => false,
                    };

                    if deleted {
                        // Remove file from disk if it exists
                        let file_path = dir.join(path.as_str());
                        if file_path.exists() {
                            let _ = std::fs::remove_file(&file_path);
                        }
                    } else {
                        doc_files.insert(path.to_string());

                        if let Some(loro::LoroValue::String(content_str)) = entry.get("content") {
                            let file_path = dir.join(path.as_str());
                            if let Some(parent) = file_path.parent() {
                                std::fs::create_dir_all(parent).map_err(|e| {
                                    format!("Failed to create dir {}: {e}", parent.display())
                                })?;
                            }
                            std::fs::write(&file_path, content_str.as_bytes()).map_err(|e| {
                                format!("Failed to write {}: {e}", file_path.display())
                            })?;
                        }
                    }
                }
            }
        }

        // Remove files on disk that are not in the LoroDoc
        if dir.exists() {
            let disk_files = Self::scan_local_files(&dir)?;
            for path in disk_files.keys() {
                if !doc_files.contains(path) {
                    let file_path = dir.join(path);
                    let _ = std::fs::remove_file(&file_path);
                }
            }
        }

        Ok(())
    }

    pub fn persist_local_snapshot(&self, doc_type: DocType) -> Result<(), String> {
        std::fs::create_dir_all(&self.loro_cache_dir)
            .map_err(|e| format!("Failed to create loro cache dir: {e}"))?;

        let doc = self.get_doc(doc_type);
        // TODO: Verify exact ExportMode API for loro v1. Using snapshot mode.
        let snapshot = doc
            .export(loro::ExportMode::Snapshot)
            .map_err(|e| format!("Failed to export loro snapshot for {:?}: {e}", doc_type))?;

        let path = self
            .loro_cache_dir
            .join(format!("{}.snapshot", doc_type.path()));
        std::fs::write(&path, &snapshot)
            .map_err(|e| format!("Failed to write snapshot {}: {e}", path.display()))?;

        Ok(())
    }

    pub fn restore_from_local_snapshot(&mut self, doc_type: DocType) -> Result<bool, String> {
        let path = self
            .loro_cache_dir
            .join(format!("{}.snapshot", doc_type.path()));

        if !path.exists() {
            return Ok(false);
        }

        let data = std::fs::read(&path)
            .map_err(|e| format!("Failed to read snapshot {}: {e}", path.display()))?;

        let doc = self.get_doc_mut(doc_type);
        doc.import(&data)
            .map_err(|e| format!("Failed to import loro snapshot for {:?}: {e}", doc_type))?;

        info!("Restored local loro snapshot for {:?}", doc_type);
        Ok(true)
    }

    // -----------------------------------------------------------------------
    // Sync Operations
    // -----------------------------------------------------------------------

    pub async fn upload_local_changes(&mut self, doc_type: DocType) -> Result<(), String> {
        let dir = self.team_dir.join(doc_type.dir_name());
        let local_files = Self::scan_local_files(&dir)?;
        let changed = self.detect_local_changes(doc_type, &local_files);

        if changed.is_empty() {
            // Also check for deleted files
            let doc = self.get_doc(doc_type);
            let files_map = doc.get_map("files");
            let map_value = files_map.get_deep_value();
            let mut has_deletions = false;

            if let loro::LoroValue::Map(entries) = &map_value {
                for (path, value) in entries.iter() {
                    if let loro::LoroValue::Map(entry) = value {
                        let deleted = match entry.get("deleted") {
                            Some(loro::LoroValue::Bool(b)) => *b,
                            _ => false,
                        };
                        if !deleted && !local_files.contains_key(path.as_str()) {
                            has_deletions = true;
                            break;
                        }
                    }
                }
            }

            if !has_deletions {
                return Ok(());
            }
        }

        let now = Utc::now().to_rfc3339();
        let node_id = self.node_id.clone();

        // Update the LoroDoc with changes
        {
            let doc = self.get_doc_mut(doc_type);
            let files_map = doc.get_map("files");

            // Update changed files
            for path in &changed {
                if let Some(content) = local_files.get(path) {
                    let hash = Self::compute_hash(content);
                    let content_str = String::from_utf8_lossy(content).to_string();

                    let entry_map = files_map
                        .get_or_create_container(path, loro::LoroMap::new())
                        .map_err(|e| format!("Failed to get/create map entry for {path}: {e}"))?;
                    entry_map
                        .insert("content", content_str.as_str())
                        .map_err(|e| format!("Failed to set content for {path}: {e}"))?;
                    entry_map
                        .insert("hash", hash.as_str())
                        .map_err(|e| format!("Failed to set hash for {path}: {e}"))?;
                    entry_map
                        .insert("deleted", false)
                        .map_err(|e| format!("Failed to set deleted for {path}: {e}"))?;
                    entry_map
                        .insert("updatedBy", node_id.as_str())
                        .map_err(|e| format!("Failed to set updatedBy for {path}: {e}"))?;
                    entry_map
                        .insert("updatedAt", now.as_str())
                        .map_err(|e| format!("Failed to set updatedAt for {path}: {e}"))?;
                }
            }

            // Mark deleted files
            let map_value = files_map.get_deep_value();
            if let loro::LoroValue::Map(entries) = &map_value {
                for (path, value) in entries.iter() {
                    if let loro::LoroValue::Map(entry) = value {
                        let deleted = match entry.get("deleted") {
                            Some(loro::LoroValue::Bool(b)) => *b,
                            _ => false,
                        };
                        if !deleted && !local_files.contains_key(path.as_str()) {
                            let entry_map = files_map
                                .get_or_create_container(path, loro::LoroMap::new())
                                .map_err(|e| format!("Failed to get map entry for {path}: {e}"))?;
                            entry_map
                                .insert("deleted", true)
                                .map_err(|e| format!("Failed to mark deleted for {path}: {e}"))?;
                            entry_map
                                .insert("updatedBy", node_id.as_str())
                                .map_err(|e| format!("Failed to set updatedBy for {path}: {e}"))?;
                            entry_map
                                .insert("updatedAt", now.as_str())
                                .map_err(|e| format!("Failed to set updatedAt for {path}: {e}"))?;
                        }
                    }
                }
            }
        }

        // Export updates and upload
        let doc = self.get_doc(doc_type);
        // TODO: Verify ExportMode for incremental updates in loro v1.
        // Using updates_till or all_updates — adjust API as needed.
        let updates = doc
            .export(loro::ExportMode::all_updates())
            .map_err(|e| format!("Failed to export loro updates for {:?}: {e}", doc_type))?;

        let timestamp_ms = Utc::now().timestamp_millis();
        let key = format!(
            "teams/{}/{}/updates/{}/{}.bin",
            self.team_id,
            doc_type.path(),
            self.node_id,
            timestamp_ms
        );

        self.s3_put(&key, &updates).await?;
        info!(
            "Uploaded {} changes for {:?} ({} bytes)",
            changed.len(),
            doc_type,
            updates.len()
        );

        Ok(())
    }

    pub async fn pull_remote_changes(&mut self, doc_type: DocType) -> Result<(), String> {
        let prefix = format!("teams/{}/{}/updates/", self.team_id, doc_type.path());
        let all_keys = self.s3_list(&prefix).await?;

        let known = self.known_files.get(&doc_type).cloned().unwrap_or_default();

        let new_keys: Vec<String> = all_keys
            .into_iter()
            .filter(|k| !known.contains(k))
            .collect();

        if new_keys.is_empty() {
            return Ok(());
        }

        info!(
            "Pulling {} new update files for {:?}",
            new_keys.len(),
            doc_type
        );

        for key in &new_keys {
            let data = self.s3_get(key).await?;
            let doc = self.get_doc_mut(doc_type);
            doc.import(&data)
                .map_err(|e| format!("Failed to import update {key}: {e}"))?;
        }

        // Add to known files
        let known_set = self.known_files.entry(doc_type).or_default();
        for key in new_keys {
            known_set.insert(key);
        }

        // Write changes to disk
        self.write_doc_to_disk(doc_type)?;

        Ok(())
    }

    pub async fn initial_sync(&mut self) -> Result<(), String> {
        for doc_type in DocType::all() {
            info!("Initial sync for {:?}...", doc_type);

            // 1. Restore from local snapshot
            let _ = self.restore_from_local_snapshot(doc_type);

            // 2. Find latest snapshot on OSS
            let snapshot_prefix = format!("teams/{}/{}/snapshot/", self.team_id, doc_type.path());
            let snapshot_keys = self.s3_list(&snapshot_prefix).await?;

            if let Some(latest_key) = snapshot_keys.last() {
                info!("Found remote snapshot: {latest_key}");
                let data = self.s3_get(latest_key).await?;
                let doc = self.get_doc_mut(doc_type);
                doc.import(&data).map_err(|e| {
                    format!("Failed to import remote snapshot for {:?}: {e}", doc_type)
                })?;
            }

            // 3. Pull remote changes
            self.pull_remote_changes(doc_type).await?;

            // 4. Write to disk
            self.write_doc_to_disk(doc_type)?;

            // 5. Persist local snapshot
            let _ = self.persist_local_snapshot(doc_type);

            info!("Initial sync complete for {:?}", doc_type);
        }

        self.connected = true;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Poll Loop
    // -----------------------------------------------------------------------

    pub async fn poll_loop(state: Arc<Mutex<Option<OssSyncManager>>>) {
        loop {
            let interval = {
                let mut guard = state.lock().await;
                if let Some(manager) = guard.as_mut() {
                    manager.syncing = true;
                    let _ = manager.refresh_token_if_needed().await;

                    for doc_type in DocType::all() {
                        if let Err(e) = manager.upload_local_changes(doc_type).await {
                            warn!("OSS upload error for {:?}: {}", doc_type, e);
                        }
                        if let Err(e) = manager.pull_remote_changes(doc_type).await {
                            warn!("OSS pull error for {:?}: {}", doc_type, e);
                        }
                        let _ = manager.persist_local_snapshot(doc_type);
                    }

                    manager.syncing = false;
                    let now = Utc::now().to_rfc3339();
                    manager.last_sync_at = Some(now);

                    // Emit status event to frontend
                    if let Some(handle) = &manager.app_handle {
                        let status = manager.get_sync_status();
                        let _ = handle.emit("oss-sync-status", &status);
                    }

                    manager.poll_interval
                } else {
                    return;
                }
            };
            tokio::time::sleep(interval).await;
        }
    }

    // -----------------------------------------------------------------------
    // Owner Operations
    // -----------------------------------------------------------------------

    pub async fn create_snapshot(&mut self, doc_type: DocType) -> Result<(), String> {
        // Pull latest first
        self.pull_remote_changes(doc_type).await?;

        let doc = self.get_doc(doc_type);
        let snapshot = doc
            .export(loro::ExportMode::Snapshot)
            .map_err(|e| format!("Failed to export snapshot for {:?}: {e}", doc_type))?;

        let timestamp_ms = Utc::now().timestamp_millis();
        let key = format!(
            "teams/{}/{}/snapshot/{}.bin",
            self.team_id,
            doc_type.path(),
            timestamp_ms
        );

        self.s3_put(&key, &snapshot).await?;
        info!(
            "Created snapshot for {:?} ({} bytes)",
            doc_type,
            snapshot.len()
        );

        Ok(())
    }

    pub async fn cleanup_old_updates(
        &mut self,
        doc_type: DocType,
    ) -> Result<CleanupResult, String> {
        let mut deleted_count: u32 = 0;
        let freed_bytes: u64 = 0;

        // Find latest snapshot timestamp
        let snapshot_prefix = format!("teams/{}/{}/snapshot/", self.team_id, doc_type.path());
        let snapshot_keys = self.s3_list(&snapshot_prefix).await?;

        if snapshot_keys.is_empty() {
            return Ok(CleanupResult {
                deleted_count: 0,
                freed_bytes: 0,
            });
        }

        let latest_snapshot = snapshot_keys.last().unwrap().clone();

        // Delete old snapshots (keep only latest)
        for key in &snapshot_keys {
            if key != &latest_snapshot {
                self.s3_delete(key).await?;
                deleted_count += 1;
                // We don't know exact size without HEAD, estimate as 0
            }
        }

        // Extract timestamp from latest snapshot key to find old updates
        // Key format: teams/{team_id}/{doc_type}/snapshot/{timestamp_ms}.bin
        let snapshot_ts: i64 = latest_snapshot
            .rsplit('/')
            .next()
            .and_then(|f| f.strip_suffix(".bin"))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        // Delete updates older than the snapshot
        let updates_prefix = format!("teams/{}/{}/updates/", self.team_id, doc_type.path());
        let update_keys = self.s3_list(&updates_prefix).await?;

        // Collect keys to delete first, then delete — avoids borrowing self
        // mutably (known_files) and immutably (s3_delete) at the same time.
        let keys_to_delete: Vec<String> = update_keys
            .iter()
            .filter(|key| {
                let file_ts: i64 = key
                    .rsplit('/')
                    .next()
                    .and_then(|f| f.strip_suffix(".bin"))
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(i64::MAX);
                file_ts < snapshot_ts
            })
            .cloned()
            .collect();

        for key in &keys_to_delete {
            self.s3_delete(key).await?;
            deleted_count += 1;
        }
        let known_set = self.known_files.entry(doc_type).or_default();
        for key in &keys_to_delete {
            known_set.remove(key);
        }

        info!(
            "Cleaned up {} old objects for {:?}",
            deleted_count, doc_type
        );

        Ok(CleanupResult {
            deleted_count,
            freed_bytes,
        })
    }

    pub fn get_sync_status(&self) -> SyncStatus {
        let mut docs = HashMap::new();

        for doc_type in DocType::all() {
            let doc = self.get_doc(doc_type);
            let remote_count = self
                .known_files
                .get(&doc_type)
                .map(|s| s.len() as u32)
                .unwrap_or(0);

            // TODO: Verify the exact API for getting Loro version/frontiers.
            let local_version = doc.oplog_vv().len() as u64;

            docs.insert(
                doc_type.path().to_string(),
                DocSyncStatus {
                    local_version,
                    remote_update_count: remote_count,
                    last_upload_at: None,
                    last_download_at: None,
                },
            );
        }

        let next_sync_at = self.last_sync_at.as_ref().and_then(|last| {
            chrono::DateTime::parse_from_rfc3339(last).ok().map(|dt| {
                (dt + chrono::Duration::from_std(self.poll_interval).unwrap_or_default())
                    .to_rfc3339()
            })
        });

        SyncStatus {
            connected: self.connected,
            syncing: self.syncing,
            last_sync_at: self.last_sync_at.clone(),
            next_sync_at,
            docs,
        }
    }
}

// ---------------------------------------------------------------------------
// Members Manifest S3 Operations
// ---------------------------------------------------------------------------

impl OssSyncManager {
    fn members_manifest_key(&self) -> String {
        format!("teams/{}/_meta/members.json", self.team_id)
    }

    /// Upload members manifest to S3
    pub async fn upload_members_manifest(&self, manifest: &TeamManifest) -> Result<(), String> {
        let json = serde_json::to_string_pretty(manifest)
            .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
        let key = self.members_manifest_key();
        self.s3_put(&key, json.as_bytes()).await
    }

    /// Download members manifest from S3
    pub async fn download_members_manifest(&self) -> Result<Option<TeamManifest>, String> {
        let key = self.members_manifest_key();
        match self.s3_get(&key).await {
            Ok(data) => {
                let manifest: TeamManifest = serde_json::from_slice(&data)
                    .map_err(|e| format!("Failed to parse manifest: {}", e))?;
                Ok(Some(manifest))
            }
            Err(e) if e.contains("NoSuchKey") || e.contains("not found") => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Add a member to the manifest and upload
    pub async fn add_member(&self, member: TeamMember) -> Result<(), String> {
        let mut manifest =
            self.download_members_manifest()
                .await?
                .unwrap_or_else(|| TeamManifest {
                    owner_node_id: self.node_id.clone(),
                    members: vec![],
                });

        if manifest.members.iter().any(|m| m.node_id == member.node_id) {
            return Err("This device already exists in the team".to_string());
        }

        manifest.members.push(member);
        self.upload_members_manifest(&manifest).await
    }

    /// Remove a member from the manifest and upload
    pub async fn remove_member(&self, node_id: &str) -> Result<(), String> {
        let mut manifest = self
            .download_members_manifest()
            .await?
            .ok_or("No members manifest found")?;

        if manifest.owner_node_id == node_id {
            return Err("Cannot remove the team Owner".to_string());
        }

        manifest.members.retain(|m| m.node_id != node_id);
        self.upload_members_manifest(&manifest).await
    }

    /// Update a member's role in the manifest and upload
    pub async fn update_member_role(&self, node_id: &str, role: MemberRole) -> Result<(), String> {
        let mut manifest = self
            .download_members_manifest()
            .await?
            .ok_or("No members manifest found")?;

        if manifest.owner_node_id == node_id && role != MemberRole::Owner {
            return Err("Cannot change the Owner's role".to_string());
        }

        if let Some(member) = manifest.members.iter_mut().find(|m| m.node_id == node_id) {
            member.role = role;
        } else {
            return Err("Member not found".to_string());
        }

        self.upload_members_manifest(&manifest).await
    }

    /// Check if a node_id is in the members manifest
    pub async fn check_member_authorized(&self, node_id: &str) -> Result<MemberRole, String> {
        let manifest = self
            .download_members_manifest()
            .await?
            .ok_or("No members manifest found")?;

        manifest
            .members
            .iter()
            .find(|m| m.node_id == node_id)
            .map(|m| m.role.clone())
            .ok_or(
                "Your device has not been added to the team. Please contact the team Owner"
                    .to_string(),
            )
    }
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

pub fn read_oss_config(workspace_path: &str) -> Option<OssTeamConfig> {
    let config_path = Path::new(workspace_path)
        .join(TEAMCLAW_DIR)
        .join("teamclaw.json");

    let content = std::fs::read_to_string(&config_path).ok()?;
    let json: Value = serde_json::from_str(&content).ok()?;
    let oss_value = json.get("oss")?;
    serde_json::from_value(oss_value.clone()).ok()
}

pub fn write_oss_config(workspace_path: &str, config: &OssTeamConfig) -> Result<(), String> {
    let config_path = Path::new(workspace_path)
        .join(TEAMCLAW_DIR)
        .join("teamclaw.json");

    let mut json: Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read teamclaw.json: {e}"))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse teamclaw.json: {e}"))?
    } else {
        Value::Object(serde_json::Map::new())
    };

    let oss_value =
        serde_json::to_value(config).map_err(|e| format!("Failed to serialize oss config: {e}"))?;

    // Merge new config into existing oss object to preserve fields like nodeId
    let root = json
        .as_object_mut()
        .ok_or_else(|| "teamclaw.json root is not an object".to_string())?;
    if let Some(existing_oss) = root.get_mut("oss").and_then(|v| v.as_object_mut()) {
        if let Some(new_obj) = oss_value.as_object() {
            for (k, v) in new_obj {
                existing_oss.insert(k.clone(), v.clone());
            }
        }
    } else {
        root.insert("oss".to_string(), oss_value);
    }

    // Ensure parent dir exists
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }

    let output = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize teamclaw.json: {e}"))?;

    std::fs::write(&config_path, output)
        .map_err(|e| format!("Failed to write teamclaw.json: {e}"))?;

    Ok(())
}

pub fn save_team_secret(team_id: &str, secret: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, team_id)
        .map_err(|e| format!("Failed to create keyring entry: {e}"))?;
    entry
        .set_password(secret)
        .map_err(|e| format!("Failed to save team secret to keyring: {e}"))?;
    Ok(())
}

pub fn load_team_secret(team_id: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, team_id)
        .map_err(|e| format!("Failed to create keyring entry: {e}"))?;
    entry
        .get_password()
        .map_err(|e| format!("Failed to load team secret from keyring: {e}"))
}

pub fn delete_team_secret(team_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, team_id)
        .map_err(|e| format!("Failed to create keyring entry: {e}"))?;
    entry
        .delete_credential()
        .map_err(|e| format!("Failed to delete team secret from keyring: {e}"))?;
    Ok(())
}

use crate::commands::oss_types::*;
use crate::commands::team::TEAM_REPO_DIR;
use crate::commands::version_types::MAX_VERSIONS;
use crate::commands::TEAMCLAW_DIR;

use aws_sdk_s3::primitives::ByteStream;
use futures::stream::{self, StreamExt};
use chrono::Utc;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use base64::Engine;
use tracing::{info, warn};
use zstd;

const KEYRING_SERVICE: &str = concat!(env!("APP_SHORT_NAME"), "-oss");
const TOKEN_REFRESH_MARGIN_SECS: i64 = 300; // refresh 5 min before expiry
/// Maximum file size (in bytes) that will be synced. Files larger than this
/// are silently skipped during scan to prevent OOM and oversized S3 PUTs.
/// 2 MB is generous for config/skill/knowledge text files.
const MAX_SYNC_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10 MB (was 2 MB)
/// Maximum cumulative size (in bytes) for S3 update downloads per pull cycle.
/// Protects against legacy oversized CRDT updates that predate the upload cap.
const MAX_DOWNLOAD_SIZE: u64 = 50 * 1024 * 1024; // 50 MB cumulative per pull

// ---------------------------------------------------------------------------
// OssSyncManager
// ---------------------------------------------------------------------------

pub struct OssSyncManager {
    s3_client: Option<aws_sdk_s3::Client>,
    credentials: Option<OssCredentials>,
    oss_config: Option<OssConfig>,
    team_endpoint: String,
    force_path_style: bool,

    skills_doc: loro::LoroDoc,
    mcp_doc: loro::LoroDoc,
    knowledge_doc: loro::LoroDoc,
    secrets_doc: loro::LoroDoc,

    team_id: String,
    node_id: String,
    team_secret: String,
    role: MemberRole,
    known_files: HashMap<DocType, HashSet<String>>,

    /// Last processed S3 key per DocType, for start_after pruning
    last_known_key: HashMap<DocType, String>,
    /// Per-node cursor: (DocType, node_prefix) → last processed S3 key.
    /// Each node subdirectory has monotonically increasing timestamps,
    /// so per-node cursors are safe for start_after pruning.
    last_known_key_per_node: HashMap<(DocType, String), String>,
    /// Last exported Loro version vector bytes per DocType, for incremental export
    last_exported_version: HashMap<DocType, Vec<u8>>,
    /// Last local file scan time per DocType, for mtime-based incremental scanning
    last_scan_time: HashMap<DocType, std::time::SystemTime>,
    /// Last compaction time per DocType
    last_compaction_at: HashMap<DocType, chrono::DateTime<Utc>>,
    /// Signal flag keys already seen (to avoid re-triggering pulls)
    known_signal_keys: HashSet<String>,

    health: SyncHealth,
    health_message: Option<String>,
    skipped_files: Vec<SkippedFile>,
    last_data_sync_at: Option<String>,
    last_check_at: Option<String>,
    live_keyset: HashSet<String>,
    generation: HashMap<DocType, String>,
    failed_import_keys: HashMap<String, u8>,

    poll_interval: Duration,
    workspace_path: String,
    team_dir: PathBuf,
    loro_cache_dir: PathBuf,
    connected: bool,
    syncing: bool,
    app_handle: Option<tauri::AppHandle>,
}

pub struct OssSyncState {
    pub manager: Arc<Mutex<Option<OssSyncManager>>>,
    pub fast_poll_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub slow_poll_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl Default for OssSyncState {
    fn default() -> Self {
        Self {
            manager: Arc::new(Mutex::new(None)),
            fast_poll_handle: Arc::new(Mutex::new(None)),
            slow_poll_handle: Arc::new(Mutex::new(None)),
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
        team_endpoint: String,
        force_path_style: bool,
        workspace_path: String,
        poll_interval: Duration,
        app_handle: Option<tauri::AppHandle>,
    ) -> Self {
        let team_dir = Path::new(&workspace_path).join(TEAM_REPO_DIR);
        let loro_cache_dir = Path::new(&workspace_path).join(TEAMCLAW_DIR).join("loro");

        let cursor = read_sync_cursor(&workspace_path);

        let mut last_known_key = HashMap::new();
        let mut last_compaction_at_map = HashMap::new();
        for dt in DocType::all() {
            if let Some(key) = cursor.last_known_keys.get(dt.path()) {
                last_known_key.insert(dt, key.clone());
            }
            if let Some(ts_str) = cursor.last_compaction_at.get(dt.path()) {
                if let Ok(dt_parsed) = chrono::DateTime::parse_from_rfc3339(ts_str) {
                    last_compaction_at_map.insert(dt, dt_parsed.with_timezone(&Utc));
                }
            }
        }
        let known_signal_keys: HashSet<String> = cursor.known_signal_keys.into_iter().collect();

        // Restore per-node cursors from persisted sync cursor
        let mut last_known_key_per_node: HashMap<(DocType, String), String> = HashMap::new();
        for (cursor_key, key) in &cursor.last_known_keys_per_node {
            // cursor_key format: "docType:nodePrefix"
            if let Some(colon_pos) = cursor_key.find(':') {
                let dt_str = &cursor_key[..colon_pos];
                let node_prefix = &cursor_key[colon_pos + 1..];
                if let Some(dt) = DocType::from_path(dt_str) {
                    last_known_key_per_node.insert((dt, node_prefix.to_string()), key.clone());
                }
            }
        }

        // Migrate from old single-cursor format: derive per-node cursor from
        // the old last_known_key. Key format is
        // "teams/{teamId}/{docType}/updates/{nodeId}/{ts}.bin", so the node
        // prefix is everything up to and including the nodeId segment + "/".
        if last_known_key_per_node.is_empty() {
            for (dt, key) in &last_known_key {
                // Find the node prefix: everything up to the last '/' + 1
                if let Some(last_slash) = key.rfind('/') {
                    let node_prefix = format!("{}/", &key[..last_slash]);
                    last_known_key_per_node.insert((*dt, node_prefix), key.clone());
                }
            }
        }

        // Restore last_exported_version from base64-encoded strings
        let mut last_exported_version = HashMap::new();
        let b64 = base64::engine::general_purpose::STANDARD;
        for (dt_str, encoded) in &cursor.last_exported_version {
            if let Some(dt) = DocType::from_path(dt_str) {
                if let Ok(bytes) = b64.decode(encoded) {
                    last_exported_version.insert(dt, bytes);
                }
            }
        }

        // Restore last_scan_time from unix millis
        let mut last_scan_time = HashMap::new();
        for (dt_str, millis) in &cursor.last_scan_time {
            if let Some(dt) = DocType::from_path(dt_str) {
                let time = std::time::UNIX_EPOCH + Duration::from_millis(*millis);
                last_scan_time.insert(dt, time);
            }
        }

        // Restore known_files from Vec<String> to HashSet<String>
        let mut known_files = HashMap::new();
        for dt in DocType::all() {
            let set = cursor.known_files.get(dt.path())
                .map(|v| v.iter().cloned().collect::<HashSet<String>>())
                .unwrap_or_default();
            known_files.insert(dt, set);
        }

        // Restore generation
        let mut generation = HashMap::new();
        for (dt_str, gen_id) in &cursor.generation {
            if let Some(dt) = DocType::from_path(dt_str) {
                generation.insert(dt, gen_id.clone());
            }
        }

        Self {
            s3_client: None,
            credentials: None,
            oss_config: None,
            team_endpoint,
            force_path_style,
            skills_doc: loro::LoroDoc::new(),
            mcp_doc: loro::LoroDoc::new(),
            knowledge_doc: loro::LoroDoc::new(),
            secrets_doc: loro::LoroDoc::new(),
            team_id,
            node_id,
            team_secret,
            role: MemberRole::Editor,
            known_files,
            last_known_key,
            last_known_key_per_node,
            last_exported_version,
            last_scan_time,
            last_compaction_at: last_compaction_at_map,
            known_signal_keys,
            health: SyncHealth::default(),
            health_message: None,
            skipped_files: Vec::new(),
            last_data_sync_at: None,
            last_check_at: None,
            live_keyset: HashSet::new(),
            generation,
            failed_import_keys: HashMap::new(),
            poll_interval,
            workspace_path,
            team_dir,
            loro_cache_dir,
            connected: false,
            syncing: false,
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

    #[allow(dead_code)]
    pub fn workspace_path(&self) -> &str {
        &self.workspace_path
    }

    pub fn set_credentials(&mut self, creds: OssCredentials, oss: OssConfig) {
        info!(
            "[OssRestore] S3 endpoint={}, region={}, bucket={}",
            oss.endpoint, oss.region, oss.bucket
        );
        self.s3_client = Some(Self::create_s3_client(&creds, &oss, self.force_path_style));
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

    pub fn set_last_data_sync_at(&mut self, ts: Option<String>) {
        self.last_data_sync_at = ts;
    }

    pub fn set_last_check_at(&mut self, ts: Option<String>) {
        self.last_check_at = ts;
    }

    pub fn export_sync_cursor(&self) -> SyncCursor {
        let mut last_known_keys = HashMap::new();
        for (dt, key) in &self.last_known_key {
            last_known_keys.insert(dt.path().to_string(), key.clone());
        }
        let mut last_known_keys_per_node = HashMap::new();
        for ((dt, node_prefix), key) in &self.last_known_key_per_node {
            let cursor_key = format!("{}:{}", dt.path(), node_prefix);
            last_known_keys_per_node.insert(cursor_key, key.clone());
        }
        let mut last_compaction_at = HashMap::new();
        for (dt, ts) in &self.last_compaction_at {
            last_compaction_at.insert(dt.path().to_string(), ts.to_rfc3339());
        }

        // Serialize last_exported_version as base64
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut last_exported_version_map = HashMap::new();
        for (dt, bytes) in &self.last_exported_version {
            last_exported_version_map.insert(dt.path().to_string(), b64.encode(bytes));
        }

        // Serialize last_scan_time as unix millis
        let mut last_scan_time_map = HashMap::new();
        for (dt, time) in &self.last_scan_time {
            if let Ok(duration) = time.duration_since(std::time::UNIX_EPOCH) {
                last_scan_time_map.insert(dt.path().to_string(), duration.as_millis() as u64);
            }
        }

        // Serialize known_files as Vec<String>
        let mut known_files_map = HashMap::new();
        for (dt, set) in &self.known_files {
            known_files_map.insert(dt.path().to_string(), set.iter().cloned().collect());
        }

        // Serialize generation
        let mut generation_map = HashMap::new();
        for (dt, gen_id) in &self.generation {
            generation_map.insert(dt.path().to_string(), gen_id.clone());
        }

        SyncCursor {
            last_known_keys,
            last_known_keys_per_node,
            known_signal_keys: self.known_signal_keys.iter().cloned().collect(),
            last_compaction_at,
            last_exported_version: last_exported_version_map,
            last_scan_time: last_scan_time_map,
            known_files: known_files_map,
            generation: generation_map,
        }
    }

    // -----------------------------------------------------------------------
    // S3 Client
    // -----------------------------------------------------------------------

    fn create_s3_client(
        creds: &OssCredentials,
        config: &OssConfig,
        force_path_style: bool,
    ) -> aws_sdk_s3::Client {
        let credentials = aws_sdk_s3::config::Credentials::new(
            &creds.access_key_id,
            &creds.access_key_secret,
            Some(creds.security_token.clone()),
            None,
            "oss-sts",
        );

        let timeout_config = aws_sdk_s3::config::timeout::TimeoutConfig::builder()
            .operation_timeout(std::time::Duration::from_secs(15))
            .operation_attempt_timeout(std::time::Duration::from_secs(8))
            .connect_timeout(std::time::Duration::from_secs(5))
            .build();

        let stalled_stream =
            aws_sdk_s3::config::StalledStreamProtectionConfig::enabled()
                .grace_period(std::time::Duration::from_secs(10))
                .build();

        let s3_config = aws_sdk_s3::config::Builder::new()
            .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest())
            .endpoint_url(&config.endpoint)
            .region(aws_sdk_s3::config::Region::new(config.region.clone()))
            .credentials_provider(credentials)
            .force_path_style(force_path_style)
            .timeout_config(timeout_config)
            .stalled_stream_protection(stalled_stream)
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
        self.s3_client = Some(Self::create_s3_client(
            &resp.credentials,
            &resp.oss,
            self.force_path_style,
        ));

        self.role =
            serde_json::from_str(&format!("\"{}\"", resp.role)).unwrap_or(MemberRole::Editor);

        info!("OSS STS token refreshed successfully");
        Ok(())
    }

    pub async fn call_fc(&self, path: &str, body: &Value) -> Result<FcResponse, String> {
        let url = format!("{}{}", self.team_endpoint, path);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

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
                // Exponential backoff with jitter to avoid thundering herd
                let base_delay_ms = 2000u64 * 2u64.pow(attempt - 1); // 2s, 4s, 8s
                let jitter_ms = (std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .subsec_nanos() as u64)
                    % 1000; // 0-999ms jitter
                let delay_ms = base_delay_ms + jitter_ms;
                if attempt == 1 {
                    warn!(
                        "FC request to {path} returned 429, will retry up to {max_retries} times with backoff"
                    );
                }
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
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

    /// Like `s3_list`, but only returns keys lexicographically after `start_after`.
    /// If `start_after` is None, behaves identically to `s3_list`.
    async fn s3_list_after(
        &self,
        prefix: &str,
        start_after: Option<&str>,
    ) -> Result<Vec<String>, String> {
        let client = self.client()?;
        let bucket = self.bucket()?;

        let mut keys: Vec<String> = Vec::new();
        let mut continuation_token: Option<String> = None;

        loop {
            let mut req = client.list_objects_v2().bucket(bucket).prefix(prefix);

            if let Some(after) = start_after {
                req = req.start_after(after);
            }

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

    /// List "subdirectories" (common prefixes) under the given prefix using
    /// the S3 delimiter. For example, listing `teams/t1/skills/updates/` with
    /// delimiter `/` returns `["teams/t1/skills/updates/nodeA/", ...]`.
    async fn s3_list_common_prefixes(&self, prefix: &str) -> Result<Vec<String>, String> {
        let client = self.client()?;
        let bucket = self.bucket()?;

        let mut prefixes: Vec<String> = Vec::new();
        let mut continuation_token: Option<String> = None;

        loop {
            let mut req = client
                .list_objects_v2()
                .bucket(bucket)
                .prefix(prefix)
                .delimiter("/");

            if let Some(token) = &continuation_token {
                req = req.continuation_token(token);
            }

            let resp = req
                .send()
                .await
                .map_err(|e| format!("S3 LIST prefixes {prefix} failed: {e}"))?;

            for cp in resp.common_prefixes() {
                if let Some(p) = cp.prefix() {
                    prefixes.push(p.to_string());
                }
            }

            if resp.is_truncated() == Some(true) {
                continuation_token = resp.next_continuation_token().map(|s| s.to_string());
            } else {
                break;
            }
        }

        prefixes.sort();
        Ok(prefixes)
    }

    /// Best-effort existence check for a specific S3 object key.
    /// Uses LIST with exact-key prefix to avoid broad scans.
    async fn s3_key_exists(&self, key: &str) -> Result<bool, String> {
        let keys = self.s3_list(key).await?;
        Ok(keys.iter().any(|k| k == key))
    }

    pub async fn s3_delete(&self, key: &str) -> Result<(), String> {
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

    /// Get the size of an S3 object without downloading it.
    pub async fn s3_head_size(&self, key: &str) -> Result<u64, String> {
        let client = self.client()?;
        let bucket = self.bucket()?;

        let resp = client
            .head_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| format!("S3 HEAD {key} failed: {e}"))?;

        Ok(resp.content_length().unwrap_or(0) as u64)
    }

    // -----------------------------------------------------------------------
    // Signal Flag Operations
    // -----------------------------------------------------------------------

    /// Write a 0-byte signal flag to S3 to notify other nodes of changes.
    pub async fn write_signal_flag(&self) -> Result<(), String> {
        let timestamp_ms = Utc::now().timestamp_millis();
        let key = format!(
            "teams/{}/signal/{}/{}.flag",
            self.team_id, self.node_id, timestamp_ms
        );
        self.s3_put(&key, &[]).await?;
        info!("Wrote signal flag: {key}");
        Ok(())
    }

    /// Check for new signal flags from other nodes.
    /// Returns `true` if there are new flags (meaning remote changes exist).
    async fn check_signal_flags(&mut self) -> Result<bool, String> {
        let prefix = format!("teams/{}/signal/", self.team_id);
        let all_flags = self.s3_list(&prefix).await?;

        let mut has_new = false;
        for flag in &all_flags {
            let own_prefix = format!("teams/{}/signal/{}/", self.team_id, self.node_id);
            if flag.starts_with(&own_prefix) {
                continue;
            }
            if !self.known_signal_keys.contains(flag) {
                has_new = true;
                self.known_signal_keys.insert(flag.clone());
            }
        }

        Ok(has_new)
    }

    /// Delete signal flags older than 1 hour, and prune matching entries
    /// from `known_signal_keys` to prevent unbounded memory growth.
    async fn cleanup_expired_signal_flags(&mut self) -> Result<u32, String> {
        let prefix = format!("teams/{}/signal/", self.team_id);
        let flags = self.s3_list(&prefix).await?;
        let one_hour_ago_ms = Utc::now().timestamp_millis() - 3_600_000;

        let mut deleted = 0u32;
        for key in &flags {
            if let Some(ts) = Self::extract_timestamp_from_flag_key(key) {
                if ts < one_hour_ago_ms {
                    self.s3_delete(key).await?;
                    self.known_signal_keys.remove(key);
                    deleted += 1;
                }
            }
        }

        if deleted > 0 {
            info!("Cleaned up {deleted} expired signal flags");
        }
        Ok(deleted)
    }

    /// Extract timestamp_ms from a signal flag key.
    /// Key format: `teams/{team_id}/signal/{node_id}/{timestamp_ms}.flag`
    fn extract_timestamp_from_flag_key(key: &str) -> Option<i64> {
        key.rsplit('/')
            .next()
            .and_then(|f| f.strip_suffix(".flag"))
            .and_then(|s| s.parse().ok())
    }

    // -----------------------------------------------------------------------
    // Loro Document Operations
    // -----------------------------------------------------------------------

    fn get_doc(&self, doc_type: DocType) -> &loro::LoroDoc {
        match doc_type {
            DocType::Skills => &self.skills_doc,
            DocType::Mcp => &self.mcp_doc,
            DocType::Knowledge => &self.knowledge_doc,
            DocType::Secrets => &self.secrets_doc,
        }
    }

    fn get_doc_mut(&mut self, doc_type: DocType) -> &mut loro::LoroDoc {
        match doc_type {
            DocType::Skills => &mut self.skills_doc,
            DocType::Mcp => &mut self.mcp_doc,
            DocType::Knowledge => &mut self.knowledge_doc,
            DocType::Secrets => &mut self.secrets_doc,
        }
    }

    /// Archive the current state of a file entry into its `versions` LoroList
    /// before overwriting or deleting it. Trims the list to MAX_VERSIONS.
    fn archive_current_version(files_map: &loro::LoroMap, path: &str) -> Result<(), String> {
        // Only archive if the entry already exists with content
        let entry_map = match files_map.get(path) {
            Some(loro::ValueOrContainer::Container(loro::Container::Map(m))) => m,
            _ => return Ok(()), // No existing entry — nothing to archive
        };

        let deep = entry_map.get_deep_value();
        let entry = match deep {
            loro::LoroValue::Map(ref m) => m.clone(),
            _ => return Ok(()),
        };

        // Require at least a content field to be worth archiving
        let content = match entry.get("content") {
            Some(loro::LoroValue::String(s)) => s.as_ref().to_string(),
            _ => return Ok(()),
        };
        let hash = match entry.get("hash") {
            Some(loro::LoroValue::String(s)) => s.as_ref().to_string(),
            _ => String::new(),
        };
        let updated_by = match entry.get("updatedBy") {
            Some(loro::LoroValue::String(s)) => s.as_ref().to_string(),
            _ => String::new(),
        };
        let updated_at = match entry.get("updatedAt") {
            Some(loro::LoroValue::String(s)) => s.as_ref().to_string(),
            _ => String::new(),
        };
        let deleted = match entry.get("deleted") {
            Some(loro::LoroValue::Bool(b)) => *b,
            _ => false,
        };

        // Get or create the versions list
        let versions = entry_map
            .get_or_create_container("versions", loro::LoroList::new())
            .map_err(|e| format!("Failed to get/create versions list for {path}: {e}"))?;

        // Push a snapshot map into the versions list
        let snapshot = versions
            .push_container(loro::LoroMap::new())
            .map_err(|e| format!("Failed to push version snapshot for {path}: {e}"))?;

        snapshot
            .insert("content", content.as_str())
            .map_err(|e| format!("Failed to set version content for {path}: {e}"))?;
        snapshot
            .insert("hash", hash.as_str())
            .map_err(|e| format!("Failed to set version hash for {path}: {e}"))?;
        snapshot
            .insert("updatedBy", updated_by.as_str())
            .map_err(|e| format!("Failed to set version updatedBy for {path}: {e}"))?;
        snapshot
            .insert("updatedAt", updated_at.as_str())
            .map_err(|e| format!("Failed to set version updatedAt for {path}: {e}"))?;
        snapshot
            .insert("deleted", deleted)
            .map_err(|e| format!("Failed to set version deleted for {path}: {e}"))?;

        // Trim to MAX_VERSIONS (oldest first, so delete from index 0)
        while versions.len() > MAX_VERSIONS {
            versions
                .delete(0, 1)
                .map_err(|e| format!("Failed to trim versions list for {path}: {e}"))?;
        }

        Ok(())
    }

    /// Build a gitignore matcher that layers rules from the team root
    /// `.gitignore` (parent of `dir`) and the doc-type subdir `.gitignore`.
    fn build_gitignore(dir: &Path) -> ignore::gitignore::Gitignore {
        let mut builder = ignore::gitignore::GitignoreBuilder::new(dir);
        // Team root .gitignore (one level up, e.g. teamclaw-team/.gitignore)
        if let Some(parent) = dir.parent() {
            let root_gi = parent.join(".gitignore");
            if root_gi.exists() {
                let _ = builder.add(root_gi);
            }
        }
        // Subdir .gitignore (e.g. teamclaw-team/skills/.gitignore)
        let sub_gi = dir.join(".gitignore");
        if sub_gi.exists() {
            let _ = builder.add(sub_gi);
        }
        builder.build().unwrap_or_else(|_| {
            ignore::gitignore::GitignoreBuilder::new(dir).build().unwrap()
        })
    }

    fn scan_local_files(dir: &Path) -> Result<HashMap<String, Vec<u8>>, String> {
        let mut result = HashMap::new();

        if !dir.exists() {
            return Ok(result);
        }

        let gitignore = Self::build_gitignore(dir);

        fn walk(
            base: &Path,
            current: &Path,
            gitignore: &ignore::gitignore::Gitignore,
            result: &mut HashMap<String, Vec<u8>>,
        ) -> Result<(), String> {
            let entries = std::fs::read_dir(current)
                .map_err(|e| format!("Failed to read dir {}: {e}", current.display()))?;

            for entry in entries {
                let entry = entry.map_err(|e| format!("Dir entry error: {e}"))?;
                let path = entry.path();
                let name = entry.file_name();
                let name_str = name.to_string_lossy();

                // Skip hidden files/dirs (but allow .gitignore)
                if name_str.starts_with('.') && name_str != ".gitignore" {
                    continue;
                }

                if path.is_dir() {
                    // Check gitignore for directories
                    if gitignore.matched(&path, true).is_ignore() {
                        continue;
                    }
                    walk(base, &path, gitignore, result)?;
                } else {
                    // Check gitignore for files
                    if gitignore.matched(&path, false).is_ignore() {
                        continue;
                    }
                    // Skip files exceeding the size limit
                    if let Ok(meta) = path.metadata() {
                        if meta.len() > MAX_SYNC_FILE_SIZE {
                            tracing::warn!(
                                "Skipping oversized file ({} bytes): {}",
                                meta.len(),
                                path.display()
                            );
                            continue;
                        }
                    }
                    let rel = path
                        .strip_prefix(base)
                        .map_err(|e| format!("Path strip error: {e}"))?;
                    let rel_str = rel.to_string_lossy().to_string();
                    let content = std::fs::read(&path)
                        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
                    // Skip binary files — CRDT stores content as UTF-8 strings,
                    // and from_utf8_lossy would corrupt binary data and cause
                    // infinite re-upload (hash mismatch every cycle).
                    if std::str::from_utf8(&content).is_err() {
                        tracing::warn!(
                            "Skipping non-UTF-8 file: {}",
                            path.display()
                        );
                        continue;
                    }
                    result.insert(rel_str, content);
                }
            }
            Ok(())
        }

        walk(dir, dir, &gitignore, &mut result)?;
        Ok(result)
    }

    /// Like `scan_local_files`, but only reads files whose mtime is newer than `since`.
    /// Used by the fast loop for quick change detection.
    fn scan_local_files_incremental(
        dir: &Path,
        since: std::time::SystemTime,
    ) -> Result<HashMap<String, Vec<u8>>, String> {
        let mut result = HashMap::new();

        if !dir.exists() {
            return Ok(result);
        }

        let gitignore = Self::build_gitignore(dir);

        fn walk_incremental(
            base: &Path,
            current: &Path,
            since: std::time::SystemTime,
            gitignore: &ignore::gitignore::Gitignore,
            result: &mut HashMap<String, Vec<u8>>,
        ) -> Result<(), String> {
            let entries = std::fs::read_dir(current)
                .map_err(|e| format!("Failed to read dir {}: {e}", current.display()))?;

            for entry in entries {
                let entry = entry.map_err(|e| format!("Dir entry error: {e}"))?;
                let path = entry.path();
                let name = entry.file_name();
                let name_str = name.to_string_lossy();

                // Skip hidden files/dirs (but allow .gitignore)
                if name_str.starts_with('.') && name_str != ".gitignore" {
                    continue;
                }

                if path.is_dir() {
                    if gitignore.matched(&path, true).is_ignore() {
                        continue;
                    }
                    walk_incremental(base, &path, since, gitignore, result)?;
                } else {
                    if gitignore.matched(&path, false).is_ignore() {
                        continue;
                    }
                    // Skip files exceeding the size limit
                    let meta = path.metadata().ok();
                    if let Some(ref m) = meta {
                        if m.len() > MAX_SYNC_FILE_SIZE {
                            tracing::warn!(
                                "Skipping oversized file ({} bytes): {}",
                                m.len(),
                                path.display()
                            );
                            continue;
                        }
                    }

                    let dominated = meta
                        .and_then(|m| m.modified().ok())
                        .map(|mtime| mtime > since)
                        .unwrap_or(true);

                    if dominated {
                        let rel = path
                            .strip_prefix(base)
                            .map_err(|e| format!("Path strip error: {e}"))?;
                        let rel_str = rel.to_string_lossy().to_string();
                        let content = std::fs::read(&path)
                            .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
                        if std::str::from_utf8(&content).is_err() {
                            tracing::warn!(
                                "Skipping non-UTF-8 file: {}",
                                path.display()
                            );
                            continue;
                        }
                        result.insert(rel_str, content);
                    }
                }
            }
            Ok(())
        }

        walk_incremental(dir, dir, since, &gitignore, &mut result)?;
        Ok(result)
    }

    /// Fast-path upload: only check files modified since last scan (mtime-based).
    /// Returns `Ok(true)` if changes were uploaded.
    ///
    /// Only uploads changed/new files — does NOT detect deletions (that's the
    /// slow_loop's job via full `upload_local_changes`). This avoids a redundant
    /// full directory scan every 30 seconds.
    pub async fn upload_local_changes_incremental(
        &mut self,
        doc_type: DocType,
    ) -> Result<bool, String> {
        let dir = self.team_dir.join(doc_type.dir_name());
        let since = self
            .last_scan_time
            .get(&doc_type)
            .copied()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

        let mtime_changed = Self::scan_local_files_incremental(&dir, since)?;

        if mtime_changed.is_empty() {
            // No mtime changes, but files may have been deleted since the
            // last scan.  Check the CRDT for entries that are not marked
            // deleted yet whose files no longer exist on disk.  If any are
            // found, delegate to the full `upload_local_changes` which
            // handles deletion marking + upload in one shot.
            let local_files = Self::scan_local_files(&dir)?;
            let doc = self.get_doc(doc_type);
            let files_map = doc.get_map("files");
            let map_value = files_map.get_deep_value();
            if let loro::LoroValue::Map(entries) = &map_value {
                for (path, value) in entries.iter() {
                    if let loro::LoroValue::Map(entry) = value {
                        let deleted = match entry.get("deleted") {
                            Some(loro::LoroValue::Bool(b)) => *b,
                            _ => false,
                        };
                        if !deleted && !local_files.contains_key(path.as_str()) {
                            // At least one file was deleted locally — hand off
                            // to the full upload path which marks deletions.
                            return self.upload_local_changes(doc_type).await;
                        }
                    }
                }
            }
            return Ok(false);
        }

        // Filter to only truly changed files (hash differs from CRDT)
        let changed = self.detect_local_changes(doc_type, &mtime_changed);
        if changed.is_empty() {
            // mtime changed but content didn't (e.g. touch, copy with same content)
            self.last_scan_time
                .insert(doc_type, std::time::SystemTime::now());
            return Ok(false);
        }

        // Update CRDT with only the changed files, then export and upload
        let now = Utc::now().to_rfc3339();
        let node_id = self.node_id.clone();
        {
            let doc = self.get_doc_mut(doc_type);
            let files_map = doc.get_map("files");

            for path in &changed {
                if let Some(content) = mtime_changed.get(path) {
                    Self::archive_current_version(&files_map, path)?;

                    let hash = Self::compute_hash(content);
                    let content_str = String::from_utf8_lossy(content).to_string();

                    let entry_map = files_map
                        .get_or_create_container(path, loro::LoroMap::new())
                        .map_err(|e| format!("Failed to get/create map entry for {path}: {e}"))?;
                    entry_map.insert("content", content_str.as_str())
                        .map_err(|e| format!("Failed to set content for {path}: {e}"))?;
                    entry_map.insert("hash", hash.as_str())
                        .map_err(|e| format!("Failed to set hash for {path}: {e}"))?;
                    entry_map.insert("deleted", false)
                        .map_err(|e| format!("Failed to set deleted for {path}: {e}"))?;
                    entry_map.insert("updatedBy", node_id.as_str())
                        .map_err(|e| format!("Failed to set updatedBy for {path}: {e}"))?;
                    entry_map.insert("updatedAt", now.as_str())
                        .map_err(|e| format!("Failed to set updatedAt for {path}: {e}"))?;
                }
            }
        }

        // Export and upload
        let updates = {
            let doc = self.get_doc(doc_type);
            match self.last_exported_version.get(&doc_type) {
                Some(vv_bytes) => {
                    match loro::VersionVector::decode(vv_bytes) {
                        Ok(vv) => doc
                            .export(loro::ExportMode::updates(&vv))
                            .unwrap_or_else(|_| {
                                doc.export(loro::ExportMode::all_updates())
                                    .unwrap_or_default()
                            }),
                        Err(_) => doc
                            .export(loro::ExportMode::all_updates())
                            .map_err(|e| format!("Failed to export updates for {:?}: {e}", doc_type))?,
                    }
                }
                None => doc
                    .export(loro::ExportMode::all_updates())
                    .map_err(|e| format!("Failed to export updates for {:?}: {e}", doc_type))?,
            }
        };

        let timestamp_ms = Utc::now().timestamp_millis();
        let key = format!(
            "teams/{}/{}/updates/{}/{}.bin",
            self.team_id,
            doc_type.path(),
            self.node_id,
            timestamp_ms
        );

        let uploaded = self.upload_with_fallback(doc_type, &updates, &key).await?;
        if !uploaded {
            return Ok(false); // All fallbacks failed, don't record VV
        }
        info!(
            "Incremental upload: {} changes for {:?} ({} bytes)",
            changed.len(),
            doc_type,
            updates.len()
        );

        // Advance scan cursor only after a successful upload, so failed uploads
        // are retried on the next fast-loop cycle.
        self.last_scan_time
            .insert(doc_type, std::time::SystemTime::now());

        let current_vv = self.get_doc(doc_type).oplog_vv().encode();
        self.last_exported_version.insert(doc_type, current_vv);

        Ok(true)
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

            // Check if the file exists in the doc with the same hash.
            // Also flag files that are marked deleted in the doc but exist
            // locally — the user re-added them and we must flip deleted→false.
            let needs_update = match files_map.get(path) {
                Some(loro::ValueOrContainer::Container(loro::Container::Map(entry_map))) => {
                    let deep = entry_map.get_deep_value();
                    if let loro::LoroValue::Map(entry) = deep {
                        let is_deleted =
                            matches!(entry.get("deleted"), Some(loro::LoroValue::Bool(true)));
                        if is_deleted {
                            // File on disk but doc says deleted → needs update
                            true
                        } else {
                            match entry.get("hash") {
                                Some(loro::LoroValue::String(h)) => h.as_ref() != local_hash,
                                _ => true,
                            }
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

    /// Compare local files against the Loro doc to determine sync status.
    /// Only reports on files that exist locally — remote-only files (added by
    /// teammates but not yet pulled to disk) are not included because the file
    /// tree only displays local files.
    pub fn get_files_sync_status(
        &self,
        doc_type: Option<DocType>,
    ) -> Result<Vec<FileSyncStatus>, String> {
        let doc_types = match doc_type {
            Some(dt) => vec![dt],
            None => DocType::all().to_vec(),
        };

        let mut result = Vec::new();

        for dt in doc_types {
            let dir = self.team_dir.join(dt.dir_name());
            let local_files = Self::scan_local_files(&dir)?;
            let doc = self.get_doc(dt);
            let files_map = doc.get_map("files");

            for (path, content) in &local_files {
                let local_hash = Self::compute_hash(content);

                let status = match files_map.get(path) {
                    Some(loro::ValueOrContainer::Container(loro::Container::Map(entry_map))) => {
                        let deep = entry_map.get_deep_value();
                        if let loro::LoroValue::Map(entry) = deep {
                            let deleted = match entry.get("deleted") {
                                Some(loro::LoroValue::Bool(b)) => *b,
                                _ => false,
                            };
                            if deleted {
                                SyncFileStatus::New
                            } else {
                                match entry.get("hash") {
                                    Some(loro::LoroValue::String(h))
                                        if h.as_ref() == local_hash =>
                                    {
                                        SyncFileStatus::Synced
                                    }
                                    _ => SyncFileStatus::Modified,
                                }
                            }
                        } else {
                            SyncFileStatus::New
                        }
                    }
                    _ => SyncFileStatus::New,
                };

                result.push(FileSyncStatus {
                    path: format!("{}/{}", dt.dir_name(), path),
                    doc_type: dt.path().to_string(),
                    status,
                });
            }
        }

        Ok(result)
    }

    /// Write LoroDoc state to disk and absorb any local-only files into the CRDT.
    /// Returns `Ok(true)` if files were absorbed (caller should upload the changes).
    pub fn write_doc_to_disk(&self, doc_type: DocType) -> Result<bool, String> {
        let doc = self.get_doc(doc_type);
        let dir = self.team_dir.join(doc_type.dir_name());

        // Ensure the directory exists
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create dir {}: {e}", dir.display()))?;

        let files_map = doc.get_map("files");

        // Collect files that should exist on disk from the LoroDoc
        let mut doc_files: HashSet<String> = HashSet::new();

        let map_value = files_map.get_deep_value();
        if let loro::LoroValue::Map(entries) = map_value {
            for (path, value) in entries.iter() {
                if let loro::LoroValue::Map(entry) = value {
                    let deleted = match entry.get("deleted") {
                        Some(loro::LoroValue::Bool(b)) => *b,
                        _ => false,
                    };

                    if deleted {
                        let file_path = dir.join(path.as_str());
                        if file_path.exists() {
                            // Only delete if the file on disk is unchanged
                            // since the CRDT wrote it (hash matches).  If the
                            // hash differs the user re-added or modified the
                            // file locally — preserve it so the absorb phase
                            // below can rescue it into the CRDT.
                            let should_delete = match entry.get("hash") {
                                Some(loro::LoroValue::String(doc_hash)) => {
                                    match std::fs::read(&file_path) {
                                        Ok(disk_content) => {
                                            let disk_hash = Self::compute_hash(&disk_content);
                                            disk_hash == doc_hash.as_ref()
                                        }
                                        Err(_) => true,
                                    }
                                }
                                _ => true,
                            };
                            if should_delete {
                                let _ = std::fs::remove_file(&file_path);
                            }
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

        // After writing Secrets files to disk, reload the in-memory secrets map
        // and notify the frontend so that env-var resolution picks up the latest values.
        if doc_type == DocType::Secrets {
            if let Some(app_handle) = &self.app_handle {
                if let Some(shared_state) = app_handle.try_state::<crate::commands::shared_secrets::SharedSecretsState>() {
                    if let Err(e) = crate::commands::shared_secrets::load_all_secrets(&shared_state) {
                        log::warn!("[OssSync] Failed to reload shared secrets: {}", e);
                    }
                }
                let _ = app_handle.emit("secrets-changed", ());
            }
        }

        // Absorb files on disk that are not yet in the LoroDoc (e.g. copied
        // via Finder while the app was closed or between sync cycles).
        // This also catches files that the CRDT marks as deleted but
        // which exist locally — they are re-absorbed with deleted=false.
        let mut absorbed = false;
        if dir.exists() {
            let disk_files = Self::scan_local_files(&dir)?;
            let now = Utc::now().to_rfc3339();
            let node_id = &self.node_id;

            for (path, content) in &disk_files {
                if !doc_files.contains(path) {
                    let hash = Self::compute_hash(content);
                    let content_str = String::from_utf8_lossy(content).to_string();

                    let entry_map = files_map
                        .get_or_create_container(path, loro::LoroMap::new())
                        .map_err(|e| format!("Failed to create map entry for {path}: {e}"))?;
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

                    info!("Absorbed local-only file into LoroDoc: {path}");
                    absorbed = true;
                }
            }
        }

        Ok(absorbed)
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

    /// Layered upload strategy with compression fallback.
    ///
    /// - Layer 1: direct upload if ≤ MAX_SYNC_FILE_SIZE
    /// - Layer 2: zstd compress (level 3), upload as .zst if compressed ≤ MAX_SYNC_FILE_SIZE
    /// - Layer 3: force compact, re-export, retry layers 1 & 2
    /// - Layer 4: all fallbacks failed → set health to Error, emit sync-error, return Ok(false)
    async fn upload_with_fallback(
        &mut self,
        doc_type: DocType,
        updates: &[u8],
        base_key: &str,
    ) -> Result<bool, String> {
        // Layer 1: direct upload if within size limit
        if updates.len() as u64 <= MAX_SYNC_FILE_SIZE {
            self.s3_put(base_key, updates).await?;
            return Ok(true);
        }

        // Layer 2: zstd compress and upload as .zst
        let compressed = zstd::encode_all(std::io::Cursor::new(updates), 3)
            .map_err(|e| format!("zstd compression failed for {:?}: {e}", doc_type))?;

        if compressed.len() as u64 <= MAX_SYNC_FILE_SIZE {
            let zst_key = base_key.replace(".bin", ".zst");
            self.s3_put(&zst_key, &compressed).await?;
            self.health = SyncHealth::Warning;
            self.health_message = Some(format!(
                "{:?} update compressed {:.1} MB → {:.1} MB for upload",
                doc_type,
                updates.len() as f64 / 1_048_576.0,
                compressed.len() as f64 / 1_048_576.0,
            ));
            warn!("{}", self.health_message.as_ref().unwrap());
            return Ok(true);
        }

        // Layer 3: force compact, re-export, then retry direct + compressed
        warn!(
            "{:?} update still too large after compression ({:.1} MB compressed). Forcing compaction...",
            doc_type,
            compressed.len() as f64 / 1_048_576.0
        );
        self.compact(doc_type).await?;

        let re_exported = {
            let doc = self.get_doc(doc_type);
            doc.export(loro::ExportMode::all_updates())
                .map_err(|e| format!("Failed to re-export after compaction for {:?}: {e}", doc_type))?
        };

        // Retry layer 1 with re-exported data
        if re_exported.len() as u64 <= MAX_SYNC_FILE_SIZE {
            self.s3_put(base_key, &re_exported).await?;
            return Ok(true);
        }

        // Retry layer 2 with re-exported data
        let re_compressed = zstd::encode_all(std::io::Cursor::new(&re_exported), 3)
            .map_err(|e| format!("zstd re-compression failed for {:?}: {e}", doc_type))?;

        if re_compressed.len() as u64 <= MAX_SYNC_FILE_SIZE {
            let zst_key = base_key.replace(".bin", ".zst");
            self.s3_put(&zst_key, &re_compressed).await?;
            self.health = SyncHealth::Warning;
            self.health_message = Some(format!(
                "{:?} update compressed after compaction {:.1} MB → {:.1} MB for upload",
                doc_type,
                re_exported.len() as f64 / 1_048_576.0,
                re_compressed.len() as f64 / 1_048_576.0,
            ));
            warn!("{}", self.health_message.as_ref().unwrap());
            return Ok(true);
        }

        // Layer 4: all fallbacks exhausted
        self.health = SyncHealth::Error;
        self.health_message = Some(format!(
            "{:?} update too large to upload even after compaction + compression ({:.1} MB compressed)",
            doc_type,
            re_compressed.len() as f64 / 1_048_576.0,
        ));
        warn!("{}", self.health_message.as_ref().unwrap());
        if let Some(handle) = self.app_handle.as_ref() {
            let _ = handle.emit("sync-error", &self.health_message);
        }
        Ok(false)
    }

    pub async fn upload_local_changes(&mut self, doc_type: DocType) -> Result<bool, String> {
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
                return Ok(false);
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
                    // Archive the current version before overwriting
                    Self::archive_current_version(&files_map, path)?;

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
                            // Archive the current version before marking deleted
                            Self::archive_current_version(&files_map, path.as_str())?;

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

        // Export updates and upload — use incremental export when a prior version vector exists
        let updates = {
            let doc = self.get_doc(doc_type);
            match self.last_exported_version.get(&doc_type) {
                Some(vv_bytes) => {
                    match loro::VersionVector::decode(vv_bytes) {
                        Ok(vv) => doc
                            .export(loro::ExportMode::updates(&vv))
                            .unwrap_or_else(|_| {
                                doc.export(loro::ExportMode::all_updates())
                                    .unwrap_or_default()
                            }),
                        Err(_) => doc
                            .export(loro::ExportMode::all_updates())
                            .map_err(|e| {
                                format!("Failed to export loro updates for {:?}: {e}", doc_type)
                            })?,
                    }
                }
                None => doc
                    .export(loro::ExportMode::all_updates())
                    .map_err(|e| {
                        format!("Failed to export loro updates for {:?}: {e}", doc_type)
                    })?,
            }
        };

        let timestamp_ms = Utc::now().timestamp_millis();
        let key = format!(
            "teams/{}/{}/updates/{}/{}.bin",
            self.team_id,
            doc_type.path(),
            self.node_id,
            timestamp_ms
        );

        let uploaded = self.upload_with_fallback(doc_type, &updates, &key).await?;
        if !uploaded {
            return Ok(false); // All fallbacks failed, don't record VV
        }
        info!(
            "Uploaded {} changes for {:?} ({} bytes)",
            changed.len(),
            doc_type,
            updates.len()
        );

        // Record version vector for future incremental exports
        let current_vv = self.get_doc(doc_type).oplog_vv().encode();
        self.last_exported_version.insert(doc_type, current_vv);

        Ok(true)
    }

    pub async fn pull_remote_changes(&mut self, doc_type: DocType) -> Result<(), String> {
        let prefix = format!("teams/{}/{}/updates/", self.team_id, doc_type.path());

        // Discover all node subdirectories under updates/
        let node_prefixes = self.s3_list_common_prefixes(&prefix).await?;

        // Pull each node's updates using a per-node cursor so that
        // lexicographic ordering across different nodeIds cannot cause
        // keys to be skipped.
        let mut new_keys: Vec<String> = Vec::new();
        for node_prefix in &node_prefixes {
            let cursor = self.last_known_key_per_node.get(&(doc_type, node_prefix.clone())).map(|s| s.as_str());
            let node_keys = self.s3_list_after(node_prefix, cursor).await?;
            if let Some(last) = node_keys.last() {
                self.last_known_key_per_node.insert((doc_type, node_prefix.clone()), last.clone());
            }
            new_keys.extend(node_keys);
        }
        new_keys.sort();

        // Compaction detection: if we had per-node cursors and got zero new
        // keys, check whether any cursor key has been deleted (compacted away).
        let cursor_keys_for_doc: Vec<String> = self
            .last_known_key_per_node
            .iter()
            .filter(|((dt, _), _)| *dt == doc_type)
            .map(|(_, key)| key.clone())
            .collect();
        let cursor_missing = if !cursor_keys_for_doc.is_empty() && new_keys.is_empty() {
            let mut any_missing = false;
            for key in &cursor_keys_for_doc {
                if !self.s3_key_exists(key).await? {
                    any_missing = true;
                    break;
                }
            }
            any_missing
        } else {
            false
        };
        if Self::should_reload_snapshot_after_empty_listing(new_keys.is_empty(), cursor_missing) {
            let snap_prefix = format!("teams/{}/{}/snapshot/", self.team_id, doc_type.path());
            let snap_keys = self.s3_list(&snap_prefix).await?;
            if let Some(latest_snap) = snap_keys.last() {
                info!(
                    "Compaction detected for {:?} — reloading from snapshot: {}",
                    doc_type, latest_snap
                );
                let data = self.s3_get(latest_snap).await?;
                let doc = self.get_doc_mut(doc_type);
                doc.import(&data)
                    .map_err(|e| format!("Failed to import snapshot after compaction: {e}"))?;

                // Reset per-node cursors and re-list updates
                self.last_known_key_per_node.retain(|k, _| k.0 != doc_type);
                self.last_known_key.remove(&doc_type);
                self.known_files.insert(doc_type, HashSet::new());

                // Re-discover nodes and pull all remaining updates
                let fresh_node_prefixes = self.s3_list_common_prefixes(&prefix).await?;
                let mut fresh_keys: Vec<String> = Vec::new();
                for np in &fresh_node_prefixes {
                    let nk = self.s3_list(np).await?;
                    if let Some(last) = nk.last() {
                        self.last_known_key_per_node.insert((doc_type, np.clone()), last.clone());
                    }
                    fresh_keys.extend(nk);
                }
                fresh_keys.sort();

                for key in &fresh_keys {
                    let data = self.s3_get(key).await?;
                    let doc = self.get_doc_mut(doc_type);
                    doc.import(&data)
                        .map_err(|e| format!("Failed to import update {key}: {e}"))?;
                }

                if let Some(last) = fresh_keys.last() {
                    self.last_known_key.insert(doc_type, last.clone());
                }
                let known_set = self.known_files.entry(doc_type).or_default();
                for key in &fresh_keys {
                    known_set.insert(key.clone());
                }

                return Ok(());
            }
        }

        if new_keys.is_empty() {
            return Ok(());
        }

        info!(
            "Pulling {} new update files for {:?}",
            new_keys.len(),
            doc_type
        );

        // Download concurrently (up to 5 at a time)
        if !new_keys.is_empty() {
            let total_keys = new_keys.len();
            let download_results: Vec<(String, Result<Vec<u8>, String>)> = stream::iter(
                new_keys.iter().cloned().enumerate(),
            )
            .map(|(idx, key)| {
                let client = self.client().cloned();
                let bucket = self.bucket().map(|b| b.to_string());
                async move {
                    info!("[S3 GET] ({}/{}) starting: {}", idx + 1, total_keys, key);
                    let t0 = std::time::Instant::now();
                    let result = match (client, bucket) {
                        (Ok(c), Ok(b)) => {
                            match c
                                .get_object()
                                .bucket(&b)
                                .key(&key)
                                .send()
                                .await
                            {
                                Ok(resp) => {
                                    let size = resp.content_length().unwrap_or(0) as u64;
                                    if size > MAX_DOWNLOAD_SIZE {
                                        warn!("[S3 GET] Skipping oversized update ({:.1} MB): {}", size as f64 / 1_048_576.0, key);
                                        Err(format!("Skipped oversized update ({size} bytes): {key}"))
                                    } else {
                                        resp.body
                                            .collect()
                                            .await
                                            .map(|d| d.into_bytes().to_vec())
                                            .map_err(|e| format!("S3 GET {key} body read failed: {e}"))
                                    }
                                }
                                Err(e) => Err(format!("S3 GET {key} failed: {e}")),
                            }
                        }
                        (Err(e), _) | (_, Err(e)) => Err(e),
                    };
                    let elapsed = t0.elapsed();
                    match &result {
                        Ok(data) => info!("[S3 GET] ({}/{}) done in {:.1}s, {} bytes: {}", idx + 1, total_keys, elapsed.as_secs_f64(), data.len(), key),
                        Err(e) => warn!("[S3 GET] ({}/{}) FAILED in {:.1}s: {} — {}", idx + 1, total_keys, elapsed.as_secs_f64(), key, e),
                    }
                    (key, result)
                }
            })
            .buffer_unordered(5)
            .collect()
            .await;

            // Import in key order (keys are sorted by timestamp)
            let mut sorted_results = download_results;
            sorted_results.sort_by(|a, b| a.0.cmp(&b.0));

            for (key, result) in sorted_results {
                match result {
                    Ok(data) => {
                        let doc = self.get_doc_mut(doc_type);
                        if let Err(e) = doc.import(&data) {
                            warn!("Failed to import update {key}: {e}");
                        }
                    }
                    Err(e) => {
                        // Oversized or failed downloads are skipped, not fatal
                        warn!("Skipping update {key}: {e}");
                    }
                }
            }
        }

        // Update cursor to the last processed key
        if let Some(last) = new_keys.last() {
            self.last_known_key.insert(doc_type, last.clone());
        }

        // Also maintain known_files for backward compat (get_sync_status uses it)
        let known_set = self.known_files.entry(doc_type).or_default();
        for key in &new_keys {
            known_set.insert(key.clone());
        }

        // Write changes to disk
        self.write_doc_to_disk(doc_type)?;

        Ok(())
    }

    fn should_reload_snapshot_after_empty_listing(
        new_keys_is_empty: bool,
        cursor_missing: bool,
    ) -> bool {
        new_keys_is_empty && cursor_missing
    }

    fn select_compaction_deletion_keys(
        pre_snapshot_updates: &[String],
        current_updates: &[String],
    ) -> Vec<String> {
        let frozen: HashSet<&str> = pre_snapshot_updates.iter().map(String::as_str).collect();
        current_updates
            .iter()
            .filter(|k| frozen.contains(k.as_str()))
            .cloned()
            .collect()
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
    // Compaction Operations
    // -----------------------------------------------------------------------

    /// Check if compaction is needed for a given DocType.
    async fn should_compact(&self, doc_type: DocType) -> bool {
        // Only Owner/Editor can compact
        if self.role != MemberRole::Owner && self.role != MemberRole::Editor {
            return false;
        }

        // Check time since last compaction
        if let Some(last) = self.last_compaction_at.get(&doc_type) {
            let elapsed = Utc::now().signed_duration_since(*last).num_seconds();
            if elapsed < 3600 {
                // Less than 1 hour — check file count threshold instead
                let prefix = format!("teams/{}/{}/updates/", self.team_id, doc_type.path());
                match self.s3_list(&prefix).await {
                    Ok(keys) => keys.len() > 100,
                    Err(_) => false,
                }
            } else {
                true
            }
        } else {
            true
        }
    }

    /// Compact update files into a snapshot, then delete old updates.
    async fn compact(&mut self, doc_type: DocType) -> Result<(), String> {
        info!("Starting compaction for {:?}...", doc_type);

        // 1. Pull all latest updates to ensure doc is current
        self.pull_remote_changes(doc_type).await?;

        // 2. Freeze the deletion set BEFORE snapshot upload. We only delete keys
        // observed at this point, so concurrently written updates are preserved.
        let update_prefix = format!("teams/{}/{}/updates/", self.team_id, doc_type.path());
        let pre_snapshot_updates = self.s3_list(&update_prefix).await?;

        // 3. Export full snapshot
        let doc = self.get_doc(doc_type);
        let snapshot = doc
            .export(loro::ExportMode::Snapshot)
            .map_err(|e| format!("Failed to export snapshot for {:?}: {e}", doc_type))?;

        // 4. Upload new snapshot
        let timestamp_ms = Utc::now().timestamp_millis();
        let snap_key = format!(
            "teams/{}/{}/snapshot/{}.bin",
            self.team_id,
            doc_type.path(),
            timestamp_ms
        );
        self.s3_put(&snap_key, &snapshot).await?;
        info!(
            "Compaction: uploaded snapshot for {:?} ({} bytes)",
            doc_type,
            snapshot.len()
        );

        // 5. Re-list and delete only keys that already existed pre-snapshot.
        let current_updates = self.s3_list(&update_prefix).await?;
        let updates_to_delete = Self::select_compaction_deletion_keys(
            &pre_snapshot_updates,
            &current_updates,
        );
        for key in &updates_to_delete {
            self.s3_delete(key).await?;
        }
        info!(
            "Compaction: deleted {} pre-snapshot update files for {:?}",
            updates_to_delete.len(),
            doc_type
        );

        // 6. Trim old snapshots (keep only 2 most recent)
        let snap_prefix = format!("teams/{}/{}/snapshot/", self.team_id, doc_type.path());
        let snap_keys = self.s3_list(&snap_prefix).await?;
        if snap_keys.len() > 2 {
            for key in &snap_keys[..snap_keys.len() - 2] {
                self.s3_delete(key).await?;
            }
            info!(
                "Compaction: trimmed {} old snapshots for {:?}",
                snap_keys.len() - 2,
                doc_type
            );
        }

        // 7. Reset local state
        self.known_files.insert(doc_type, HashSet::new());
        self.last_known_key.remove(&doc_type);
        self.last_known_key_per_node.retain(|k, _| k.0 != doc_type);
        self.last_exported_version.remove(&doc_type);

        // 8. Record compaction time
        self.last_compaction_at.insert(doc_type, Utc::now());

        info!("Compaction complete for {:?}", doc_type);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Version History Operations
    // -----------------------------------------------------------------------

    /// List all archived versions for a file, returned in newest-first order.
    pub fn list_file_versions(
        &self,
        doc_type: DocType,
        file_path: &str,
    ) -> Vec<crate::commands::version_types::FileVersion> {
        let doc = self.get_doc(doc_type);
        let files_map = doc.get_map("files");

        let entry_map = match files_map.get(file_path) {
            Some(loro::ValueOrContainer::Container(loro::Container::Map(m))) => m,
            _ => return Vec::new(),
        };

        let deep = entry_map.get_deep_value();
        let entry = match deep {
            loro::LoroValue::Map(ref m) => m.clone(),
            _ => return Vec::new(),
        };

        let versions_value = match entry.get("versions") {
            Some(v) => v.clone(),
            None => return Vec::new(),
        };

        let versions_list = match versions_value {
            loro::LoroValue::List(list) => list,
            _ => return Vec::new(),
        };

        let mut result: Vec<crate::commands::version_types::FileVersion> = versions_list
            .iter()
            .enumerate()
            .filter_map(|(i, v)| {
                if let loro::LoroValue::Map(m) = v {
                    let content = match m.get("content") {
                        Some(loro::LoroValue::String(s)) => s.as_ref().to_string(),
                        _ => return None,
                    };
                    let hash = match m.get("hash") {
                        Some(loro::LoroValue::String(s)) => s.as_ref().to_string(),
                        _ => String::new(),
                    };
                    let updated_by = match m.get("updatedBy") {
                        Some(loro::LoroValue::String(s)) => s.as_ref().to_string(),
                        _ => String::new(),
                    };
                    let updated_at = match m.get("updatedAt") {
                        Some(loro::LoroValue::String(s)) => s.as_ref().to_string(),
                        _ => String::new(),
                    };
                    let deleted = match m.get("deleted") {
                        Some(loro::LoroValue::Bool(b)) => *b,
                        _ => false,
                    };
                    Some(crate::commands::version_types::FileVersion {
                        index: i as u32,
                        content,
                        hash,
                        updated_by,
                        updated_at,
                        deleted,
                    })
                } else {
                    None
                }
            })
            .collect();

        // Return in newest-first order
        result.reverse();
        result
    }

    /// List all files across one or all doc types that have non-empty version history,
    /// sorted by latest_update_at descending.
    pub fn list_all_versioned_files(
        &self,
        doc_type: Option<DocType>,
    ) -> Vec<crate::commands::version_types::VersionedFileInfo> {
        let doc_types: Vec<DocType> = match doc_type {
            Some(dt) => vec![dt],
            None => DocType::all().to_vec(),
        };

        let mut result = Vec::new();

        for dt in doc_types {
            let doc = self.get_doc(dt);
            let files_map = doc.get_map("files");
            let map_value = files_map.get_deep_value();

            if let loro::LoroValue::Map(entries) = map_value {
                for (path, value) in entries.iter() {
                    if let loro::LoroValue::Map(entry) = value {
                        // Check if versions list is non-empty
                        let version_count = match entry.get("versions") {
                            Some(loro::LoroValue::List(list)) => list.len() as u32,
                            _ => 0,
                        };

                        if version_count == 0 {
                            continue;
                        }

                        let current_deleted = match entry.get("deleted") {
                            Some(loro::LoroValue::Bool(b)) => *b,
                            _ => false,
                        };
                        let latest_update_at = match entry.get("updatedAt") {
                            Some(loro::LoroValue::String(s)) => s.as_ref().to_string(),
                            _ => String::new(),
                        };
                        let latest_update_by = match entry.get("updatedBy") {
                            Some(loro::LoroValue::String(s)) => s.as_ref().to_string(),
                            _ => String::new(),
                        };

                        result.push(crate::commands::version_types::VersionedFileInfo {
                            path: path.to_string(),
                            doc_type: dt.path().to_string(),
                            current_deleted,
                            version_count,
                            latest_update_at,
                            latest_update_by,
                        });
                    }
                }
            }
        }

        // Sort by latest_update_at descending
        result.sort_by(|a, b| b.latest_update_at.cmp(&a.latest_update_at));
        result
    }

    /// Restore a specific archived version of a file to both disk and the Loro
    /// document so that the next sync cycle does not overwrite it.
    pub fn restore_file_version(
        &mut self,
        doc_type: DocType,
        file_path: &str,
        version_index: u32,
    ) -> Result<(), String> {
        let versions = self.list_file_versions(doc_type, file_path);

        let version = versions
            .into_iter()
            .find(|v| v.index == version_index)
            .ok_or_else(|| format!("Version index {} not found for {file_path}", version_index))?;

        let restored_content = version.content.clone();

        // 1. Write the restored content to disk
        let dest = self.team_dir.join(doc_type.dir_name()).join(file_path);

        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Failed to create parent directories for {}: {e}",
                    dest.display()
                )
            })?;
        }

        std::fs::write(&dest, restored_content.as_bytes())
            .map_err(|e| format!("Failed to write restored file {}: {e}", dest.display()))?;

        // 2. Update the Loro document so the restored content is the current
        //    version and the previous current version is archived.
        let doc = self.get_doc_mut(doc_type);
        let files_map = doc.get_map("files");

        Self::archive_current_version(&files_map, file_path)?;

        let hash = Self::compute_hash(restored_content.as_bytes());
        let now = chrono::Utc::now().to_rfc3339();
        let node_id = self.node_id.clone();

        let entry_map = files_map
            .get_or_create_container(file_path, loro::LoroMap::new())
            .map_err(|e| format!("Failed to get/create map entry for {file_path}: {e}"))?;
        entry_map
            .insert("content", restored_content.as_str())
            .map_err(|e| format!("Failed to set content for {file_path}: {e}"))?;
        entry_map
            .insert("hash", hash.as_str())
            .map_err(|e| format!("Failed to set hash for {file_path}: {e}"))?;
        entry_map
            .insert("deleted", false)
            .map_err(|e| format!("Failed to set deleted for {file_path}: {e}"))?;
        entry_map
            .insert("updatedBy", node_id.as_str())
            .map_err(|e| format!("Failed to set updatedBy for {file_path}: {e}"))?;
        entry_map
            .insert("updatedAt", now.as_str())
            .map_err(|e| format!("Failed to set updatedAt for {file_path}: {e}"))?;

        info!(
            "Restored version {} of {:?}/{file_path} to disk and Loro doc",
            version_index, doc_type
        );

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Dual Poll Loops
    // -----------------------------------------------------------------------

    /// Fast loop: runs every 30 seconds.
    /// - Checks local file changes (mtime-based) → upload + signal flag
    /// - Checks signal flags → pull remote changes
    pub async fn fast_loop(state: Arc<Mutex<Option<OssSyncManager>>>) {
        let base_interval = Duration::from_secs(30);
        let max_interval = Duration::from_secs(300); // back off up to 5 min
        let mut consecutive_failures: u32 = 0;

        loop {
            // Exponential backoff: 30s, 60s, 120s, 240s, 300s (capped)
            let sleep_duration = if consecutive_failures == 0 {
                base_interval
            } else {
                let backoff_secs = 30u64 * 2u64.pow(consecutive_failures.min(4));
                Duration::from_secs(backoff_secs).min(max_interval)
            };
            tokio::time::sleep(sleep_duration).await;

            // Use try_lock: if slow_loop holds the lock, skip this cycle
            // rather than blocking. The slow_loop does a full sync anyway.
            let mut guard = match state.try_lock() {
                Ok(g) => g,
                Err(_) => {
                    info!("Fast loop skipped: slow loop is running");
                    continue;
                }
            };
            let manager = match guard.as_mut() {
                Some(m) => m,
                None => return,
            };

            let _ = manager.refresh_token_if_needed().await;

            // Track whether any S3 call fails this cycle
            let mut had_network_error = false;

            // 1. Check local changes and upload (incremental scan)
            let mut any_uploaded = false;
            for doc_type in DocType::all() {
                match manager.upload_local_changes_incremental(doc_type).await {
                    Ok(true) => any_uploaded = true,
                    Ok(false) => {}
                    Err(e) => {
                        warn!("OSS fast upload error for {:?}: {}", doc_type, e);
                        had_network_error = true;
                    }
                }
            }

            // Write signal flag if we uploaded anything
            if any_uploaded {
                if let Err(e) = manager.write_signal_flag().await {
                    warn!("Failed to write signal flag: {}", e);
                    had_network_error = true;
                }
            }

            // 2. Check for remote changes via signal flags
            if !had_network_error {
                match manager.check_signal_flags().await {
                    Ok(true) => {
                        // New signals found — pull remote changes
                        let mut needs_upload = false;
                        for doc_type in DocType::all() {
                            if let Err(e) = manager.pull_remote_changes(doc_type).await {
                                warn!("OSS fast pull error for {:?}: {}", doc_type, e);
                                had_network_error = true;
                            }
                            match manager.write_doc_to_disk(doc_type) {
                                Ok(true) => needs_upload = true, // absorbed local files
                                Ok(false) => {}
                                Err(e) => warn!("OSS fast write_doc_to_disk error for {:?}: {}", doc_type, e),
                            }
                        }

                        // If write_doc_to_disk absorbed local-only files into the
                        // CRDT, upload them so other nodes can see them.
                        if needs_upload && !had_network_error {
                            for doc_type in DocType::all() {
                                if let Err(e) = manager.upload_local_changes(doc_type).await {
                                    warn!("OSS fast absorb-upload error for {:?}: {}", doc_type, e);
                                    had_network_error = true;
                                }
                            }
                            if let Err(e) = manager.write_signal_flag().await {
                                warn!("Failed to write signal flag after absorb: {}", e);
                            }
                        }

                        // Emit status event (data changed)
                        let now = Utc::now().to_rfc3339();
                        manager.last_data_sync_at = Some(now.clone());
                        manager.last_check_at = Some(now);
                        if let Some(handle) = &manager.app_handle {
                            let status = manager.get_sync_status();
                            let _ = handle.emit("oss-sync-status", &status);
                        }
                    }
                    Ok(false) => {} // No new signals, skip
                    Err(e) => {
                        warn!("Failed to check signal flags: {}", e);
                        had_network_error = true;
                    }
                }
            }

            // Persist cursor after fast loop cycle
            {
                let cursor = manager.export_sync_cursor();
                if let Err(e) = write_sync_cursor(&manager.workspace_path, &cursor) {
                    warn!("Failed to persist sync cursor in fast loop: {}", e);
                }
            }

            // Update backoff state
            if had_network_error {
                consecutive_failures = consecutive_failures.saturating_add(1);
                if consecutive_failures == 1 {
                    warn!("Fast loop: network error, will back off");
                }
            } else {
                if consecutive_failures > 0 {
                    info!("Fast loop: network recovered after {} failures", consecutive_failures);
                }
                consecutive_failures = 0;
            }
        }
    }

    /// Slow loop: runs every 5 minutes.
    /// - Unconditional full pull (fallback consistency)
    /// - Full local file scan
    /// - Persist snapshots and cursor
    /// - Compaction and signal cleanup
    pub async fn slow_loop(state: Arc<Mutex<Option<OssSyncManager>>>) {
        let max_interval = Duration::from_secs(3600); // back off up to 1 hour
        let mut consecutive_failures: u32 = 0;

        loop {
            let interval = {
                let mut guard = state.lock().await;
                if let Some(manager) = guard.as_mut() {
                    manager.syncing = true;
                    let _ = manager.refresh_token_if_needed().await;

                    let mut had_network_error = false;

                    // 1. Full upload + pull for all DocTypes
                    let mut needs_absorb_upload = false;
                    for doc_type in DocType::all() {
                        if let Err(e) = manager.upload_local_changes(doc_type).await {
                            warn!("OSS slow upload error for {:?}: {}", doc_type, e);
                            had_network_error = true;
                        }
                        if let Err(e) = manager.pull_remote_changes(doc_type).await {
                            warn!("OSS slow pull error for {:?}: {}", doc_type, e);
                            had_network_error = true;
                        }
                        match manager.write_doc_to_disk(doc_type) {
                            Ok(true) => needs_absorb_upload = true,
                            Ok(false) => {}
                            Err(e) => warn!("OSS slow write_doc_to_disk error for {:?}: {}", doc_type, e),
                        }
                        let _ = manager.persist_local_snapshot(doc_type);
                    }

                    // Upload absorbed local-only files so other nodes see them
                    if needs_absorb_upload && !had_network_error {
                        for doc_type in DocType::all() {
                            if let Err(e) = manager.upload_local_changes(doc_type).await {
                                warn!("OSS slow absorb-upload error for {:?}: {}", doc_type, e);
                                had_network_error = true;
                            }
                        }
                    }

                    // 2. List pending applications for owners/editors
                    if manager.role() == MemberRole::Owner || manager.role() == MemberRole::Editor {
                        match manager.list_applications().await {
                            Ok(apps) => {
                                if let Some(handle) = &manager.app_handle {
                                    let _ = handle.emit("oss-applications-updated", &apps);
                                }
                            }
                            Err(e) => {
                                warn!("Failed to list applications: {}", e);
                            }
                        }
                    }

                    // 3. Persist sync cursor
                    let cursor = manager.export_sync_cursor();
                    if let Err(e) = write_sync_cursor(&manager.workspace_path, &cursor) {
                        warn!("Failed to persist sync cursor: {}", e);
                    }

                    // 4. Compaction check (skip if network is down)
                    if !had_network_error {
                        for doc_type in DocType::all() {
                            if manager.should_compact(doc_type).await {
                                if let Err(e) = manager.compact(doc_type).await {
                                    warn!("Compaction failed for {:?}: {}", doc_type, e);
                                }
                            }
                        }

                        // 5. Signal flag cleanup
                        if let Err(e) = manager.cleanup_expired_signal_flags().await {
                            warn!("Signal flag cleanup failed: {}", e);
                        }
                    }

                    manager.syncing = false;
                    let now = Utc::now().to_rfc3339();
                    // slow_loop always updates last_check_at; only set last_data_sync_at
                    // when data was actually exchanged (uploads or absorb-uploads happened)
                    if needs_absorb_upload {
                        manager.last_data_sync_at = Some(now.clone());
                    }
                    manager.last_check_at = Some(now);

                    // Persist cursor after compaction block
                    {
                        let cursor = manager.export_sync_cursor();
                        if let Err(e) = write_sync_cursor(&manager.workspace_path, &cursor) {
                            warn!("Failed to persist sync cursor after slow loop: {}", e);
                        }
                    }

                    // Emit status event to frontend
                    if let Some(handle) = &manager.app_handle {
                        let status = manager.get_sync_status();
                        let _ = handle.emit("oss-sync-status", &status);
                    }

                    // Backoff on network errors: 5m, 10m, 20m, 40m, 60m (capped)
                    if had_network_error {
                        consecutive_failures = consecutive_failures.saturating_add(1);
                        if consecutive_failures == 1 {
                            warn!("Slow loop: network error, will back off");
                        }
                        let backoff = manager.poll_interval * 2u32.pow(consecutive_failures.min(4));
                        backoff.min(max_interval)
                    } else {
                        if consecutive_failures > 0 {
                            info!("Slow loop: network recovered after {} failures", consecutive_failures);
                        }
                        consecutive_failures = 0;
                        manager.poll_interval
                    }
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

        let next_sync_at = self.last_check_at.as_ref().and_then(|last| {
            chrono::DateTime::parse_from_rfc3339(last).ok().map(|dt| {
                (dt + chrono::Duration::from_std(self.poll_interval).unwrap_or_default())
                    .to_rfc3339()
            })
        });

        SyncStatus {
            connected: self.connected,
            syncing: self.syncing,
            last_data_sync_at: self.last_data_sync_at.clone(),
            last_check_at: self.last_check_at.clone(),
            next_sync_at,
            health: self.health.clone(),
            health_message: self.health_message.clone(),
            skipped_files: self.skipped_files.clone(),
            docs,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::OssSyncManager;

    #[test]
    fn snapshot_reload_only_when_cursor_missing() {
        assert!(OssSyncManager::should_reload_snapshot_after_empty_listing(
            true, true
        ));
        assert!(!OssSyncManager::should_reload_snapshot_after_empty_listing(
            true, false
        ));
        assert!(!OssSyncManager::should_reload_snapshot_after_empty_listing(
            false, true
        ));
    }

    #[test]
    fn compaction_deletes_only_pre_snapshot_updates() {
        let pre_snapshot = vec![
            "teams/t/notes/updates/a/100.bin".to_string(),
            "teams/t/notes/updates/a/101.bin".to_string(),
        ];
        let current = vec![
            "teams/t/notes/updates/a/100.bin".to_string(),
            "teams/t/notes/updates/a/101.bin".to_string(),
            "teams/t/notes/updates/b/102.bin".to_string(), // concurrent new write
        ];

        let deletion = OssSyncManager::select_compaction_deletion_keys(&pre_snapshot, &current);
        assert_eq!(
            deletion,
            vec![
                "teams/t/notes/updates/a/100.bin".to_string(),
                "teams/t/notes/updates/a/101.bin".to_string(),
            ]
        );
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

        // If caller is manager (not owner), block removing other managers
        let is_owner = manifest.owner_node_id == self.node_id;
        if !is_owner {
            let target_role = manifest.members.iter().find(|m| m.node_id == node_id).map(|m| &m.role);
            if matches!(target_role, Some(MemberRole::Owner) | Some(MemberRole::Manager)) {
                return Err("Managers can only remove editors and viewers".to_string());
            }
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

        // Cannot assign Owner role
        if matches!(role, MemberRole::Owner) {
            return Err("Cannot assign the owner role".to_string());
        }

        let is_owner = manifest.owner_node_id == self.node_id;
        let target_role = manifest.members.iter().find(|m| m.node_id == node_id).map(|m| m.role.clone());

        // Manager restrictions
        if !is_owner {
            if matches!(role, MemberRole::Manager) {
                return Err("Only the owner can promote to manager".to_string());
            }
            if matches!(target_role, Some(MemberRole::Manager)) {
                return Err("Managers cannot change another manager's role".to_string());
            }
        }

        if let Some(member) = manifest.members.iter_mut().find(|m| m.node_id == node_id) {
            member.role = role;
        } else {
            return Err("Member not found".to_string());
        }

        self.upload_members_manifest(&manifest).await
    }

    /// List pending applications from S3.
    /// Also performs orphan cleanup: deletes applications for nodeIds already in manifest.
    pub async fn list_applications(&self) -> Result<Vec<TeamApplication>, String> {
        let prefix = format!("teams/{}/_meta/applications/", self.team_id);
        let keys = self.s3_list(&prefix).await?;

        if keys.is_empty() {
            return Ok(vec![]);
        }

        // Load current manifest for orphan check
        let manifest = self
            .download_members_manifest()
            .await?
            .unwrap_or(TeamManifest {
                owner_node_id: String::new(),
                members: vec![],
            });
        let member_ids: HashSet<&str> = manifest
            .members
            .iter()
            .map(|m| m.node_id.as_str())
            .collect();

        let mut applications = Vec::new();
        for key in &keys {
            let data = match self.s3_get(key).await {
                Ok(d) => d,
                Err(_) => continue,
            };
            let app: TeamApplication = match serde_json::from_slice(&data) {
                Ok(a) => a,
                Err(_) => continue,
            };

            // Orphan cleanup: if nodeId is already a member, delete the application file
            if member_ids.contains(app.node_id.as_str()) {
                let _ = self.s3_delete(key).await;
                continue;
            }

            applications.push(app);
        }

        Ok(applications)
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
        .join(super::CONFIG_FILE_NAME);

    let content = std::fs::read_to_string(&config_path).ok()?;
    let json: Value = serde_json::from_str(&content).ok()?;
    let oss_value = json.get("oss")?;
    serde_json::from_value(oss_value.clone()).ok()
}

pub fn write_oss_config(workspace_path: &str, config: &OssTeamConfig) -> Result<(), String> {
    let config_path = Path::new(workspace_path)
        .join(TEAMCLAW_DIR)
        .join(super::CONFIG_FILE_NAME);

    let mut json: Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {e}", super::CONFIG_FILE_NAME))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse {}: {e}", super::CONFIG_FILE_NAME))?
    } else {
        Value::Object(serde_json::Map::new())
    };

    let oss_value =
        serde_json::to_value(config).map_err(|e| format!("Failed to serialize oss config: {e}"))?;

    // Merge new config into existing oss object to preserve fields like nodeId
    let root = json
        .as_object_mut()
        .ok_or_else(|| format!("{} root is not an object", super::CONFIG_FILE_NAME))?;
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
        .map_err(|e| format!("Failed to serialize {}: {e}", super::CONFIG_FILE_NAME))?;

    std::fs::write(&config_path, output)
        .map_err(|e| format!("Failed to write {}: {e}", super::CONFIG_FILE_NAME))?;

    Ok(())
}

fn sync_cursor_path(workspace_path: &str) -> PathBuf {
    Path::new(workspace_path)
        .join(TEAMCLAW_DIR)
        .join("loro")
        .join("sync_cursor.json")
}

pub fn read_sync_cursor(workspace_path: &str) -> SyncCursor {
    let path = sync_cursor_path(workspace_path);
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => SyncCursor::default(),
    }
}

pub fn write_sync_cursor(workspace_path: &str, cursor: &SyncCursor) -> Result<(), String> {
    let path = sync_cursor_path(workspace_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create cursor dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(cursor)
        .map_err(|e| format!("Failed to serialize sync cursor: {e}"))?;
    // Atomic write: write to tmp file, then rename
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, json)
        .map_err(|e| format!("Failed to write sync cursor tmp: {e}"))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| format!("Failed to rename sync cursor tmp: {e}"))?;
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

pub fn write_pending_application(
    workspace_path: &str,
    pending: &PendingApplication,
) -> Result<(), String> {
    let config_path = Path::new(workspace_path)
        .join(TEAMCLAW_DIR)
        .join(super::CONFIG_FILE_NAME);

    let mut json: Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {e}", super::CONFIG_FILE_NAME))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse {}: {e}", super::CONFIG_FILE_NAME))?
    } else {
        Value::Object(serde_json::Map::new())
    };

    let pending_value = serde_json::to_value(pending)
        .map_err(|e| format!("Failed to serialize pending application: {e}"))?;

    let root = json
        .as_object_mut()
        .ok_or_else(|| format!("{} root is not an object", super::CONFIG_FILE_NAME))?;
    let oss = root
        .entry("oss")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if let Some(oss_obj) = oss.as_object_mut() {
        oss_obj.insert("pendingApplication".to_string(), pending_value);
    }

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }

    let output = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize {}: {e}", super::CONFIG_FILE_NAME))?;
    std::fs::write(&config_path, output)
        .map_err(|e| format!("Failed to write {}: {e}", super::CONFIG_FILE_NAME))?;

    Ok(())
}

pub fn read_pending_application(workspace_path: &str) -> Option<PendingApplication> {
    let config_path = Path::new(workspace_path)
        .join(TEAMCLAW_DIR)
        .join(super::CONFIG_FILE_NAME);

    let content = std::fs::read_to_string(&config_path).ok()?;
    let json: Value = serde_json::from_str(&content).ok()?;
    let pending = json.get("oss")?.get("pendingApplication")?;
    serde_json::from_value(pending.clone()).ok()
}

pub fn clear_pending_application(workspace_path: &str) -> Result<(), String> {
    let config_path = Path::new(workspace_path)
        .join(TEAMCLAW_DIR)
        .join(super::CONFIG_FILE_NAME);

    if !config_path.exists() {
        return Ok(());
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read {}: {e}", super::CONFIG_FILE_NAME))?;
    let mut json: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {e}", super::CONFIG_FILE_NAME))?;

    if let Some(oss) = json.get_mut("oss").and_then(|v| v.as_object_mut()) {
        oss.remove("pendingApplication");
    }

    let output = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize {}: {e}", super::CONFIG_FILE_NAME))?;
    std::fs::write(&config_path, output)
        .map_err(|e| format!("Failed to write {}: {e}", super::CONFIG_FILE_NAME))?;

    Ok(())
}

//! OSS/S3 sync — thin wrapper over `teamclaw_sync::oss_sync`.
//!
//! This module re-exports the core sync engine from the `teamclaw-sync` crate
//! and provides:
//!   - A Tauri-specific `SyncEventEmitter` implementation
//!   - Convenience config I/O that bakes in the app-specific directory names
//!   - Team-secret keyring helpers (depend on the main crate's `env_vars`)

use crate::commands::oss_types::*;
use crate::commands::TEAMCLAW_DIR;

use std::path::Path;
use tracing::info;

// ---------------------------------------------------------------------------
// Re-export everything from teamclaw_sync::oss_sync
// ---------------------------------------------------------------------------

pub use teamclaw_sync::oss_sync::{OssSyncManager, OssSyncState, SyncEventEmitter};

// ---------------------------------------------------------------------------
// Tauri SyncEventEmitter implementation
// ---------------------------------------------------------------------------

/// Bridges `teamclaw_sync::oss_sync::SyncEventEmitter` to `tauri::AppHandle`.
pub struct TauriSyncEventEmitter {
    pub app_handle: tauri::AppHandle,
}

impl SyncEventEmitter for TauriSyncEventEmitter {
    fn emit(&self, event: &str, payload: &serde_json::Value) {
        use tauri::Emitter;
        let _ = self.app_handle.emit(event, payload);
    }

    fn reload_shared_secrets(&self) {
        use tauri::{Emitter, Manager};
        if let Some(shared_state) =
            self.app_handle
                .try_state::<crate::commands::shared_secrets::SharedSecretsState>()
        {
            if let Err(e) = crate::commands::shared_secrets::load_all_secrets(&shared_state) {
                log::warn!("[OssSync] Failed to reload shared secrets: {}", e);
            }
        }
        let _ = self.app_handle.emit("secrets-changed", ());
    }

    fn trash_file(&self, team_dir: &Path, rel_path: &str) {
        let _ = crate::commands::trash::trash_file(team_dir, rel_path);
    }
}

/// Helper: create a boxed TauriSyncEventEmitter from an AppHandle.
pub fn tauri_emitter(app_handle: tauri::AppHandle) -> Box<dyn SyncEventEmitter> {
    Box::new(TauriSyncEventEmitter { app_handle })
}

// ---------------------------------------------------------------------------
// Config I/O (convenience wrappers with baked-in dir names)
// ---------------------------------------------------------------------------

pub fn read_oss_config(workspace_path: &str) -> Option<OssTeamConfig> {
    teamclaw_sync::oss_sync::read_oss_config_with(
        workspace_path,
        TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME,
    )
}

pub fn write_oss_config(workspace_path: &str, config: &OssTeamConfig) -> Result<(), String> {
    teamclaw_sync::oss_sync::write_oss_config_with(
        workspace_path,
        config,
        TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME,
    )
}

#[allow(dead_code)]
pub fn read_sync_cursor(workspace_path: &str) -> SyncCursor {
    teamclaw_sync::oss_sync::read_sync_cursor_with(workspace_path, TEAMCLAW_DIR)
}

#[allow(dead_code)]
pub fn write_sync_cursor(workspace_path: &str, cursor: &SyncCursor) -> Result<(), String> {
    teamclaw_sync::oss_sync::write_sync_cursor_with(workspace_path, cursor, TEAMCLAW_DIR)
}

pub fn write_pending_application(
    workspace_path: &str,
    pending: &PendingApplication,
) -> Result<(), String> {
    teamclaw_sync::oss_sync::write_pending_application_with(
        workspace_path,
        pending,
        TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME,
    )
}

pub fn read_pending_application(workspace_path: &str) -> Option<PendingApplication> {
    teamclaw_sync::oss_sync::read_pending_application_with(
        workspace_path,
        TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME,
    )
}

pub fn clear_pending_application(workspace_path: &str) -> Result<(), String> {
    teamclaw_sync::oss_sync::clear_pending_application_with(
        workspace_path,
        TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME,
    )
}

// ---------------------------------------------------------------------------
// Team Secret keyring helpers (depend on main crate's env_vars module)
// ---------------------------------------------------------------------------

const KEYRING_SERVICE: &str = concat!(env!("APP_SHORT_NAME"), "-oss");

fn team_secret_blob_key(team_id: &str) -> String {
    format!("_oss_team_secret.{}", team_id)
}

pub fn save_team_secret(workspace_path: &str, team_id: &str, secret: &str) -> Result<(), String> {
    let mut blob = super::env_vars::read_env_blob(workspace_path)?;
    blob.insert(
        team_secret_blob_key(team_id),
        serde_json::Value::String(secret.to_string()),
    );
    super::env_vars::write_env_blob(&blob)
}

pub fn load_team_secret(workspace_path: &str, team_id: &str) -> Result<String, String> {
    let blob = super::env_vars::read_env_blob(workspace_path)?;
    let key = team_secret_blob_key(team_id);
    if let Some(value) = blob.get(&key).and_then(|v| v.as_str()) {
        return Ok(value.to_string());
    }
    // Migration: try legacy per-team keyring entry
    let legacy_entry = keyring::Entry::new(KEYRING_SERVICE, team_id)
        .map_err(|e| format!("Failed to create keyring entry: {e}"))?;
    match legacy_entry.get_password() {
        Ok(secret) => {
            // Migrate into env blob and delete legacy entry
            let mut blob = blob;
            blob.insert(key, serde_json::Value::String(secret.clone()));
            let _ = super::env_vars::write_env_blob(&blob);
            let _ = legacy_entry.delete_credential();
            info!(
                "Migrated team secret for {} from legacy keyring to env blob",
                team_id
            );
            Ok(secret)
        }
        Err(_) => Err(format!("Team secret not found for team {team_id}")),
    }
}

pub fn delete_team_secret(workspace_path: &str, team_id: &str) -> Result<(), String> {
    let mut blob = super::env_vars::read_env_blob(workspace_path)?;
    blob.remove(&team_secret_blob_key(team_id));
    super::env_vars::write_env_blob(&blob)?;
    // Also clean up legacy entry if it exists
    if let Ok(legacy_entry) = keyring::Entry::new(KEYRING_SERVICE, team_id) {
        let _ = legacy_entry.delete_credential();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // =========================================================================
    // Mini S3 Server — in-memory S3-compatible HTTP server for integration tests
    // =========================================================================

    mod mini_s3 {
        use axum::{
            body::Bytes,
            extract::{OriginalUri, Query, State},
            http::{HeaderMap, Method, StatusCode},
            response::IntoResponse,
            Router,
        };
        use std::collections::{BTreeSet, HashMap};
        use std::net::SocketAddr;
        use std::sync::Arc;
        use tokio::sync::Mutex;

        pub type S3Store = Arc<Mutex<HashMap<String, Vec<u8>>>>;

        pub struct MiniS3 {
            pub store: S3Store,
            pub addr: SocketAddr,
            shutdown_tx: tokio::sync::oneshot::Sender<()>,
        }

        impl MiniS3 {
            pub async fn start() -> Self {
                let store: S3Store = Arc::new(Mutex::new(HashMap::new()));
                let app = Router::new().fallback(s3_handler).with_state(store.clone());

                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();

                let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
                tokio::spawn(async move {
                    axum::serve(listener, app)
                        .with_graceful_shutdown(async {
                            let _ = shutdown_rx.await;
                        })
                        .await
                        .unwrap();
                });

                Self {
                    store,
                    addr,
                    shutdown_tx,
                }
            }

            pub fn endpoint(&self) -> String {
                format!("http://{}", self.addr)
            }

            #[allow(dead_code)]
            pub async fn get_stored(&self, key: &str) -> Option<Vec<u8>> {
                self.store.lock().await.get(key).cloned()
            }

            #[allow(dead_code)]
            pub async fn put_stored(&self, key: &str, data: Vec<u8>) {
                self.store.lock().await.insert(key.to_string(), data);
            }

            #[allow(dead_code)]
            pub async fn list_keys(&self, prefix: &str) -> Vec<String> {
                self.store
                    .lock()
                    .await
                    .keys()
                    .filter(|k| k.starts_with(prefix))
                    .cloned()
                    .collect()
            }

            pub fn shutdown(self) {
                let _ = self.shutdown_tx.send(());
            }
        }

        async fn s3_handler(
            method: Method,
            State(store): State<S3Store>,
            OriginalUri(uri): OriginalUri,
            Query(params): Query<HashMap<String, String>>,
            body: Bytes,
        ) -> impl IntoResponse {
            // Path-style: /{bucket}/{key...}
            let path = uri.path();
            // Skip leading "/" and bucket name to get the key
            let parts: Vec<&str> = path.splitn(3, '/').collect();
            let key = parts.get(2).map(|s| s.to_string()).unwrap_or_default();

            match method {
                Method::PUT => {
                    store.lock().await.insert(key, body.to_vec());
                    StatusCode::OK.into_response()
                }
                Method::GET if params.contains_key("list-type") => {
                    let prefix = params.get("prefix").cloned().unwrap_or_default();
                    let delimiter = params.get("delimiter").cloned();
                    let start_after = params.get("start-after").cloned();

                    let store = store.lock().await;
                    let mut contents: Vec<(String, usize)> = Vec::new();
                    let mut common_prefixes: BTreeSet<String> = BTreeSet::new();

                    for (k, v) in store.iter() {
                        if !k.starts_with(&prefix) {
                            continue;
                        }
                        if let Some(ref after) = start_after {
                            if k.as_str() <= after.as_str() {
                                continue;
                            }
                        }
                        if let Some(ref delim) = delimiter {
                            let suffix = &k[prefix.len()..];
                            if let Some(pos) = suffix.find(delim.as_str()) {
                                common_prefixes.insert(format!(
                                    "{}{}",
                                    prefix,
                                    &suffix[..pos + delim.len()]
                                ));
                                continue;
                            }
                        }
                        contents.push((k.clone(), v.len()));
                    }
                    contents.sort_by_key(|content| content.0.clone());

                    let mut xml = String::from(
                        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
                         <ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
                    );
                    xml.push_str(&format!("<Prefix>{}</Prefix>", prefix));
                    xml.push_str("<IsTruncated>false</IsTruncated>");
                    xml.push_str("<MaxKeys>1000</MaxKeys>");
                    for (k, size) in &contents {
                        xml.push_str(&format!(
                            "<Contents><Key>{}</Key><Size>{}</Size></Contents>",
                            k, size
                        ));
                    }
                    for cp in &common_prefixes {
                        xml.push_str(&format!(
                            "<CommonPrefixes><Prefix>{}</Prefix></CommonPrefixes>",
                            cp
                        ));
                    }
                    xml.push_str("</ListBucketResult>");

                    (StatusCode::OK, [("content-type", "application/xml")], xml).into_response()
                }
                Method::GET => match store.lock().await.get(&key) {
                    Some(data) => (StatusCode::OK, data.clone()).into_response(),
                    None => {
                        let xml = format!(
                            "<?xml version=\"1.0\"?><Error><Code>NoSuchKey</Code>\
                             <Message>not found</Message><Key>{}</Key></Error>",
                            key
                        );
                        (StatusCode::NOT_FOUND, xml).into_response()
                    }
                },
                Method::DELETE => {
                    store.lock().await.remove(&key);
                    StatusCode::NO_CONTENT.into_response()
                }
                Method::HEAD => match store.lock().await.get(&key) {
                    Some(data) => {
                        let mut headers = HeaderMap::new();
                        headers.insert("content-length", data.len().to_string().parse().unwrap());
                        (StatusCode::OK, headers).into_response()
                    }
                    None => StatusCode::NOT_FOUND.into_response(),
                },
                _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
            }
        }
    }

    // =========================================================================
    // Test helpers
    // =========================================================================

    fn create_test_manager(workspace: &str, endpoint: &str) -> OssSyncManager {
        let mut mgr = OssSyncManager::new(
            "test-team".to_string(),
            "test-node".to_string(),
            "test-secret".to_string(),
            endpoint.to_string(),
            true, // force_path_style — required for path-style URLs to local server
            workspace.to_string(),
            std::time::Duration::from_secs(30),
            TEAMCLAW_DIR.to_string(),
            crate::commands::TEAM_REPO_DIR.to_string(),
            crate::commands::CONFIG_FILE_NAME.to_string(),
            None,
        );
        // Set credentials to initialize the S3 client pointing at our mini S3
        mgr.set_credentials(
            OssCredentials {
                access_key_id: "test-ak".to_string(),
                access_key_secret: "test-sk".to_string(),
                security_token: "test-token".to_string(),
                expiration: "2099-01-01T00:00:00Z".to_string(),
            },
            OssConfig {
                bucket: "test-bucket".to_string(),
                region: "us-east-1".to_string(),
                endpoint: endpoint.to_string(),
            },
        );
        mgr
    }

    /// Create a temp workspace directory with standard team subdirs.
    fn create_temp_workspace() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let team_dir = tmp.path().join(crate::commands::TEAM_REPO_DIR);
        for sub in &["skills", ".mcp", "knowledge", "_secrets"] {
            std::fs::create_dir_all(team_dir.join(sub)).unwrap();
        }
        // Also create the teamclaw config dir for sync cursor
        let tc_dir = tmp.path().join(crate::commands::TEAMCLAW_DIR).join("loro");
        std::fs::create_dir_all(tc_dir).unwrap();
        tmp
    }

    // =========================================================================
    // Existing unit tests (preserved)
    // =========================================================================

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

    #[test]
    fn zstd_roundtrip() {
        let data = b"hello world repeated ".repeat(1000);
        let compressed = zstd::encode_all(std::io::Cursor::new(&data[..]), 3).unwrap();
        assert!(compressed.len() < data.len());
        let decompressed = zstd::decode_all(std::io::Cursor::new(&compressed[..])).unwrap();
        assert_eq!(decompressed, data);
    }

    #[test]
    fn sync_cursor_roundtrip_with_new_fields() {
        use base64::Engine;

        let cursor = SyncCursor {
            last_known_keys: HashMap::new(),
            last_known_keys_per_node: HashMap::new(),
            known_signal_keys: vec![],
            last_compaction_at: HashMap::new(),
            last_exported_version: {
                let mut m = HashMap::new();
                m.insert(
                    "skills".to_string(),
                    base64::engine::general_purpose::STANDARD.encode(b"test-vv-bytes"),
                );
                m
            },
            last_scan_time: {
                let mut m = HashMap::new();
                m.insert("skills".to_string(), 1712500000000u64);
                m
            },
            known_files: {
                let mut m = HashMap::new();
                m.insert("skills".to_string(), vec!["file1.md".to_string()]);
                m
            },
            generation: {
                let mut m = HashMap::new();
                m.insert("skills".to_string(), "gen-uuid-123".to_string());
                m
            },
        };

        let json = serde_json::to_string(&cursor).unwrap();
        let deserialized: SyncCursor = serde_json::from_str(&json).unwrap();

        assert_eq!(
            deserialized.last_exported_version.get("skills"),
            cursor.last_exported_version.get("skills")
        );
        assert_eq!(
            deserialized.last_scan_time.get("skills"),
            cursor.last_scan_time.get("skills")
        );
        assert_eq!(
            deserialized.known_files.get("skills"),
            cursor.known_files.get("skills")
        );
        assert_eq!(
            deserialized.generation.get("skills"),
            cursor.generation.get("skills")
        );
    }

    #[test]
    fn sync_cursor_backward_compatible() {
        // Old format JSON (without new fields) should deserialize fine
        let old_json = r#"{"lastKnownKeys":{},"lastKnownKeysPerNode":{},"knownSignalKeys":[],"lastCompactionAt":{}}"#;
        let cursor: SyncCursor = serde_json::from_str(old_json).unwrap();
        assert!(cursor.last_exported_version.is_empty());
        assert!(cursor.last_scan_time.is_empty());
        assert!(cursor.known_files.is_empty());
        assert!(cursor.generation.is_empty());
    }

    // =========================================================================
    // Integration tests — S3 operations
    // =========================================================================

    #[tokio::test]
    async fn s3_put_get_roundtrip() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        // PUT then GET
        let data = b"hello integration test";
        mgr.s3_put("some/key.bin", data).await.unwrap();
        let fetched = mgr.s3_get("some/key.bin").await.unwrap();
        assert_eq!(fetched, data);

        // GET non-existent key returns an error
        let err = mgr.s3_get("does/not/exist.bin").await;
        assert!(err.is_err(), "GET for non-existent key should fail");

        s3.shutdown();
    }

    #[tokio::test]
    async fn s3_list_and_delete() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        // Seed some keys
        mgr.s3_put("teams/t/skills/updates/nodeA/100.bin", b"a")
            .await
            .unwrap();
        mgr.s3_put("teams/t/skills/updates/nodeA/200.bin", b"b")
            .await
            .unwrap();
        mgr.s3_put("teams/t/skills/updates/nodeB/150.bin", b"c")
            .await
            .unwrap();
        mgr.s3_put("teams/t/mcp/updates/nodeA/100.bin", b"d")
            .await
            .unwrap();

        // List with prefix
        let keys = mgr.s3_list("teams/t/skills/updates/").await.unwrap();
        assert_eq!(keys.len(), 3);
        assert!(keys[0].contains("nodeA/100"));
        assert!(keys[2].contains("nodeB/150"));

        // List with start_after
        let keys = mgr
            .s3_list_after(
                "teams/t/skills/updates/nodeA/",
                Some("teams/t/skills/updates/nodeA/100.bin"),
            )
            .await
            .unwrap();
        assert_eq!(keys.len(), 1);
        assert!(keys[0].contains("200.bin"));

        // List common prefixes (node discovery)
        let prefixes = mgr
            .s3_list_common_prefixes("teams/t/skills/updates/")
            .await
            .unwrap();
        assert_eq!(prefixes.len(), 2);
        assert!(prefixes[0].ends_with("nodeA/"));
        assert!(prefixes[1].ends_with("nodeB/"));

        // Delete and verify
        mgr.s3_delete("teams/t/skills/updates/nodeA/100.bin")
            .await
            .unwrap();
        let keys = mgr.s3_list("teams/t/skills/updates/nodeA/").await.unwrap();
        assert_eq!(keys.len(), 1);

        s3.shutdown();
    }

    #[tokio::test]
    async fn s3_key_exists_check() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        mgr.s3_put("exists.bin", b"yes").await.unwrap();
        assert!(mgr.s3_key_exists("exists.bin").await.unwrap());
        assert!(!mgr.s3_key_exists("nope.bin").await.unwrap());

        s3.shutdown();
    }

    // =========================================================================
    // Integration tests — upload with zstd compression fallback
    // =========================================================================

    #[tokio::test]
    async fn upload_with_fallback_small_direct() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        let small_data = b"small update".to_vec();
        let ok = mgr
            .upload_with_fallback(
                DocType::Skills,
                &small_data,
                "teams/t/skills/updates/n/1.bin",
            )
            .await
            .unwrap();
        assert!(ok);

        // Should be stored as-is (no compression for small data)
        let stored = s3.get_stored("teams/t/skills/updates/n/1.bin").await;
        assert!(stored.is_some());
        assert_eq!(stored.unwrap(), small_data);

        s3.shutdown();
    }

    #[tokio::test]
    async fn upload_with_fallback_large_uses_zstd() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        // Create data larger than MAX_SYNC_FILE_SIZE (10 MB) but compressible
        let large_data = b"repetitive content for compression test\n".repeat(300_000); // ~12 MB
        assert!(large_data.len() > 10 * 1024 * 1024);

        let ok = mgr
            .upload_with_fallback(
                DocType::Skills,
                &large_data,
                "teams/t/skills/updates/n/1.bin",
            )
            .await
            .unwrap();
        assert!(ok);

        // Should be stored as .zst (original .bin key should NOT exist)
        let raw = s3.get_stored("teams/t/skills/updates/n/1.bin").await;
        assert!(
            raw.is_none(),
            "raw .bin should not be stored for large data"
        );

        let compressed = s3.get_stored("teams/t/skills/updates/n/1.zst").await;
        assert!(compressed.is_some(), ".zst key should exist");

        // Verify decompression roundtrip
        let decompressed = zstd::decode_all(std::io::Cursor::new(&compressed.unwrap())).unwrap();
        assert_eq!(decompressed, large_data);

        // Health should be Warning after compression fallback
        assert_eq!(mgr.health, SyncHealth::Warning);

        s3.shutdown();
    }

    // =========================================================================
    // Integration tests — local file scanning
    // =========================================================================

    #[test]
    fn scan_skips_binary_files() {
        let ws = create_temp_workspace();
        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");

        // Write a valid UTF-8 file
        std::fs::write(skills_dir.join("good.md"), "# Hello").unwrap();
        // Write a binary file (invalid UTF-8)
        std::fs::write(
            skills_dir.join("image.png"),
            &[0x89, 0x50, 0x4E, 0x47, 0xFF, 0xFE],
        )
        .unwrap();

        let (files, skipped) = OssSyncManager::scan_local_files(&skills_dir).unwrap();
        assert!(files.contains_key("good.md"));
        assert!(!files.contains_key("image.png"));
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].path, "image.png");
        assert!(skipped[0].reason.contains("二进制"));
    }

    #[test]
    fn scan_skips_oversized_files() {
        let ws = create_temp_workspace();
        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");

        // Write a file exceeding MAX_SYNC_FILE_SIZE (10 MB)
        let big_content = "x".repeat(11 * 1024 * 1024);
        std::fs::write(skills_dir.join("huge.md"), &big_content).unwrap();
        std::fs::write(skills_dir.join("small.md"), "ok").unwrap();

        let (files, skipped) = OssSyncManager::scan_local_files(&skills_dir).unwrap();
        assert!(files.contains_key("small.md"));
        assert!(!files.contains_key("huge.md"));
        assert_eq!(skipped.len(), 1);
        assert!(skipped[0].reason.contains("文件过大"));
    }

    #[test]
    fn scan_respects_gitignore() {
        let ws = create_temp_workspace();
        let team_dir = ws.path().join(crate::commands::TEAM_REPO_DIR);
        let skills_dir = team_dir.join("skills");

        std::fs::write(skills_dir.join(".gitignore"), "*.log\nsecret/\n").unwrap();
        std::fs::write(skills_dir.join("keep.md"), "keep").unwrap();
        std::fs::write(skills_dir.join("debug.log"), "nope").unwrap();
        std::fs::create_dir_all(skills_dir.join("secret")).unwrap();
        std::fs::write(skills_dir.join("secret").join("key.txt"), "hidden").unwrap();

        let (files, _) = OssSyncManager::scan_local_files(&skills_dir).unwrap();
        assert!(files.contains_key("keep.md"));
        // .gitignore itself is included (special-cased)
        assert!(files.contains_key(".gitignore"));
        assert!(!files.contains_key("debug.log"));
        assert!(!files.contains_key("secret/key.txt"));
    }

    #[test]
    fn scan_includes_leaderboard_dir_under_team_whitelist() {
        use crate::commands::team::GITIGNORE_CONTENT;

        let ws = create_temp_workspace();
        let team_dir = ws.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();
        std::fs::write(team_dir.join(".gitignore"), GITIGNORE_CONTENT).unwrap();

        let leaderboard_dir = team_dir.join(".leaderboard");
        std::fs::create_dir_all(&leaderboard_dir).unwrap();
        std::fs::write(leaderboard_dir.join("alice.json"), "{}").unwrap();

        let (files, _) = OssSyncManager::scan_local_files(&team_dir).unwrap();
        assert!(
            files.contains_key(".leaderboard/alice.json"),
            ".leaderboard/ must be whitelisted for team sync; got keys: {:?}",
            files.keys().collect::<Vec<_>>()
        );
    }

    #[test]
    fn scan_incremental_includes_leaderboard_dir_under_team_whitelist() {
        use crate::commands::team::GITIGNORE_CONTENT;

        let ws = create_temp_workspace();
        let team_dir = ws.path().join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&team_dir).unwrap();
        std::fs::write(team_dir.join(".gitignore"), GITIGNORE_CONTENT).unwrap();

        // Record time before writing the new file so incremental picks it up.
        let since = std::time::SystemTime::now();
        std::thread::sleep(std::time::Duration::from_millis(50));

        let leaderboard_dir = team_dir.join(".leaderboard");
        std::fs::create_dir_all(&leaderboard_dir).unwrap();
        std::fs::write(leaderboard_dir.join("alice.json"), "{}").unwrap();

        let (files, _) = OssSyncManager::scan_local_files_incremental(&team_dir, since).unwrap();
        assert!(
            files.contains_key(".leaderboard/alice.json"),
            "incremental scan must include newly-whitelisted .leaderboard entries; got keys: {:?}",
            files.keys().collect::<Vec<_>>()
        );
    }

    #[test]
    fn scan_incremental_only_new_files() {
        let ws = create_temp_workspace();
        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");

        std::fs::write(skills_dir.join("old.md"), "old content").unwrap();

        // Record time after writing old file
        let since = std::time::SystemTime::now();
        // Small delay to ensure mtime difference
        std::thread::sleep(std::time::Duration::from_millis(50));

        std::fs::write(skills_dir.join("new.md"), "new content").unwrap();

        let (files, _) = OssSyncManager::scan_local_files_incremental(&skills_dir, since).unwrap();
        assert!(files.contains_key("new.md"));
        // old.md may or may not appear depending on filesystem mtime resolution;
        // the key assertion is that new.md IS included
    }

    // =========================================================================
    // Integration tests — write_doc_to_disk (atomic writes)
    // =========================================================================

    #[tokio::test]
    async fn write_doc_to_disk_creates_files_atomically() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        // Populate the LoroDoc with a file entry
        let doc = mgr.get_doc(DocType::Skills);
        let files_map = doc.get_map("files");
        let entry = files_map
            .get_or_create_container("hello.md", loro::LoroMap::new())
            .unwrap();
        entry.insert("content", "# Hello World").unwrap();
        entry.insert("hash", "abc123").unwrap();
        entry.insert("deleted", false).unwrap();
        entry.insert("updatedBy", "test-node").unwrap();
        entry.insert("updatedAt", "2026-01-01T00:00:00Z").unwrap();

        // Write to disk
        mgr.write_doc_to_disk(DocType::Skills).unwrap();

        // Verify file was created
        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");
        let content = std::fs::read_to_string(skills_dir.join("hello.md")).unwrap();
        assert_eq!(content, "# Hello World");

        // Verify no .tmp directory remains
        assert!(!skills_dir.join(".tmp").exists());

        s3.shutdown();
    }

    #[tokio::test]
    async fn write_doc_to_disk_deletes_removed_files() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");

        // Create a file on disk and in the doc, marked as deleted
        std::fs::write(skills_dir.join("removed.md"), "to be removed").unwrap();

        let doc = mgr.get_doc(DocType::Skills);
        let files_map = doc.get_map("files");
        let entry = files_map
            .get_or_create_container("removed.md", loro::LoroMap::new())
            .unwrap();
        entry.insert("content", "to be removed").unwrap();
        entry
            .insert("hash", &*OssSyncManager::compute_hash(b"to be removed"))
            .unwrap();
        entry.insert("deleted", true).unwrap();
        entry.insert("updatedBy", "test-node").unwrap();
        entry.insert("updatedAt", "2026-01-01T00:00:00Z").unwrap();

        mgr.write_doc_to_disk(DocType::Skills).unwrap();

        // File should be deleted from disk
        assert!(!skills_dir.join("removed.md").exists());

        s3.shutdown();
    }

    #[tokio::test]
    async fn write_doc_to_disk_absorbs_local_only_files() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");
        // A file on disk not in the LoroDoc should be absorbed
        std::fs::write(skills_dir.join("local-only.md"), "I was added via Finder").unwrap();

        let absorbed = mgr.write_doc_to_disk(DocType::Skills).unwrap();
        assert!(absorbed, "local-only file should have been absorbed");

        // Verify it's now in the LoroDoc
        let doc = mgr.get_doc(DocType::Skills);
        let files_map = doc.get_map("files");
        let deep = files_map.get_deep_value();
        if let loro::LoroValue::Map(entries) = deep {
            let entry = entries.get("local-only.md");
            assert!(entry.is_some(), "absorbed file should be in the doc");
        } else {
            panic!("files map should be a Map");
        }

        s3.shutdown();
    }

    // =========================================================================
    // Integration tests — upload_local_changes
    // =========================================================================

    #[tokio::test]
    async fn upload_local_changes_detects_new_and_changed() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");
        std::fs::write(skills_dir.join("new-skill.md"), "# New Skill\nContent here").unwrap();

        let uploaded = mgr.upload_local_changes(DocType::Skills).await.unwrap();
        assert!(uploaded, "should detect new file and upload");

        // Verify an update was uploaded to S3
        let keys = s3
            .list_keys("teams/test-team/skills/updates/test-node/")
            .await;
        assert_eq!(keys.len(), 1, "should have one update file");

        // The uploaded data should be a valid Loro export
        let key = &keys[0];
        let data = s3.get_stored(key).await.unwrap();
        assert!(!data.is_empty());

        // Uploading again without changes should be no-op
        let uploaded2 = mgr.upload_local_changes(DocType::Skills).await.unwrap();
        assert!(!uploaded2, "no changes should mean no upload");

        s3.shutdown();
    }

    #[tokio::test]
    async fn upload_local_changes_marks_deletions() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");

        // First: create a file and upload it
        std::fs::write(skills_dir.join("will-delete.md"), "temporary").unwrap();
        mgr.upload_local_changes(DocType::Skills).await.unwrap();

        // Delete the file from disk
        std::fs::remove_file(skills_dir.join("will-delete.md")).unwrap();

        // Upload again — should detect deletion
        let uploaded = mgr.upload_local_changes(DocType::Skills).await.unwrap();
        assert!(uploaded, "should detect deletion and upload");

        // Verify the doc marks the file as deleted
        let doc = mgr.get_doc(DocType::Skills);
        let files_map = doc.get_map("files");
        let deep = files_map.get_deep_value();
        if let loro::LoroValue::Map(entries) = deep {
            if let Some(loro::LoroValue::Map(entry)) = entries.get("will-delete.md") {
                let deleted = match entry.get("deleted") {
                    Some(loro::LoroValue::Bool(b)) => *b,
                    _ => false,
                };
                assert!(deleted, "file should be marked as deleted in doc");
            } else {
                panic!("will-delete.md entry should be a Map");
            }
        }

        s3.shutdown();
    }

    // =========================================================================
    // Integration tests — pull_remote_changes
    // =========================================================================

    #[tokio::test]
    async fn pull_remote_changes_imports_updates() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        // Simulate a remote node: create a LoroDoc, add a file, export updates,
        // and upload to S3 under a different node_id.
        let remote_doc = loro::LoroDoc::new();
        let files_map = remote_doc.get_map("files");
        let entry = files_map
            .get_or_create_container("remote-file.md", loro::LoroMap::new())
            .unwrap();
        entry.insert("content", "remote content").unwrap();
        entry.insert("hash", "remotehash").unwrap();
        entry.insert("deleted", false).unwrap();
        entry.insert("updatedBy", "remote-node").unwrap();
        entry.insert("updatedAt", "2026-01-01T00:00:00Z").unwrap();

        let updates = remote_doc.export(loro::ExportMode::all_updates()).unwrap();
        s3.put_stored(
            "teams/test-team/skills/updates/remote-node/1000.bin",
            updates,
        )
        .await;

        // Pull remote changes
        mgr.pull_remote_changes(DocType::Skills).await.unwrap();

        // Verify the remote file is now in our doc
        let doc = mgr.get_doc(DocType::Skills);
        let files_map = doc.get_map("files");
        let deep = files_map.get_deep_value();
        if let loro::LoroValue::Map(entries) = deep {
            let entry = entries.get("remote-file.md");
            assert!(entry.is_some(), "remote file should be imported");
            if let Some(loro::LoroValue::Map(e)) = entry {
                assert_eq!(
                    e.get("content"),
                    Some(&loro::LoroValue::String("remote content".into()))
                );
            }
        }

        // Verify file was written to disk
        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");
        let content = std::fs::read_to_string(skills_dir.join("remote-file.md")).unwrap();
        assert_eq!(content, "remote content");

        s3.shutdown();
    }

    #[tokio::test]
    async fn pull_remote_changes_decompresses_zst() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        // Create a remote update and compress it
        let remote_doc = loro::LoroDoc::new();
        let files_map = remote_doc.get_map("files");
        let entry = files_map
            .get_or_create_container("compressed.md", loro::LoroMap::new())
            .unwrap();
        entry.insert("content", "compressed content").unwrap();
        entry.insert("hash", "zhash").unwrap();
        entry.insert("deleted", false).unwrap();
        entry.insert("updatedBy", "remote-node").unwrap();
        entry.insert("updatedAt", "2026-01-01T00:00:00Z").unwrap();

        let updates = remote_doc.export(loro::ExportMode::all_updates()).unwrap();
        let compressed = zstd::encode_all(std::io::Cursor::new(&updates), 3).unwrap();

        // Upload as .zst
        s3.put_stored(
            "teams/test-team/skills/updates/remote-node/1000.zst",
            compressed,
        )
        .await;

        mgr.pull_remote_changes(DocType::Skills).await.unwrap();

        // Verify the file was imported despite being compressed
        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");
        let content = std::fs::read_to_string(skills_dir.join("compressed.md")).unwrap();
        assert_eq!(content, "compressed content");

        s3.shutdown();
    }

    // =========================================================================
    // Integration tests — signal flags
    // =========================================================================

    #[tokio::test]
    async fn signal_flag_write_and_check() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        // Write a signal flag from our node
        mgr.write_signal_flag().await.unwrap();

        let keys = s3.list_keys("teams/test-team/signal/test-node/").await;
        assert_eq!(keys.len(), 1);
        assert!(keys[0].ends_with(".flag"));

        // Check signal flags — our own should be ignored
        let has_new = mgr.check_signal_flags().await.unwrap();
        assert!(!has_new, "own signal flags should be ignored");

        // Simulate a remote node's signal flag
        s3.put_stored(
            "teams/test-team/signal/remote-node/9999999999999.flag",
            vec![],
        )
        .await;

        let has_new = mgr.check_signal_flags().await.unwrap();
        assert!(has_new, "remote signal flag should trigger");

        // Second check should NOT report the same flag as new
        let has_new_again = mgr.check_signal_flags().await.unwrap();
        assert!(!has_new_again, "already-seen flag should not re-trigger");

        s3.shutdown();
    }

    #[tokio::test]
    async fn signal_flag_cleanup_expired() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        // Create an old signal flag (timestamp from 2 hours ago)
        let old_ts = chrono::Utc::now().timestamp_millis() - 7_200_000;
        let old_key = format!("teams/test-team/signal/remote-node/{}.flag", old_ts);
        s3.put_stored(&old_key, vec![]).await;

        // Create a recent signal flag
        let recent_ts = chrono::Utc::now().timestamp_millis() - 100;
        let recent_key = format!("teams/test-team/signal/remote-node/{}.flag", recent_ts);
        s3.put_stored(&recent_key, vec![]).await;

        let deleted = mgr.cleanup_expired_signal_flags().await.unwrap();
        assert_eq!(deleted, 1, "only the old flag should be cleaned up");

        // Recent flag should still exist
        assert!(s3.get_stored(&recent_key).await.is_some());
        assert!(s3.get_stored(&old_key).await.is_none());

        s3.shutdown();
    }

    // =========================================================================
    // Integration tests — initial sync full flow
    // =========================================================================

    #[tokio::test]
    async fn initial_sync_downloads_snapshot_and_updates() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        // Create a "remote" snapshot: a LoroDoc with one file, exported as snapshot
        let snap_doc = loro::LoroDoc::new();
        {
            let files_map = snap_doc.get_map("files");
            let entry = files_map
                .get_or_create_container("from-snapshot.md", loro::LoroMap::new())
                .unwrap();
            entry.insert("content", "snapshot content").unwrap();
            entry.insert("hash", "snaphash").unwrap();
            entry.insert("deleted", false).unwrap();
            entry.insert("updatedBy", "owner-node").unwrap();
            entry.insert("updatedAt", "2026-01-01T00:00:00Z").unwrap();
        }
        let snapshot = snap_doc.export(loro::ExportMode::Snapshot).unwrap();

        // Upload snapshot and generation.json
        let snap_key = "teams/test-team/skills/snapshots/abc123.bin";
        s3.put_stored(snap_key, snapshot).await;
        let gen_json = serde_json::json!({
            "generationId": "gen-001",
            "snapshotKey": snap_key,
            "createdAt": "2026-01-01T00:00:00Z",
        });
        s3.put_stored(
            "teams/test-team/skills/generation.json",
            gen_json.to_string().into_bytes(),
        )
        .await;

        // Also create an incremental update from a different "remote" doc
        // that adds another file on top of the snapshot
        let update_doc = loro::LoroDoc::new();
        // First import the snapshot so the update doc has the same base
        let snap_data = s3.get_stored(snap_key).await.unwrap();
        update_doc.import(&snap_data).unwrap();
        {
            let files_map = update_doc.get_map("files");
            let entry = files_map
                .get_or_create_container("from-update.md", loro::LoroMap::new())
                .unwrap();
            entry.insert("content", "update content").unwrap();
            entry.insert("hash", "uphash").unwrap();
            entry.insert("deleted", false).unwrap();
            entry.insert("updatedBy", "editor-node").unwrap();
            entry.insert("updatedAt", "2026-01-02T00:00:00Z").unwrap();
        }
        let updates = update_doc.export(loro::ExportMode::all_updates()).unwrap();
        s3.put_stored(
            "teams/test-team/skills/updates/editor-node/2000.bin",
            updates,
        )
        .await;

        // Run initial_sync
        mgr.initial_sync().await.unwrap();

        // Verify both files exist on disk
        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");
        assert_eq!(
            std::fs::read_to_string(skills_dir.join("from-snapshot.md")).unwrap(),
            "snapshot content"
        );
        assert_eq!(
            std::fs::read_to_string(skills_dir.join("from-update.md")).unwrap(),
            "update content"
        );

        // Verify generation was recorded
        assert_eq!(
            mgr.generation.get(&DocType::Skills).map(String::as_str),
            Some("gen-001")
        );

        assert!(mgr.connected);

        s3.shutdown();
    }

    #[tokio::test]
    async fn initial_sync_with_legacy_snapshot_path() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        // Use legacy snapshot/ (singular) path instead of snapshots/
        let snap_doc = loro::LoroDoc::new();
        {
            let files_map = snap_doc.get_map("files");
            let entry = files_map
                .get_or_create_container("legacy.md", loro::LoroMap::new())
                .unwrap();
            entry.insert("content", "legacy snapshot").unwrap();
            entry.insert("hash", "lhash").unwrap();
            entry.insert("deleted", false).unwrap();
            entry.insert("updatedBy", "old-node").unwrap();
            entry.insert("updatedAt", "2025-01-01T00:00:00Z").unwrap();
        }
        let snapshot = snap_doc.export(loro::ExportMode::Snapshot).unwrap();
        s3.put_stored("teams/test-team/skills/snapshot/latest.bin", snapshot)
            .await;

        mgr.initial_sync().await.unwrap();

        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");
        assert_eq!(
            std::fs::read_to_string(skills_dir.join("legacy.md")).unwrap(),
            "legacy snapshot"
        );

        s3.shutdown();
    }

    // =========================================================================
    // Integration tests — compaction
    // =========================================================================

    #[tokio::test]
    async fn compaction_uploads_snapshot_and_deletes_old_updates() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());
        mgr.set_role(MemberRole::Owner);

        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");

        // Create files and upload to build up update history
        std::fs::write(skills_dir.join("file1.md"), "content1").unwrap();
        mgr.upload_local_changes(DocType::Skills).await.unwrap();
        std::fs::write(skills_dir.join("file2.md"), "content2").unwrap();
        mgr.upload_local_changes(DocType::Skills).await.unwrap();

        // Record update keys before compaction
        let pre_update_keys = s3.list_keys("teams/test-team/skills/updates/").await;
        assert!(pre_update_keys.len() >= 2, "should have at least 2 updates");

        // Populate live_keyset (normally done by initial_sync)
        for key in &pre_update_keys {
            mgr.live_keyset.insert(key.clone());
        }

        // Run compaction
        mgr.compact(DocType::Skills).await.unwrap();

        // A snapshot should have been uploaded
        let snap_keys = s3.list_keys("teams/test-team/skills/snapshots/").await;
        assert!(
            !snap_keys.is_empty(),
            "snapshot should exist after compaction"
        );

        // generation.json should exist
        let gen = s3
            .get_stored("teams/test-team/skills/generation.json")
            .await;
        assert!(gen.is_some(), "generation.json should exist");
        let gen_json: serde_json::Value = serde_json::from_slice(&gen.unwrap()).unwrap();
        assert!(gen_json.get("generationId").is_some());
        assert!(gen_json.get("snapshotKey").is_some());

        // Old update files should have been deleted
        let post_update_keys = s3.list_keys("teams/test-team/skills/updates/").await;
        assert!(
            post_update_keys.len() < pre_update_keys.len(),
            "old updates should be deleted after compaction"
        );

        s3.shutdown();
    }

    // =========================================================================
    // Integration tests — two-node sync roundtrip
    // =========================================================================

    #[tokio::test]
    async fn two_node_sync_roundtrip() {
        let s3 = mini_s3::MiniS3::start().await;

        // Node A: create and upload
        let ws_a = create_temp_workspace();
        let mut mgr_a = OssSyncManager::new(
            "shared-team".to_string(),
            "node-a".to_string(),
            "secret".to_string(),
            s3.endpoint(),
            true,
            ws_a.path().to_str().unwrap().to_string(),
            std::time::Duration::from_secs(30),
            TEAMCLAW_DIR.to_string(),
            crate::commands::TEAM_REPO_DIR.to_string(),
            crate::commands::CONFIG_FILE_NAME.to_string(),
            None,
        );
        mgr_a.set_credentials(
            OssCredentials {
                access_key_id: "ak".to_string(),
                access_key_secret: "sk".to_string(),
                security_token: "tok".to_string(),
                expiration: "2099-01-01T00:00:00Z".to_string(),
            },
            OssConfig {
                bucket: "test-bucket".to_string(),
                region: "us-east-1".to_string(),
                endpoint: s3.endpoint(),
            },
        );

        let skills_a = ws_a
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");
        std::fs::write(skills_a.join("shared.md"), "hello from node A").unwrap();
        mgr_a.upload_local_changes(DocType::Skills).await.unwrap();

        // Node B: pull and verify
        let ws_b = create_temp_workspace();
        let mut mgr_b = OssSyncManager::new(
            "shared-team".to_string(),
            "node-b".to_string(),
            "secret".to_string(),
            s3.endpoint(),
            true,
            ws_b.path().to_str().unwrap().to_string(),
            std::time::Duration::from_secs(30),
            TEAMCLAW_DIR.to_string(),
            crate::commands::TEAM_REPO_DIR.to_string(),
            crate::commands::CONFIG_FILE_NAME.to_string(),
            None,
        );
        mgr_b.set_credentials(
            OssCredentials {
                access_key_id: "ak".to_string(),
                access_key_secret: "sk".to_string(),
                security_token: "tok".to_string(),
                expiration: "2099-01-01T00:00:00Z".to_string(),
            },
            OssConfig {
                bucket: "test-bucket".to_string(),
                region: "us-east-1".to_string(),
                endpoint: s3.endpoint(),
            },
        );

        mgr_b.pull_remote_changes(DocType::Skills).await.unwrap();

        let skills_b = ws_b
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");
        let content = std::fs::read_to_string(skills_b.join("shared.md")).unwrap();
        assert_eq!(content, "hello from node A");

        // Node B writes a new file and uploads
        std::fs::write(skills_b.join("reply.md"), "hello from node B").unwrap();
        mgr_b.upload_local_changes(DocType::Skills).await.unwrap();

        // Node A pulls and should see both files
        mgr_a.pull_remote_changes(DocType::Skills).await.unwrap();
        let reply = std::fs::read_to_string(skills_a.join("reply.md")).unwrap();
        assert_eq!(reply, "hello from node B");

        s3.shutdown();
    }

    // =========================================================================
    // Integration tests — SyncCursor persistence
    // =========================================================================

    #[test]
    fn sync_cursor_write_read_roundtrip() {
        let ws = create_temp_workspace();
        let ws_path = ws.path().to_str().unwrap();

        let cursor = SyncCursor {
            last_known_keys: {
                let mut m = HashMap::new();
                m.insert(
                    "skills".to_string(),
                    "teams/t/skills/updates/n/100.bin".to_string(),
                );
                m
            },
            last_known_keys_per_node: {
                let mut m = HashMap::new();
                m.insert(
                    "skills:teams/t/skills/updates/nodeA/".to_string(),
                    "teams/t/skills/updates/nodeA/100.bin".to_string(),
                );
                m
            },
            known_signal_keys: vec!["teams/t/signal/n/1.flag".to_string()],
            last_compaction_at: HashMap::new(),
            last_exported_version: HashMap::new(),
            last_scan_time: {
                let mut m = HashMap::new();
                m.insert("skills".to_string(), 1712500000000u64);
                m
            },
            known_files: {
                let mut m = HashMap::new();
                m.insert(
                    "skills".to_string(),
                    vec!["a.md".to_string(), "b.md".to_string()],
                );
                m
            },
            generation: {
                let mut m = HashMap::new();
                m.insert("skills".to_string(), "gen-1".to_string());
                m
            },
        };

        write_sync_cursor(ws_path, &cursor).unwrap();
        let loaded = read_sync_cursor(ws_path);

        assert_eq!(loaded.last_known_keys, cursor.last_known_keys);
        assert_eq!(
            loaded.last_known_keys_per_node,
            cursor.last_known_keys_per_node
        );
        assert_eq!(loaded.known_signal_keys, cursor.known_signal_keys);
        assert_eq!(loaded.last_scan_time, cursor.last_scan_time);
        assert_eq!(loaded.known_files, cursor.known_files);
        assert_eq!(loaded.generation, cursor.generation);
    }

    #[test]
    fn sync_cursor_atomic_write_no_partial() {
        let ws = create_temp_workspace();
        let ws_path = ws.path().to_str().unwrap();

        let cursor = SyncCursor::default();
        write_sync_cursor(ws_path, &cursor).unwrap();

        // Verify no .tmp file remains
        let loro_dir = ws.path().join(crate::commands::TEAMCLAW_DIR).join("loro");
        let tmp_path = loro_dir.join("sync_cursor.json.tmp");
        assert!(
            !tmp_path.exists(),
            ".tmp file should not remain after write"
        );

        // Verify the actual file exists and is valid JSON
        let path = loro_dir.join("sync_cursor.json");
        assert!(path.exists());
        let content = std::fs::read_to_string(&path).unwrap();
        let _: SyncCursor = serde_json::from_str(&content).unwrap();
    }

    // =========================================================================
    // Integration tests — export_sync_cursor
    // =========================================================================

    #[tokio::test]
    async fn export_sync_cursor_captures_state() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        // Upload a file to populate version vectors and cursors
        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");
        std::fs::write(skills_dir.join("track.md"), "track this").unwrap();
        mgr.upload_local_changes(DocType::Skills).await.unwrap();

        let cursor = mgr.export_sync_cursor();

        // Version vector should be populated after upload
        assert!(
            cursor.last_exported_version.contains_key("skills"),
            "should have version vector for skills"
        );

        s3.shutdown();
    }

    // =========================================================================
    // Integration tests — generation mismatch triggers re-bootstrap
    // =========================================================================

    #[tokio::test]
    async fn pull_detects_generation_mismatch_and_rebootstraps() {
        let s3 = mini_s3::MiniS3::start().await;
        let ws = create_temp_workspace();
        let mut mgr = create_test_manager(ws.path().to_str().unwrap(), &s3.endpoint());

        // Set a local generation
        mgr.generation
            .insert(DocType::Skills, "old-gen".to_string());

        // Upload a snapshot and generation.json with a DIFFERENT generation
        let snap_doc = loro::LoroDoc::new();
        {
            let files_map = snap_doc.get_map("files");
            let entry = files_map
                .get_or_create_container("rebootstrapped.md", loro::LoroMap::new())
                .unwrap();
            entry.insert("content", "new generation content").unwrap();
            entry.insert("hash", "nghash").unwrap();
            entry.insert("deleted", false).unwrap();
            entry.insert("updatedBy", "compactor").unwrap();
            entry.insert("updatedAt", "2026-01-03T00:00:00Z").unwrap();
        }
        let snapshot = snap_doc.export(loro::ExportMode::Snapshot).unwrap();
        let snap_key = "teams/test-team/skills/snapshots/newgen.bin";
        s3.put_stored(snap_key, snapshot).await;

        let gen_json = serde_json::json!({
            "generationId": "new-gen",
            "snapshotKey": snap_key,
        });
        s3.put_stored(
            "teams/test-team/skills/generation.json",
            gen_json.to_string().into_bytes(),
        )
        .await;

        mgr.pull_remote_changes(DocType::Skills).await.unwrap();

        // Generation should be updated
        assert_eq!(
            mgr.generation.get(&DocType::Skills).map(String::as_str),
            Some("new-gen")
        );

        // The re-bootstrap imports the snapshot into the doc. Since there are no
        // update keys, pull_remote_changes returns early before write_doc_to_disk.
        // Write to disk manually to verify the doc state.
        mgr.write_doc_to_disk(DocType::Skills).unwrap();

        let skills_dir = ws
            .path()
            .join(crate::commands::TEAM_REPO_DIR)
            .join("skills");
        assert_eq!(
            std::fs::read_to_string(skills_dir.join("rebootstrapped.md")).unwrap(),
            "new generation content"
        );

        s3.shutdown();
    }
}

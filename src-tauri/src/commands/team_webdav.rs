//! WebDAV sync — thin wrapper over `teamclaw_sync::team_webdav`.
//!
//! This module re-exports types and pure functions from the `teamclaw-sync` crate
//! and provides Tauri command wrappers that manage app-level state.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::State;

use super::opencode::OpenCodeState;
use super::team::{get_workspace_path, TEAM_REPO_DIR};
use super::TEAMCLAW_DIR;

// ---------------------------------------------------------------------------
// Re-export types and pure functions from teamclaw_sync::team_webdav
// ---------------------------------------------------------------------------

pub use teamclaw_sync::team_webdav::{
    // Pure functions
    build_client,
    decrypt_config,
    delete_credential,
    encrypt_config,
    get_credential,
    propfind,
    store_credential,
    validate_webdav_url,
    ExportPayload,
    SyncManifest,
    SyncResult,
    WebDavAuth,
    WebDavConfig,
    WebDavManagedState,
    WebDavSyncStatus,
};

// ---------------------------------------------------------------------------
// Config I/O (convenience wrappers with baked-in dir names)
// ---------------------------------------------------------------------------

pub fn read_webdav_config(workspace_path: &str) -> Option<WebDavConfig> {
    teamclaw_sync::team_webdav::read_webdav_config(
        workspace_path,
        TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME,
    )
}

pub fn write_webdav_config(workspace_path: &str, config: &WebDavConfig) -> Result<(), String> {
    teamclaw_sync::team_webdav::write_webdav_config(
        workspace_path,
        config,
        TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME,
    )
}

pub fn read_sync_manifest(workspace_path: &str) -> Option<SyncManifest> {
    teamclaw_sync::team_webdav::read_sync_manifest(workspace_path, TEAMCLAW_DIR)
}

#[allow(dead_code)]
pub fn write_sync_manifest(workspace_path: &str, manifest: &SyncManifest) -> Result<(), String> {
    teamclaw_sync::team_webdav::write_sync_manifest(workspace_path, manifest, TEAMCLAW_DIR)
}

// ---------------------------------------------------------------------------
// Sync orchestration (delegates to crate with baked-in dir names)
// ---------------------------------------------------------------------------

pub async fn sync_from_webdav(
    client: &reqwest::Client,
    url: &str,
    auth: &WebDavAuth,
    workspace_path: &str,
) -> Result<SyncResult, String> {
    teamclaw_sync::team_webdav::sync_from_webdav(
        client,
        url,
        auth,
        workspace_path,
        TEAM_REPO_DIR,
        TEAMCLAW_DIR,
    )
    .await
}

pub fn spawn_sync_timer(
    client: reqwest::Client,
    url: String,
    auth: WebDavAuth,
    workspace_path: String,
    interval_secs: u64,
    syncing: std::sync::Arc<AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    teamclaw_sync::team_webdav::spawn_sync_timer(
        client,
        url,
        auth,
        workspace_path,
        interval_secs,
        syncing,
        TEAM_REPO_DIR.to_string(),
        TEAMCLAW_DIR.to_string(),
        super::CONFIG_FILE_NAME.to_string(),
    )
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn webdav_connect(
    url: String,
    auth: WebDavAuth,
    opencode_state: State<'_, OpenCodeState>,
    webdav_state: State<'_, tokio::sync::Mutex<WebDavManagedState>>,
) -> Result<WebDavSyncStatus, String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    let config = read_webdav_config(&workspace_path);
    let allow_insecure = config.as_ref().map(|c| c.allow_insecure).unwrap_or(false);

    validate_webdav_url(&url, allow_insecure)?;

    let client = build_client(&auth)?;

    // Test connection with PROPFIND
    propfind(&client, &url, &auth).await?;

    // Store credentials in keyring
    match &auth {
        WebDavAuth::Basic { password, .. } => store_credential(&workspace_path, password)?,
        WebDavAuth::Bearer { token } => store_credential(&workspace_path, token)?,
    }

    // Save config
    let sync_interval = config.as_ref().map(|c| c.sync_interval_secs).unwrap_or(300);
    let new_config = WebDavConfig {
        url: url.clone(),
        auth_type: match &auth {
            WebDavAuth::Basic { .. } => "basic".to_string(),
            WebDavAuth::Bearer { .. } => "bearer".to_string(),
        },
        username: match &auth {
            WebDavAuth::Basic { username, .. } => Some(username.clone()),
            _ => None,
        },
        sync_interval_secs: sync_interval,
        enabled: true,
        last_sync_at: None,
        allow_insecure,
    };
    write_webdav_config(&workspace_path, &new_config)?;

    // Set team_mode
    crate::commands::team::write_team_mode(&workspace_path, Some("webdav"))?;

    // Update state
    let mut state = webdav_state.lock().await;
    state.client = Some(client.clone());
    state.auth = Some(auth.clone());
    state.url = Some(url.clone());
    state.last_error = None;

    // Spawn background sync timer
    let handle = spawn_sync_timer(
        client,
        url,
        auth,
        workspace_path,
        sync_interval,
        state.syncing.clone(),
    );
    state.sync_handle = Some(handle);

    Ok(WebDavSyncStatus {
        connected: true,
        syncing: false,
        last_sync_at: None,
        file_count: 0,
        error: None,
    })
}

#[tauri::command]
pub async fn webdav_sync(
    opencode_state: State<'_, OpenCodeState>,
    webdav_state: State<'_, tokio::sync::Mutex<WebDavManagedState>>,
) -> Result<SyncResult, String> {
    let workspace_path = get_workspace_path(&opencode_state)?;

    let (client, url, auth, syncing) = {
        let state = webdav_state.lock().await;
        let client = state.client.clone().ok_or("WebDAV not connected")?;
        let url = state.url.clone().ok_or("WebDAV URL not set")?;
        let auth = state.auth.clone().ok_or("WebDAV auth not set")?;

        if state.syncing.load(Ordering::Relaxed) {
            return Err("Sync already in progress".to_string());
        }
        state.syncing.store(true, Ordering::Relaxed);
        (client, url, auth, state.syncing.clone())
    };

    let result = sync_from_webdav(&client, &url, &auth, &workspace_path).await;

    syncing.store(false, Ordering::Relaxed);

    if result.is_ok() {
        if let Some(mut config) = read_webdav_config(&workspace_path) {
            config.last_sync_at = Some(chrono::Utc::now().to_rfc3339());
            let _ = write_webdav_config(&workspace_path, &config);
        }
    }

    result
}

#[tauri::command]
pub async fn webdav_disconnect(
    opencode_state: State<'_, OpenCodeState>,
    webdav_state: State<'_, tokio::sync::Mutex<WebDavManagedState>>,
) -> Result<(), String> {
    let workspace_path = get_workspace_path(&opencode_state)?;

    let mut state = webdav_state.lock().await;

    if let Some(handle) = state.sync_handle.take() {
        handle.abort();
    }

    state.client = None;
    state.auth = None;
    state.url = None;
    state.last_error = None;

    if let Some(mut config) = read_webdav_config(&workspace_path) {
        config.enabled = false;
        let _ = write_webdav_config(&workspace_path, &config);
    }

    let _ = delete_credential(&workspace_path);

    // Clear team_mode
    crate::commands::team::write_team_mode(&workspace_path, None)?;

    // Remove teamclaw-team directory
    let team_dir = Path::new(&workspace_path).join(TEAM_REPO_DIR);
    if team_dir.exists() {
        std::fs::remove_dir_all(&team_dir)
            .map_err(|e| format!("Failed to remove team directory: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn webdav_export_config(
    password: String,
    opencode_state: State<'_, OpenCodeState>,
) -> Result<String, String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    let config = read_webdav_config(&workspace_path).ok_or("WebDAV not configured")?;
    let credential = get_credential(&workspace_path)?;

    let payload = ExportPayload {
        url: config.url,
        auth_type: config.auth_type.clone(),
        username: config.username,
        password: if config.auth_type == "basic" {
            Some(credential.clone())
        } else {
            None
        },
        token: if config.auth_type == "bearer" {
            Some(credential)
        } else {
            None
        },
    };

    encrypt_config(&payload, &password)
}

#[tauri::command]
pub async fn webdav_import_config(
    config_json: String,
    password: String,
    opencode_state: State<'_, OpenCodeState>,
    webdav_state: State<'_, tokio::sync::Mutex<WebDavManagedState>>,
) -> Result<(), String> {
    let payload = decrypt_config(&config_json, &password)?;

    let auth = match payload.auth_type.as_str() {
        "basic" => WebDavAuth::Basic {
            username: payload.username.unwrap_or_default(),
            password: payload.password.unwrap_or_default(),
        },
        "bearer" => WebDavAuth::Bearer {
            token: payload.token.unwrap_or_default(),
        },
        other => return Err(format!("Unknown auth type: {other}")),
    };

    webdav_connect(payload.url, auth, opencode_state, webdav_state).await?;

    Ok(())
}

#[tauri::command]
pub async fn webdav_get_status(
    opencode_state: State<'_, OpenCodeState>,
    webdav_state: State<'_, tokio::sync::Mutex<WebDavManagedState>>,
) -> Result<WebDavSyncStatus, String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    let state = webdav_state.lock().await;
    let config = read_webdav_config(&workspace_path);

    let manifest = read_sync_manifest(&workspace_path);
    let file_count = manifest.as_ref().map(|m| m.files.len()).unwrap_or(0);

    Ok(WebDavSyncStatus {
        connected: state.client.is_some(),
        syncing: state.syncing.load(Ordering::Relaxed),
        last_sync_at: config.and_then(|c| c.last_sync_at),
        file_count,
        error: state.last_error.clone(),
    })
}

/// Deprecated: use team::get_team_status instead. Kept for backward compatibility.
#[tauri::command]
pub async fn get_team_mode(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<Option<String>, String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    Ok(crate::commands::team::check_team_status(&workspace_path).mode)
}

// --- Tests ---

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use teamclaw_sync::team_webdav::{
        compute_sync_diff, keyring_account_id, parse_propfind_response, DavEntry, FileEntry,
    };
    use tempfile::TempDir;

    #[test]
    fn test_read_write_webdav_config() {
        let tmp = TempDir::new().unwrap();
        let workspace = tmp.path().to_str().unwrap();

        let config = read_webdav_config(workspace);
        assert!(config.is_none());

        let cfg = WebDavConfig {
            url: "https://dav.example.com/team/".to_string(),
            auth_type: "basic".to_string(),
            username: Some("admin@co.com".to_string()),
            sync_interval_secs: 300,
            enabled: true,
            last_sync_at: None,
            allow_insecure: false,
        };
        write_webdav_config(workspace, &cfg).unwrap();

        let read = read_webdav_config(workspace).unwrap();
        assert_eq!(read.url, "https://dav.example.com/team/");
        assert_eq!(read.auth_type, "basic");
        assert_eq!(read.sync_interval_secs, 300);
        assert!(read.enabled);
    }

    #[test]
    fn test_read_write_preserves_other_fields() {
        let tmp = TempDir::new().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let teamclaw_dir = tmp.path().join(super::TEAMCLAW_DIR);
        fs::create_dir_all(&teamclaw_dir).unwrap();

        let existing = r#"{"team": {"gitUrl": "https://github.com/org/repo", "enabled": true}}"#;
        fs::write(
            teamclaw_dir.join(crate::commands::CONFIG_FILE_NAME),
            existing,
        )
        .unwrap();

        let cfg = WebDavConfig {
            url: "https://dav.example.com/team/".to_string(),
            auth_type: "basic".to_string(),
            username: Some("admin@co.com".to_string()),
            sync_interval_secs: 300,
            enabled: true,
            last_sync_at: None,
            allow_insecure: false,
        };
        write_webdav_config(workspace, &cfg).unwrap();

        let raw = fs::read_to_string(teamclaw_dir.join(crate::commands::CONFIG_FILE_NAME)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(json["team"]["gitUrl"].as_str().unwrap() == "https://github.com/org/repo");
        assert!(json["webdav"]["url"].as_str().unwrap() == "https://dav.example.com/team/");
    }

    #[test]
    fn test_parse_propfind_response() {
        let team = super::TEAM_REPO_DIR;
        let xml = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/{team}/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/{team}/README.md</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getcontentlength>256</D:getcontentlength>
        <D:getetag>"abc123"</D:getetag>
        <D:getlastmodified>Mon, 16 Mar 2026 09:00:00 GMT</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/{team}/.claude/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#
        );

        let base = format!("/dav/{team}/");
        let entries = parse_propfind_response(&xml, &base).unwrap();
        assert_eq!(entries.len(), 2);

        let file = entries.iter().find(|e| !e.is_collection).unwrap();
        assert_eq!(file.href, "README.md");
        assert_eq!(file.etag.as_deref(), Some("\"abc123\""));
        assert_eq!(file.content_length, Some(256));

        let dir = entries.iter().find(|e| e.is_collection).unwrap();
        assert_eq!(dir.href, ".claude/");
    }

    #[test]
    fn test_parse_propfind_empty_response() {
        let team = super::TEAM_REPO_DIR;
        let xml = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/{team}/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#
        );

        let base = format!("/dav/{team}/");
        let entries = parse_propfind_response(&xml, &base).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn test_validate_webdav_url() {
        assert!(validate_webdav_url("https://dav.example.com/team/", false).is_ok());
        assert!(validate_webdav_url("http://192.168.1.1/team/", false).is_err());
        assert!(validate_webdav_url("http://192.168.1.1/team/", true).is_ok());
        assert!(validate_webdav_url("ftp://example.com", false).is_err());
        assert!(validate_webdav_url("", false).is_err());
    }

    #[test]
    fn test_compute_sync_diff() {
        use std::collections::HashMap;

        let mut old_files = HashMap::new();
        old_files.insert(
            "README.md".to_string(),
            FileEntry {
                etag: Some("\"aaa\"".to_string()),
                last_modified: None,
                size: 100,
            },
        );
        old_files.insert(
            "old-file.md".to_string(),
            FileEntry {
                etag: Some("\"bbb\"".to_string()),
                last_modified: None,
                size: 50,
            },
        );

        let remote_files = vec![
            DavEntry {
                href: "README.md".to_string(),
                is_collection: false,
                etag: Some("\"aaa-changed\"".to_string()),
                last_modified: None,
                content_length: Some(120),
            },
            DavEntry {
                href: "skills/new.md".to_string(),
                is_collection: false,
                etag: Some("\"ccc\"".to_string()),
                last_modified: None,
                content_length: Some(200),
            },
        ];

        let diff = compute_sync_diff(&old_files, &remote_files);
        assert_eq!(diff.to_add.len(), 1);
        assert_eq!(diff.to_update.len(), 1);
        assert_eq!(diff.to_delete.len(), 1);
        assert_eq!(diff.to_add[0].href, "skills/new.md");
        assert_eq!(diff.to_update[0].href, "README.md");
        assert_eq!(diff.to_delete[0], "old-file.md");
    }

    #[test]
    fn test_keyring_account_id() {
        let account1 = keyring_account_id("/Users/alice/workspace");
        let account2 = keyring_account_id("/Users/alice/other-project");
        assert_ne!(account1, account2);
        assert_eq!(account1.len(), 16);

        let account1b = keyring_account_id("/Users/alice/workspace");
        assert_eq!(account1, account1b);
    }

    #[test]
    fn test_config_export_import_roundtrip() {
        let payload = ExportPayload {
            url: "https://dav.example.com/team/".to_string(),
            auth_type: "basic".to_string(),
            username: Some("admin@co.com".to_string()),
            password: Some("secret123".to_string()),
            token: None,
        };

        let password = "my-secure-passphrase";
        let encrypted = encrypt_config(&payload, password).unwrap();

        let json: serde_json::Value = serde_json::from_str(&encrypted).unwrap();
        assert_eq!(json["type"], "teamclaw-team-webdav");
        assert_eq!(json["version"], 1);
        assert!(json["salt"].is_string());
        assert!(json["nonce"].is_string());
        assert!(json["ciphertext"].is_string());

        let decrypted = decrypt_config(&encrypted, password).unwrap();
        assert_eq!(decrypted.url, "https://dav.example.com/team/");
        assert_eq!(decrypted.username.as_deref(), Some("admin@co.com"));
        assert_eq!(decrypted.password.as_deref(), Some("secret123"));
    }

    #[test]
    fn test_config_decrypt_wrong_password() {
        let payload = ExportPayload {
            url: "https://dav.example.com/team/".to_string(),
            auth_type: "basic".to_string(),
            username: Some("admin".to_string()),
            password: Some("secret".to_string()),
            token: None,
        };

        let encrypted = encrypt_config(&payload, "correct-password").unwrap();
        let result = decrypt_config(&encrypted, "wrong-password");
        assert!(result.is_err());
    }

    #[test]
    fn test_config_export_short_password() {
        let payload = ExportPayload {
            url: "https://dav.example.com/".to_string(),
            auth_type: "basic".to_string(),
            username: None,
            password: None,
            token: None,
        };

        let result = encrypt_config(&payload, "short");
        assert!(result.is_err());
    }

    #[test]
    fn test_read_write_team_mode() {
        use crate::commands::team::{check_team_status, write_team_mode};
        let tmp = TempDir::new().unwrap();
        let workspace = tmp.path().to_str().unwrap();

        assert!(!check_team_status(workspace).active);

        write_team_mode(workspace, Some("webdav")).unwrap();
        let status = check_team_status(workspace);
        assert_eq!(status.mode.as_deref(), Some("webdav"));

        write_team_mode(workspace, None).unwrap();
        assert!(!check_team_status(workspace).active);
    }

    #[test]
    fn test_team_mode_migration() {
        use crate::commands::team::check_team_status;
        let tmp = TempDir::new().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let teamclaw_dir = tmp.path().join(super::TEAMCLAW_DIR);
        fs::create_dir_all(&teamclaw_dir).unwrap();

        let config = r#"{"p2p": {"enabled": true}, "team": {"enabled": false}}"#;
        fs::write(teamclaw_dir.join(crate::commands::CONFIG_FILE_NAME), config).unwrap();

        let status = check_team_status(workspace);
        assert!(status.active);
        assert_eq!(status.mode.as_deref(), Some("p2p"));
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn propfind_response(base_path: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>{base_path}</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>{base_path}README.md</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getcontentlength>100</D:getcontentlength>
        <D:getetag>"v1"</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#
        )
    }

    #[tokio::test]
    async fn test_full_sync_flow() {
        let server = MockServer::start().await;
        let base_path = "/team/";

        Mock::given(method("PROPFIND"))
            .and(path(base_path))
            .respond_with(ResponseTemplate::new(207).set_body_string(propfind_response(base_path)))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/team/README.md"))
            .respond_with(ResponseTemplate::new(200).set_body_string("llm:\n  model: gpt-4o\n"))
            .mount(&server)
            .await;

        let tmp = TempDir::new().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let url = format!("{}{}", server.uri(), base_path);
        let auth = WebDavAuth::Basic {
            username: "test".to_string(),
            password: "pass".to_string(),
        };
        let client = build_client(&auth).unwrap();

        let result = sync_from_webdav(&client, &url, &auth, workspace)
            .await
            .unwrap();
        assert_eq!(result.files_added, 1);
        assert_eq!(result.files_updated, 0);
        assert_eq!(result.files_deleted, 0);

        let content =
            fs::read_to_string(tmp.path().join(super::TEAM_REPO_DIR).join("README.md")).unwrap();
        assert!(content.contains("gpt-4o"));

        let manifest = read_sync_manifest(workspace).unwrap();
        assert_eq!(manifest.files.len(), 1);
        assert!(manifest.files.contains_key("README.md"));
    }

    #[tokio::test]
    async fn test_sync_auth_failure() {
        let server = MockServer::start().await;

        Mock::given(method("PROPFIND"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let url = format!("{}/team/", server.uri());
        let auth = WebDavAuth::Basic {
            username: "bad".to_string(),
            password: "creds".to_string(),
        };
        let client = build_client(&auth).unwrap();

        let result = propfind(&client, &url, &auth).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("401"));
    }

    #[tokio::test]
    async fn test_sync_network_timeout() {
        let server = MockServer::start().await;

        Mock::given(method("PROPFIND"))
            .respond_with(
                ResponseTemplate::new(207)
                    .set_body_string("<D:multistatus xmlns:D=\"DAV:\"></D:multistatus>")
                    .set_delay(std::time::Duration::from_secs(10)),
            )
            .mount(&server)
            .await;

        let url = format!("{}/team/", server.uri());
        let auth = WebDavAuth::Basic {
            username: "test".to_string(),
            password: "pass".to_string(),
        };

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap();

        let result = propfind(&client, &url, &auth).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("timed out") || err.contains("timeout") || err.contains("failed"),
            "Expected timeout error, got: {err}"
        );
    }

    #[tokio::test]
    async fn test_sync_directory_not_found() {
        let server = MockServer::start().await;

        Mock::given(method("PROPFIND"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let url = format!("{}/nonexistent/", server.uri());
        let auth = WebDavAuth::Basic {
            username: "test".to_string(),
            password: "pass".to_string(),
        };
        let client = build_client(&auth).unwrap();

        let result = propfind(&client, &url, &auth).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("404"));
    }

    #[tokio::test]
    async fn test_sync_incremental_update() {
        let server = MockServer::start().await;
        let base_path = "/team/";
        let tmp = TempDir::new().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let auth = WebDavAuth::Basic {
            username: "test".to_string(),
            password: "pass".to_string(),
        };
        let client = build_client(&auth).unwrap();

        let propfind_v1 = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>{base_path}</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>{base_path}README.md</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getcontentlength>10</D:getcontentlength>
        <D:getetag>"v1"</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#
        );

        Mock::given(method("PROPFIND"))
            .and(path(base_path))
            .respond_with(ResponseTemplate::new(207).set_body_string(&propfind_v1))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/team/README.md"))
            .respond_with(ResponseTemplate::new(200).set_body_string("version: 1"))
            .mount(&server)
            .await;

        let url = format!("{}{}", server.uri(), base_path);
        let r1 = sync_from_webdav(&client, &url, &auth, workspace)
            .await
            .unwrap();
        assert_eq!(r1.files_added, 1);
        assert_eq!(r1.files_updated, 0);

        // Second sync: same etag -> no download
        let r2 = sync_from_webdav(&client, &url, &auth, workspace)
            .await
            .unwrap();
        assert_eq!(r2.files_added, 0);
        assert_eq!(r2.files_updated, 0);
        assert_eq!(r2.files_deleted, 0);

        // Third sync: etag changed -> update
        server.reset().await;

        let propfind_v2 = propfind_v1.replace(r#""v1""#, r#""v2""#);
        Mock::given(method("PROPFIND"))
            .and(path(base_path))
            .respond_with(ResponseTemplate::new(207).set_body_string(&propfind_v2))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/team/README.md"))
            .respond_with(ResponseTemplate::new(200).set_body_string("version: 2"))
            .mount(&server)
            .await;

        let r3 = sync_from_webdav(&client, &url, &auth, workspace)
            .await
            .unwrap();
        assert_eq!(r3.files_added, 0);
        assert_eq!(r3.files_updated, 1);

        let content =
            fs::read_to_string(tmp.path().join(super::TEAM_REPO_DIR).join("README.md")).unwrap();
        assert_eq!(content, "version: 2");
    }

    #[tokio::test]
    async fn test_sync_file_deletion() {
        let server = MockServer::start().await;
        let base_path = "/team/";
        let tmp = TempDir::new().unwrap();
        let workspace = tmp.path().to_str().unwrap();
        let auth = WebDavAuth::Basic {
            username: "test".to_string(),
            password: "pass".to_string(),
        };
        let client = build_client(&auth).unwrap();

        let propfind_two = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>{base_path}</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>{base_path}README.md</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/><D:getcontentlength>10</D:getcontentlength><D:getetag>"a"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>{base_path}old.txt</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/><D:getcontentlength>5</D:getcontentlength><D:getetag>"b"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#
        );

        Mock::given(method("PROPFIND"))
            .and(path(base_path))
            .respond_with(ResponseTemplate::new(207).set_body_string(&propfind_two))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/team/README.md"))
            .respond_with(ResponseTemplate::new(200).set_body_string("yaml"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/team/old.txt"))
            .respond_with(ResponseTemplate::new(200).set_body_string("old"))
            .mount(&server)
            .await;

        let url = format!("{}{}", server.uri(), base_path);
        sync_from_webdav(&client, &url, &auth, workspace)
            .await
            .unwrap();
        assert!(tmp
            .path()
            .join(super::TEAM_REPO_DIR)
            .join("old.txt")
            .exists());

        // Second sync: old.txt removed from remote
        server.reset().await;
        let propfind_one = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>{base_path}</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>{base_path}README.md</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/><D:getcontentlength>10</D:getcontentlength><D:getetag>"a"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#
        );

        Mock::given(method("PROPFIND"))
            .and(path(base_path))
            .respond_with(ResponseTemplate::new(207).set_body_string(&propfind_one))
            .mount(&server)
            .await;

        let result = sync_from_webdav(&client, &url, &auth, workspace)
            .await
            .unwrap();
        assert_eq!(result.files_deleted, 1);
        assert!(!tmp
            .path()
            .join(super::TEAM_REPO_DIR)
            .join("old.txt")
            .exists());
        assert!(tmp
            .path()
            .join(super::TEAM_REPO_DIR)
            .join("README.md")
            .exists());
    }
}

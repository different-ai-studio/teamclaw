//! WebDAV sync types and pure logic.
//!
//! Tauri command wrappers remain in the main crate.
//! This module contains: types, PROPFIND XML parser, URL validation,
//! HTTP helpers, sync diff computation, file download, AES-256-GCM crypto,
//! keyring helpers, and background sync timer.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use pbkdf2::pbkdf2_hmac;
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::{Client, Method, StatusCode};
use sha2::{Digest, Sha256};
use tokio::task::JoinHandle;

// --- Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
    pub url: String,
    pub auth_type: String,
    pub username: Option<String>,
    pub sync_interval_secs: u64,
    pub enabled: bool,
    pub last_sync_at: Option<String>,
    #[serde(default)]
    pub allow_insecure: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WebDavAuth {
    Basic { username: String, password: String },
    Bearer { token: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSyncStatus {
    pub connected: bool,
    pub syncing: bool,
    pub last_sync_at: Option<String>,
    pub file_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub files_added: usize,
    pub files_updated: usize,
    pub files_deleted: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncManifest {
    pub last_sync: String,
    pub files: std::collections::HashMap<String, FileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct DavEntry {
    pub href: String,
    pub is_collection: bool,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_length: Option<u64>,
}

pub struct SyncDiff {
    pub to_add: Vec<DavEntry>,
    pub to_update: Vec<DavEntry>,
    pub to_delete: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPayload {
    pub url: String,
    pub auth_type: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub token: Option<String>,
}

pub struct WebDavManagedState {
    pub client: Option<Client>,
    pub auth: Option<WebDavAuth>,
    pub url: Option<String>,
    pub sync_handle: Option<JoinHandle<()>>,
    pub syncing: Arc<AtomicBool>,
    pub last_error: Option<String>,
}

impl Default for WebDavManagedState {
    fn default() -> Self {
        Self {
            client: None,
            auth: None,
            url: None,
            sync_handle: None,
            syncing: Arc::new(AtomicBool::new(false)),
            last_error: None,
        }
    }
}

// --- Constants ---

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(120);
const KEYRING_SERVICE: &str = "teamclaw-webdav";
const PBKDF2_ITERATIONS: u32 = 600_000;
const MIN_PASSWORD_LEN: usize = 8;

// --- Config I/O ---

pub fn read_webdav_config(workspace_path: &str, teamclaw_dir: &str, config_file_name: &str) -> Option<WebDavConfig> {
    let config_path = Path::new(workspace_path)
        .join(teamclaw_dir)
        .join(config_file_name);
    let content = fs::read_to_string(&config_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let webdav_value = json.get("webdav")?;
    serde_json::from_value(webdav_value.clone()).ok()
}

pub fn write_webdav_config(workspace_path: &str, config: &WebDavConfig, teamclaw_dir: &str, config_file_name: &str) -> Result<(), String> {
    let tc_dir = Path::new(workspace_path).join(teamclaw_dir);
    fs::create_dir_all(&tc_dir)
        .map_err(|e| format!("Failed to create {} dir: {e}", teamclaw_dir))?;

    let config_path = tc_dir.join(config_file_name);
    let mut json: serde_json::Value = if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {e}", config_file_name))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let webdav_value = serde_json::to_value(config)
        .map_err(|e| format!("Failed to serialize webdav config: {e}"))?;
    json["webdav"] = webdav_value;

    let content = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize {}: {e}", config_file_name))?;
    fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write {}: {e}", config_file_name))?;

    Ok(())
}

pub fn read_sync_manifest(workspace_path: &str, teamclaw_dir: &str) -> Option<SyncManifest> {
    let path = Path::new(workspace_path)
        .join(teamclaw_dir)
        .join("webdav_sync_manifest.json");
    let content = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn write_sync_manifest(workspace_path: &str, manifest: &SyncManifest, teamclaw_dir: &str) -> Result<(), String> {
    let tc_dir = Path::new(workspace_path).join(teamclaw_dir);
    fs::create_dir_all(&tc_dir)
        .map_err(|e| format!("Failed to create {} dir: {e}", teamclaw_dir))?;
    let path = tc_dir.join("webdav_sync_manifest.json");
    let content = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Failed to serialize manifest: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write manifest: {e}"))?;
    Ok(())
}

// --- PROPFIND XML Parser ---

pub fn parse_propfind_response(xml: &str, base_href: &str) -> Result<Vec<DavEntry>, String> {
    let mut reader = Reader::from_str(xml);
    let mut entries: Vec<DavEntry> = Vec::new();

    let mut in_response = false;
    let mut in_propstat = false;
    let mut current_href: Option<String> = None;
    let mut is_collection = false;
    let mut etag: Option<String> = None;
    let mut last_modified: Option<String> = None;
    let mut content_length: Option<u64> = None;
    let mut current_element: Option<String> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let local_name = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                match local_name.as_str() {
                    "response" => {
                        in_response = true;
                        current_href = None;
                        is_collection = false;
                        etag = None;
                        last_modified = None;
                        content_length = None;
                    }
                    "propstat" => in_propstat = true,
                    "collection" if in_propstat => is_collection = true,
                    "href" | "getetag" | "getlastmodified" | "getcontentlength" => {
                        current_element = Some(local_name);
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref e)) => {
                if let Some(ref elem) = current_element {
                    let text = e.unescape().unwrap_or_default().to_string();
                    match elem.as_str() {
                        "href" if in_response && !in_propstat => {
                            current_href = Some(text);
                        }
                        "getetag" if in_propstat => etag = Some(text),
                        "getlastmodified" if in_propstat => last_modified = Some(text),
                        "getcontentlength" if in_propstat => {
                            content_length = text.parse().ok();
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let local_name = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                match local_name.as_str() {
                    "response" => {
                        if let Some(href) = current_href.take() {
                            let relative = compute_relative_path(&href, base_href);
                            if !relative.is_empty() {
                                entries.push(DavEntry {
                                    href: relative,
                                    is_collection,
                                    etag: etag.take(),
                                    last_modified: last_modified.take(),
                                    content_length,
                                });
                            }
                        }
                        in_response = false;
                    }
                    "propstat" => in_propstat = false,
                    "href" | "getetag" | "getlastmodified" | "getcontentlength" => {
                        current_element = None;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XML parse error: {e}")),
            _ => {}
        }
    }

    Ok(entries)
}

fn compute_relative_path(href: &str, base_href: &str) -> String {
    let decoded = urlencoding::decode(href).unwrap_or_else(|_| href.into());
    let base = urlencoding::decode(base_href).unwrap_or_else(|_| base_href.into());

    let normalized_href = decoded.trim_start_matches('/');
    let normalized_base = base.trim_start_matches('/');

    if let Some(relative) = normalized_href.strip_prefix(normalized_base) {
        relative.to_string()
    } else {
        decoded.to_string()
    }
}

// --- URL Validation ---

pub fn validate_webdav_url(url: &str, allow_insecure: bool) -> Result<(), String> {
    if url.is_empty() {
        return Err("URL cannot be empty".to_string());
    }
    if url.starts_with("https://") {
        return Ok(());
    }
    if url.starts_with("http://") && allow_insecure {
        return Ok(());
    }
    if url.starts_with("http://") {
        return Err(
            "HTTP URLs are not allowed. Use HTTPS or enable 'allow insecure connections'."
                .to_string(),
        );
    }
    Err(format!("Unsupported URL scheme: {url}"))
}

// --- HTTP Client ---

pub fn build_client(_auth: &WebDavAuth) -> Result<Client, String> {
    let builder = Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(READ_TIMEOUT);

    builder
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

pub fn apply_auth(req: reqwest::RequestBuilder, auth: &WebDavAuth) -> reqwest::RequestBuilder {
    match auth {
        WebDavAuth::Basic { username, password } => req.basic_auth(username, Some(password)),
        WebDavAuth::Bearer { token } => req.bearer_auth(token),
    }
}

pub async fn propfind(
    client: &Client,
    url: &str,
    auth: &WebDavAuth,
) -> Result<Vec<DavEntry>, String> {
    let req = client
        .request(Method::from_bytes(b"PROPFIND").unwrap(), url)
        .header("Depth", "1")
        .header("Content-Type", "application/xml");

    let req = apply_auth(req, auth);

    let resp = req
        .send()
        .await
        .map_err(|e| format!("PROPFIND request failed: {e}"))?;

    match resp.status() {
        StatusCode::MULTI_STATUS => {
            let body = resp
                .text()
                .await
                .map_err(|e| format!("Failed to read response: {e}"))?;
            let base_path = url::Url::parse(url)
                .map(|u| u.path().to_string())
                .unwrap_or_default();
            parse_propfind_response(&body, &base_path)
        }
        StatusCode::UNAUTHORIZED => {
            Err("Authentication failed (401). Check credentials.".to_string())
        }
        StatusCode::FORBIDDEN => Err("Access denied (403). Check permissions.".to_string()),
        StatusCode::NOT_FOUND => Err("Directory not found (404). Check URL.".to_string()),
        status => Err(format!("Unexpected status: {status}")),
    }
}

pub fn list_all_files<'a>(
    client: &'a Client,
    base_url: &'a str,
    auth: &'a WebDavAuth,
    prefix: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<DavEntry>, String>> + Send + 'a>>
{
    Box::pin(async move {
        let mut all_files: Vec<DavEntry> = Vec::new();
        let entries = propfind(client, base_url, auth).await?;

        for entry in entries {
            if entry.is_collection {
                let sub_url = format!(
                    "{}{}",
                    base_url.trim_end_matches('/'),
                    &format!("/{}", entry.href.trim_end_matches('/'))
                );
                let sub_url = format!("{}/", sub_url);
                let sub_prefix = format!("{}{}", prefix, &entry.href);
                let sub_files = list_all_files(client, &sub_url, auth, &sub_prefix).await?;
                all_files.extend(sub_files);
            } else {
                all_files.push(DavEntry {
                    href: format!("{}{}", prefix, &entry.href),
                    ..entry
                });
            }
        }

        Ok(all_files)
    })
}

pub async fn download_file(
    client: &Client,
    base_url: &str,
    file_path: &str,
    auth: &WebDavAuth,
    dest: &Path,
) -> Result<u64, String> {
    let url = format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        file_path.trim_start_matches('/')
    );
    let req = apply_auth(client.get(&url), auth);
    let resp = req
        .send()
        .await
        .map_err(|e| format!("GET failed for {file_path}: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GET {file_path} returned {}", resp.status()));
    }

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read body: {e}"))?;
    let size = bytes.len() as u64;
    fs::write(dest, &bytes).map_err(|e| format!("Failed to write {}: {e}", dest.display()))?;

    Ok(size)
}

// --- Sync Logic ---

pub fn compute_sync_diff(
    old_files: &std::collections::HashMap<String, FileEntry>,
    remote_files: &[DavEntry],
) -> SyncDiff {
    let mut to_add = Vec::new();
    let mut to_update = Vec::new();
    let mut remote_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

    for remote in remote_files {
        if remote.is_collection {
            continue;
        }
        remote_paths.insert(remote.href.clone());

        match old_files.get(&remote.href) {
            None => to_add.push(remote.clone()),
            Some(old) => {
                let changed = match (&remote.etag, &old.etag) {
                    (Some(r), Some(o)) => r != o,
                    _ => remote.content_length.unwrap_or(0) != old.size,
                };
                if changed {
                    to_update.push(remote.clone());
                }
            }
        }
    }

    let to_delete: Vec<String> = old_files
        .keys()
        .filter(|k| !remote_paths.contains(*k))
        .cloned()
        .collect();

    SyncDiff {
        to_add,
        to_update,
        to_delete,
    }
}

/// Perform a full sync from a WebDAV server to the local team directory.
pub async fn sync_from_webdav(
    client: &Client,
    url: &str,
    auth: &WebDavAuth,
    workspace_path: &str,
    team_repo_dir: &str,
    teamclaw_dir: &str,
) -> Result<SyncResult, String> {
    let team_dir = Path::new(workspace_path).join(team_repo_dir);
    fs::create_dir_all(&team_dir).map_err(|e| format!("Failed to create team dir: {e}"))?;

    let remote_files = list_all_files(client, url, auth, "").await?;

    let manifest = read_sync_manifest(workspace_path, teamclaw_dir);
    let old_files = manifest
        .as_ref()
        .map(|m| m.files.clone())
        .unwrap_or_default();

    let diff = compute_sync_diff(&old_files, &remote_files);

    for entry in diff.to_add.iter().chain(diff.to_update.iter()) {
        let dest = team_dir.join(&entry.href);
        download_file(client, url, &entry.href, auth, &dest).await?;
    }

    for path in &diff.to_delete {
        let local_path = team_dir.join(path);
        if local_path.exists() {
            fs::remove_file(&local_path).ok();
        }
    }

    let mut new_files = std::collections::HashMap::new();
    for entry in &remote_files {
        if !entry.is_collection {
            new_files.insert(
                entry.href.clone(),
                FileEntry {
                    etag: entry.etag.clone(),
                    last_modified: entry.last_modified.clone(),
                    size: entry.content_length.unwrap_or(0),
                },
            );
        }
    }

    let new_manifest = SyncManifest {
        last_sync: chrono::Utc::now().to_rfc3339(),
        files: new_files,
    };
    write_sync_manifest(workspace_path, &new_manifest, teamclaw_dir)?;

    Ok(SyncResult {
        files_added: diff.to_add.len(),
        files_updated: diff.to_update.len(),
        files_deleted: diff.to_delete.len(),
    })
}

// --- Keyring Helpers ---

pub fn keyring_account_id(workspace_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(workspace_path.as_bytes());
    let result = hasher.finalize();
    hex::encode(&result[..8])
}

pub fn store_credential(workspace_path: &str, password: &str) -> Result<(), String> {
    let account = keyring_account_id(workspace_path);
    let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| format!("Keyring entry error: {e}"))?;
    entry
        .set_password(password)
        .map_err(|e| format!("Failed to store credential: {e}"))?;
    Ok(())
}

pub fn get_credential(workspace_path: &str) -> Result<String, String> {
    let account = keyring_account_id(workspace_path);
    let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| format!("Keyring entry error: {e}"))?;
    entry
        .get_password()
        .map_err(|e| format!("Failed to get credential: {e}"))
}

pub fn delete_credential(workspace_path: &str) -> Result<(), String> {
    let account = keyring_account_id(workspace_path);
    let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| format!("Keyring entry error: {e}"))?;
    entry
        .delete_credential()
        .map_err(|e| format!("Failed to delete credential: {e}"))
}

// --- AES-256-GCM Encryption ---

pub fn encrypt_config(payload: &ExportPayload, password: &str) -> Result<String, String> {
    if password.len() < MIN_PASSWORD_LEN {
        return Err(format!(
            "Password must be at least {MIN_PASSWORD_LEN} characters"
        ));
    }

    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut salt).map_err(|e| format!("RNG error: {e}"))?;
    getrandom::getrandom(&mut nonce_bytes).map_err(|e| format!("RNG error: {e}"))?;

    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, PBKDF2_ITERATIONS, &mut key);

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Cipher init error: {e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = serde_json::to_vec(payload).map_err(|e| format!("Serialize error: {e}"))?;
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("Encryption error: {e}"))?;

    let export = serde_json::json!({
        "type": "teamclaw-team-webdav",
        "version": 1,
        "salt": BASE64.encode(&salt),
        "nonce": BASE64.encode(&nonce_bytes),
        "ciphertext": BASE64.encode(&ciphertext),
    });

    serde_json::to_string_pretty(&export).map_err(|e| format!("JSON serialize error: {e}"))
}

pub fn decrypt_config(encrypted_json: &str, password: &str) -> Result<ExportPayload, String> {
    let json: serde_json::Value =
        serde_json::from_str(encrypted_json).map_err(|e| format!("Invalid JSON: {e}"))?;

    if json["type"] != "teamclaw-team-webdav" {
        return Err("Invalid config file type".to_string());
    }

    let salt = BASE64
        .decode(json["salt"].as_str().ok_or("Missing salt")?)
        .map_err(|e| format!("Invalid salt: {e}"))?;
    let nonce_bytes = BASE64
        .decode(json["nonce"].as_str().ok_or("Missing nonce")?)
        .map_err(|e| format!("Invalid nonce: {e}"))?;
    let ciphertext = BASE64
        .decode(json["ciphertext"].as_str().ok_or("Missing ciphertext")?)
        .map_err(|e| format!("Invalid ciphertext: {e}"))?;

    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, PBKDF2_ITERATIONS, &mut key);

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Cipher init error: {e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "Decryption failed. Wrong password?".to_string())?;

    serde_json::from_slice(&plaintext).map_err(|e| format!("Invalid payload: {e}"))
}

// --- Background Sync Timer ---

pub fn spawn_sync_timer(
    client: Client,
    url: String,
    auth: WebDavAuth,
    workspace_path: String,
    interval_secs: u64,
    syncing: Arc<AtomicBool>,
    team_repo_dir: String,
    teamclaw_dir: String,
    config_file_name: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let base_interval = Duration::from_secs(interval_secs);
        let mut current_interval = base_interval;
        let max_interval = Duration::from_secs(3600);

        let _ = do_background_sync(&client, &url, &auth, &workspace_path, &syncing, &team_repo_dir, &teamclaw_dir, &config_file_name).await;

        loop {
            tokio::time::sleep(current_interval).await;

            match do_background_sync(&client, &url, &auth, &workspace_path, &syncing, &team_repo_dir, &teamclaw_dir, &config_file_name).await {
                Ok(_) => {
                    current_interval = base_interval;
                }
                Err(_) => {
                    current_interval = (current_interval * 2).min(max_interval);
                    log::warn!(
                        "WebDAV sync failed, retrying in {}s",
                        current_interval.as_secs()
                    );
                }
            }
        }
    })
}

async fn do_background_sync(
    client: &Client,
    url: &str,
    auth: &WebDavAuth,
    workspace_path: &str,
    syncing: &Arc<AtomicBool>,
    team_repo_dir: &str,
    teamclaw_dir: &str,
    config_file_name: &str,
) -> Result<SyncResult, String> {
    if syncing.load(Ordering::Relaxed) {
        return Err("Sync already in progress".to_string());
    }
    syncing.store(true, Ordering::Relaxed);

    let result = sync_from_webdav(client, url, auth, workspace_path, team_repo_dir, teamclaw_dir).await;

    syncing.store(false, Ordering::Relaxed);

    if result.is_ok() {
        if let Some(mut config) = read_webdav_config(workspace_path, teamclaw_dir, config_file_name) {
            config.last_sync_at = Some(chrono::Utc::now().to_rfc3339());
            let _ = write_webdav_config(workspace_path, &config, teamclaw_dir, config_file_name);
        }
    }

    result
}

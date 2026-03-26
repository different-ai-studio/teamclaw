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
use tauri::State;
use tokio::task::JoinHandle;

use super::opencode::OpenCodeState;
use super::team::{get_workspace_path, TEAM_REPO_DIR};
use super::TEAMCLAW_DIR;

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
const KEYRING_SERVICE: &str = concat!(env!("APP_SHORT_NAME"), "-webdav");
const PBKDF2_ITERATIONS: u32 = 600_000;
const MIN_PASSWORD_LEN: usize = 8;

// --- Config I/O ---

pub fn read_webdav_config(workspace_path: &str) -> Option<WebDavConfig> {
    let config_path = Path::new(workspace_path)
        .join(TEAMCLAW_DIR)
        .join(super::CONFIG_FILE_NAME);
    let content = fs::read_to_string(&config_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let webdav_value = json.get("webdav")?;
    serde_json::from_value(webdav_value.clone()).ok()
}

pub fn write_webdav_config(workspace_path: &str, config: &WebDavConfig) -> Result<(), String> {
    let teamclaw_dir = Path::new(workspace_path).join(TEAMCLAW_DIR);
    fs::create_dir_all(&teamclaw_dir)
        .map_err(|e| format!("Failed to create {} dir: {e}", super::TEAMCLAW_DIR))?;

    let config_path = teamclaw_dir.join(super::CONFIG_FILE_NAME);
    let mut json: serde_json::Value = if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {e}", super::CONFIG_FILE_NAME))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let webdav_value = serde_json::to_value(config)
        .map_err(|e| format!("Failed to serialize webdav config: {e}"))?;
    json["webdav"] = webdav_value;

    let content = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize {}: {e}", super::CONFIG_FILE_NAME))?;
    fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write {}: {e}", super::CONFIG_FILE_NAME))?;

    Ok(())
}

pub fn read_sync_manifest(workspace_path: &str) -> Option<SyncManifest> {
    let path = Path::new(workspace_path)
        .join(TEAMCLAW_DIR)
        .join("webdav_sync_manifest.json");
    let content = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn write_sync_manifest(workspace_path: &str, manifest: &SyncManifest) -> Result<(), String> {
    let teamclaw_dir = Path::new(workspace_path).join(TEAMCLAW_DIR);
    fs::create_dir_all(&teamclaw_dir)
        .map_err(|e| format!("Failed to create {} dir: {e}", super::TEAMCLAW_DIR))?;
    let path = teamclaw_dir.join("webdav_sync_manifest.json");
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

fn build_client(_auth: &WebDavAuth) -> Result<Client, String> {
    let builder = Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(READ_TIMEOUT);

    builder
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

fn apply_auth(req: reqwest::RequestBuilder, auth: &WebDavAuth) -> reqwest::RequestBuilder {
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

pub async fn sync_from_webdav(
    client: &Client,
    url: &str,
    auth: &WebDavAuth,
    workspace_path: &str,
) -> Result<SyncResult, String> {
    let team_dir = Path::new(workspace_path).join(TEAM_REPO_DIR);
    fs::create_dir_all(&team_dir).map_err(|e| format!("Failed to create team dir: {e}"))?;

    let remote_files = list_all_files(client, url, auth, "").await?;

    let manifest = read_sync_manifest(workspace_path);
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
    write_sync_manifest(workspace_path, &new_manifest)?;

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
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let base_interval = Duration::from_secs(interval_secs);
        let mut current_interval = base_interval;
        let max_interval = Duration::from_secs(3600);

        let _ = do_background_sync(&client, &url, &auth, &workspace_path, &syncing).await;

        loop {
            tokio::time::sleep(current_interval).await;

            match do_background_sync(&client, &url, &auth, &workspace_path, &syncing).await {
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
) -> Result<SyncResult, String> {
    if syncing.load(Ordering::Relaxed) {
        return Err("Sync already in progress".to_string());
    }
    syncing.store(true, Ordering::Relaxed);

    let result = sync_from_webdav(client, url, auth, workspace_path).await;

    syncing.store(false, Ordering::Relaxed);

    if result.is_ok() {
        if let Some(mut config) = read_webdav_config(workspace_path) {
            config.last_sync_at = Some(chrono::Utc::now().to_rfc3339());
            let _ = write_webdav_config(workspace_path, &config);
        }
    }

    result
}

// --- team_mode --- (delegated to team::check_team_status / team::write_team_mode)

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

        let client = Client::builder()
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

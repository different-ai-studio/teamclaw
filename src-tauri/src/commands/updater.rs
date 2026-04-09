use base64::{engine::general_purpose::STANDARD, Engine};
#[cfg(target_os = "macos")]
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::io::Cursor;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Runtime};

const DEFAULT_REPO_OWNER: &str = "diffrent-ai-studio";
const DEFAULT_REPO_NAME: &str = "teamclaw";
const DEFAULT_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQzODk5QzIxMUI4RkY3OTkKUldTWjk0OGJJWnlKUTlnZVdEaUsyUGJ4WFpaYmlQZW03NGdlNVdyUlRMNGtKVVBKeTk3NEYwZXAK";
const APP_USER_AGENT: &str = concat!("teamclaw-updater/", env!("CARGO_PKG_VERSION"));

fn get_updater_endpoint() -> Option<&'static str> {
    option_env!("UPDATER_ENDPOINT")
}

fn get_updater_pubkey() -> &'static str {
    option_env!("UPDATER_PUBKEY").unwrap_or(DEFAULT_PUBKEY)
}

// ---------- Types ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: String,
    pub download_url: String,
    pub signature: String,
}

/// Progress events emitted during download
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub content_length: Option<u64>,
}

// GitHub API response types
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct GhRelease {
    tag_name: String,
    body: Option<String>,
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    url: String, // api.github.com asset URL
}

/// Tauri updater static JSON format (latest.json)
#[derive(Debug, Deserialize)]
struct UpdateManifest {
    version: String,
    notes: Option<String>,
    platforms: HashMap<String, PlatformEntry>,
}

#[derive(Debug, Deserialize)]
struct PlatformEntry {
    signature: String,
    url: String,
}

// ---------- Helpers ----------

fn get_token() -> Option<&'static str> {
    option_env!("UPDATER_GITHUB_TOKEN")
}

fn build_headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", token)).unwrap(),
    );
    headers.insert(USER_AGENT, HeaderValue::from_static(APP_USER_AGENT));
    headers
}

fn current_target() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        #[cfg(target_arch = "aarch64")]
        return "darwin-aarch64";
        #[cfg(target_arch = "x86_64")]
        return "darwin-x86_64";
    }
    #[cfg(target_os = "linux")]
    {
        #[cfg(target_arch = "x86_64")]
        return "linux-x86_64";
        #[cfg(target_arch = "aarch64")]
        return "linux-aarch64";
    }
    #[cfg(target_os = "windows")]
    {
        #[cfg(target_arch = "x86_64")]
        return "windows-x86_64";
        #[cfg(target_arch = "aarch64")]
        return "windows-aarch64";
    }
}

/// Fetch update manifest directly from configured endpoint
async fn fetch_manifest_from_endpoint(
    client: &reqwest::Client,
    endpoint: &str,
) -> Result<UpdateManifest, String> {
    let resp = client
        .get(endpoint)
        .header(USER_AGENT, APP_USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch update manifest: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Update endpoint returned status {}: {}",
            resp.status(),
            endpoint
        ));
    }

    resp.json::<UpdateManifest>()
        .await
        .map_err(|e| format!("Failed to parse update manifest: {}", e))
}

/// Fetch the latest GitHub release metadata via the API.
async fn fetch_latest_release(client: &reqwest::Client, token: &str) -> Result<GhRelease, String> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        DEFAULT_REPO_OWNER, DEFAULT_REPO_NAME
    );
    let resp = client
        .get(&url)
        .headers(build_headers(token))
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest release: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "GitHub API returned status {} when fetching latest release",
            resp.status()
        ));
    }

    resp.json::<GhRelease>()
        .await
        .map_err(|e| format!("Failed to parse release JSON: {}", e))
}

/// Download a release asset by its API URL, returning raw bytes.
async fn download_asset(
    client: &reqwest::Client,
    token: &str,
    api_url: &str,
) -> Result<Vec<u8>, String> {
    let mut headers = build_headers(token);
    headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));

    let resp = client
        .get(api_url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("Failed to download asset: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Asset download returned status {}", resp.status()));
    }

    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("Failed to read asset bytes: {}", e))
}

/// Download a release asset with progress events emitted to the frontend.
/// Retries up to MAX_DOWNLOAD_RETRIES times with exponential backoff on network errors.
async fn download_asset_with_progress<R: Runtime>(
    app: &AppHandle<R>,
    client: &reqwest::Client,
    token: &str,
    api_url: &str,
) -> Result<Vec<u8>, String> {
    let mut last_err = String::new();

    for attempt in 0..=MAX_DOWNLOAD_RETRIES {
        if attempt > 0 {
            let delay = RETRY_BASE_DELAY_MS * 2u64.pow(attempt - 1);
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            let _ = app.emit(
                "update-download-progress",
                DownloadProgress {
                    downloaded: 0,
                    content_length: None,
                },
            );
        }

        match try_download_asset(app, client, token, api_url).await {
            Ok(bytes) => return Ok(bytes),
            Err(e) => {
                last_err = e;
                if attempt < MAX_DOWNLOAD_RETRIES {
                    log::warn!(
                        "Asset download attempt {}/{} failed: {}. Retrying...",
                        attempt + 1,
                        MAX_DOWNLOAD_RETRIES + 1,
                        last_err
                    );
                }
            }
        }
    }

    Err(format!(
        "Download failed after {} attempts: {}",
        MAX_DOWNLOAD_RETRIES + 1,
        last_err
    ))
}

/// Single asset download attempt with progress events.
async fn try_download_asset<R: Runtime>(
    app: &AppHandle<R>,
    client: &reqwest::Client,
    token: &str,
    api_url: &str,
) -> Result<Vec<u8>, String> {
    let mut headers = build_headers(token);
    headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));

    let resp = client
        .get(api_url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("Failed to download asset: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Asset download returned status {}", resp.status()));
    }

    let content_length = resp.content_length();
    let mut downloaded: u64 = 0;
    let mut buffer = Vec::new();
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        downloaded += chunk.len() as u64;
        buffer.extend_from_slice(&chunk);

        if downloaded % (100 * 1024) < chunk.len() as u64
            || content_length.map_or(false, |cl| downloaded >= cl)
        {
            let _ = app.emit(
                "update-download-progress",
                DownloadProgress {
                    downloaded,
                    content_length,
                },
            );
        }
    }

    let _ = app.emit(
        "update-download-progress",
        DownloadProgress {
            downloaded,
            content_length,
        },
    );

    Ok(buffer)
}

/// Normalize signature string so minisign_verify can parse it.
/// Handles: CRLF/CR line endings; signature stored as single-line base64 (decode to get 4-line .sig content).
fn normalize_signature(s: &str) -> String {
    let trimmed = s.trim();
    // If it looks like a single line of base64 (no newline, alphanumeric+/=), decode to get .sig text
    if !trimmed.contains('\n') && trimmed.len() > 100 {
        if let Ok(decoded) = STANDARD.decode(trimmed) {
            if let Ok(text) = String::from_utf8(decoded) {
                if text.contains("untrusted comment:") && text.contains("trusted comment:") {
                    return text;
                }
            }
        }
    }
    // Normalize line endings so minisign_verify's .lines() and base64 decode don't see \r
    trimmed
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .to_string()
}

fn verify_signature(data: &[u8], release_signature: &str, pub_key_str: &str) -> Result<(), String> {
    // Decode base64-encoded minisign public key format
    let decoded_key = STANDARD
        .decode(pub_key_str)
        .map_err(|e| format!("Failed to decode base64 public key: {}", e))?;
    let key_string = String::from_utf8(decoded_key)
        .map_err(|e| format!("Invalid UTF-8 in decoded public key: {}", e))?;

    let pub_key =
        PublicKey::decode(&key_string).map_err(|e| format!("Invalid public key: {}", e))?;
    let normalized = normalize_signature(release_signature);
    let signature =
        Signature::decode(&normalized).map_err(|e| format!("Invalid signature: {}", e))?;
    pub_key
        .verify(data, &signature, false)
        .map_err(|e| format!("Signature verification failed: {}", e))
}

/// Extract the .app bundle path from the current executable.
/// e.g. /Applications/TeamClaw.app/Contents/MacOS/TeamClaw -> /Applications/TeamClaw.app
#[cfg(target_os = "macos")]
fn get_app_bundle_path() -> Result<PathBuf, String> {
    let exe = tauri::utils::platform::current_exe()
        .map_err(|e| format!("Cannot get current exe: {}", e))?;
    // exe:        .../TeamClaw.app/Contents/MacOS/TeamClaw
    // parent 1:   .../TeamClaw.app/Contents/MacOS
    // parent 2:   .../TeamClaw.app/Contents
    // parent 3:   .../TeamClaw.app
    exe.parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Cannot determine .app bundle path from executable".to_string())
}

/// Install the update by extracting the tar.gz and replacing the .app bundle (macOS).
#[cfg(target_os = "macos")]
fn install_update(bytes: &[u8]) -> Result<(), String> {
    let app_path = get_app_bundle_path()?;
    let parent_dir = app_path
        .parent()
        .ok_or_else(|| "Cannot determine parent dir of .app bundle".to_string())?;

    // Create a temp dir on the same volume for atomic move
    let tmp_dir = tempfile::Builder::new()
        .prefix("teamclaw-updater-")
        .tempdir_in(parent_dir)
        .map_err(|e| format!("Cannot create temp dir: {}", e))?;

    // Backup current app
    let backup_path = tmp_dir.path().join("backup.app");
    std::fs::rename(&app_path, &backup_path)
        .map_err(|e| format!("Cannot backup current app: {}", e))?;

    // Extract tar.gz
    let archive = Cursor::new(bytes);
    let decoder = GzDecoder::new(archive);
    let mut archive = tar::Archive::new(decoder);

    let result = (|| -> Result<(), String> {
        // We need to find and extract the .app bundle
        // The archive typically contains a top-level .app directory
        archive
            .unpack(parent_dir)
            .map_err(|e| format!("Failed to extract archive: {}", e))?;

        // Verify the app was extracted
        if !app_path.exists() {
            return Err("Extracted archive does not contain the expected .app bundle".to_string());
        }

        Ok(())
    })();

    match result {
        Ok(()) => {
            // Clean up backup
            let _ = std::fs::remove_dir_all(&backup_path);
            Ok(())
        }
        Err(e) => {
            // Restore from backup
            if backup_path.exists() {
                let _ = std::fs::remove_dir_all(&app_path);
                let _ = std::fs::rename(&backup_path, &app_path);
            }
            Err(format!("Installation failed (restored backup): {}", e))
        }
    }
}

// Stub for non-macOS platforms
#[cfg(not(target_os = "macos"))]
fn install_update(_bytes: &[u8]) -> Result<(), String> {
    Err("Auto-update installation is only supported on macOS currently".to_string())
}

/// Maximum number of download retry attempts
const MAX_DOWNLOAD_RETRIES: u32 = 3;
/// Base delay between retries in milliseconds (doubles each attempt)
const RETRY_BASE_DELAY_MS: u64 = 2000;

/// Download file with progress events (for custom endpoint mode).
/// Retries up to MAX_DOWNLOAD_RETRIES times with exponential backoff on network errors.
async fn download_file_with_progress<R: Runtime>(
    app: &AppHandle<R>,
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<u8>, String> {
    let mut last_err = String::new();

    for attempt in 0..=MAX_DOWNLOAD_RETRIES {
        if attempt > 0 {
            let delay = RETRY_BASE_DELAY_MS * 2u64.pow(attempt - 1);
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            // Reset progress so the UI shows the retry starting fresh
            let _ = app.emit(
                "update-download-progress",
                DownloadProgress {
                    downloaded: 0,
                    content_length: None,
                },
            );
        }

        match try_download_file(app, client, url).await {
            Ok(bytes) => return Ok(bytes),
            Err(e) => {
                last_err = e;
                if attempt < MAX_DOWNLOAD_RETRIES {
                    log::warn!(
                        "Download attempt {}/{} failed: {}. Retrying...",
                        attempt + 1,
                        MAX_DOWNLOAD_RETRIES + 1,
                        last_err
                    );
                }
            }
        }
    }

    Err(format!(
        "Download failed after {} attempts: {}",
        MAX_DOWNLOAD_RETRIES + 1,
        last_err
    ))
}

/// Single download attempt with progress events.
async fn try_download_file<R: Runtime>(
    app: &AppHandle<R>,
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .header(USER_AGENT, APP_USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Failed to download file: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Download returned status {}", resp.status()));
    }

    let content_length = resp.content_length();
    let mut downloaded: u64 = 0;
    let mut buffer = Vec::new();
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        downloaded += chunk.len() as u64;
        buffer.extend_from_slice(&chunk);

        if downloaded % (100 * 1024) < chunk.len() as u64
            || content_length.map_or(false, |cl| downloaded >= cl)
        {
            let _ = app.emit(
                "update-download-progress",
                DownloadProgress {
                    downloaded,
                    content_length,
                },
            );
        }
    }

    let _ = app.emit(
        "update-download-progress",
        DownloadProgress {
            downloaded,
            content_length,
        },
    );

    Ok(buffer)
}

// ---------- Tauri Commands ----------

#[tauri::command]
pub async fn check_update<R: Runtime>(app: AppHandle<R>) -> Result<Option<UpdateInfo>, String> {
    let client = reqwest::Client::builder()
        .user_agent(APP_USER_AGENT)
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Cannot create HTTP client: {}", e))?;

    let current_version = app.package_info().version.clone();
    let target = current_target();

    // Check if custom endpoint is configured (from build.config.json)
    let manifest = if let Some(endpoint) = get_updater_endpoint() {
        // Mode 1: Fetch from custom endpoint directly
        fetch_manifest_from_endpoint(&client, endpoint).await?
    } else {
        // Mode 2: Fetch from GitHub API (fallback)
        let token = match get_token() {
            Some(t) if !t.is_empty() => t,
            _ => {
                return Err(
                    "Updater token not configured (GitHub mode requires UPDATER_GITHUB_TOKEN)"
                        .to_string(),
                )
            }
        };

        let release = fetch_latest_release(&client, token).await?;
        let manifest_asset = release
            .assets
            .iter()
            .find(|a| a.name == "latest.json")
            .ok_or_else(|| "No latest.json asset found in the latest release".to_string())?;

        let manifest_bytes = download_asset(&client, token, &manifest_asset.url).await?;
        serde_json::from_slice(&manifest_bytes)
            .map_err(|e| format!("Failed to parse latest.json: {}", e))?
    };

    // Compare versions
    let remote_version = Version::parse(&manifest.version)
        .map_err(|e| format!("Invalid remote version '{}': {}", manifest.version, e))?;

    if remote_version <= current_version {
        return Ok(None); // up to date
    }

    // Find the platform entry
    let platform = manifest
        .platforms
        .get(target)
        .ok_or_else(|| format!("No update available for platform '{}'", target))?;

    // For custom endpoint mode, use the URL directly from manifest
    // For GitHub mode, we need to map to API asset URL
    let download_url = if get_updater_endpoint().is_some() {
        // Custom endpoint: use URL as-is (should be direct download URL)
        platform.url.clone()
    } else {
        // GitHub mode: map web URL to API asset URL
        let token = get_token().unwrap();
        let release = fetch_latest_release(&client, token).await?;
        let binary_filename = platform
            .url
            .rsplit('/')
            .next()
            .ok_or_else(|| "Cannot extract filename from download URL".to_string())?;

        let binary_asset = release
            .assets
            .iter()
            .find(|a| a.name == binary_filename)
            .ok_or_else(|| {
                format!(
                    "Binary asset '{}' not found in release assets",
                    binary_filename
                )
            })?;
        binary_asset.url.clone()
    };

    Ok(Some(UpdateInfo {
        version: manifest.version,
        notes: manifest.notes.unwrap_or_default(),
        download_url,
        signature: platform.signature.clone(),
    }))
}

#[tauri::command]
pub async fn download_and_install_update<R: Runtime>(
    app: AppHandle<R>,
    download_url: String,
    signature: String,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent(APP_USER_AGENT)
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Cannot create HTTP client: {}", e))?;

    // 1. Download the binary with progress reporting
    let bytes = if get_updater_endpoint().is_some() {
        // Custom endpoint mode: direct HTTP download
        download_file_with_progress(&app, &client, &download_url).await?
    } else {
        // GitHub mode: use GitHub API with token
        let token = match get_token() {
            Some(t) if !t.is_empty() => t,
            _ => return Err("Updater token not configured (GitHub mode)".to_string()),
        };
        download_asset_with_progress(&app, &client, token, &download_url).await?
    };

    // 2. Verify signature
    let pubkey = get_updater_pubkey();
    verify_signature(&bytes, &signature, pubkey)?;

    // 3. Snapshot keychain env blob to disk before replacing the app bundle.
    //    The current process still has keychain access (matching code signature).
    //    After the bundle is replaced, the new binary's signature won't match the
    //    keychain ACL, so this disk snapshot is the only way the new version can
    //    recover secrets on first launch.
    super::env_vars::snapshot_env_blob_to_disk();

    // 4. Install (extract tar.gz and replace .app bundle)
    install_update(&bytes)?;

    Ok(())
}

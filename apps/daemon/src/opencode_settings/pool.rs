use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::{Child, Command};
use std::sync::Mutex;
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::Instant;

use super::client::OpenCodeSettingsClient;
use super::OpenCodeSettingsError;

struct SettingsInstance {
    base_url: String,
    child: Child,
    last_used: Instant,
}

/// Manages per-workspace `opencode serve` processes for settings/OAuth only.
pub struct OpenCodeSettingsService {
    opencode_binary: String,
    instances: AsyncMutex<HashMap<String, SettingsInstance>>,
    /// Test hook: fixed base URL per workspace path (wiremock), skips spawn.
    test_fixtures: Mutex<HashMap<String, String>>,
}

impl OpenCodeSettingsService {
    pub fn new(opencode_binary: impl Into<String>) -> Self {
        Self {
            opencode_binary: opencode_binary.into(),
            instances: AsyncMutex::new(HashMap::new()),
            test_fixtures: Mutex::new(HashMap::new()),
        }
    }

    /// Inject a loopback base URL for a workspace (integration tests only).
    pub fn inject_test_base_url(&self, workspace: &Path, base_url: String) {
        self.test_fixtures
            .lock()
            .unwrap()
            .insert(workspace.to_string_lossy().to_string(), base_url);
    }

    pub async fn client_for_workspace(
        &self,
        workspace: &Path,
    ) -> Result<OpenCodeSettingsClient, OpenCodeSettingsError> {
        let key = workspace.to_string_lossy().to_string();

        if let Some(base) = self.test_fixtures.lock().unwrap().get(&key).cloned() {
            return Ok(OpenCodeSettingsClient::new(base, workspace));
        }

        let mut instances = self.instances.lock().await;
        if let Some(entry) = instances.get_mut(&key) {
            entry.last_used = Instant::now();
            return Ok(OpenCodeSettingsClient::new(entry.base_url.clone(), workspace));
        }

        let (base_url, child) = spawn_settings_server(workspace, &self.opencode_binary).await?;
        instances.insert(
            key,
            SettingsInstance {
                base_url: base_url.clone(),
                child,
                last_used: Instant::now(),
            },
        );
        Ok(OpenCodeSettingsClient::new(base_url, workspace))
    }

    /// Stop the loopback settings server for a workspace (e.g. after OAuth writes new auth).
    pub async fn drop_workspace_instance(&self, workspace: &Path) {
        let key = workspace.to_string_lossy().to_string();
        let mut instances = self.instances.lock().await;
        if let Some(mut entry) = instances.remove(&key) {
            let _ = entry.child.kill().await;
        }
    }
}

async fn spawn_settings_server(
    workspace: &Path,
    binary: &str,
) -> Result<(String, Child), OpenCodeSettingsError> {
    if !binary_available(binary) {
        return Err(OpenCodeSettingsError::OpencodeBinaryMissing(binary.to_string()));
    }

    let port = find_available_port().await?;

    let mut cmd = Command::new(binary);
    cmd.arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .current_dir(workspace);
    let mut cmd = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let child = cmd
        .spawn()
        .map_err(|e| OpenCodeSettingsError::SpawnFailed(e.to_string()))?;

    let base_url = format!("http://127.0.0.1:{port}");
    wait_until_ready(&base_url).await?;
    Ok((base_url, child))
}

async fn find_available_port() -> Result<u16, OpenCodeSettingsError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| OpenCodeSettingsError::SpawnFailed(e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| OpenCodeSettingsError::SpawnFailed(e.to_string()))?
        .port();
    Ok(port)
}

async fn wait_until_ready(base_url: &str) -> Result<(), OpenCodeSettingsError> {
    let health_url = format!("{base_url}/session");
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if let Ok(resp) = reqwest::get(&health_url).await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Err(OpenCodeSettingsError::StartTimeout)
}

fn binary_available(binary: &str) -> bool {
    let path = PathBuf::from(binary);
    if path.is_absolute() && path.exists() {
        return true;
    }
    std::process::Command::new("sh")
        .arg("-lc")
        .arg(format!("command -v {}", shell_escape(binary)))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn shell_escape(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-:".contains(c))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

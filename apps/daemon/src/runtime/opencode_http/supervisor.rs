//! Global `opencode serve` process supervisor.
//!
//! One serve instance per daemon (loopback, ephemeral port, HTTP Basic auth
//! via `OPENCODE_SERVER_PASSWORD`). Sessions for every worktree ride on it via
//! the `?directory=` query parameter. Crash recovery is lazy: `ensure()`
//! respawns on the next call (the SSE tasks call it in their reconnect loops,
//! which provides the restart-with-backoff behavior).

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use rand::Rng;
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{info, warn};

use super::client::ServeClient;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_TICK: Duration = Duration::from_millis(200);

struct ServeInstance {
    child: tokio::process::Child,
    client: ServeClient,
}

pub struct ServeSupervisor {
    /// `[agents.opencode].binary` override from daemon.toml, when configured.
    binary_override: parking_lot::Mutex<Option<String>>,
    /// Extra env captured from the first prewarm/attach; applied on (re)spawn.
    extra_env: parking_lot::Mutex<HashMap<String, String>>,
    state: parking_lot::Mutex<Option<ServeInstance>>,
    /// Serializes spawn attempts without holding `state` across awaits.
    spawn_lock: tokio::sync::Mutex<()>,
    password: String,
}

fn generate_password() -> String {
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| {
            const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            CHARS[rng.gen_range(0..CHARS.len())] as char
        })
        .collect()
}

fn pick_free_port() -> crate::error::Result<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| crate::error::AmuxError::Agent(format!("pick serve port: {e}")))
}

impl ServeSupervisor {
    pub fn new() -> Self {
        Self {
            binary_override: parking_lot::Mutex::new(None),
            extra_env: parking_lot::Mutex::new(HashMap::new()),
            state: parking_lot::Mutex::new(None),
            spawn_lock: tokio::sync::Mutex::new(()),
            password: generate_password(),
        }
    }

    /// Record the configured opencode binary (from `AgentLaunchConfig`).
    /// `"claude"` (the serde default) counts as unconfigured.
    pub fn set_binary_hint(&self, binary: &str) {
        if !binary.is_empty() && binary != "claude" && binary != "opencode" {
            *self.binary_override.lock() = Some(binary.to_string());
        }
    }

    /// Merge session env into the env applied at (re)spawn. The serve process
    /// is global, so this is best-effort first-wins per key.
    pub fn merge_extra_env(&self, extra_env: &HashMap<String, String>) {
        if extra_env.is_empty() {
            return;
        }
        let mut env = self.extra_env.lock();
        for (k, v) in extra_env {
            env.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }

    /// True when a serve child is currently tracked and alive.
    pub fn is_running(&self) -> bool {
        let mut guard = self.state.lock();
        match guard.as_mut() {
            Some(inst) => match inst.child.try_wait() {
                Ok(None) => true,
                _ => {
                    *guard = None;
                    false
                }
            },
            None => false,
        }
    }

    /// Kill the current serve process (next `ensure()` respawns). Used after
    /// provider auth/config changes. Returns true when a process was running.
    pub fn shutdown(&self) -> bool {
        let taken = self.state.lock().take();
        match taken {
            Some(mut inst) => {
                let _ = inst.child.start_kill();
                info!("opencode serve process shut down");
                true
            }
            None => false,
        }
    }

    /// Ensure the global serve instance is up; returns a client for it.
    pub async fn ensure(&self) -> crate::error::Result<ServeClient> {
        if let Some(client) = self.client_if_running() {
            return Ok(client);
        }
        let _guard = self.spawn_lock.lock().await;
        if let Some(client) = self.client_if_running() {
            return Ok(client);
        }
        self.spawn().await
    }

    fn client_if_running(&self) -> Option<ServeClient> {
        let mut guard = self.state.lock();
        let inst = guard.as_mut()?;
        match inst.child.try_wait() {
            Ok(None) => Some(inst.client.clone()),
            other => {
                warn!(exit = ?other, "opencode serve process is gone; will respawn");
                *guard = None;
                None
            }
        }
    }

    async fn spawn(&self) -> crate::error::Result<ServeClient> {
        let configured = self.binary_override.lock().clone();
        let binary = crate::opencode_install::resolve_binary(configured.as_deref());
        let port = pick_free_port()?;
        let base = format!("http://127.0.0.1:{port}");

        let mut cmd = tokio::process::Command::new(&binary);
        cmd.arg("serve")
            .arg("--port")
            .arg(port.to_string())
            .arg("--hostname")
            .arg("127.0.0.1");
        cmd.env(
            "PATH",
            super::enriched_spawn_path(
                std::env::var("PATH").ok().as_deref(),
                std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .map(PathBuf::from)
                    .as_deref(),
            ),
        );
        cmd.env("OPENCODE_SERVER_PASSWORD", &self.password);
        for (k, v) in self.extra_env.lock().iter() {
            if std::env::var_os(k).is_none() {
                cmd.env(k, v);
            }
        }
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        info!(binary = %binary, port, "spawning global opencode serve");
        let mut child = cmd.spawn().map_err(|e| {
            crate::error::AmuxError::Agent(format!("spawn opencode serve ({binary}): {e}"))
        })?;

        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(target: "opencode_serve", "{line}");
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    warn!(target: "opencode_serve", "{line}");
                }
            });
        }

        let client = ServeClient::new(base.clone(), self.password.clone());
        let started = Instant::now();
        loop {
            if client.health().await {
                break;
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(crate::error::AmuxError::Agent(format!(
                    "opencode serve exited during startup: {status}"
                )));
            }
            if started.elapsed() > HEALTH_TIMEOUT {
                let _ = child.start_kill();
                return Err(crate::error::AmuxError::Agent(
                    "opencode serve health check timed out".into(),
                ));
            }
            tokio::time::sleep(HEALTH_TICK).await;
        }
        info!(base = %base, ready_ms = started.elapsed().as_millis() as u64, "opencode serve ready");

        *self.state.lock() = Some(ServeInstance {
            child,
            client: client.clone(),
        });
        Ok(client)
    }
}

impl Default for ServeSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

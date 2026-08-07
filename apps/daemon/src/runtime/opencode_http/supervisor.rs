//! Global `opencode serve` process supervisor.
//!
//! One serve instance per daemon (loopback, ephemeral port, HTTP Basic auth
//! via `OPENCODE_SERVER_PASSWORD`). Sessions for every worktree ride on it via
//! the `?directory=` query parameter. Crash recovery is lazy: `ensure()`
//! respawns on the next call (the SSE tasks call it in their reconnect loops,
//! which provides the restart-with-backoff behavior).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use rand::Rng;
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{info, warn};

use super::client::ServeClient;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_TICK: Duration = Duration::from_millis(200);
/// Wait for `opencode serve` (+ MCP children in its process group) after SIGTERM.
const STOP_GRACE: Duration = Duration::from_millis(500);

struct ServeInstance {
    child: tokio::process::Child,
    client: ServeClient,
}

pub struct ServeSupervisor {
    /// `[agents.opencode].binary` override from daemon.toml, when configured.
    binary_override: parking_lot::Mutex<Option<String>>,
    /// Extra env captured from the first prewarm/attach; applied on (re)spawn.
    extra_env: parking_lot::Mutex<HashMap<String, String>>,
    /// Fingerprint of the complete env queued for the next spawn.
    configured_env_fingerprint: parking_lot::Mutex<Option<String>>,
    /// Fingerprint actually inherited by the currently running serve process.
    active_env_fingerprint: parking_lot::Mutex<Option<String>>,
    /// Most recently resolved fingerprint per canonical workspace.
    requested_env_fingerprints: parking_lot::Mutex<HashMap<String, String>>,
    /// Workspace whose snapshot could not replace the active global host.
    snapshot_conflict_workspaces: parking_lot::Mutex<HashSet<String>>,
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
            configured_env_fingerprint: parking_lot::Mutex::new(None),
            active_env_fingerprint: parking_lot::Mutex::new(None),
            requested_env_fingerprints: parking_lot::Mutex::new(HashMap::new()),
            snapshot_conflict_workspaces: parking_lot::Mutex::new(HashSet::new()),
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
    /// is global; when `force` is false, existing cached keys are kept
    /// (first-wins). When `force` is true, incoming values overwrite.
    pub fn merge_extra_env(&self, extra_env: &HashMap<String, String>, force: bool) {
        if extra_env.is_empty() {
            return;
        }
        let mut env = self.extra_env.lock();
        for (k, v) in extra_env {
            if force {
                env.insert(k.clone(), v.clone());
            } else {
                env.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        *self.configured_env_fingerprint.lock() = Some(
            teamclaw_runtime_env::resolved_env::fingerprint_bindings(&env),
        );
    }

    /// Record and atomically queue a complete workspace env snapshot.
    ///
    /// Unlike [`Self::merge_extra_env`], this removes keys absent from the new
    /// snapshot, preventing values from an earlier workspace leaking into the
    /// next serve spawn.
    pub fn install_env_snapshot(
        &self,
        workspace: &str,
        extra_env: HashMap<String, String>,
    ) -> String {
        let fingerprint = teamclaw_runtime_env::resolved_env::fingerprint_bindings(&extra_env);
        self.record_requested_env_fingerprint(workspace, &fingerprint);
        *self.extra_env.lock() = extra_env;
        *self.configured_env_fingerprint.lock() = Some(fingerprint.clone());
        fingerprint
    }

    pub fn record_requested_env_fingerprint(&self, workspace: &str, fingerprint: &str) {
        self.requested_env_fingerprints
            .lock()
            .insert(workspace.to_string(), fingerprint.to_string());
    }

    pub fn requested_env_fingerprint(&self, workspace: &str) -> Option<String> {
        self.requested_env_fingerprints
            .lock()
            .get(workspace)
            .cloned()
    }

    pub fn active_env_fingerprint(&self) -> Option<String> {
        self.active_env_fingerprint.lock().clone()
    }

    /// Test seam: pretend a serve child inherited `fingerprint` without spawning.
    #[cfg(test)]
    pub(crate) fn set_active_env_fingerprint_for_test(&self, fingerprint: Option<String>) {
        *self.active_env_fingerprint.lock() = fingerprint;
    }

    /// Fingerprint queued for the next spawn (`install_env_snapshot` / merge).
    pub fn configured_env_fingerprint(&self) -> Option<String> {
        self.configured_env_fingerprint.lock().clone()
    }

    /// True when a running serve still holds an older env than the queued snapshot.
    ///
    /// Used after the last route detaches so we can recycle the process without
    /// discarding the queued bindings (see #779).
    pub fn has_pending_env_refresh(&self) -> bool {
        match (
            self.configured_env_fingerprint.lock().clone(),
            self.active_env_fingerprint.lock().clone(),
        ) {
            (Some(configured), Some(active)) => configured != active,
            _ => false,
        }
    }

    /// Stop the serve process group but keep the queued env for the next spawn.
    ///
    /// Unlike [`Self::shutdown`], this does **not** call [`Self::clear_extra_env`].
    /// Returns whether a child was running.
    pub fn shutdown_preserving_configured_env(&self) -> bool {
        let taken = self.state.lock().take();
        *self.active_env_fingerprint.lock() = None;
        match taken {
            Some(mut inst) => {
                kill_serve_tree(&mut inst.child);
                info!("opencode serve shut down to apply pending env snapshot");
                true
            }
            None => false,
        }
    }

    /// When no routes remain and a newer env is queued, recycle the serve child
    /// so the next `ensure()` inherits the configured snapshot.
    pub fn apply_pending_env_if_idle(&self, routes_empty: bool) -> bool {
        if !routes_empty || !self.has_pending_env_refresh() {
            return false;
        }
        let _ = self.shutdown_preserving_configured_env();
        true
    }

    pub fn env_snapshot_requires_restart(&self, incoming_fingerprint: &str) -> bool {
        self.is_running() && self.active_env_fingerprint().as_deref() != Some(incoming_fingerprint)
    }

    pub fn mark_snapshot_conflict(&self, workspace: &str) {
        self.snapshot_conflict_workspaces
            .lock()
            .insert(workspace.to_string());
    }

    pub fn clear_snapshot_conflict(&self, workspace: &str) {
        self.snapshot_conflict_workspaces.lock().remove(workspace);
    }

    pub fn snapshot_conflict_workspace(&self, workspace: &str) -> Option<String> {
        if !self.snapshot_conflict_workspaces.lock().contains(workspace) {
            return None;
        }
        let requested = self.requested_env_fingerprint(workspace);
        let active = self.active_env_fingerprint();
        (requested.is_some() && active.is_some() && requested != active)
            .then(|| workspace.to_string())
    }

    /// Drop cached env so the next serve spawn does not inherit stale keys.
    pub fn clear_extra_env(&self) {
        self.extra_env.lock().clear();
        *self.configured_env_fingerprint.lock() = None;
        *self.active_env_fingerprint.lock() = None;
    }

    /// Count of env keys queued for the next serve spawn (no values exposed).
    pub fn cached_env_key_count(&self) -> usize {
        self.extra_env.lock().len()
    }

    /// Key names queued for the next serve spawn (sorted, no values exposed).
    pub fn cached_env_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.extra_env.lock().keys().cloned().collect();
        keys.sort_by(|left, right| left.to_ascii_lowercase().cmp(&right.to_ascii_lowercase()));
        keys
    }

    /// True when a serve child is currently tracked and alive.
    pub fn is_running(&self) -> bool {
        let mut guard = self.state.lock();
        match guard.as_mut() {
            Some(inst) => match inst.child.try_wait() {
                Ok(None) => true,
                _ => {
                    *guard = None;
                    *self.active_env_fingerprint.lock() = None;
                    clear_opencode_pgid();
                    false
                }
            },
            None => false,
        }
    }

    /// Kill the current serve process group (serve + MCP children). Next
    /// `ensure()` respawns. Used on daemon stop and after provider auth/config
    /// changes. Returns true when a process was running.
    pub fn shutdown(&self) -> bool {
        let taken = self.state.lock().take();
        // Cached env is queued for the NEXT spawn, so it must go whether or not
        // a child was alive to kill. Clearing it only in the `Some` arm left
        // stale keys behind exactly when `evict_agent_types` runs against an
        // already-dead serve — the case that eviction exists to recover from.
        self.clear_extra_env();
        match taken {
            Some(mut inst) => {
                kill_serve_tree(&mut inst.child);
                info!("opencode serve process group shut down");
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
                *self.active_env_fingerprint.lock() = None;
                clear_opencode_pgid();
                None
            }
        }
    }

    async fn spawn(&self) -> crate::error::Result<ServeClient> {
        let configured = self.binary_override.lock().clone();
        let binary = crate::opencode_install::resolve_binary(configured.as_deref());
        // Capture one immutable env snapshot for this child. Configuration may
        // change while health-checking; the active fingerprint must describe
        // what the process actually inherited, not whatever is queued later.
        let spawn_env = self.extra_env.lock().clone();
        let spawn_env_fingerprint =
            teamclaw_runtime_env::resolved_env::fingerprint_bindings(&spawn_env);
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
        for (k, v) in &spawn_env {
            if std::env::var_os(k).is_none() {
                cmd.env(k, v);
            }
        }
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        // Own process group so shutdown can SIGTERM/SIGKILL the whole tree
        // (serve + MCP children like remote-tools-mcp), not just the leader.
        #[cfg(unix)]
        {
            cmd.process_group(0);
        }

        // If a prior kill_serve_tree left survivors (and kept the pgid file),
        // reap that group before we overwrite the file with the new leader.
        // Local helper — must not call `crate::cli` (integration tests compile
        // runtime without the cli module).
        reap_kept_opencode_pgid_before_spawn();

        info!(binary = %binary, port, "spawning global opencode serve");
        let mut child = cmd.spawn().map_err(|e| {
            crate::error::AmuxError::Agent(format!("spawn opencode serve ({binary}): {e}"))
        })?;
        if let Some(pid) = child.id() {
            write_opencode_pgid(pid);
        }

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
                clear_opencode_pgid();
                return Err(crate::error::AmuxError::Agent(format!(
                    "opencode serve exited during startup: {status}"
                )));
            }
            if started.elapsed() > HEALTH_TIMEOUT {
                kill_serve_tree(&mut child);
                return Err(crate::error::AmuxError::Agent(
                    "opencode serve health check timed out".into(),
                ));
            }
            tokio::time::sleep(HEALTH_TICK).await;
        }
        info!(base = %base, ready_ms = started.elapsed().as_millis() as u64, "opencode serve ready");

        *self.active_env_fingerprint.lock() = Some(spawn_env_fingerprint);
        *self.state.lock() = Some(ServeInstance {
            child,
            client: client.clone(),
        });
        Ok(client)
    }
}

/// SIGTERM the serve process group, wait briefly, then SIGKILL the group.
/// Children (MCP servers) inherit the group from `setpgid(0,0)` at spawn.
///
/// The pgid file is only removed once the *whole group* is confirmed dead —
/// a reaped leader with surviving MCP children must keep the file so
/// `amuxd stop` or the next `spawn()` (`reap_kept_opencode_pgid_before_spawn`) can
/// still find them.
fn kill_serve_tree(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            let pgid = pid as i32;
            unsafe {
                let _ = libc::kill(-pgid, libc::SIGTERM);
            }
            let mut leader_reaped = false;
            let deadline = Instant::now() + STOP_GRACE;
            loop {
                if !leader_reaped {
                    match child.try_wait() {
                        Ok(Some(_)) => leader_reaped = true,
                        Ok(None) => {}
                        Err(_) => break,
                    }
                }
                if leader_reaped && !process_group_alive(pgid) {
                    clear_opencode_pgid();
                    return;
                }
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            unsafe {
                let _ = libc::kill(-pgid, libc::SIGKILL);
            }
            let _ = child.start_kill();
            let _ = child.try_wait();
            // Give the kernel a moment to tear the group down after SIGKILL.
            let kill_deadline = Instant::now() + Duration::from_millis(300);
            while Instant::now() < kill_deadline && process_group_alive(pgid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            if process_group_alive(pgid) {
                // Keep the pgid file: `amuxd stop` / next start can still reap.
                warn!(
                    pgid,
                    "opencode serve group survived SIGKILL; keeping pgid file"
                );
            } else {
                clear_opencode_pgid();
            }
            return;
        }
        // No pid (already reaped by a previous wait): just clean up the handle.
        let _ = child.start_kill();
        let _ = child.try_wait();
        clear_opencode_pgid();
    }
    #[cfg(windows)]
    {
        // taskkill /T terminates the whole child tree (serve + MCP children);
        // Child::start_kill alone would only hit the leader.
        if let Some(pid) = child.id() {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
        }
        let _ = child.start_kill();
        let _ = child.try_wait();
        clear_opencode_pgid();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = child.start_kill();
        let _ = child.try_wait();
        clear_opencode_pgid();
    }
}

/// Reap a process group recorded in the pgid file before writing a new one.
/// Kept intentionally inside this module so integration tests (which compile
/// `runtime` without `cli`) still build.
fn reap_kept_opencode_pgid_before_spawn() {
    #[cfg(unix)]
    {
        let path = crate::config::DaemonConfig::opencode_serve_pgid_path();
        let Ok(body) = std::fs::read_to_string(&path) else {
            return;
        };
        let Ok(pgid) = body.trim().parse::<i32>() else {
            let _ = std::fs::remove_file(&path);
            return;
        };
        if pgid <= 1 {
            let _ = std::fs::remove_file(&path);
            return;
        }
        if process_group_alive(pgid) {
            warn!(pgid, "reaping leftover opencode serve group before respawn");
            unsafe {
                let _ = libc::kill(-pgid, libc::SIGTERM);
            }
            let deadline = Instant::now() + Duration::from_millis(500);
            while Instant::now() < deadline && process_group_alive(pgid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            if process_group_alive(pgid) {
                unsafe {
                    let _ = libc::kill(-pgid, libc::SIGKILL);
                }
                let kill_deadline = Instant::now() + Duration::from_millis(300);
                while Instant::now() < kill_deadline && process_group_alive(pgid) {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
        clear_opencode_pgid();
    }
    #[cfg(windows)]
    {
        let path = crate::config::DaemonConfig::opencode_serve_pgid_path();
        let Ok(body) = std::fs::read_to_string(&path) else {
            return;
        };
        let Ok(pid) = body.trim().parse::<u32>() else {
            let _ = std::fs::remove_file(&path);
            return;
        };
        if pid > 0 {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
        }
        clear_opencode_pgid();
    }
}

/// `kill(-pgid, 0)` succeeds while any member of the group exists.
#[cfg(unix)]
fn process_group_alive(pgid: i32) -> bool {
    if pgid <= 1 {
        return false;
    }
    unsafe { libc::kill(-pgid, 0) == 0 }
}

fn write_opencode_pgid(pid: u32) {
    let path = crate::config::DaemonConfig::opencode_serve_pgid_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, pid.to_string()) {
        warn!(error = %e, path = %path.display(), "failed to write opencode serve pgid");
    }
}

fn clear_opencode_pgid() {
    let path = crate::config::DaemonConfig::opencode_serve_pgid_path();
    let _ = std::fs::remove_file(path);
}

impl Default for ServeSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_extra_env_force_overwrites_existing_keys() {
        let serve = ServeSupervisor::new();
        let mut first = HashMap::new();
        first.insert("API_KEY".to_string(), "old".to_string());
        serve.merge_extra_env(&first, false);

        let mut second = HashMap::new();
        second.insert("API_KEY".to_string(), "new".to_string());
        serve.merge_extra_env(&second, false);
        assert_eq!(serve.cached_env_key_count(), 1);

        serve.merge_extra_env(&second, true);
        assert_eq!(serve.cached_env_key_count(), 1);
    }

    #[test]
    fn cached_env_keys_returns_sorted_key_names() {
        let serve = ServeSupervisor::new();
        let mut env = HashMap::new();
        env.insert("Z_KEY".to_string(), "z".to_string());
        env.insert("a_key".to_string(), "a".to_string());
        serve.merge_extra_env(&env, false);
        assert_eq!(
            serve.cached_env_keys(),
            vec!["a_key".to_string(), "Z_KEY".to_string()]
        );
    }

    #[test]
    fn shutdown_clears_cached_env() {
        let serve = ServeSupervisor::new();
        let mut env = HashMap::new();
        env.insert("FOO".to_string(), "bar".to_string());
        serve.merge_extra_env(&env, true);
        assert_eq!(serve.cached_env_key_count(), 1);
        assert!(!serve.shutdown());
        assert_eq!(serve.cached_env_key_count(), 0);
    }

    #[test]
    fn install_snapshot_replaces_stale_keys_and_tracks_workspace() {
        let serve = ServeSupervisor::new();
        serve.install_env_snapshot(
            "/workspace-a",
            HashMap::from([
                ("ONLY_A".to_string(), "a".to_string()),
                ("SHARED".to_string(), "old".to_string()),
            ]),
        );

        let fingerprint = serve.install_env_snapshot(
            "/workspace-b",
            HashMap::from([("SHARED".to_string(), "new".to_string())]),
        );

        assert_eq!(serve.cached_env_key_count(), 1);
        assert_eq!(
            serve.requested_env_fingerprint("/workspace-b"),
            Some(fingerprint)
        );
    }

    #[test]
    fn configured_env_fingerprint_is_readable_after_install() {
        let serve = ServeSupervisor::new();
        let fingerprint = serve.install_env_snapshot(
            "/workspace-a",
            HashMap::from([("KEY".to_string(), "value".to_string())]),
        );
        assert_eq!(
            serve.configured_env_fingerprint().as_deref(),
            Some(fingerprint.as_str())
        );
    }

    #[test]
    fn pending_env_refresh_when_configured_differs_from_active() {
        let serve = ServeSupervisor::new();
        let active = serve.install_env_snapshot(
            "/workspace-a",
            HashMap::from([("KEY".to_string(), "old".to_string())]),
        );
        *serve.active_env_fingerprint.lock() = Some(active);
        assert!(!serve.has_pending_env_refresh());

        serve.install_env_snapshot(
            "/workspace-a",
            HashMap::from([("KEY".to_string(), "new".to_string())]),
        );
        assert!(serve.has_pending_env_refresh());
    }

    #[test]
    fn shutdown_preserving_configured_env_keeps_queued_snapshot() {
        let serve = ServeSupervisor::new();
        let fingerprint = serve.install_env_snapshot(
            "/workspace-a",
            HashMap::from([("KEY".to_string(), "new".to_string())]),
        );
        *serve.active_env_fingerprint.lock() = Some("stale-active".to_string());
        assert!(serve.has_pending_env_refresh());

        assert!(!serve.shutdown_preserving_configured_env());
        assert_eq!(serve.cached_env_key_count(), 1);
        assert_eq!(
            serve.configured_env_fingerprint().as_deref(),
            Some(fingerprint.as_str())
        );
        assert!(serve.active_env_fingerprint().is_none());
        assert!(!serve.has_pending_env_refresh());
    }

    #[test]
    fn apply_pending_env_if_idle_only_when_routes_empty_and_pending() {
        let serve = ServeSupervisor::new();
        serve.install_env_snapshot(
            "/workspace-a",
            HashMap::from([("KEY".to_string(), "new".to_string())]),
        );
        *serve.active_env_fingerprint.lock() = Some("stale-active".to_string());

        assert!(!serve.apply_pending_env_if_idle(false));
        assert!(serve.has_pending_env_refresh());
        assert_eq!(serve.cached_env_key_count(), 1);

        assert!(serve.apply_pending_env_if_idle(true));
        assert!(!serve.has_pending_env_refresh());
        assert_eq!(serve.cached_env_key_count(), 1);
        assert!(serve.active_env_fingerprint().is_none());
    }

    #[test]
    fn snapshot_conflict_is_non_secret_workspace_metadata() {
        let serve = ServeSupervisor::new();
        serve.record_requested_env_fingerprint("/workspace-b", "fingerprint-b");
        serve.record_requested_env_fingerprint("/workspace-c", "fingerprint-c");
        *serve.active_env_fingerprint.lock() = Some("fingerprint-a".to_string());
        serve.mark_snapshot_conflict("/workspace-b");
        serve.mark_snapshot_conflict("/workspace-c");
        assert_eq!(
            serve.snapshot_conflict_workspace("/workspace-b").as_deref(),
            Some("/workspace-b")
        );
        serve.clear_snapshot_conflict("/workspace-b");
        assert!(serve.snapshot_conflict_workspace("/workspace-b").is_none());
        assert_eq!(
            serve.snapshot_conflict_workspace("/workspace-c").as_deref(),
            Some("/workspace-c")
        );
    }

    #[test]
    fn host_switch_preserves_other_workspace_conflicts() {
        let serve = ServeSupervisor::new();
        serve.record_requested_env_fingerprint("/workspace-b", "fingerprint-b");
        serve.record_requested_env_fingerprint("/workspace-c", "fingerprint-c");
        *serve.active_env_fingerprint.lock() = Some("fingerprint-a".to_string());
        serve.mark_snapshot_conflict("/workspace-b");
        serve.mark_snapshot_conflict("/workspace-c");

        serve.shutdown();
        assert!(serve.snapshot_conflict_workspace("/workspace-c").is_none());

        *serve.active_env_fingerprint.lock() = Some("fingerprint-b".to_string());
        assert!(serve.snapshot_conflict_workspace("/workspace-b").is_none());
        assert_eq!(
            serve.snapshot_conflict_workspace("/workspace-c").as_deref(),
            Some("/workspace-c")
        );
    }
}

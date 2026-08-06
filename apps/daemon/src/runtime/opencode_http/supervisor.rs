//! Pool of `opencode serve` child processes, keyed by resolved runtime env.
//!
//! Sessions for every worktree ride on a serve instance via the `?directory=`
//! query parameter, so one child can host many workspaces. The runtime env
//! (personal + team secrets, the team LLM gateway handoff) is a different
//! matter: it is inherited at spawn and is process-wide, with no per-request
//! scope. Two workspaces that resolve to *different* envs therefore cannot
//! share a child — doing so would either hand the second workspace the first
//! one's secrets or leak team A's secrets into team B's agent process.
//!
//! Rather than refuse the second workspace, this supervisor keeps one child per
//! distinct env. Workspaces resolving to the same env — the common case, and
//! every case on a single-team device — still share one process, so the cold
//! start the single-instance design was built to avoid is only paid when the
//! envs genuinely differ. The pool is capped (`agents.max_serve_instances`,
//! default [`DEFAULT_MAX_INSTANCES`]) because a serve child costs ~250 MB of
//! physical footprint that instances barely share; idle instances are evicted
//! to make room, and [`ServeSupervisor::reap_unused`] drops instances once
//! their sessions drain, always keeping one warm.
//!
//! Instances are keyed by the fingerprint of the env *actually applied* to the
//! child rather than the requested snapshot: the spawn leaves keys the daemon's
//! own environment already defines alone (see [`applied_env`]), so two
//! snapshots differing only in host-shadowed keys are the same process.
//!
//! Crash recovery is lazy: `ensure_*` respawns on the next call (the SSE tasks
//! call it in their reconnect loops, which provides restart-with-backoff).

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

/// Default ceiling on concurrently running serve children, overridden by
/// `agents.max_serve_instances` in `daemon.toml`.
///
/// Two, not more, because a serve child measures ~250 MB of physical footprint
/// and instances share almost none of it — a second one costs nearly as much as
/// the first. A single-team device never reaches even this, since every one of
/// its workspaces resolves to the same env and shares one child.
const DEFAULT_MAX_INSTANCES: usize = 2;

/// How long [`ServeSupervisor::ensure_for_workspace`] waits for a slot when the
/// pool is at its ceiling and every instance is serving live sessions.
/// Waiting beats the old behavior (fail the spawn outright) because the common
/// blocker is another workspace's turn, which finishes on its own.
const POOL_FULL_WAIT: Duration = Duration::from_secs(30);
const POOL_FULL_TICK: Duration = Duration::from_millis(500);

struct ServeInstance {
    child: tokio::process::Child,
    client: ServeClient,
    /// Process-group leader pid, for the pgid file and orphan reaping.
    pid: Option<u32>,
    last_used: Instant,
}

/// The runtime env resolved for one canonical workspace.
#[derive(Clone)]
struct WorkspaceEnv {
    /// Fingerprint of the snapshot as resolved. Diagnostics compare against
    /// this (it describes what the workspace asked for), not the pool key.
    requested: String,
    /// Env a child actually receives, and its fingerprint — the pool key.
    applied: HashMap<String, String>,
    applied_fingerprint: String,
}

pub struct ServeSupervisor {
    /// `[agents.opencode].binary` override from daemon.toml, when configured.
    binary_override: parking_lot::Mutex<Option<String>>,
    /// applied-env fingerprint -> running child.
    instances: parking_lot::Mutex<HashMap<String, ServeInstance>>,
    /// canonical workspace -> the env snapshot most recently installed for it.
    workspace_env: parking_lot::Mutex<HashMap<String, WorkspaceEnv>>,
    /// Pool keys currently serving at least one live session. Maintained by
    /// [`ServeSupervisor::reap_unused`]; these are never evicted for room.
    live_keys: parking_lot::Mutex<HashSet<String>>,
    /// Workspaces that could not be given a process (pool full, all busy).
    snapshot_conflict_workspaces: parking_lot::Mutex<HashSet<String>>,
    /// Most recent workspace to install a snapshot, for [`ServeSupervisor::ensure_any`].
    last_installed: parking_lot::Mutex<Option<String>>,
    /// Serializes spawn attempts without holding `instances` across awaits.
    spawn_lock: tokio::sync::Mutex<()>,
    /// Pool ceiling, from `agents.max_serve_instances`. Atomic rather than a
    /// constructor argument so a config reload can move it without rebuilding
    /// the pool and killing live sessions.
    max_instances: std::sync::atomic::AtomicUsize,
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

/// The subset of `snapshot` a child actually receives.
///
/// [`ServeSupervisor::spawn`] leaves keys the daemon's own environment already
/// defines alone (first-wins against the host), so those values never reach
/// opencode. Keying the pool on the applied subset keeps the key an honest
/// description of the child and stops two snapshots that differ only in
/// host-shadowed keys from being handed separate processes. The shadowing
/// itself is surfaced to the user as the `host_env_shadowed` diagnostics
/// blocker.
fn applied_env(snapshot: &HashMap<String, String>) -> HashMap<String, String> {
    snapshot
        .iter()
        .filter(|(key, _)| std::env::var_os(key).is_none())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// Which instance to evict to make pool room: the least recently used one not
/// serving live sessions. `None` when every instance is busy.
///
/// Pure, and separate from the pool, because getting it wrong kills an agent
/// mid-turn while the pool itself owns real child processes a unit test cannot
/// fabricate.
fn evict_candidate<'a>(
    instances: impl IntoIterator<Item = (&'a str, Instant)>,
    live_keys: &HashSet<String>,
) -> Option<String> {
    instances
        .into_iter()
        .filter(|(key, _)| !live_keys.contains(*key))
        .min_by_key(|(_, last_used)| *last_used)
        .map(|(key, _)| key.to_string())
}

/// Instances to reap once sessions drain, oldest first. Only idle instances are
/// candidates, and the total never drops below one, so the next session on this
/// device still skips a cold start.
fn reap_candidates<'a>(
    instances: impl IntoIterator<Item = (&'a str, Instant)>,
    live_keys: &HashSet<String>,
    total: usize,
) -> Vec<String> {
    let mut candidates: Vec<(&str, Instant)> = instances
        .into_iter()
        .filter(|(key, _)| !live_keys.contains(*key))
        .collect();
    candidates.sort_by_key(|(_, last_used)| *last_used);
    candidates.truncate(total.saturating_sub(1));
    candidates
        .into_iter()
        .map(|(key, _)| key.to_string())
        .collect()
}

impl ServeSupervisor {
    pub fn new() -> Self {
        Self {
            binary_override: parking_lot::Mutex::new(None),
            instances: parking_lot::Mutex::new(HashMap::new()),
            workspace_env: parking_lot::Mutex::new(HashMap::new()),
            live_keys: parking_lot::Mutex::new(HashSet::new()),
            snapshot_conflict_workspaces: parking_lot::Mutex::new(HashSet::new()),
            last_installed: parking_lot::Mutex::new(None),
            spawn_lock: tokio::sync::Mutex::new(()),
            max_instances: std::sync::atomic::AtomicUsize::new(DEFAULT_MAX_INSTANCES),
            password: generate_password(),
        }
    }

    /// Apply the configured pool ceiling (`agents.max_serve_instances`).
    ///
    /// Clamped to at least one: a zero ceiling would make every attach wait out
    /// [`POOL_FULL_WAIT`] and then fail, which is not a configuration anyone
    /// means to express.
    pub fn set_max_instances(&self, max_instances: usize) {
        self.max_instances
            .store(max_instances.max(1), std::sync::atomic::Ordering::Relaxed);
    }

    fn max_instances(&self) -> usize {
        self.max_instances
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Record the configured opencode binary (from `AgentLaunchConfig`).
    /// `"claude"` (the serde default) counts as unconfigured.
    pub fn set_binary_hint(&self, binary: &str) {
        if !binary.is_empty() && binary != "claude" && binary != "opencode" {
            *self.binary_override.lock() = Some(binary.to_string());
        }
    }

    /// Record the complete env snapshot resolved for `workspace` and return the
    /// pool key it maps to.
    ///
    /// This replaces the whole snapshot rather than merging, so values from an
    /// earlier resolution cannot leak forward. Installing does not touch any
    /// running child: a workspace whose env changed simply routes to a
    /// different pool key from here on, and the old instance lives until its
    /// remaining sessions drain.
    pub fn install_env_snapshot(
        &self,
        workspace: &str,
        extra_env: HashMap<String, String>,
    ) -> String {
        let requested = teamclaw_runtime_env::resolved_env::fingerprint_bindings(&extra_env);
        let applied = applied_env(&extra_env);
        let applied_fingerprint =
            teamclaw_runtime_env::resolved_env::fingerprint_bindings(&applied);
        self.workspace_env.lock().insert(
            workspace.to_string(),
            WorkspaceEnv {
                requested,
                applied,
                applied_fingerprint: applied_fingerprint.clone(),
            },
        );
        *self.last_installed.lock() = Some(workspace.to_string());
        applied_fingerprint
    }

    /// Fingerprint of the snapshot most recently resolved for `workspace`.
    pub fn requested_env_fingerprint(&self, workspace: &str) -> Option<String> {
        self.workspace_env
            .lock()
            .get(workspace)
            .map(|env| env.requested.clone())
    }

    /// Fingerprint of the env `workspace` is *currently running on* — i.e. its
    /// requested fingerprint, but only once a child for that env is actually
    /// alive. `None` while the snapshot is still pending activation.
    pub fn active_env_fingerprint_for_workspace(&self, workspace: &str) -> Option<String> {
        let env = self.workspace_env.lock().get(workspace).cloned()?;
        self.instances
            .lock()
            .contains_key(&env.applied_fingerprint)
            .then_some(env.requested)
    }

    /// Env key names queued for `workspace` (sorted, no values exposed).
    pub fn installed_env_keys(&self, workspace: &str) -> Vec<String> {
        let mut keys: Vec<String> = match self.workspace_env.lock().get(workspace) {
            Some(env) => env.applied.keys().cloned().collect(),
            None => return Vec::new(),
        };
        keys.sort_by(|left, right| left.to_ascii_lowercase().cmp(&right.to_ascii_lowercase()));
        keys
    }

    /// Count of env keys queued for `workspace` (no values exposed).
    pub fn installed_env_key_count(&self, workspace: &str) -> usize {
        self.workspace_env
            .lock()
            .get(workspace)
            .map_or(0, |env| env.applied.len())
    }

    pub fn mark_snapshot_conflict(&self, workspace: &str) {
        self.snapshot_conflict_workspaces
            .lock()
            .insert(workspace.to_string());
    }

    pub fn clear_snapshot_conflict(&self, workspace: &str) {
        self.snapshot_conflict_workspaces.lock().remove(workspace);
    }

    /// `Some(workspace)` while `workspace` is still waiting for a process it
    /// could not get. Cleared as soon as it attaches successfully.
    pub fn snapshot_conflict_workspace(&self, workspace: &str) -> Option<String> {
        if !self.snapshot_conflict_workspaces.lock().contains(workspace) {
            return None;
        }
        self.active_env_fingerprint_for_workspace(workspace)
            .is_none()
            .then(|| workspace.to_string())
    }

    /// True when at least one serve child is currently tracked and alive.
    pub fn is_running(&self) -> bool {
        self.instance_count() > 0
    }

    /// Number of live serve children.
    pub fn instance_count(&self) -> usize {
        let dead: Vec<String> = {
            let mut instances = self.instances.lock();
            let mut dead = Vec::new();
            for (key, inst) in instances.iter_mut() {
                if !matches!(inst.child.try_wait(), Ok(None)) {
                    dead.push(key.clone());
                }
            }
            for key in &dead {
                instances.remove(key);
            }
            dead
        };
        if !dead.is_empty() {
            self.rewrite_pgid_file();
        }
        self.instances.lock().len()
    }

    /// Kill every serve process group. Next `ensure_*` respawns. Used on daemon
    /// stop and after provider auth/config changes. Returns true when at least
    /// one process was running.
    ///
    /// Workspace env snapshots survive: they describe resolved configuration,
    /// not process state, and each attach replaces its workspace's entry
    /// wholesale anyway.
    pub fn shutdown(&self) -> bool {
        let taken: Vec<ServeInstance> = self.instances.lock().drain().map(|(_, v)| v).collect();
        self.live_keys.lock().clear();
        let killed = !taken.is_empty();
        for mut inst in taken {
            kill_serve_tree(&mut inst.child);
        }
        if killed {
            info!("opencode serve process groups shut down");
        }
        clear_pgid_file();
        killed
    }

    /// Tell the pool which canonical worktrees currently have live sessions, so
    /// [`Self::try_make_room`] never evicts an instance that is serving one.
    /// Call after every route change, not only on detach: an instance that just
    /// took on its first session is otherwise indistinguishable from an idle
    /// one.
    pub fn set_live_directories(&self, live_directories: &HashSet<String>) -> HashSet<String> {
        let live_keys: HashSet<String> = {
            let workspaces = self.workspace_env.lock();
            live_directories
                .iter()
                .filter_map(|dir| {
                    workspaces
                        .get(dir)
                        .map(|env| env.applied_fingerprint.clone())
                })
                .collect()
        };
        *self.live_keys.lock() = live_keys.clone();
        live_keys
    }

    /// True when `workspace`'s env already has an instance, or one can start
    /// without evicting anything. Prewarm checks this so warming many
    /// workspaces never thrashes the pool: a workspace that would need an
    /// eviction keeps its installed snapshot and spawns lazily on first attach.
    pub fn has_idle_capacity_for(&self, workspace: &str) -> bool {
        let key = self
            .workspace_env
            .lock()
            .get(workspace)
            .map(|env| env.applied_fingerprint.clone());
        let instances = self.instances.lock();
        match key {
            Some(key) if instances.contains_key(&key) => true,
            _ => instances.len() < self.max_instances(),
        }
    }

    /// Drop instances that no longer serve any of `live_directories`, keeping
    /// the most recently used one warm so the next session skips a cold start.
    /// Called after a session detaches. Returns how many were reaped.
    pub fn reap_unused(&self, live_directories: &HashSet<String>) -> usize {
        let live_keys = self.set_live_directories(live_directories);

        let mut victims = Vec::new();
        {
            let mut instances = self.instances.lock();
            let total = instances.len();
            let doomed = reap_candidates(
                instances
                    .iter()
                    .map(|(key, inst)| (key.as_str(), inst.last_used)),
                &live_keys,
                total,
            );
            for key in doomed {
                if let Some(inst) = instances.remove(&key) {
                    victims.push((key, inst));
                }
            }
        }
        let reaped = victims.len();
        for (key, mut inst) in victims {
            info!(key = %key, "reaping idle opencode serve instance");
            kill_serve_tree(&mut inst.child);
        }
        if reaped > 0 {
            self.rewrite_pgid_file();
        }
        reaped
    }

    /// Ensure a serve child running `workspace`'s env is up; returns a client.
    ///
    /// A workspace with no installed snapshot (settings/OAuth against a
    /// workspace that never ran a session) rides an existing instance rather
    /// than spawning an env-less one.
    pub async fn ensure_for_workspace(&self, workspace: &str) -> crate::error::Result<ServeClient> {
        // Bind first so the `workspace_env` guard is provably released before
        // the fallback runs — `ensure_any` takes the same (non-reentrant) lock.
        let installed = self.workspace_env.lock().get(workspace).cloned();
        let Some(env) = installed else {
            return self.ensure_any().await;
        };
        self.ensure_for_key(&env.applied_fingerprint, &env.applied)
            .await
    }

    /// A client for any live instance, for callers with no workspace in hand
    /// (prewarm without a worktree, the `amuxd test-spawn` CLI). Prefers the
    /// most recently used instance; otherwise spawns one on the last installed
    /// snapshot, or an env-less child if nothing has been installed yet.
    pub async fn ensure_any(&self) -> crate::error::Result<ServeClient> {
        if let Some(client) = self.most_recently_used_client() {
            return Ok(client);
        }
        let last_installed = self.last_installed.lock().clone();
        let fallback = last_installed.and_then(|ws| self.workspace_env.lock().get(&ws).cloned());
        match fallback {
            Some(env) => {
                self.ensure_for_key(&env.applied_fingerprint, &env.applied)
                    .await
            }
            None => {
                let empty = HashMap::new();
                let key = teamclaw_runtime_env::resolved_env::fingerprint_bindings(&empty);
                self.ensure_for_key(&key, &empty).await
            }
        }
    }

    /// A client for an already-running instance serving `workspace`, without
    /// spawning one.
    pub fn client_for_workspace(&self, workspace: &str) -> Option<ServeClient> {
        let env = self.workspace_env.lock().get(workspace).cloned()?;
        self.client_if_running(&env.applied_fingerprint)
    }

    async fn ensure_for_key(
        &self,
        key: &str,
        env: &HashMap<String, String>,
    ) -> crate::error::Result<ServeClient> {
        if let Some(client) = self.client_if_running(key) {
            return Ok(client);
        }
        let deadline = Instant::now() + POOL_FULL_WAIT;
        loop {
            {
                let _guard = self.spawn_lock.lock().await;
                if let Some(client) = self.client_if_running(key) {
                    return Ok(client);
                }
                if self.try_make_room(key) {
                    return self.spawn(key, env).await;
                }
            }
            if Instant::now() >= deadline {
                let max = self.max_instances();
                return Err(crate::error::AmuxError::Agent(format!(
                    "opencode serve pool is full ({max} instances, all serving active sessions) \
                     and this workspace needs a different environment; finish or stop another \
                     workspace's task, or raise agents.max_serve_instances in daemon.toml"
                )));
            }
            tokio::time::sleep(POOL_FULL_TICK).await;
        }
    }

    fn client_if_running(&self, key: &str) -> Option<ServeClient> {
        let mut died = false;
        let client = {
            let mut instances = self.instances.lock();
            match instances.get_mut(key) {
                Some(inst) => match inst.child.try_wait() {
                    Ok(None) => {
                        inst.last_used = Instant::now();
                        Some(inst.client.clone())
                    }
                    other => {
                        warn!(exit = ?other, "opencode serve process is gone; will respawn");
                        instances.remove(key);
                        died = true;
                        None
                    }
                },
                None => None,
            }
        };
        if died {
            self.rewrite_pgid_file();
        }
        client
    }

    fn most_recently_used_client(&self) -> Option<ServeClient> {
        let key = {
            let instances = self.instances.lock();
            instances
                .iter()
                .max_by_key(|(_, inst)| inst.last_used)
                .map(|(key, _)| key.clone())?
        };
        self.client_if_running(&key)
    }

    /// Ensure the pool has room for `key`, evicting the least recently used
    /// instance that is not serving live sessions. False when the pool is at
    /// its ceiling and every instance is busy.
    fn try_make_room(&self, key: &str) -> bool {
        let live_keys = self.live_keys.lock().clone();
        let max_instances = self.max_instances();
        let victim = {
            let instances = self.instances.lock();
            if instances.contains_key(key) || instances.len() < max_instances {
                return true;
            }
            evict_candidate(
                instances
                    .iter()
                    .map(|(candidate, inst)| (candidate.as_str(), inst.last_used)),
                &live_keys,
            )
        };
        let Some(victim) = victim else {
            return false;
        };
        let evicted = self.instances.lock().remove(&victim);
        if let Some(mut inst) = evicted {
            info!(key = %victim, "evicting idle opencode serve instance to make pool room");
            kill_serve_tree(&mut inst.child);
            self.rewrite_pgid_file();
        }
        true
    }

    async fn spawn(
        &self,
        key: &str,
        spawn_env: &HashMap<String, String>,
    ) -> crate::error::Result<ServeClient> {
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
        // `spawn_env` is already the applied subset (host-shadowed keys removed
        // by `applied_env`), so every entry here really does reach the child —
        // which is what makes `key` an honest description of this process.
        for (k, v) in spawn_env {
            cmd.env(k, v);
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

        // If a prior kill_serve_tree left survivors (and kept their pgid in the
        // file), reap those groups before we rewrite it. Only groups no live
        // instance owns are touched.
        self.reap_orphan_pgids();

        info!(binary = %binary, port, key, "spawning opencode serve");
        let mut child = cmd.spawn().map_err(|e| {
            crate::error::AmuxError::Agent(format!("spawn opencode serve ({binary}): {e}"))
        })?;
        let pid = child.id();

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
                kill_serve_tree(&mut child);
                return Err(crate::error::AmuxError::Agent(
                    "opencode serve health check timed out".into(),
                ));
            }
            tokio::time::sleep(HEALTH_TICK).await;
        }
        info!(base = %base, key, ready_ms = started.elapsed().as_millis() as u64, "opencode serve ready");

        self.instances.lock().insert(
            key.to_string(),
            ServeInstance {
                child,
                client: client.clone(),
                pid,
                last_used: Instant::now(),
            },
        );
        self.rewrite_pgid_file();
        Ok(client)
    }

    /// Rewrite the pgid file to exactly the live instances' group leaders.
    fn rewrite_pgid_file(&self) {
        let pids: Vec<u32> = {
            let instances = self.instances.lock();
            instances.values().filter_map(|inst| inst.pid).collect()
        };
        write_pgid_file(&pids);
    }

    /// SIGTERM/SIGKILL any process group recorded in the pgid file that no live
    /// instance owns — survivors of an earlier `kill_serve_tree`.
    fn reap_orphan_pgids(&self) {
        let owned: HashSet<u32> = {
            let instances = self.instances.lock();
            instances.values().filter_map(|inst| inst.pid).collect()
        };
        for pgid in read_pgid_file() {
            if owned.contains(&pgid) {
                continue;
            }
            reap_pgid(pgid);
        }
        self.rewrite_pgid_file();
    }
}

/// SIGTERM the serve process group, wait briefly, then SIGKILL the group.
/// Children (MCP servers) inherit the group from `setpgid(0,0)` at spawn.
///
/// A group that survives SIGKILL keeps its pgid in the file (rewritten by the
/// caller only from live instances, so the survivor is re-read as an orphan and
/// reaped by `amuxd stop` or the next `spawn`).
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
                warn!(
                    pgid,
                    "opencode serve group survived SIGKILL; leaving it for orphan reaping"
                );
            }
            return;
        }
        // No pid (already reaped by a previous wait): just clean up the handle.
        let _ = child.start_kill();
        let _ = child.try_wait();
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
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = child.start_kill();
        let _ = child.try_wait();
    }
}

/// Terminate one recorded process group. Kept inside this module so integration
/// tests (which compile `runtime` without `cli`) still build.
fn reap_pgid(pgid: u32) {
    #[cfg(unix)]
    {
        let pgid = pgid as i32;
        if pgid <= 1 || !process_group_alive(pgid) {
            return;
        }
        warn!(pgid, "reaping leftover opencode serve group");
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
    #[cfg(windows)]
    {
        if pgid > 0 {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pgid.to_string(), "/T", "/F"])
                .output();
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pgid;
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

/// Process-group leaders recorded in the pgid file, one per line.
fn read_pgid_file() -> Vec<u32> {
    let path = crate::config::DaemonConfig::opencode_serve_pgid_path();
    let Ok(body) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    body.lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .filter(|pid| *pid > 1)
        .collect()
}

fn write_pgid_file(pids: &[u32]) {
    let path = crate::config::DaemonConfig::opencode_serve_pgid_path();
    if pids.is_empty() {
        let _ = std::fs::remove_file(&path);
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = pids
        .iter()
        .map(|pid| pid.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    if let Err(e) = std::fs::write(&path, body) {
        warn!(error = %e, path = %path.display(), "failed to write opencode serve pgid file");
    }
}

fn clear_pgid_file() {
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

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn install_snapshot_replaces_stale_keys_per_workspace() {
        let serve = ServeSupervisor::new();
        serve.install_env_snapshot(
            "/workspace-a",
            env(&[("TC_TEST_ONLY_A", "a"), ("TC_TEST_SHARED", "old")]),
        );
        serve.install_env_snapshot("/workspace-a", env(&[("TC_TEST_SHARED", "new")]));

        assert_eq!(
            serve.installed_env_keys("/workspace-a"),
            vec!["TC_TEST_SHARED".to_string()],
            "a re-resolved snapshot must replace the previous one, not merge into it"
        );
    }

    /// The regression this pool exists for: a second workspace resolving a
    /// different env must get its own pool key rather than colliding with the
    /// first one's. Under the old single-instance supervisor this pair produced
    /// `env_snapshot_conflict`.
    #[test]
    fn differing_workspaces_map_to_distinct_pool_keys() {
        let serve = ServeSupervisor::new();
        let key_a = serve.install_env_snapshot("/workspace-a", env(&[("TC_TEST_TOKEN", "a")]));
        let key_b = serve.install_env_snapshot("/workspace-b", env(&[("TC_TEST_TOKEN", "b")]));
        assert_ne!(key_a, key_b);
        assert_eq!(
            serve.requested_env_fingerprint("/workspace-a"),
            serve.requested_env_fingerprint("/workspace-a")
        );
        assert_ne!(
            serve.requested_env_fingerprint("/workspace-a"),
            serve.requested_env_fingerprint("/workspace-b")
        );
    }

    /// Two workspaces whose snapshots differ only in a key the daemon's own
    /// environment shadows never reach opencode differently, so they must share
    /// one child instead of being handed separate processes.
    #[test]
    fn host_shadowed_keys_do_not_split_the_pool() {
        std::env::set_var("TC_TEST_HOST_SHADOWED", "from-host");
        let serve = ServeSupervisor::new();
        let key_a = serve.install_env_snapshot(
            "/workspace-a",
            env(&[("TC_TEST_HOST_SHADOWED", "a"), ("TC_TEST_REAL", "same")]),
        );
        let key_b = serve.install_env_snapshot(
            "/workspace-b",
            env(&[("TC_TEST_HOST_SHADOWED", "b"), ("TC_TEST_REAL", "same")]),
        );
        std::env::remove_var("TC_TEST_HOST_SHADOWED");
        assert_eq!(
            key_a, key_b,
            "the shadowed key never reaches the child, so both workspaces are one process"
        );
        assert_ne!(
            serve.requested_env_fingerprint("/workspace-a"),
            serve.requested_env_fingerprint("/workspace-b"),
            "diagnostics still report what each workspace asked for"
        );
    }

    /// A workspace is only "active" once a child running its env exists — with
    /// no instances up, a freshly installed snapshot is pending, not active.
    #[test]
    fn snapshot_is_pending_until_an_instance_runs() {
        let serve = ServeSupervisor::new();
        serve.install_env_snapshot("/workspace-a", env(&[("TC_TEST_TOKEN", "a")]));
        assert!(serve
            .active_env_fingerprint_for_workspace("/workspace-a")
            .is_none());
        assert!(!serve.is_running());
    }

    #[test]
    fn conflict_clears_once_the_workspace_activates() {
        let serve = ServeSupervisor::new();
        serve.install_env_snapshot("/workspace-b", env(&[("TC_TEST_TOKEN", "b")]));
        serve.mark_snapshot_conflict("/workspace-b");
        assert_eq!(
            serve.snapshot_conflict_workspace("/workspace-b").as_deref(),
            Some("/workspace-b")
        );
        serve.clear_snapshot_conflict("/workspace-b");
        assert!(serve.snapshot_conflict_workspace("/workspace-b").is_none());
    }

    #[test]
    fn reaping_with_no_instances_is_a_no_op() {
        let serve = ServeSupervisor::new();
        serve.install_env_snapshot("/workspace-a", env(&[("TC_TEST_TOKEN", "a")]));
        assert_eq!(serve.reap_unused(&HashSet::new()), 0);
    }

    fn live(keys: &[&str]) -> HashSet<String> {
        keys.iter().map(|k| (*k).to_string()).collect()
    }

    /// Keys with ascending `last_used`, so the first entry is the oldest.
    fn aged(keys: &[&str]) -> Vec<(String, Instant)> {
        let base = Instant::now();
        keys.iter()
            .enumerate()
            .map(|(index, key)| ((*key).to_string(), base + Duration::from_secs(index as u64)))
            .collect()
    }

    fn entries(aged: &[(String, Instant)]) -> impl Iterator<Item = (&str, Instant)> {
        aged.iter().map(|(key, at)| (key.as_str(), *at))
    }

    #[test]
    fn eviction_picks_the_least_recently_used_idle_instance() {
        let instances = aged(&["oldest", "middle", "newest"]);
        assert_eq!(
            evict_candidate(entries(&instances), &live(&[])).as_deref(),
            Some("oldest")
        );
    }

    /// The failure this guards is fatal: evicting an instance that is serving a
    /// session kills that agent mid-turn.
    #[test]
    fn eviction_never_touches_an_instance_serving_live_sessions() {
        let instances = aged(&["oldest", "middle", "newest"]);
        assert_eq!(
            evict_candidate(entries(&instances), &live(&["oldest"])).as_deref(),
            Some("middle"),
            "the oldest is busy, so the next-oldest idle one goes instead"
        );
        assert!(
            evict_candidate(entries(&instances), &live(&["oldest", "middle", "newest"])).is_none(),
            "with every instance busy there is nothing to evict — the caller must wait"
        );
    }

    #[test]
    fn reaping_leaves_one_instance_warm() {
        let instances = aged(&["oldest", "middle", "newest"]);
        let reaped = reap_candidates(entries(&instances), &live(&[]), instances.len());
        assert_eq!(
            reaped,
            vec!["oldest".to_string(), "middle".to_string()],
            "all three are idle, but one stays so the next session skips a cold start"
        );
    }

    #[test]
    fn reaping_keeps_every_live_instance() {
        let instances = aged(&["oldest", "middle", "newest"]);
        let reaped = reap_candidates(
            entries(&instances),
            &live(&["middle", "newest"]),
            instances.len(),
        );
        assert_eq!(reaped, vec!["oldest".to_string()]);
    }

    #[test]
    fn reaping_a_lone_idle_instance_keeps_it() {
        let instances = aged(&["only"]);
        assert!(reap_candidates(entries(&instances), &live(&[]), 1).is_empty());
    }

    /// A zero ceiling would make every attach wait out `POOL_FULL_WAIT` and
    /// then fail — never what a config author means.
    #[test]
    fn max_instances_is_clamped_to_at_least_one() {
        let serve = ServeSupervisor::new();
        assert_eq!(serve.max_instances(), DEFAULT_MAX_INSTANCES);
        serve.set_max_instances(0);
        assert_eq!(serve.max_instances(), 1);
        serve.set_max_instances(6);
        assert_eq!(serve.max_instances(), 6);
    }

    /// With no instance running, capacity is governed by the ceiling, so a
    /// misconfigured zero must not report "no room" for the very first spawn.
    #[test]
    fn a_fresh_pool_has_capacity_for_any_workspace() {
        let serve = ServeSupervisor::new();
        serve.set_max_instances(0);
        serve.install_env_snapshot("/workspace-a", env(&[("TC_TEST_TOKEN", "a")]));
        assert!(serve.has_idle_capacity_for("/workspace-a"));
    }
}

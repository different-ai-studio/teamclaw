//! Per-worktree pi process pool.
//!
//! One child per (isolation domain, process-env revision, canonical worktree).
//! Two modes:
//!
//! - **Host** (default): `node <cache>/pi/host/host.mjs` — the TeamClu
//!   multi-session host over the pi SDK. One process holds N concurrent
//!   `AgentSession`s; commands and events carry a `sessionId`. This is what
//!   makes several TeamClu sessions on one worktree run in parallel instead of
//!   failing with "pi is mid-turn on another session".
//! - **LegacyRpc**: `pi --mode rpc`, the single-active-session protocol. Used
//!   when the pi install has no importable npm package (e.g. a Bun single
//!   binary), or when `[agents.pi] session_host = "rpc"` forces it.
//!
//! Sessions persist under `<state>/pi-sessions/<worktree-hash>/` via
//! `--session-dir` — keyed by worktree only, NOT by pool key, so a session
//! survives env changes and daemon restarts. Crash recovery is lazy: a dead
//! child is respawned on the next `ensure()` (attach / prompt).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{info, warn};

use crate::runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};

use super::client::PiClient;
use super::{events, Shared};

/// Soft cap on sessions held open inside one host process. Above it, the
/// least recently used idle session is `close_session`d before a new one is
/// opened; its route stays and the next prompt reopens it from its jsonl.
pub(crate) const MAX_OPEN_SESSIONS_PER_HOST: usize = 8;

/// Process pool key: the same three coordinates the opencode host pool
/// isolates on. Previously pi pooled on `worktree` alone with pool-global env
/// (first-wins per key), so workspace A's env stuck to the process and B could
/// never override it. Keying the pool on domain + env revision makes an env
/// change a *different process* instead of a silent leak.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct PoolKey {
    pub(crate) domain: IsolationDomainKey,
    pub(crate) env_revision: ProcessEnvRevision,
    /// Canonical worktree path.
    pub(crate) worktree: String,
}

/// Spawn-affecting environment for one pool key. Carried by the caller on
/// every `ensure_with_env` (attach / workspace prewarm) and remembered per key
/// so a crash respawn (`ensure`) can rebuild the same process.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct SpawnEnv {
    pub(crate) extra_env: HashMap<String, String>,
    pub(crate) force_env_override: bool,
    /// `TEAMCLU_REMOTE_TOOLS_CMD` (JSON array string) from the session's mcp
    /// config.
    pub(crate) remote_tools_cmd: Option<String>,
    /// `TEAMCLU_MCP_SERVERS` (JSON object string) — the workspace's other
    /// enabled local MCP servers, bridged into pi by the extension.
    pub(crate) mcp_servers: Option<String>,
}

/// How a spawned child speaks to us.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PiSessionMode {
    /// TeamClu multi-session host (`host.mjs`): commands/events carry
    /// `sessionId`, N sessions run concurrently.
    Host,
    /// `pi --mode rpc`: one active session, `switch_session` between them,
    /// guarded because switching destroys a live turn.
    LegacyRpc,
}

/// A live pi child for one pool key.
pub(crate) struct PiProcess {
    pub(crate) client: PiClient,
    pub(crate) mode: PiSessionMode,
    /// Fresh per spawn; reported as `host_generation_id` in startup metadata
    /// so "same worktree, respawned process" is observable.
    pub(crate) generation_id: String,
    /// Host mode: acp session id → last use. The set of sessions currently
    /// open inside the host (bounded by [`MAX_OPEN_SESSIONS_PER_HOST`]).
    pub(crate) open_sessions: parking_lot::Mutex<HashMap<String, Instant>>,
    /// LegacyRpc only: the acp session id currently active in this process.
    pub(crate) active_acp_session: parking_lot::Mutex<Option<String>>,
    /// LegacyRpc only. Held across "ask pi whether it is busy, then switch".
    /// Those are two round trips, and without the lock a second caller can
    /// pass the busy check with the answer the first one already invalidated.
    pub(crate) switch_lock: tokio::sync::Mutex<()>,
    child: parking_lot::Mutex<tokio::process::Child>,
    /// Fingerprint of what this child was spawned with (binary + mode + env).
    /// `ensure` respawns when it no longer matches the wanted spawn.
    env_fingerprint: String,
    /// Set by every deliberate `kill()` (eviction, env-change respawn,
    /// shutdown). The stdout-EOF handler reads it to tell a crash — worth a
    /// respawn + `get_entries` backfill — from a child that was told to die
    /// and must stay dead.
    retired: std::sync::atomic::AtomicBool,
}

impl PiProcess {
    pub(crate) fn is_alive(&self) -> bool {
        matches!(self.child.lock().try_wait(), Ok(None))
    }

    pub(crate) fn kill(&self) {
        self.retired
            .store(true, std::sync::atomic::Ordering::Release);
        let _ = self.child.lock().start_kill();
    }

    pub(crate) fn is_retired(&self) -> bool {
        self.retired.load(std::sync::atomic::Ordering::Acquire)
    }
}

/// Pool of pi children keyed by [`PoolKey`].
pub(crate) struct PiProcessPool {
    procs: parking_lot::Mutex<HashMap<PoolKey, Arc<PiProcess>>>,
    /// Last spawn env per key — what a crash respawn uses.
    envs: parking_lot::Mutex<HashMap<PoolKey, SpawnEnv>>,
    /// `[agents.pi].binary` override from daemon config, when configured.
    binary_override: parking_lot::Mutex<Option<String>>,
}

impl PiProcessPool {
    pub(crate) fn new() -> Self {
        Self {
            procs: parking_lot::Mutex::new(HashMap::new()),
            envs: parking_lot::Mutex::new(HashMap::new()),
            binary_override: parking_lot::Mutex::new(None),
        }
    }

    /// Record the configured pi binary (from `AgentLaunchConfig`). The serde
    /// default `"claude"` and the plain names count as unconfigured.
    pub(crate) fn set_binary_hint(&self, binary: &str) {
        if !binary.is_empty() && binary != "claude" && binary != "pi" && binary != "opencode" {
            *self.binary_override.lock() = Some(binary.to_string());
        }
    }

    /// Fingerprint of a wanted spawn: binary + resolved mode + env. A live
    /// child whose fingerprint differs is replaced by `ensure`.
    fn spawn_fingerprint(&self, env: &SpawnEnv, launch: &ResolvedLaunch) -> String {
        let mode = match &launch.mode {
            LaunchMode::Host { node, package_root } => format!(
                "host:{}:{}",
                node.to_string_lossy(),
                package_root.to_string_lossy()
            ),
            LaunchMode::LegacyRpc => "rpc".to_string(),
        };
        let remote = env.remote_tools_cmd.clone().unwrap_or_default();
        let servers = env.mcp_servers.clone().unwrap_or_default();
        // Sort extra env for a stable fingerprint regardless of map order.
        let mut extra: Vec<String> = env
            .extra_env
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        extra.sort();
        format!(
            "bin={}\x1fmode={mode}\x1fforce={}\x1fremote={remote}\x1fservers={servers}\x1fextra={}",
            launch.binary,
            env.force_env_override,
            extra.join("\x1e")
        )
    }

    pub(crate) fn get(&self, key: &PoolKey) -> Option<Arc<PiProcess>> {
        let mut procs = self.procs.lock();
        match procs.get(key) {
            Some(p) if p.is_alive() => Some(Arc::clone(p)),
            Some(_) => {
                procs.remove(key);
                None
            }
            None => None,
        }
    }

    /// Number of live children.
    pub(crate) fn live_count(&self) -> usize {
        self.procs.lock().values().filter(|p| p.is_alive()).count()
    }

    /// Any live child (used for the model catalog fallback).
    pub(crate) fn any_live(&self) -> Option<Arc<PiProcess>> {
        self.procs
            .lock()
            .values()
            .find(|p| p.is_alive())
            .map(Arc::clone)
    }

    /// Kill and drop all children. Returns the number that were alive.
    pub(crate) fn kill_all(&self) -> usize {
        // Spawn envs deliberately survive: a session prompting after an
        // eviction respawns its child through `ensure()`, which must still
        // carry the key's secrets/MCP payload.
        let procs: Vec<Arc<PiProcess>> = self.procs.lock().drain().map(|(_, p)| p).collect();
        let mut killed = 0;
        for p in procs {
            if p.is_alive() {
                p.kill();
                killed += 1;
            }
        }
        killed
    }

    /// Kill and drop the children of one isolation domain. Precise eviction:
    /// invalidating workspace A must not take down workspace B's sessions.
    pub(crate) fn kill_domain(&self, domain: &IsolationDomainKey) -> usize {
        let victims: Vec<(PoolKey, Arc<PiProcess>)> = {
            let mut procs = self.procs.lock();
            let keys: Vec<PoolKey> = procs
                .keys()
                .filter(|k| &k.domain == domain)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|k| procs.remove(&k).map(|p| (k, p)))
                .collect()
        };
        let mut killed = 0;
        for (_key, p) in victims {
            if p.is_alive() {
                p.kill();
                killed += 1;
            }
        }
        killed
    }

    /// Ensure a live child for `key`, recording `env` as the key's spawn env.
    pub(crate) fn ensure_with_env(
        &self,
        shared: &Arc<Shared>,
        key: &PoolKey,
        env: SpawnEnv,
    ) -> crate::error::Result<Arc<PiProcess>> {
        self.envs.lock().insert(key.clone(), env);
        self.ensure(shared, key)
    }

    /// Ensure a live child for `key` using its recorded spawn env (empty when
    /// the key has never attached — e.g. a catalog probe).
    pub(crate) fn ensure(
        &self,
        shared: &Arc<Shared>,
        key: &PoolKey,
    ) -> crate::error::Result<Arc<PiProcess>> {
        let env = self.envs.lock().get(key).cloned().unwrap_or_default();
        let launch = self.resolve_launch();
        let want = self.spawn_fingerprint(&env, &launch);
        if let Some(p) = self.get(key) {
            if p.env_fingerprint == want {
                return Ok(p);
            }
            // Env or mode changed since this child spawned (e.g. a prewarmed
            // child that predates the session's MCP servers/secrets) — replace.
            info!(worktree = %key.worktree, "pi env changed; respawning");
            p.kill();
            self.procs.lock().remove(key);
        }
        let proc = self.spawn(shared, key, &env, &launch, want)?;
        self.procs.lock().insert(key.clone(), Arc::clone(&proc));
        Ok(proc)
    }

    /// Resolve what to spawn: binary + host/legacy mode. Read fresh per spawn
    /// so a config flip (`[agents.pi] session_host`) or a pi upgrade takes
    /// effect on the next respawn without a daemon restart.
    fn resolve_launch(&self) -> ResolvedLaunch {
        let configured = self.binary_override.lock().clone();
        let binary = resolve_binary(configured.as_deref());
        let mode = match session_host_preference() {
            SessionHostPreference::LegacyRpc => {
                info!("pi session_host = rpc (configured); using legacy single-session mode");
                LaunchMode::LegacyRpc
            }
            SessionHostPreference::Host => match resolve_host_launch(&binary) {
                Some(host) => LaunchMode::Host {
                    node: host.node,
                    package_root: host.package_root,
                },
                None => {
                    // Bun single binary or unreadable install: no npm package
                    // to import, so the multi-session host cannot run. Fall
                    // back to the single-session protocol rather than failing.
                    warn!(
                        binary = %binary,
                        "pi npm package root not resolvable; falling back to single-session --mode rpc"
                    );
                    LaunchMode::LegacyRpc
                }
            },
        };
        ResolvedLaunch { binary, mode }
    }

    fn spawn(
        &self,
        shared: &Arc<Shared>,
        key: &PoolKey,
        env: &SpawnEnv,
        launch: &ResolvedLaunch,
        fingerprint: String,
    ) -> crate::error::Result<Arc<PiProcess>> {
        let worktree = key.worktree.as_str();
        let session_dir = session_dir_for(worktree);
        if let Err(e) = std::fs::create_dir_all(&session_dir) {
            warn!(dir = %session_dir.display(), error = %e, "pi session dir create failed");
        }

        let extension = match materialize_extension() {
            Ok(ext) => Some(ext),
            Err(e) => {
                warn!(error = %e, "pi extension materialize failed; permission gate off");
                None
            }
        };

        let (program, mode) = match &launch.mode {
            LaunchMode::Host { node, package_root } => {
                let host_script = materialize_host_script().map_err(|e| {
                    crate::error::AmuxError::Agent(format!("pi host script materialize: {e}"))
                })?;
                let mut cmd = tokio::process::Command::new(node);
                cmd.arg(&host_script)
                    .arg("--pi-package")
                    .arg(package_root)
                    .arg("--cwd")
                    .arg(worktree)
                    .arg("--session-dir")
                    .arg(&session_dir);
                if let Some(ext) = &extension {
                    cmd.arg("--extension").arg(ext);
                }
                (cmd, PiSessionMode::Host)
            }
            LaunchMode::LegacyRpc => {
                let mut cmd = tokio::process::Command::new(&launch.binary);
                cmd.arg("--mode")
                    .arg("rpc")
                    .arg("--session-dir")
                    .arg(&session_dir);
                if let Some(ext) = &extension {
                    cmd.arg("-e").arg(ext);
                }
                (cmd, PiSessionMode::LegacyRpc)
            }
        };
        let mut cmd = program;
        cmd.current_dir(worktree);

        // TeamClu extension env contract: permission gate + MCP bridges.
        let perms_file = permissions_file_for(worktree);
        if let Err(e) = write_default_permissions_if_absent(&perms_file) {
            warn!(path = %perms_file.display(), error = %e, "pi permissions file init failed");
        }
        cmd.env("TEAMCLU_PI_PERMISSIONS_FILE", &perms_file);
        if let Some(remote_cmd) = &env.remote_tools_cmd {
            cmd.env("TEAMCLU_REMOTE_TOOLS_CMD", remote_cmd);
        }
        if let Some(servers) = &env.mcp_servers {
            cmd.env("TEAMCLU_MCP_SERVERS", servers);
        }
        // Same file `mcp_servers_from_opencode_json` read to build the payload.
        // The extension watches it so an edit re-bridges in place; the env
        // payload alone only ever reflects spawn time.
        cmd.env(
            "TEAMCLU_MCP_CONFIG_PATH",
            Path::new(worktree).join("opencode.json"),
        );
        let tool_cache = mcp_tool_cache_dir();
        if let Err(e) = std::fs::create_dir_all(&tool_cache) {
            warn!(path = %tool_cache.display(), error = %e, "pi MCP tool cache dir unavailable");
        } else {
            cmd.env("TEAMCLU_MCP_TOOL_CACHE_DIR", &tool_cache);
        }
        // Enriched PATH: node shims (`#!/usr/bin/env node`) and the MCP bridge
        // children all resolve through the child's own PATH.
        cmd.env(
            "PATH",
            crate::runtime::opencode_http::enriched_spawn_path(
                std::env::var("PATH").ok().as_deref(),
                dirs::home_dir().as_deref(),
            ),
        );
        for (k, v) in env.extra_env.iter() {
            if env.force_env_override || std::env::var_os(k).is_none() {
                cmd.env(k, v);
            }
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        info!(
            binary = %launch.binary,
            mode = ?mode,
            worktree,
            session_dir = %session_dir.display(),
            "spawning pi child"
        );
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                crate::error::agent_binary_missing(
                    "pi",
                    format_args!("pi launcher ({}) not found", launch.binary),
                )
            } else {
                crate::error::AmuxError::Agent(format!("spawn pi ({}): {e}", launch.binary))
            }
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| crate::error::AmuxError::Agent("pi stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| crate::error::AmuxError::Agent("pi stdout unavailable".into()))?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    warn!(target: "pi_rpc", "{line}");
                }
            });
        }

        let client = PiClient::new(stdin);
        let proc = Arc::new(PiProcess {
            client: client.clone(),
            mode,
            generation_id: format!("pi-{}", uuid::Uuid::new_v4()),
            open_sessions: parking_lot::Mutex::new(HashMap::new()),
            active_acp_session: parking_lot::Mutex::new(None),
            switch_lock: tokio::sync::Mutex::new(()),
            child: parking_lot::Mutex::new(child),
            env_fingerprint: fingerprint,
            retired: std::sync::atomic::AtomicBool::new(false),
        });
        events::spawn_reader(
            Arc::clone(shared),
            key.clone(),
            mode,
            Arc::downgrade(&proc),
            stdout,
            client,
        );
        Ok(proc)
    }
}

struct ResolvedLaunch {
    binary: String,
    mode: LaunchMode,
}

enum LaunchMode {
    Host {
        node: PathBuf,
        package_root: PathBuf,
    },
    LegacyRpc,
}

// ---------------------------------------------------------------------------
// Launch resolution
// ---------------------------------------------------------------------------

enum SessionHostPreference {
    Host,
    LegacyRpc,
}

/// `[agents.pi] session_host` from daemon.toml; anything but "rpc" (including
/// absent) means the multi-session host. Read at spawn time (cursor-config
/// pattern) so flipping it needs a respawn, not a daemon restart.
fn session_host_preference() -> SessionHostPreference {
    let configured =
        crate::config::DaemonConfig::load(&crate::config::DaemonConfig::default_path())
            .ok()
            .and_then(|c| c.agents.pi.and_then(|pi| pi.session_host));
    match configured.as_deref() {
        Some("rpc") => SessionHostPreference::LegacyRpc,
        _ => SessionHostPreference::Host,
    }
}

pub(crate) struct HostLaunch {
    pub(crate) node: PathBuf,
    pub(crate) package_root: PathBuf,
}

/// Resolve what the multi-session host needs: a Node binary and the pi npm
/// package root (the directory whose `dist/index.js` the host imports).
///
/// `None` ⇒ this pi install has no importable package (Bun single binary, or a
/// wrapper script we can't see through) and the caller falls back to legacy
/// `--mode rpc`.
pub(crate) fn resolve_host_launch(binary: &str) -> Option<HostLaunch> {
    let package_root = resolve_pi_package_root(Path::new(binary))?;
    // The npm shim's own shebang is `#!/usr/bin/env node`, so a working pi
    // install implies node exists — but a GUI-launched daemon can't rely on
    // PATH, hence the well-known-dir search first.
    let node =
        crate::runtime::well_known_bin::find("node", &[]).unwrap_or_else(|| PathBuf::from("node"));
    Some(HostLaunch { node, package_root })
}

/// Walk from the pi executable (through symlinks) up to the npm package root:
/// the ancestor holding `package.json` for `@earendil-works/pi-coding-agent`
/// with a `dist/index.js` to import.
fn resolve_pi_package_root(binary: &Path) -> Option<PathBuf> {
    // A bare name ("pi") has no location to walk from; try PATH-style lookup
    // through the well-known dirs to make it absolute first.
    let start = if binary.is_absolute() {
        binary.to_path_buf()
    } else {
        crate::runtime::well_known_bin::find(&binary.to_string_lossy(), &[])?
    };
    let resolved = std::fs::canonicalize(&start).ok()?;
    for dir in resolved.ancestors().skip(1) {
        let package_json = dir.join("package.json");
        if !package_json.exists() || !dir.join("dist").join("index.js").exists() {
            continue;
        }
        let body = std::fs::read_to_string(&package_json).ok()?;
        if body.contains("\"@earendil-works/pi-coding-agent\"") {
            return Some(dir.to_path_buf());
        }
        // A package root that isn't pi's (e.g. a wrapper package) — keep
        // walking; the real root may sit above a nested bin dir.
    }
    None
}

/// Resolve the pi binary amuxd should run. Order: explicit daemon config
/// override → `~/.pi/bin/pi` when present → `pi` on PATH.
pub(crate) fn resolve_binary(configured: Option<&str>) -> String {
    resolve_binary_with(
        configured,
        default_bin(),
        &crate::runtime::well_known_bin::search_dirs(),
    )
}

fn default_bin() -> Option<PathBuf> {
    let name = if cfg!(windows) { "pi.exe" } else { "pi" };
    dirs::home_dir().map(|h| h.join(".pi").join("bin").join(name))
}

/// `well_known` is a parameter rather than a call to
/// `well_known_bin::search_dirs()` so the precedence test below does not depend
/// on whether the machine running it happens to have pi installed.
fn resolve_binary_with(
    configured: Option<&str>,
    default_bin: Option<PathBuf>,
    well_known: &[PathBuf],
) -> String {
    if let Some(b) = configured {
        if !b.is_empty() && b != "claude" {
            return b.to_string();
        }
    }
    if let Some(p) = default_bin {
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    // `~/.pi/bin` is only where pi's own installer puts it; a Homebrew or npm
    // install lands elsewhere and used to fall through to the bare name, which
    // a GUI-launched daemon cannot resolve. See runtime::well_known_bin.
    crate::runtime::well_known_bin::find_with("pi", &[], well_known)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "pi".to_string())
}

/// Stable (FNV-1a) hash of the canonical worktree path, used to name the
/// per-worktree session directory. Must stay stable across daemon restarts —
/// session resume depends on it — so no `DefaultHasher`.
pub(crate) fn worktree_hash(worktree: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in worktree.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

pub(crate) fn session_dir_for(worktree: &str) -> PathBuf {
    // Keyed by worktree only (NOT the pool key): the session files must be
    // findable again after an env change or daemon restart re-keys the pool.
    crate::config::layout::active_state_dir()
        .join("pi-sessions")
        .join(worktree_hash(worktree))
}

// ---------------------------------------------------------------------------
// TeamClu extension + host script + permission rules file
// ---------------------------------------------------------------------------

/// The TeamClu pi extension, embedded at compile time and materialized to
/// disk at spawn (loaded via `pi -e <path>` / host `--extension`).
const TEAMCLU_EXTENSION_TS: &str = include_str!("../../../assets/pi-extension/teamclu.ts");

/// The TeamClu multi-session host, embedded and materialized the same way.
const TEAMCLU_HOST_MJS: &str = include_str!("../../../assets/pi-host/host.mjs");

/// `cache/pi/` — machine-level pi runtime files (the materialized extension,
/// host script, and per-worktree permission grants). Under `cache/` per the
/// layout spec: deleting it costs a re-materialize and re-prompts, nothing
/// more.
fn amuxd_pi_dir() -> PathBuf {
    crate::config::layout::cache_dir().join("pi")
}

pub(crate) fn extension_path() -> PathBuf {
    amuxd_pi_dir().join("extensions").join("teamclu.ts")
}

pub(crate) fn host_script_path() -> PathBuf {
    amuxd_pi_dir().join("host").join("host.mjs")
}

/// Where the extension caches each MCP server's `tools/list` result
/// (`TEAMCLU_MCP_TOOL_CACHE_DIR`). Bridging a server takes seconds — measured
/// 4.2s for the slowest one here — and pi cannot start a session until the
/// extension has registered its tools. With a cached list the tools register
/// at once and the child is spawned in the background instead.
fn mcp_tool_cache_dir() -> PathBuf {
    amuxd_pi_dir().join("mcp-tools")
}

/// Write embedded content to its on-disk path (only when the content changed,
/// so mtimes stay stable across spawns).
fn materialize(path: PathBuf, content: &str) -> std::io::Result<PathBuf> {
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current != content {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, content)?;
    }
    Ok(path)
}

fn materialize_extension() -> std::io::Result<PathBuf> {
    materialize(extension_path(), TEAMCLU_EXTENSION_TS)
}

fn materialize_host_script() -> std::io::Result<PathBuf> {
    materialize(host_script_path(), TEAMCLU_HOST_MJS)
}

/// Per-worktree permission rules file read by the TeamClu pi extension
/// (`TEAMCLU_PI_PERMISSIONS_FILE`). The daemon appends patterns to it when
/// the host resolves a permission with option_id "always".
pub(crate) fn permissions_file_for(worktree: &str) -> PathBuf {
    amuxd_pi_dir()
        .join("permissions")
        .join(format!("{}.json", worktree_hash(worktree)))
}

fn default_permissions() -> serde_json::Value {
    serde_json::json!({ "defaultAction": "ask", "alwaysAllowed": [] })
}

pub(crate) fn write_default_permissions_if_absent(path: &Path) -> std::io::Result<()> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(&default_permissions())?)
}

/// Append an "always allow" pattern to the rules file (dedup; a missing or
/// corrupt file is replaced with defaults + the pattern).
pub(crate) fn append_always_pattern(path: &Path, pattern: &str) -> std::io::Result<()> {
    let mut rules = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(default_permissions);
    let obj = rules.as_object_mut().expect("rules is an object");
    let list = obj
        .entry("alwaysAllowed")
        .or_insert_with(|| serde_json::json!([]));
    if !list.is_array() {
        *list = serde_json::json!([]);
    }
    let arr = list.as_array_mut().expect("alwaysAllowed is an array");
    if !arr.iter().any(|v| v.as_str() == Some(pattern)) {
        arr.push(serde_json::json!(pattern));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(&rules)?)
}

#[cfg(test)]
pub(crate) fn test_pool_key(worktree: &str) -> PoolKey {
    PoolKey {
        domain: IsolationDomainKey::Workspace("test-ws".into()),
        env_revision: ProcessEnvRevision::from_bindings(&HashMap::new()),
        worktree: worktree.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_binary_precedence() {
        assert_eq!(resolve_binary_with(Some("/opt/pi"), None, &[]), "/opt/pi");
        // serde default "claude" counts as unconfigured
        assert_eq!(resolve_binary_with(Some("claude"), None, &[]), "pi");
        assert_eq!(resolve_binary_with(Some(""), None, &[]), "pi");
        assert_eq!(resolve_binary_with(None, None, &[]), "pi");
        // existing default bin wins over PATH fallback
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("pi");
        std::fs::write(&bin, "").unwrap();
        assert_eq!(
            resolve_binary_with(None, Some(bin.clone()), &[]),
            bin.to_string_lossy()
        );
        // ...and a well-known-dir hit beats the bare name when ~/.pi/bin has
        // nothing (Homebrew / npm installs).
        let brew = tempfile::tempdir().unwrap();
        let brew_pi = brew.path().join("pi");
        std::fs::write(&brew_pi, "").unwrap();
        assert_eq!(
            resolve_binary_with(None, None, &[brew.path().to_path_buf()]),
            brew_pi.to_string_lossy()
        );
    }

    #[test]
    fn package_root_resolved_through_symlink() {
        // Layout mirroring a real npm global install:
        //   <root>/lib/node_modules/@earendil-works/pi-coding-agent/
        //     package.json  dist/cli.js  dist/index.js
        //   <root>/bin/pi -> ../lib/node_modules/.../dist/cli.js
        let dir = tempfile::tempdir().unwrap();
        let pkg = dir
            .path()
            .join("lib/node_modules/@earendil-works/pi-coding-agent");
        std::fs::create_dir_all(pkg.join("dist")).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@earendil-works/pi-coding-agent","version":"0.84.2"}"#,
        )
        .unwrap();
        std::fs::write(pkg.join("dist/cli.js"), "").unwrap();
        std::fs::write(pkg.join("dist/index.js"), "").unwrap();
        let bin_dir = dir.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let shim = bin_dir.join("pi");
        #[cfg(unix)]
        std::os::unix::fs::symlink(pkg.join("dist/cli.js"), &shim).unwrap();
        #[cfg(not(unix))]
        std::fs::copy(pkg.join("dist/cli.js"), &shim).unwrap();

        #[cfg(unix)]
        {
            let root = resolve_pi_package_root(&shim).expect("package root");
            assert_eq!(
                std::fs::canonicalize(&root).unwrap(),
                std::fs::canonicalize(&pkg).unwrap()
            );
        }
    }

    #[test]
    fn package_root_none_for_single_binary() {
        // A Bun single binary: an executable with no package.json anywhere
        // above it → no host mode, caller falls back to --mode rpc.
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("pi");
        std::fs::write(&bin, "#!ELF not really").unwrap();
        assert!(resolve_pi_package_root(&bin).is_none());
    }

    #[test]
    fn package_root_rejects_foreign_package() {
        // A wrapper package that is not pi must not be mistaken for it.
        let dir = tempfile::tempdir().unwrap();
        let pkg = dir.path().join("some-wrapper");
        std::fs::create_dir_all(pkg.join("dist")).unwrap();
        std::fs::write(pkg.join("package.json"), r#"{"name":"some-wrapper"}"#).unwrap();
        std::fs::write(pkg.join("dist/index.js"), "").unwrap();
        std::fs::write(pkg.join("dist/cli.js"), "").unwrap();
        assert!(resolve_pi_package_root(&pkg.join("dist/cli.js")).is_none());
    }

    #[test]
    fn pool_keys_separate_domains_and_revisions() {
        let base = test_pool_key("/w");
        let other_domain = PoolKey {
            domain: IsolationDomainKey::Workspace("other-ws".into()),
            ..base.clone()
        };
        let other_env = PoolKey {
            env_revision: ProcessEnvRevision::from_bindings(&HashMap::from([(
                "K".to_string(),
                "V".to_string(),
            )])),
            ..base.clone()
        };
        assert_ne!(base, other_domain);
        assert_ne!(base, other_env);
        let mut map = HashMap::new();
        map.insert(base.clone(), 1);
        map.insert(other_domain, 2);
        map.insert(other_env, 3);
        assert_eq!(map.len(), 3, "all three keys must hash distinctly");
    }

    #[test]
    fn spawn_fingerprint_isolates_env_per_key_shape() {
        let pool = PiProcessPool::new();
        let launch = ResolvedLaunch {
            binary: "pi".into(),
            mode: LaunchMode::LegacyRpc,
        };
        let a = SpawnEnv {
            extra_env: HashMap::from([("A".into(), "1".into())]),
            ..Default::default()
        };
        let b = SpawnEnv {
            extra_env: HashMap::from([("A".into(), "2".into())]),
            ..Default::default()
        };
        assert_ne!(
            pool.spawn_fingerprint(&a, &launch),
            pool.spawn_fingerprint(&b, &launch),
            "different env values must produce different fingerprints"
        );
        assert_eq!(
            pool.spawn_fingerprint(&a, &launch),
            pool.spawn_fingerprint(&a.clone(), &launch)
        );
    }

    #[test]
    fn default_permissions_written_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("perms.json");
        write_default_permissions_if_absent(&path).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["defaultAction"], "ask");
        assert_eq!(v["alwaysAllowed"], serde_json::json!([]));
        // Second call must not clobber user-modified content.
        std::fs::write(&path, r#"{"defaultAction":"allow","alwaysAllowed":["x"]}"#).unwrap();
        write_default_permissions_if_absent(&path).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["defaultAction"], "allow");
    }

    #[test]
    fn append_always_pattern_dedups_and_heals_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("perms.json");
        // Missing file: created from defaults + pattern.
        append_always_pattern(&path, "ls *").unwrap();
        append_always_pattern(&path, "ls *").unwrap();
        append_always_pattern(&path, "edit").unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["defaultAction"], "ask");
        assert_eq!(v["alwaysAllowed"], serde_json::json!(["ls *", "edit"]));
        // Corrupt file: replaced with defaults + pattern.
        std::fs::write(&path, "not json").unwrap();
        append_always_pattern(&path, "git *").unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["alwaysAllowed"], serde_json::json!(["git *"]));
    }

    #[test]
    fn permissions_file_is_per_worktree() {
        assert_ne!(permissions_file_for("/a/b"), permissions_file_for("/a/c"));
        assert_eq!(permissions_file_for("/a/b"), permissions_file_for("/a/b"));
    }

    #[test]
    fn worktree_hash_is_stable_and_distinct() {
        assert_eq!(worktree_hash("/a/b"), worktree_hash("/a/b"));
        assert_ne!(worktree_hash("/a/b"), worktree_hash("/a/c"));
        assert_eq!(worktree_hash("/a/b").len(), 16);
    }
}

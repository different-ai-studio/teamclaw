use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::mpsc;

/// Default port for the OpenCode server.
/// Used for the first/main workspace instance and for dev mode.
pub const DEFAULT_PORT: u16 = 13141;
const PLUGIN_UPDATE_TTL_SECS: u64 = 60 * 60 * 6;

/// Mutable runtime state for a single OpenCode sidecar instance.
/// Keyed by workspace_path inside `OpenCodeState::instances`.
pub struct OpenCodeInner {
    pub is_running: bool,
    pub port: u16,
    pub child_process: Option<CommandChild>,
    /// Handle to the async task monitoring sidecar stdout/stderr.
    /// Aborted on shutdown to prevent resource leaks.
    pub reader_task: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// OpenCode server state.
///
/// Multi-instance scaffolding: `instances` is keyed by workspace_path so that
/// multiple windows can each run their own sidecar. In single-window flow the
/// map holds at most one entry and `resolve_workspace(state, None)` returns
/// it without needing an explicit workspace argument (back-compat).
pub struct OpenCodeState {
    /// Active sidecar instances, keyed by workspace_path.
    pub instances: Mutex<HashMap<String, OpenCodeInner>>,
    /// Per-workspace start locks that serialize concurrent `start_opencode`
    /// calls for the same workspace (different workspaces can start in parallel).
    pub start_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Early launch state — set by setup hook, consumed by start_opencode.
    pub early_launch: tokio::sync::Mutex<Option<EarlyLaunchState>>,
    /// Process-wide dev mode flag (read from OPENCODE_DEV_MODE env var at startup).
    pub is_dev_mode: bool,
}

impl Default for OpenCodeState {
    fn default() -> Self {
        let is_dev = env::var("OPENCODE_DEV_MODE")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        Self {
            instances: Mutex::new(HashMap::new()),
            start_locks: Mutex::new(HashMap::new()),
            early_launch: tokio::sync::Mutex::new(None),
            is_dev_mode: is_dev,
        }
    }
}

/// Pick a free TCP port on 127.0.0.1 by binding to port 0 and reading back.
/// Used by Phase 2 to allocate ports for additional workspace windows.
pub async fn find_available_port() -> Result<u16, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind for port allocation: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read local addr: {}", e))?
        .port();
    drop(listener);
    Ok(port)
}

/// Resolve which sidecar instance to operate on.
///
/// - `explicit = Some(ws)`: must exist in `instances`; returns its `(workspace_path, port)`.
/// - `explicit = None` + 0 instances: error (no workspace selected yet).
/// - `explicit = None` + 1 instance: returns that one (back-compat single-window).
/// - `explicit = None` + 2+ instances: error (caller must pass an explicit workspace).
pub fn resolve_workspace(
    state: &OpenCodeState,
    explicit: Option<&str>,
) -> Result<(String, u16), String> {
    let instances = state.instances.lock().map_err(|e| e.to_string())?;
    if let Some(ws) = explicit {
        match instances.get(ws) {
            Some(inner) => Ok((ws.to_string(), inner.port)),
            None => Err(format!("No OpenCode instance for workspace: {}", ws)),
        }
    } else {
        match instances.len() {
            0 => Err("No workspace path set. Please select a workspace first.".to_string()),
            1 => {
                let (ws, inner) = instances.iter().next().unwrap();
                Ok((ws.clone(), inner.port))
            }
            n => Err(format!(
                "{} OpenCode instances active; caller must specify workspace_path",
                n
            )),
        }
    }
}

/// Convenience wrapper around `resolve_workspace(state, None)` for callers that
/// only need the workspace path (back-compat single-window).
pub fn current_workspace_path(state: &OpenCodeState) -> Result<String, String> {
    resolve_workspace(state, None).map(|(w, _)| w)
}

/// Get (or create) the per-workspace start lock.
fn get_start_lock(
    state: &OpenCodeState,
    workspace_path: &str,
) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    let mut locks = state.start_locks.lock().map_err(|e| e.to_string())?;
    Ok(locks
        .entry(workspace_path.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OpenCodeConfig {
    pub workspace_path: String,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenCodeStatus {
    pub is_running: bool,
    pub port: u16,
    pub url: String,
    pub is_dev_mode: bool,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PluginUpdateTarget {
    spec: String,
    package_name: String,
    auto_update: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PluginUpdateState {
    last_checked_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct OpenCodeBootstrappedEvent {
    url: String,
    workspace_path: String,
}

/// State for the early sidecar launch (initiated from setup hook before frontend).
pub struct EarlyLaunchState {
    /// The workspace path this early launch was started for.
    pub workspace_path: String,
    /// Receiver to await the result. Clone to subscribe.
    pub result_rx: tokio::sync::watch::Receiver<Option<Result<OpenCodeStatus, String>>>,
}

/// Start OpenCode server as a sidecar process (or connect to external in dev mode)
#[tauri::command]
pub async fn start_opencode(
    app: AppHandle,
    state: State<'_, OpenCodeState>,
    config: OpenCodeConfig,
) -> Result<OpenCodeStatus, String> {
    // Check if early launch is in progress for this workspace
    {
        let mut early_guard = state.early_launch.lock().await;
        if let Some(early) = early_guard.as_ref() {
            if early.workspace_path == config.workspace_path {
                println!(
                    "[OpenCode] Reusing early launch for: {}",
                    config.workspace_path
                );
                let mut rx = early.result_rx.clone();
                drop(early_guard);
                // Wait for the early launch to complete
                while rx.borrow().is_none() {
                    if rx.changed().await.is_err() {
                        break;
                    }
                }
                let result = rx.borrow().clone();
                let mut early_guard = state.early_launch.lock().await;
                *early_guard = None;
                match result {
                    Some(Ok(status)) => return Ok(status),
                    Some(Err(e)) => {
                        println!("[OpenCode] Early launch failed ({}), retrying fresh", e);
                    }
                    None => {
                        println!("[OpenCode] Early launch sender dropped, retrying fresh");
                    }
                }
            } else {
                println!("[OpenCode] Workspace mismatch, clearing early launch");
                *early_guard = None;
            }
        }
    }

    start_opencode_inner(app, &state, config).await
}

/// Core sidecar startup logic, shared between the Tauri command and early launch.
///
/// Phase 1 scaffolding semantics:
/// - Sidecar instances live in `state.instances`, keyed by workspace_path.
/// - For now `start_opencode` is treated as the "main slot" path: it uses
///   `DEFAULT_PORT` (or `config.port` if explicitly given) and assumes the
///   caller wants only one main-slot instance at a time. If a different
///   workspace already occupies that slot, it is shut down before starting
///   the new one — preserving today's single-window UX.
/// - Phase 2 will add a separate `create_workspace_window` command path that
///   uses `find_available_port()` to spawn additional sidecars without
///   disturbing the main slot.
pub async fn start_opencode_inner(
    app: AppHandle,
    state: &OpenCodeState,
    config: OpenCodeConfig,
) -> Result<OpenCodeStatus, String> {
    let inner_t0 = std::time::Instant::now();

    let is_dev_mode = state.is_dev_mode;
    let port = config.port.unwrap_or(DEFAULT_PORT);
    let workspace_key = config.workspace_path.clone();

    // Per-workspace start lock — concurrent starts for the same workspace serialize,
    // but different workspaces may start in parallel.
    let start_lock = get_start_lock(state, &workspace_key)?;
    let _start_guard = start_lock.lock().await;
    eprintln!(
        "[Startup] start_opencode_inner: lock acquired in {:.1}ms",
        inner_t0.elapsed().as_secs_f64() * 1000.0
    );

    // Already running for this workspace? Return cached status.
    {
        let instances = state.instances.lock().map_err(|e| e.to_string())?;
        if let Some(inner) = instances.get(&workspace_key) {
            if inner.is_running {
                return Ok(OpenCodeStatus {
                    is_running: true,
                    port: inner.port,
                    url: format!("http://127.0.0.1:{}", inner.port),
                    is_dev_mode,
                    workspace_path: Some(workspace_key.clone()),
                });
            }
        }
    }

    // Detect main-slot collision: another workspace already holds the same port.
    // For Phase 1 (scaffolding), that means the user "switched workspace" in the
    // single window — shut down the previous instance to free the port.
    let conflicting_workspace: Option<String> = {
        let instances = state.instances.lock().map_err(|e| e.to_string())?;
        instances
            .iter()
            .find(|(ws, inner)| ws.as_str() != workspace_key && inner.port == port)
            .map(|(ws, _)| ws.clone())
    };

    if let Some(prev_ws) = conflicting_workspace {
        println!(
            "[OpenCode] Port {} held by workspace {:?}, shutting it down before starting {}",
            port, prev_ws, workspace_key
        );
        // Stop the previous instance
        if !is_dev_mode {
            let mut instances = state.instances.lock().map_err(|e| e.to_string())?;
            if let Some(inner) = instances.get_mut(&prev_ws) {
                if let Some(child) = inner.child_process.take() {
                    println!("[OpenCode] Killing previous process...");
                    let _ = child.kill();
                }
                if let Some(handle) = inner.reader_task.take() {
                    handle.abort();
                }
                inner.is_running = false;
            }
            // Drop the entry entirely so we don't keep stale instances around.
            instances.remove(&prev_ws);
        } else {
            let mut instances = state.instances.lock().map_err(|e| e.to_string())?;
            instances.remove(&prev_ws);
        }

        // Wait for port to be released with exponential backoff
        println!("[OpenCode] Waiting for port {} to be released...", port);
        let start_time = std::time::Instant::now();
        const MAX_WAIT_TIME: std::time::Duration = std::time::Duration::from_secs(10);
        let mut delay = std::time::Duration::from_millis(100);
        let mut released = false;

        loop {
            // Check if port is free
            if !is_port_in_use(port).await {
                println!(
                    "[OpenCode] Port {} released after {:.1}s",
                    port,
                    start_time.elapsed().as_secs_f32()
                );
                released = true;
                break;
            }

            // Check timeout
            if start_time.elapsed() >= MAX_WAIT_TIME {
                println!("[OpenCode] Timeout waiting for port {} (10s elapsed)", port);
                break;
            }

            // Exponential backoff (max 1 second)
            tokio::time::sleep(delay).await;
            delay = std::cmp::min(delay * 2, std::time::Duration::from_secs(1));

            if start_time.elapsed().as_secs() % 2 == 0 {
                println!(
                    "[OpenCode] Still waiting for port {} ({:.1}s elapsed)...",
                    port,
                    start_time.elapsed().as_secs_f32()
                );
            }
        }

        // If still occupied after 10s, force kill whatever is on the port
        if !released && is_port_in_use(port).await {
            println!(
                "[OpenCode] Port {} still occupied after 10s, force killing process...",
                port
            );
            if !kill_process_on_port(port).await {
                return Err(format!(
                    "Timeout waiting for port {} to be released. \
                    The process may be stuck. Please manually kill the process:\n\n{}",
                    port,
                    manual_kill_port_hint(port)
                ));
            }
        }

        // Extra safety: wait 500ms after port is released to ensure full cleanup
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // In dev mode, check if external server is available and verify workspace
    if is_dev_mode {
        println!(
            "[OpenCode] Dev mode enabled - connecting to external server at port {}",
            port
        );

        // Try to connect to external server
        let is_ready = check_server_health(port).await;

        if !is_ready {
            return Err(format!(
                "Dev mode: OpenCode server not running at port {}. Please start it with:\n\ncd {} && opencode serve --port {}",
                port, config.workspace_path, port
            ));
        }

        // Verify the server is running in the expected workspace
        let (server_directory, server_worktree) = get_server_paths(port).await;
        let requested_path = config.workspace_path.clone();
        let requested_normalized = requested_path.trim_end_matches('/');

        let paths_match = {
            let dir_matches = server_directory
                .as_ref()
                .map(|p| p.trim_end_matches('/') == requested_normalized)
                .unwrap_or(false);

            let worktree_matches = server_worktree
                .as_ref()
                .map(|p| {
                    let w = p.trim_end_matches('/');
                    w != "/" && w == requested_normalized
                })
                .unwrap_or(false);

            dir_matches || worktree_matches
        };

        if !paths_match {
            let server_path_display = server_directory
                .clone()
                .or(server_worktree.clone())
                .unwrap_or_else(|| "unknown".to_string());
            return Err(format!(
                "Dev mode: OpenCode server is running in a different directory.\n\n\
                Server directory: {}\n\
                Requested directory: {}\n\n\
                Please restart OpenCode in the correct directory:\n\n\
                cd {} && opencode serve --port {}",
                server_path_display, requested_path, requested_path, port
            ));
        }

        // Update state
        {
            let mut instances = state.instances.lock().map_err(|e| e.to_string())?;
            instances.insert(
                requested_path.clone(),
                OpenCodeInner {
                    is_running: true,
                    port,
                    child_process: None,
                    reader_task: None,
                },
            );
        }

        let url = format!("http://127.0.0.1:{}", port);
        let _ = app.emit(
            "opencode_bootstrapped",
            OpenCodeBootstrappedEvent {
                url: url.clone(),
                workspace_path: requested_path.clone(),
            },
        );

        return Ok(OpenCodeStatus {
            is_running: true,
            port,
            url,
            is_dev_mode: true,
            workspace_path: Some(requested_path),
        });
    }

    // Production mode: if port is occupied, it's almost certainly our own zombie process.
    // Kill it directly instead of waiting.
    if is_port_in_use(port).await {
        println!(
            "[OpenCode] Port {} is already in use, killing zombie process...",
            port
        );
        if !kill_process_on_port(port).await {
            return Err(format!(
                "Port {} is still in use after attempting to kill the occupying process.\n\
                Please manually kill the process: {}",
                port,
                manual_kill_port_hint(port)
            ));
        }
        println!("[OpenCode] Port {} is now free after killing zombie", port);
    }

    // Spawn sidecar
    let port_str = port.to_string();
    let workspace_path = config.workspace_path.clone();

    // ── Pre-sidecar setup (parallelized) ──────────────────────────────
    //
    // Three branches run concurrently via tokio::join!:
    //   1. opencode.json writers (sequential: permissions → config → binary paths)
    //   2. ensure_inherent_skills (writes to .opencode/skills/, independent)
    //   3. load_local_personal_secrets (reads local encrypted secret blob, independent)
    //
    // resolve_config_secret_refs runs AFTER all three complete (depends on
    // both the config writers finishing and local personal secrets being available).

    // Ensure system env vars exist (e.g. tc_api_key) before reading personal secrets.
    // Runs synchronously before the local encrypted secret blob load.
    {
        let device_id = super::oss_commands::get_device_id().unwrap_or_default();
        let ws = workspace_path.clone();
        let did = device_id.clone();
        if let Err(e) =
            tokio::task::spawn_blocking(move || super::env_vars::ensure_system_env_vars(&ws, &did))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r)
        {
            eprintln!(
                "[OpenCode] Warning: failed to ensure system env vars: {}",
                e
            );
        }
    }

    let ws_for_config = workspace_path.clone();
    let ws_for_skills = workspace_path.clone();
    let ws_for_personal_secrets = workspace_path.clone();

    let (config_result, skills_result, personal_secrets_result) = tokio::join!(
        // Branch 1: opencode.json writers (must be sequential with each other)
        tokio::task::spawn_blocking(move || {
            if let Err(e) = ensure_default_permissions(&ws_for_config) {
                eprintln!(
                    "[OpenCode] Warning: failed to ensure default permissions: {}",
                    e
                );
            }
            if let Err(e) = ensure_inherent_config(&ws_for_config) {
                eprintln!(
                    "[OpenCode] Warning: failed to ensure inherent configs: {}",
                    e
                );
            }
            if let Err(e) = resolve_sidecar_binary_paths(&ws_for_config) {
                eprintln!("[OpenCode] Warning: failed to resolve binary paths: {}", e);
            }
            if let Err(e) = refresh_npm_plugins_if_needed(&ws_for_config) {
                eprintln!("[OpenCode] Warning: failed to refresh npm plugins: {}", e);
            }
        }),
        // Branch 2: inherent skills (writes to .opencode/skills/, no opencode.json conflict)
        tokio::task::spawn_blocking(move || {
            if let Err(e) = ensure_inherent_skills(&ws_for_skills) {
                eprintln!(
                    "[OpenCode] Warning: failed to ensure inherent skills: {}",
                    e
                );
            }
        }),
        // Branch 3: local personal secrets
        tokio::task::spawn_blocking(move || load_local_personal_secrets(&ws_for_personal_secrets))
    );

    // Unwrap spawn results (panics inside spawn_blocking become JoinErrors)
    if let Err(e) = config_result {
        eprintln!("[OpenCode] Config setup task panicked: {}", e);
    }
    if let Err(e) = skills_result {
        eprintln!("[OpenCode] Skills setup task panicked: {}", e);
    }

    let (mut secrets, failed_keys) = personal_secrets_result.unwrap_or_else(|e| {
        eprintln!(
            "[OpenCode] spawn_blocking for local personal secrets failed: {}",
            e
        );
        (Vec::new(), Vec::new())
    });

    if !failed_keys.is_empty() {
        if failed_keys == ["__blob__"] {
            println!("[OpenCode] Local encrypted secret blob unavailable, retrying once...");
        } else {
            println!(
                "[OpenCode] {} personal secret(s) failed to read ({:?}), retrying local encrypted blob load...",
                failed_keys.len(),
                failed_keys
            );
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        let ws_retry = workspace_path.clone();
        let (retry_secrets, still_failed) =
            tokio::task::spawn_blocking(move || load_local_personal_secrets(&ws_retry))
                .await
                .unwrap_or_else(|e| {
                    eprintln!(
                        "[OpenCode] spawn_blocking for local personal secrets retry failed: {}",
                        e
                    );
                    (Vec::new(), Vec::new())
                });

        if !still_failed.is_empty() {
            if still_failed == ["__blob__"] {
                eprintln!(
                    "[OpenCode] Warning: local encrypted secret blob still unavailable after retry"
                );
            } else {
                eprintln!(
                    "[OpenCode] Warning: {} personal secret(s) still unavailable after retry: {:?}",
                    still_failed.len(),
                    still_failed
                );
            }
        }

        secrets = retry_secrets;
    }

    // Merge shared secrets (team KMS) into secrets vec.
    // Shared secrets take priority over local personal secrets with the same key.
    //
    // On every (re)start: (1) lazy-init if needed — supports both OSS and Git
    // teams via `try_lazy_init_from_workspace`, and (2) re-read the `_secrets/`
    // directory unconditionally so we pick up envelopes that arrived via sync
    // while the app was running (or while opencode was stopped).
    if let Some(shared_state) = app.try_state::<super::shared_secrets::SharedSecretsState>() {
        if let Err(e) =
            super::shared_secrets::try_lazy_init_from_workspace(&shared_state, &workspace_path)
        {
            // Not an error when the workspace has no team — expected for solo workspaces.
            println!("[OpenCode] shared_secrets init skipped: {}", e);
        }
        if let Err(e) = super::shared_secrets::load_all_secrets(&shared_state) {
            // Only surfaces when init also failed (no team_dir set). Safe to ignore.
            println!("[OpenCode] shared_secrets reload skipped: {}", e);
        }

        let shared_map = shared_state
            .secrets
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        println!("[OpenCode] Shared secrets count: {}", shared_map.len());
        for (key_id, entry) in shared_map.iter() {
            // Inject both original key_id and UPPER_CASE version as env vars
            // so ${wecom_corp_id} and WECOM_CORP_ID both resolve
            let upper_key = key_id.to_uppercase();
            secrets.retain(|(k, _)| k != key_id && k != &upper_key);
            println!(
                "[OpenCode] Loaded shared secret: {} (also {})",
                key_id, upper_key
            );
            secrets.push((key_id.clone(), entry.key.clone()));
            if upper_key != *key_id {
                secrets.push((upper_key, entry.key.clone()));
            }
        }
    }

    eprintln!(
        "[Startup] Pre-sidecar I/O (parallel): {:.1}ms",
        inner_t0.elapsed().as_secs_f64() * 1000.0
    );

    println!(
        "[OpenCode] Secret keys available for resolution: {:?}",
        secrets.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>()
    );
    let original_config = resolve_config_secret_refs(&workspace_path, &secrets);

    println!(
        "[OpenCode] Starting sidecar in directory: {}",
        workspace_path
    );

    // Build sidecar command, also injecting secrets as process env vars (backup)
    //
    // XDG isolation: redirect all OpenCode data/config/state/cache directories
    // into <workspace>/.opencode/ so each workspace is fully self-contained
    // and independent of any system-installed OpenCode.
    let xdg_base = std::path::PathBuf::from(&workspace_path).join(".opencode");
    let mut sidecar_command = app
        .shell()
        .sidecar("opencode")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(["serve", "--port", &port_str])
        .current_dir(&workspace_path)
        .env(
            "XDG_DATA_HOME",
            xdg_base.join("data").to_string_lossy().as_ref(),
        )
        .env(
            "XDG_CONFIG_HOME",
            xdg_base.join("config").to_string_lossy().as_ref(),
        )
        .env(
            "XDG_STATE_HOME",
            xdg_base.join("state").to_string_lossy().as_ref(),
        )
        .env(
            "XDG_CACHE_HOME",
            xdg_base.join("cache").to_string_lossy().as_ref(),
        );
    // Inject device identity as environment variables
    let device_id = super::oss_commands::get_device_id().unwrap_or_default();
    if !device_id.is_empty() {
        sidecar_command = sidecar_command.env("device_id", &device_id);
    }
    let device_name = gethostname::gethostname().to_string_lossy().to_string();
    sidecar_command = sidecar_command.env("device_name", &device_name);

    for (key, value) in &secrets {
        sidecar_command = sidecar_command.env(key, value);
        // Also inject a dot-free alias so bash/skill scripts can access it
        if key.contains('.') {
            let alias = key.replace('.', "_");
            sidecar_command = sidecar_command.env(&alias, value);
        }
    }

    let (mut rx, child) = sidecar_command
        .spawn()
        .map_err(|e| format!("Failed to spawn OpenCode sidecar: {}", e))?;

    // Store the child process — insert/replace this workspace's instance.
    {
        let mut instances = state.instances.lock().map_err(|e| e.to_string())?;
        instances.insert(
            workspace_path.clone(),
            OpenCodeInner {
                is_running: false,
                port,
                child_process: Some(child),
                reader_task: None,
            },
        );
    }

    // Wait for server to be ready — channel carries Ok(()) on success or Err(message) on crash
    let (ready_tx, mut ready_rx) = mpsc::channel::<Result<(), String>>(1);

    let ready_tx_clone = ready_tx.clone();
    let reader_handle = tauri::async_runtime::spawn(async move {
        let mut stderr_lines: Vec<String> = Vec::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    println!("[OpenCode] {}", line_str);
                    if line_str.contains("listening")
                        || line_str.contains("started")
                        || line_str.contains("ready")
                    {
                        let _ = ready_tx_clone.send(Ok(())).await;
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line).to_string();
                    // opencode logs INFO to stderr, only print actual errors
                    if line_str.contains("Error") || line_str.contains("Failed") {
                        eprintln!("[OpenCode Error] {}", line_str);
                    } else {
                        println!("[OpenCode] {}", line_str);
                    }
                    // Collect stderr for crash diagnostics (keep last 20 lines)
                    stderr_lines.push(line_str);
                    if stderr_lines.len() > 20 {
                        stderr_lines.remove(0);
                    }
                }
                CommandEvent::Error(err) => {
                    eprintln!("[OpenCode Error] {}", err);
                    stderr_lines.push(err.clone());
                }
                CommandEvent::Terminated(payload) => {
                    let code = payload.code.unwrap_or(-1);
                    eprintln!("[OpenCode] Process terminated with code: {}", code);
                    if code != 0 {
                        let context = if stderr_lines.is_empty() {
                            format!("OpenCode process exited with code {}", code)
                        } else {
                            // Include last few stderr lines for context
                            let tail: Vec<&str> = stderr_lines.iter().map(|s| s.as_str()).collect();
                            format!(
                                "OpenCode process exited with code {}:\n{}",
                                code,
                                tail.join("\n")
                            )
                        };
                        let _ = ready_tx_clone.send(Err(context)).await;
                    }
                }
                _ => {}
            }
        }
    });

    // Store the reader task handle for cleanup
    {
        let mut instances = state.instances.lock().map_err(|e| e.to_string())?;
        if let Some(inner) = instances.get_mut(&workspace_path) {
            inner.reader_task = Some(reader_handle);
        }
    }

    // Wait for ready signal with timeout
    let ready = tokio::time::timeout(std::time::Duration::from_secs(15), ready_rx.recv()).await;

    match ready {
        Ok(Some(Ok(()))) => {} // Server is ready
        Ok(Some(Err(crash_msg))) => {
            // Process crashed — return the error with stderr context
            restore_config(&workspace_path, &original_config, &secrets);
            return Err(crash_msg);
        }
        _ => {
            // Timeout or channel closed — fallback: poll health endpoint
            let mut healthy = false;
            for _ in 0..20 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                if check_server_health(port).await {
                    healthy = true;
                    break;
                }
            }
            if !healthy {
                restore_config(&workspace_path, &original_config, &secrets);
                return Err("OpenCode server failed to start within timeout. Check opencode.json for errors.".to_string());
            }
        }
    };

    let url = format!("http://127.0.0.1:{}", port);
    let _ = app.emit(
        "opencode_bootstrapped",
        OpenCodeBootstrappedEvent {
            url: url.clone(),
            workspace_path: workspace_path.clone(),
        },
    );

    // Schedule async config restore: wait for MCP servers to connect (so they
    // read the resolved secrets), then put back the original ${KEY} references.
    // Provider apiKey values stay resolved since opencode re-reads the config.
    if let Some(original) = original_config {
        let ws = workspace_path.clone();
        tauri::async_runtime::spawn(async move {
            schedule_config_restore(port, &ws, &original, secrets).await;
        });
    }

    // Verify the server is running in the correct workspace
    let (server_directory, _server_worktree) = get_server_paths(port).await;
    if let Some(ref dir) = server_directory {
        println!("[OpenCode] Server confirmed running in directory: {}", dir);
    }

    // Mark instance as ready
    {
        let mut instances = state.instances.lock().map_err(|e| e.to_string())?;
        if let Some(inner) = instances.get_mut(&workspace_path) {
            inner.is_running = true;
            inner.port = port;
        }
    }

    eprintln!(
        "[Startup] start_opencode_inner TOTAL: {:.1}ms",
        inner_t0.elapsed().as_secs_f64() * 1000.0
    );

    // Persist workspace for early launch on next startup
    write_last_workspace(&workspace_path);

    Ok(OpenCodeStatus {
        is_running: true,
        port,
        url,
        is_dev_mode: false,
        workspace_path: Some(workspace_path),
    })
}

/// Get the current platform's target triple (e.g. "aarch64-apple-darwin", "x86_64-apple-darwin").
fn get_target_triple() -> String {
    let arch = std::env::consts::ARCH;
    let os = std::env::consts::OS;

    match os {
        "macos" => format!("{}-apple-darwin", arch),
        "linux" => format!("{}-unknown-linux-gnu", arch),
        "windows" => format!("{}-pc-windows-msvc", arch),
        _ => format!("{}-unknown-{}", arch, os),
    }
}

/// Known target triples that may appear in binary paths.
const KNOWN_TRIPLES: &[&str] = &[
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
];

/// Ensure opencode.json exists and has a `permission` section with TeamClaw defaults.
///
/// OpenCode's built-in default is `"*": "allow"` (everything auto-approved).
/// TeamClaw sets safer defaults: destructive operations (bash, edit, write) require
/// approval while read-only operations remain auto-approved.
///
/// If opencode.json doesn't exist, creates it with the permission section.
/// If it exists but has no permission section, adds it.
/// If it already has a permission section, leaves it untouched.
fn ensure_default_permissions(workspace_path: &str) -> Result<(), String> {
    let config_path = super::mcp::get_config_path(workspace_path);

    let mut config: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read opencode.json: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse opencode.json: {}", e))?
    } else {
        serde_json::json!({})
    };

    let obj = config
        .as_object_mut()
        .ok_or("opencode.json root is not an object")?;

    if obj.contains_key("permission") {
        return Ok(());
    }

    let defaults = serde_json::json!({
        "bash": "ask",
        "edit": "ask",
        "write": "ask",
        "external_directory": "ask",
        "doom_loop": "ask"
    });

    obj.insert("permission".to_string(), defaults);

    let new_content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize opencode.json: {}", e))?;
    std::fs::write(&config_path, &new_content)
        .map_err(|e| format!("Failed to write opencode.json: {}", e))?;

    println!(
        "[OpenCode] Created default permission config in {}",
        config_path.display()
    );

    Ok(())
}

/// Ensure autoui, playwright, chrome-control MCP configs and skill paths are present in opencode.json.
/// These are inherent configurations required by TeamClaw. Missing entries are added automatically;
/// existing configurations are never modified.
fn ensure_inherent_config(workspace_path: &str) -> Result<(), String> {
    let config_path = super::mcp::get_config_path(workspace_path);

    let mut config: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read opencode.json: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse opencode.json: {}", e))?
    } else {
        serde_json::json!({ "$schema": "https://opencode.ai/config.json" })
    };

    let obj = config
        .as_object_mut()
        .ok_or("opencode.json root is not an object")?;

    let mut changed = false;

    // Ensure MCP section contains playwright, chrome-control, and autoui
    {
        let mcp = obj.entry("mcp").or_insert_with(|| serde_json::json!({}));
        let mcp_obj = mcp.as_object_mut().ok_or("mcp is not an object")?;

        if !mcp_obj.contains_key("playwright") {
            mcp_obj.insert(
                "playwright".to_string(),
                serde_json::json!({
                    "type": "local",
                    "enabled": false,
                    "command": ["npx", "-y", "@playwright/mcp@latest"]
                }),
            );
            changed = true;
            println!("[Config] Added inherent 'playwright' MCP config");
        }

        if !mcp_obj.contains_key("chrome-control") {
            mcp_obj.insert(
                "chrome-control".to_string(),
                serde_json::json!({
                    "type": "local",
                    "enabled": true,
                    "command": [
                        "npx",
                        "-y",
                        "chrome-devtools-mcp@latest",
                        "--autoConnect"
                    ]
                }),
            );
            changed = true;
            println!("[Config] Added inherent 'chrome-control' MCP config");
        }

        // Re-generate if missing OR if the saved binary path no longer exists
        let needs_introspect = if let Some(existing) = mcp_obj.get("teamclaw-introspect") {
            existing
                .get("command")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .map(|p| !std::path::Path::new(p).exists())
                .unwrap_or(true)
        } else {
            true
        };
        if needs_introspect {
            // Resolve absolute path to the sidecar binary.
            // In dev: <repo>/src-tauri/binaries/teamclaw-introspect-<triple>
            // In prod: next to the main executable in the app bundle
            let triple = get_target_triple();
            let introspect_bin = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
                .and_then(|dir| {
                    // Dev mode: exe is in .cargo-target/debug/, binaries are in src-tauri/binaries/
                    let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("binaries")
                        .join(format!("teamclaw-introspect-{}", triple));
                    if dev_path.exists() {
                        return Some(dev_path.to_string_lossy().to_string());
                    }
                    // Production: sidecar is next to the main exe
                    // Tauri may strip the triple suffix when bundling
                    let prod_path_with_triple = dir.join(format!("teamclaw-introspect-{}", triple));
                    if prod_path_with_triple.exists() {
                        return Some(prod_path_with_triple.to_string_lossy().to_string());
                    }
                    let prod_path = dir.join("teamclaw-introspect");
                    if prod_path.exists() {
                        return Some(prod_path.to_string_lossy().to_string());
                    }
                    None
                });

            if let Some(introspect_bin) = introspect_bin {
                mcp_obj.insert(
                    "teamclaw-introspect".to_string(),
                    serde_json::json!({
                        "type": "local",
                        "enabled": true,
                        "command": [
                            introspect_bin,
                            "--workspace", workspace_path,
                            "--api-port", format!("{}", super::introspect_api::INTROSPECT_API_PORT)
                        ]
                    }),
                );
                changed = true;
                println!("[Config] Added inherent 'teamclaw-introspect' MCP config");
            } else {
                println!(
                    "[Config] teamclaw-introspect binary not found, skipping MCP registration"
                );
            }
        }

        if !mcp_obj.contains_key("autoui") {
            mcp_obj.insert(
                "autoui".to_string(),
                serde_json::json!({
                    "type": "local",
                    "enabled": true,
                    "command": ["npx", "-y", "autoui-mcp@latest"],
                    "environment": {
                        "QWEN_API_KEY": "${QWEN_API_KEY}",
                        "QWEN_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                        "QWEN_MODEL": "qwen3-vl-flash"
                    }
                }),
            );
            changed = true;
            println!("[Config] Added inherent 'autoui' MCP config");
        } else if let Some(autoui) = mcp_obj.get_mut("autoui").and_then(|v| v.as_object_mut()) {
            // Migration for users whose autoui `environment` block was stripped by a
            // previous build: restore the 3 QWEN_* defaults. Only runs when the block
            // is absent or empty, so partial user customizations are left alone.
            let needs_restore = autoui
                .get("environment")
                .and_then(|v| v.as_object())
                .map(|env| env.is_empty())
                .unwrap_or(true);
            if needs_restore {
                autoui.insert(
                    "environment".to_string(),
                    serde_json::json!({
                        "QWEN_API_KEY": "${QWEN_API_KEY}",
                        "QWEN_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                        "QWEN_MODEL": "qwen3-vl-flash"
                    }),
                );
                changed = true;
                println!("[Config] Restored default environment block on autoui MCP config");
            }
        }
    }

    // Ensure skills.paths always contains teamclaw-team/skills
    {
        let skills = obj.entry("skills").or_insert_with(|| serde_json::json!({}));
        let skills_obj = skills.as_object_mut().ok_or("skills is not an object")?;

        let paths_val = skills_obj
            .entry("paths")
            .or_insert_with(|| serde_json::json!([]));
        let paths = paths_val
            .as_array_mut()
            .ok_or("skills.paths is not an array")?;

        let inherent_path = concat!(env!("APP_SHORT_NAME"), "-team/skills");

        let already_present = paths.iter().any(|v| v.as_str() == Some(inherent_path));
        if !already_present {
            paths.push(serde_json::json!(inherent_path));
            changed = true;
            println!("[Config] Added inherent skill path '{}'", inherent_path);
        }
    }

    // Provider section is NOT auto-populated.
    // Team provider is added only when creating/joining a team (via team-mode store).
    // Personal providers are added manually by the user in Settings > LLM.

    if changed {
        let mut new_content = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize opencode.json: {}", e))?;
        if !new_content.ends_with('\n') {
            new_content.push('\n');
        }
        std::fs::write(&config_path, &new_content)
            .map_err(|e| format!("Failed to write opencode.json: {}", e))?;
        println!(
            "[Config] Updated opencode.json with inherent configs in {}",
            config_path.display()
        );
    }

    Ok(())
}

fn refresh_npm_plugins_if_needed(workspace_path: &str) -> Result<(), String> {
    let state_path = plugin_update_state_path(workspace_path);
    let ttl = std::time::Duration::from_secs(PLUGIN_UPDATE_TTL_SECS);
    if !should_check_plugin_updates(&state_path, ttl) {
        return Ok(());
    }

    let config_path = super::mcp::get_config_path(workspace_path);
    if !config_path.exists() {
        write_plugin_update_state(&state_path)?;
        return Ok(());
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read opencode.json for plugin refresh: {}", e))?;
    let config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse opencode.json for plugin refresh: {}", e))?;

    let plugin_specs = config
        .get("plugin")
        .and_then(|value| value.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str())
                .filter_map(parse_plugin_update_target)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if plugin_specs.is_empty() {
        write_plugin_update_state(&state_path)?;
        return Ok(());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new());

    for plugin in plugin_specs {
        let latest_version = match fetch_latest_npm_version(&client, &plugin.package_name) {
            Ok(version) => version,
            Err(err) => {
                eprintln!(
                    "[OpenCode] Plugin update check skipped for {}: {}",
                    plugin.spec, err
                );
                continue;
            }
        };

        let Some(latest_version) = latest_version else {
            continue;
        };

        let cache_dir = plugin_cache_dir(workspace_path, &plugin.spec);
        let Some(local_version) = read_installed_plugin_version(&cache_dir, &plugin.package_name)?
        else {
            continue;
        };

        if !is_remote_version_newer(&local_version, &latest_version) {
            continue;
        }

        if cache_dir.exists() {
            std::fs::remove_dir_all(&cache_dir).map_err(|e| {
                format!(
                    "Failed to remove plugin cache {}: {}",
                    cache_dir.display(),
                    e
                )
            })?;
            println!(
                "[OpenCode] Removed stale plugin cache for {} ({} -> {})",
                plugin.spec, local_version, latest_version
            );
        }
    }

    write_plugin_update_state(&state_path)?;
    Ok(())
}

fn parse_plugin_update_target(spec: &str) -> Option<PluginUpdateTarget> {
    let spec = spec.trim();
    if spec.is_empty()
        || spec.starts_with("git+")
        || spec.starts_with("github:")
        || spec.starts_with("file:")
        || spec.starts_with("link:")
        || spec.starts_with("workspace:")
        || spec.contains("://")
    {
        return None;
    }

    let (package_name, version) = split_npm_package_spec(spec)?;
    let auto_update = version.is_none() || version == Some("latest");
    if !auto_update {
        return None;
    }

    Some(PluginUpdateTarget {
        spec: spec.to_string(),
        package_name: package_name.to_string(),
        auto_update,
    })
}

fn split_npm_package_spec(spec: &str) -> Option<(&str, Option<&str>)> {
    if spec.is_empty() {
        return None;
    }

    if let Some(rest) = spec.strip_prefix('@') {
        let slash = rest.find('/')?;
        let after_scope = slash + 2;
        if after_scope >= spec.len() {
            return None;
        }
        let version_sep = spec[after_scope..].rfind('@').map(|idx| idx + after_scope);
        return match version_sep {
            Some(idx) => Some((&spec[..idx], Some(&spec[idx + 1..]))),
            None => Some((spec, None)),
        };
    }

    match spec.rfind('@') {
        Some(idx) => Some((&spec[..idx], Some(&spec[idx + 1..]))),
        None => Some((spec, None)),
    }
}

fn fetch_latest_npm_version(
    client: &reqwest::blocking::Client,
    package_name: &str,
) -> Result<Option<String>, String> {
    let package_url = format!(
        "https://registry.npmjs.org/{}",
        urlencoding::encode(package_name)
    );
    let response = client
        .get(&package_url)
        .send()
        .map_err(|e| format!("registry request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("registry returned status {}", response.status()));
    }

    let body: serde_json::Value = response
        .json()
        .map_err(|e| format!("registry response parse failed: {}", e))?;

    Ok(body
        .get("dist-tags")
        .and_then(|tags| tags.get("latest"))
        .and_then(|latest| latest.as_str())
        .map(str::to_string))
}

fn plugin_update_state_path(workspace_path: &str) -> PathBuf {
    Path::new(workspace_path)
        .join(".opencode")
        .join("state")
        .join("plugin-update-check.json")
}

fn should_check_plugin_updates(state_path: &Path, ttl: std::time::Duration) -> bool {
    let Ok(content) = std::fs::read_to_string(state_path) else {
        return true;
    };
    let Ok(state) = serde_json::from_str::<PluginUpdateState>(&content) else {
        return true;
    };

    current_time_ms().saturating_sub(state.last_checked_at_ms) >= ttl.as_millis() as u64
}

fn write_plugin_update_state(state_path: &Path) -> Result<(), String> {
    if let Some(parent) = state_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create plugin update state directory {}: {}",
                parent.display(),
                e
            )
        })?;
    }

    let content = serde_json::to_string_pretty(&PluginUpdateState {
        last_checked_at_ms: current_time_ms(),
    })
    .map_err(|e| format!("Failed to serialize plugin update state: {}", e))?;

    std::fs::write(state_path, content).map_err(|e| {
        format!(
            "Failed to write plugin update state {}: {}",
            state_path.display(),
            e
        )
    })
}

fn plugin_cache_dir(workspace_path: &str, spec: &str) -> PathBuf {
    Path::new(workspace_path)
        .join(".opencode")
        .join("cache")
        .join("opencode")
        .join("packages")
        .join(normalized_plugin_cache_key(spec))
}

fn normalized_plugin_cache_key(spec: &str) -> String {
    let Some((_, version)) = split_npm_package_spec(spec) else {
        return spec.to_string();
    };
    if version.is_none() {
        return format!("{}@latest", spec);
    }
    spec.to_string()
}

fn read_installed_plugin_version(
    cache_dir: &Path,
    package_name: &str,
) -> Result<Option<String>, String> {
    let package_json_path = cache_dir
        .join("node_modules")
        .join(package_name)
        .join("package.json");
    if !package_json_path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&package_json_path).map_err(|e| {
        format!(
            "Failed to read plugin package.json {}: {}",
            package_json_path.display(),
            e
        )
    })?;
    let package_json: serde_json::Value = serde_json::from_str(&content).map_err(|e| {
        format!(
            "Failed to parse plugin package.json {}: {}",
            package_json_path.display(),
            e
        )
    })?;

    Ok(package_json
        .get("version")
        .and_then(|value| value.as_str())
        .map(str::to_string))
}

fn is_remote_version_newer(local_version: &str, remote_version: &str) -> bool {
    match (
        semver::Version::parse(local_version),
        semver::Version::parse(remote_version),
    ) {
        (Ok(local), Ok(remote)) => remote > local,
        _ => local_version != remote_version,
    }
}

fn current_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Inherent skill definition: a skill that TeamClaw auto-provisions in every workspace.
struct InherentSkill {
    /// Directory name under `.opencode/skills/`
    dirname: &'static str,
    /// Full content of SKILL.md
    content: &'static str,
}

/// Desktop automation skills: only the native OS build provisions its folder; Linux has neither.
fn inherent_desktop_control_skill() -> Option<InherentSkill> {
    #[cfg(target_os = "macos")]
    return Some(InherentSkill {
        dirname: "macos-control",
        content: include_str!("../../../packages/app/src/lib/skills/macos-control/SKILL.md"),
    });

    #[cfg(target_os = "windows")]
    return Some(InherentSkill {
        dirname: "windows-control",
        content: include_str!("../../../packages/app/src/lib/skills/windows-control/SKILL.md"),
    });

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return None;
}

fn inherent_skills_common() -> Vec<InherentSkill> {
    vec![
        InherentSkill {
            dirname: "create-role",
            content: include_str!("../../../packages/app/src/lib/skills/create-role/SKILL.md"),
        },
        InherentSkill {
            dirname: "ai-keys",
            content: include_str!("../../../packages/app/src/lib/skills/ai-keys/SKILL.md"),
        },
        InherentSkill {
            dirname: "ai-usage",
            content: include_str!("../../../packages/app/src/lib/skills/ai-usage/SKILL.md"),
        },
        InherentSkill {
            dirname: "ai-manage",
            content: include_str!("../../../packages/app/src/lib/skills/ai-manage/SKILL.md"),
        },
    ]
}

/// All skills that TeamClaw treats as inherent (auto-provisioned, shown as built-in in UI).
fn inherent_skills() -> Vec<InherentSkill> {
    let mut out = Vec::new();
    if let Some(sk) = inherent_desktop_control_skill() {
        out.push(sk);
    }
    out.extend(inherent_skills_common());
    out
}

/// Drops `macos-control` / `windows-control` under `.opencode/skills/` when they do not match
/// the host OS so OpenCode only registers the correct built-in desktop skill (none on Linux).
fn remove_non_native_desktop_control_skills(skills_dir: &std::path::Path) {
    let remove_if_dir = |name: &str| {
        let path = skills_dir.join(name);
        if path.is_dir() {
            match std::fs::remove_dir_all(&path) {
                Ok(()) => println!(
                    "[Skills] Removed non-native desktop skill directory '{}'",
                    name
                ),
                Err(e) => println!(
                    "[Skills] Warning: could not remove '{}': {}",
                    path.display(),
                    e
                ),
            }
        }
    };

    #[cfg(target_os = "macos")]
    remove_if_dir("windows-control");
    #[cfg(target_os = "windows")]
    remove_if_dir("macos-control");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        remove_if_dir("macos-control");
        remove_if_dir("windows-control");
    }
}

/// Scan `~/.agents/skills/` for bundle directories (e.g. `superpowers/`) and
/// create symlinks in `target_skills_dir` for each nested skill, so OpenCode
/// discovers them alongside inherent skills without modifying `opencode.json`.
///
/// A "bundle directory" is a subdirectory of `~/.agents/skills/` that does NOT
/// contain a `SKILL.md` at its root but contains child directories that do.
fn symlink_bundle_skills(target_skills_dir: &std::path::Path) {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return,
    };
    let agents_skills_dir = std::path::PathBuf::from(&home).join(".agents/skills");
    if !agents_skills_dir.is_dir() {
        return;
    }

    let entries = match std::fs::read_dir(&agents_skills_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let bundle_path = entry.path();
        if !bundle_path.is_dir() || bundle_path.join("SKILL.md").exists() {
            continue;
        }

        let nested = match std::fs::read_dir(&bundle_path) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for nested_entry in nested.flatten() {
            let skill_src = nested_entry.path();
            if !skill_src.is_dir() || !skill_src.join("SKILL.md").exists() {
                continue;
            }
            let skill_name = match nested_entry.file_name().into_string() {
                Ok(n) => n,
                Err(_) => continue,
            };
            let link_path = target_skills_dir.join(&skill_name);

            if link_path.exists() || link_path.symlink_metadata().is_ok() {
                continue;
            }

            #[cfg(unix)]
            {
                if let Err(e) = std::os::unix::fs::symlink(&skill_src, &link_path) {
                    println!(
                        "[Skills] Warning: failed to symlink '{}' -> '{}': {}",
                        link_path.display(),
                        skill_src.display(),
                        e
                    );
                } else {
                    println!(
                        "[Skills] Linked bundle skill '{}' -> {}",
                        skill_name,
                        skill_src.display()
                    );
                }
            }

            #[cfg(windows)]
            {
                if let Err(e) = std::os::windows::fs::symlink_dir(&skill_src, &link_path) {
                    println!(
                        "[Skills] Warning: failed to symlink '{}' -> '{}': {}",
                        link_path.display(),
                        skill_src.display(),
                        e
                    );
                } else {
                    println!(
                        "[Skills] Linked bundle skill '{}' -> {}",
                        skill_name,
                        skill_src.display()
                    );
                }
            }
        }
    }
}

/// Ensure inherent skills are present in `<workspace>/.opencode/skills/`.
/// Skills are written only when the SKILL.md does not yet exist — existing
/// files (including user-customised versions) are never overwritten.
fn ensure_inherent_skills(workspace_path: &str) -> Result<(), String> {
    let skills_dir = std::path::PathBuf::from(workspace_path)
        .join(".opencode")
        .join("skills");

    if !skills_dir.exists() {
        std::fs::create_dir_all(&skills_dir)
            .map_err(|e| format!("Failed to create skills dir: {}", e))?;
    }

    remove_non_native_desktop_control_skills(&skills_dir);

    for skill in inherent_skills() {
        let skill_dir = skills_dir.join(skill.dirname);
        let skill_md = skill_dir.join("SKILL.md");

        if skill_md.exists() {
            continue;
        }

        if !skill_dir.exists() {
            std::fs::create_dir_all(&skill_dir)
                .map_err(|e| format!("Failed to create skill dir '{}': {}", skill.dirname, e))?;
        }

        std::fs::write(&skill_md, skill.content)
            .map_err(|e| format!("Failed to write skill '{}': {}", skill.dirname, e))?;

        println!("[Skills] Provisioned inherent skill '{}'", skill.dirname);
    }

    symlink_bundle_skills(&skills_dir);

    Ok(())
}

/// Resolve architecture-specific binary paths in `opencode.json`.
///
/// MCP server commands that reference `src-tauri/binaries/` may contain a
/// target triple for a different architecture (e.g. `aarch64-apple-darwin` on
/// an `x86_64` machine). This function rewrites those paths so OpenCode spawns
/// the correct binary for the current platform.
fn resolve_sidecar_binary_paths(workspace_path: &str) -> Result<(), String> {
    let config_path = super::mcp::get_config_path(workspace_path);
    if !config_path.exists() {
        return Ok(());
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read opencode.json: {}", e))?;

    let mut config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse opencode.json: {}", e))?;

    let target_triple = get_target_triple();
    let mut modified = false;

    if let Some(mcp) = config.get_mut("mcp") {
        if let Some(mcp_obj) = mcp.as_object_mut() {
            for (name, server) in mcp_obj.iter_mut() {
                if let Some(command) = server.get_mut("command") {
                    if let Some(arr) = command.as_array_mut() {
                        for item in arr.iter_mut() {
                            if let Some(cmd_str) = item.as_str() {
                                // Fix legacy relative paths like ./binaries/teamclaw-introspect
                                if cmd_str.starts_with("./binaries/teamclaw-introspect") {
                                    let abs_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                                        .join("binaries")
                                        .join(format!("teamclaw-introspect-{}", target_triple));
                                    if abs_path.exists() {
                                        let new_cmd = abs_path.to_string_lossy().to_string();
                                        println!(
                                            "[OpenCode] Resolved MCP '{}' binary: {} -> {}",
                                            name, cmd_str, new_cmd
                                        );
                                        *item = serde_json::Value::String(new_cmd);
                                        modified = true;
                                    }
                                    continue;
                                }
                                // Only touch paths that reference our bundled binaries
                                if !cmd_str.contains("src-tauri/binaries/") {
                                    continue;
                                }
                                for triple in KNOWN_TRIPLES {
                                    if cmd_str.contains(triple) && *triple != target_triple {
                                        let new_cmd = cmd_str.replace(triple, &target_triple);
                                        println!(
                                            "[OpenCode] Resolved MCP '{}' binary: {} -> {}",
                                            name, cmd_str, new_cmd
                                        );
                                        *item = serde_json::Value::String(new_cmd);
                                        modified = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if modified {
        let new_content = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize opencode.json: {}", e))?;
        std::fs::write(&config_path, &new_content)
            .map_err(|e| format!("Failed to write opencode.json: {}", e))?;
        println!(
            "[OpenCode] Updated opencode.json binary paths for target: {}",
            target_triple
        );
    }

    Ok(())
}

// ─── Secret / env-var helpers for MCP config ────────────────────────────
//
// teamclaw stores personal API keys in a local encrypted secret blob.
// Legacy keychain data is consulted only as first-read migration input.
// opencode.json
// references them via ${KEY_NAME}.  OpenCode passes environment values
// literally to MCP server processes, so we must:
//   1. Read personal secrets from the local encrypted store
//   2. Write resolved values into opencode.json before OpenCode starts
//   3. Restore the ${KEY} references after all MCP servers have connected

fn load_local_personal_secrets_from_blob<F>(
    paths: &super::local_secret_store::SecretStorePaths,
    legacy_reader: F,
) -> Result<Vec<(String, String)>, String>
where
    F: FnOnce() -> Result<Option<serde_json::Map<String, serde_json::Value>>, String>,
{
    let blob = super::local_secret_store::read_or_migrate_secret_blob(paths, legacy_reader)?;
    Ok(blob
        .into_iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
        .collect())
}

fn load_local_personal_secrets_from_paths(
    workspace_path: &str,
    paths: &super::local_secret_store::SecretStorePaths,
) -> Result<Vec<(String, String)>, String> {
    load_local_personal_secrets_from_blob(paths, || {
        super::env_vars::read_legacy_keychain_blob(workspace_path)
    })
}

/// Read all personal env vars from the local encrypted secret blob.
/// Returns `(secrets, failed)` — failed is always empty on success, or contains
/// a diagnostic sentinel if the blob itself cannot be read.
fn load_local_personal_secrets(workspace_path: &str) -> (Vec<(String, String)>, Vec<String>) {
    let paths = match super::local_secret_store::SecretStorePaths::for_home_dir() {
        Ok(paths) => paths,
        Err(e) => {
            eprintln!(
                "[OpenCode] Failed to resolve local encrypted secret store path: {}",
                e
            );
            return (Vec::new(), vec!["__blob__".to_string()]);
        }
    };

    match load_local_personal_secrets_from_paths(workspace_path, &paths) {
        Ok(blob) => {
            println!(
                "[OpenCode] Loaded {} personal secrets from local encrypted store",
                blob.len()
            );
            (blob, Vec::new())
        }
        Err(e) => {
            eprintln!(
                "[OpenCode] Failed to read local encrypted secret blob: {}",
                e
            );
            (Vec::new(), vec!["__blob__".to_string()])
        }
    }
}

/// Replace `${KEY}` references in opencode.json MCP environment sections
/// with actual values.  Writes the resolved config to disk.
///
/// Returns the original file content if any substitutions were made (caller
/// must restore it later), or `None` if nothing changed.
fn resolve_config_secret_refs(
    workspace_path: &str,
    secrets: &[(String, String)],
) -> Option<String> {
    if secrets.is_empty() {
        return None;
    }

    let config_path = super::mcp::get_config_path(workspace_path);
    let original = std::fs::read_to_string(&config_path).ok()?;

    // Simple string replacement on the raw JSON — avoids re-serialization
    // artefacts (key ordering, whitespace).  Safe because secret values
    // never contain `${`.
    let mut resolved = original.clone();
    let mut changed = false;
    for (key, value) in secrets {
        let placeholder = format!("${{{}}}", key); // ${KEY}
        if resolved.contains(&placeholder) {
            println!(
                "[OpenCode] Replacing placeholder: {} (value length: {})",
                placeholder,
                value.len()
            );
            resolved = resolved.replace(&placeholder, value);
            changed = true;
        }
        let placeholder_bare = format!("${}", key); // $KEY  (no braces)
        if resolved.contains(&placeholder_bare) {
            resolved = resolved.replace(&placeholder_bare, value);
            changed = true;
        }
    }

    if changed {
        let _ = std::fs::write(&config_path, &resolved);
        println!(
            "[OpenCode] Resolved secret references in opencode.json ({} secrets)",
            secrets.len()
        );
        Some(original)
    } else {
        None
    }
}

/// Restore the original opencode.json content (with ${KEY} placeholders),
/// but keep provider apiKey values resolved since opencode re-reads the
/// config at request time.
fn restore_config(workspace_path: &str, original: &Option<String>, secrets: &[(String, String)]) {
    if let Some(ref content) = original {
        let restored = resolve_provider_api_keys(content, secrets);
        let config_path = super::mcp::get_config_path(workspace_path);
        let _ = std::fs::write(&config_path, &restored);
    }
}

/// Resolve only `provider.*.options.apiKey` values in the JSON content.
/// Other ${KEY} references (e.g. MCP env vars) are left as placeholders
/// so they don't linger as plaintext on disk.
fn resolve_provider_api_keys(content: &str, secrets: &[(String, String)]) -> String {
    let mut json: serde_json::Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(_) => return content.to_string(),
    };

    let mut changed = false;
    if let Some(providers) = json.get_mut("provider").and_then(|p| p.as_object_mut()) {
        for (_id, provider) in providers.iter_mut() {
            if let Some(api_key) = provider
                .get_mut("options")
                .and_then(|o| o.get_mut("apiKey"))
                .and_then(|v| v.as_str().map(|s| s.to_string()))
            {
                // Check if value contains a ${KEY} reference
                if let Some(start) = api_key.find("${") {
                    if let Some(end) = api_key[start..].find('}') {
                        let key_name = &api_key[start + 2..start + end];
                        if let Some((_, value)) = secrets.iter().find(|(k, _)| k == key_name) {
                            let resolved = api_key.replace(&format!("${{{}}}", key_name), value);
                            provider["options"]["apiKey"] = serde_json::Value::String(resolved);
                            changed = true;
                        }
                    }
                }
            }
        }
    }

    if changed {
        serde_json::to_string_pretty(&json).unwrap_or_else(|_| content.to_string())
    } else {
        content.to_string()
    }
}

/// Wait for all MCP servers to connect, then restore the original config.
///
/// Polls the `/mcp` endpoint every 500ms up to 30s.  Restores unconditionally
/// on timeout to avoid leaving plaintext secrets on disk.
async fn schedule_config_restore(
    port: u16,
    workspace_path: &str,
    original: &str,
    secrets: Vec<(String, String)>,
) {
    let config_path = super::mcp::get_config_path(workspace_path);
    let restored = resolve_provider_api_keys(original, &secrets);
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(30);

    while start.elapsed() < timeout {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if check_mcp_servers_ready(port).await {
            let _ = std::fs::write(&config_path, &restored);
            println!(
                "[OpenCode] Restored opencode.json ({:.1}s, after MCP servers connected)",
                start.elapsed().as_secs_f32()
            );
            return;
        }
    }

    // Timeout — restore anyway
    eprintln!("[OpenCode] MCP servers not ready after 30s, restoring config anyway");
    let _ = std::fs::write(&config_path, &restored);
}

/// Check if a port is in use by attempting to bind to it
/// This is more reliable than trying to connect, as it directly checks if the port is available
async fn is_port_in_use(port: u16) -> bool {
    match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => {
            // Port is available - drop the listener to free it immediately
            drop(listener);
            false
        }
        Err(_) => {
            // Port is occupied
            true
        }
    }
}

/// Returns OS-specific hint for manually killing the process on the given port.
fn manual_kill_port_hint(port: u16) -> String {
    if cfg!(target_os = "windows") {
        format!(
            "PowerShell: $p = Get-NetTCPConnection -LocalPort {} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($p) {{ Stop-Process -Id $p -Force }}\n\n\
            Or: netstat -ano | findstr :{}  (then: taskkill /PID <PID> /F)",
            port, port
        )
    } else {
        format!("lsof -ti :{} | xargs kill -9", port)
    }
}

/// Kill any process occupying the given port (likely our own zombie process).
/// Uses OS-specific commands (lsof/kill on Unix, netstat/taskkill on Windows).
#[cfg(target_os = "windows")]
async fn kill_process_on_port(port: u16) -> bool {
    kill_process_on_port_windows(port).await
}

#[cfg(not(target_os = "windows"))]
async fn kill_process_on_port(port: u16) -> bool {
    kill_process_on_port_unix(port).await
}

#[cfg(target_os = "windows")]
async fn kill_process_on_port_windows(port: u16) -> bool {
    use std::process::Command;

    let output = Command::new("netstat").args(["-ano"]).output();

    let Ok(output) = output else {
        println!("[OpenCode] Failed to run netstat on port {}", port);
        return false;
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let port_needle = format!(":{}", port);
    let mut pids: Vec<&str> = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.contains(&port_needle) && line.contains("LISTENING") {
            if let Some(pid) = line.split_whitespace().last() {
                if pid.parse::<u32>().is_ok() {
                    pids.push(pid);
                }
            }
        }
    }

    if pids.is_empty() {
        println!("[OpenCode] No process found on port {} via netstat", port);
        return false;
    }

    let mut killed_any = false;
    for pid in pids {
        if pid.is_empty() {
            continue;
        }
        println!("[OpenCode] Killing zombie process {} on port {}", pid, port);
        let _ = Command::new("taskkill").args(["/PID", pid, "/F"]).output();
        killed_any = true;
    }

    if killed_any {
        for i in 0..10 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            if !is_port_in_use(port).await {
                println!(
                    "[OpenCode] Port {} released after killing zombie ({}ms)",
                    port,
                    (i + 1) * 200
                );
                return true;
            }
        }
    }

    !is_port_in_use(port).await
}

#[cfg(not(target_os = "windows"))]
async fn kill_process_on_port_unix(port: u16) -> bool {
    use std::process::Command;

    let output = Command::new("lsof")
        .args(["-ti", &format!(":{}", port)])
        .output();

    match output {
        Ok(output) if output.status.success() => {
            let pids = String::from_utf8_lossy(&output.stdout);
            let mut killed_any = false;
            for pid in pids.trim().lines() {
                let pid = pid.trim();
                if !pid.is_empty() {
                    println!("[OpenCode] Killing zombie process {} on port {}", pid, port);
                    let _ = Command::new("kill").args(["-9", pid]).output();
                    killed_any = true;
                }
            }
            if killed_any {
                for i in 0..10 {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    if !is_port_in_use(port).await {
                        println!(
                            "[OpenCode] Port {} released after killing zombie ({}ms)",
                            port,
                            (i + 1) * 200
                        );
                        return true;
                    }
                }
            }
            !is_port_in_use(port).await
        }
        _ => {
            println!(
                "[OpenCode] Failed to find process on port {} via lsof",
                port
            );
            false
        }
    }
}

/// Check if all enabled MCP servers are connected.
///
/// Queries the `/mcp` endpoint and checks that every enabled server has
/// status "connected". Returns false if any enabled server is still starting.
async fn check_mcp_servers_ready(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/mcp", port);
    match reqwest::get(&url).await {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(obj) = json.as_object() {
                    let all_ready = obj.values().all(|server| {
                        let status = server.get("status").and_then(|s| s.as_str()).unwrap_or("");
                        // "connected" means running; "disabled" is intentionally off
                        status == "connected" || status == "disabled"
                    });
                    return all_ready && !obj.is_empty();
                }
            }
            false
        }
        _ => false,
    }
}

/// Check if OpenCode server is healthy.
/// Uses `/session` (the first endpoint the frontend calls) instead of `/project`
/// to ensure the session API is fully initialized before declaring ready.
async fn check_server_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/session", port);
    match reqwest::get(&url).await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// Get the current path from OpenCode server
/// Returns (directory, worktree) - directory is the actual cwd, worktree is the git root
async fn get_server_paths(port: u16) -> (Option<String>, Option<String>) {
    let url = format!("http://127.0.0.1:{}/path", port);
    if let Ok(resp) = reqwest::get(&url).await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                println!("[OpenCode] /path response: {:?}", json);
                let directory = json
                    .get("directory")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let worktree = json
                    .get("worktree")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                return (directory, worktree);
            }
        }
    }

    (None, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::local_secret_store::{self, SecretStorePaths};
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use tempfile::tempdir;

    fn home_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct HomeGuard {
        original_home: Option<std::ffi::OsString>,
    }

    impl HomeGuard {
        fn set(path: &Path) -> Self {
            let original_home = std::env::var_os("HOME");
            std::env::set_var("HOME", path);
            Self { original_home }
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.original_home {
                Some(value) => std::env::set_var("HOME", value),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    #[test]
    fn load_local_personal_secrets_prefers_existing_encrypted_blob_without_legacy_read() {
        let _home_guard = home_lock().lock().unwrap();
        let home_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());
        let paths = SecretStorePaths::for_home_dir().unwrap();

        let mut map = serde_json::Map::new();
        map.insert(
            "OPENAI_API_KEY".into(),
            serde_json::Value::String("local-secret".into()),
        );
        map.insert("IGNORED".into(), serde_json::json!(123));
        local_secret_store::write_secret_blob(&paths, &map).unwrap();

        let legacy_reader_called = AtomicBool::new(false);
        let secrets = load_local_personal_secrets_from_blob(&paths, || {
            legacy_reader_called.store(true, Ordering::SeqCst);
            Ok(Some(serde_json::Map::new()))
        })
        .unwrap();

        assert_eq!(
            secrets,
            vec![("OPENAI_API_KEY".to_string(), "local-secret".to_string())]
        );
        assert!(!legacy_reader_called.load(Ordering::SeqCst));
    }

    #[test]
    fn load_local_personal_secrets_migrates_from_legacy_reader_not_read_env_blob() {
        let _home_guard = home_lock().lock().unwrap();
        let home_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());
        let workspace_dir = tempdir().unwrap();
        let workspace_path = workspace_dir.path().to_string_lossy().to_string();

        let home_paths = SecretStorePaths::for_home_dir().unwrap();
        let mut home_map = serde_json::Map::new();
        home_map.insert(
            "OPENAI_API_KEY".into(),
            serde_json::Value::String("from-read-env-blob".into()),
        );
        local_secret_store::write_secret_blob(&home_paths, &home_map).unwrap();

        let legacy_blob_dir = home_dir.path().join(concat!(".", env!("APP_SHORT_NAME")));
        std::fs::create_dir_all(&legacy_blob_dir).unwrap();
        let mut legacy_map = serde_json::Map::new();
        legacy_map.insert(
            "OPENAI_API_KEY".into(),
            serde_json::Value::String("from-legacy-reader".into()),
        );
        std::fs::write(
            legacy_blob_dir.join("env-blob.json"),
            serde_json::to_vec(&legacy_map).unwrap(),
        )
        .unwrap();

        let custom_store_dir = tempdir().unwrap();
        let custom_paths = SecretStorePaths::for_base_dir(custom_store_dir.path().join("secrets"));

        let secrets =
            load_local_personal_secrets_from_paths(&workspace_path, &custom_paths).unwrap();

        assert_eq!(
            secrets,
            vec![(
                "OPENAI_API_KEY".to_string(),
                "from-legacy-reader".to_string()
            )]
        );

        let migrated = local_secret_store::read_secret_blob(&custom_paths).unwrap();
        assert_eq!(
            migrated.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("from-legacy-reader")
        );
    }
}

/// Stop OpenCode sidecar(s) (production) or clear running state (dev).
///
/// `workspace_path = None` shuts down ALL instances (used by `RunEvent::Exit`
/// and the back-compat `stop_opencode` command). `Some(ws)` shuts down only
/// the named instance — Phase 2 will use this for per-window cleanup.
pub async fn shutdown_opencode(
    state: &OpenCodeState,
    workspace_path: Option<&str>,
) -> Result<(), String> {
    let is_dev_mode = state.is_dev_mode;

    // Snapshot the targets we need to kill (workspace_path, port, child, reader_handle).
    // We remove entries from the map up-front so any concurrent caller sees a clean slate.
    let targets: Vec<(
        String,
        u16,
        Option<CommandChild>,
        Option<tauri::async_runtime::JoinHandle<()>>,
    )> = {
        let mut instances = state.instances.lock().map_err(|e| e.to_string())?;
        let keys: Vec<String> = match workspace_path {
            Some(ws) => {
                if instances.contains_key(ws) {
                    vec![ws.to_string()]
                } else {
                    return Ok(());
                }
            }
            None => instances.keys().cloned().collect(),
        };
        keys.into_iter()
            .filter_map(|k| {
                instances.remove(&k).map(|mut inner| {
                    let child = inner.child_process.take();
                    let reader = inner.reader_task.take();
                    (k, inner.port, child, reader)
                })
            })
            .collect()
    };

    if targets.is_empty() {
        return Ok(());
    }

    for (ws, port, child, reader) in targets {
        if is_dev_mode {
            // External server — don't kill, just clear state (already removed above).
            println!("[OpenCode] Dev mode: cleared state for {}", ws);
            continue;
        }

        if let Some(child) = child {
            if let Err(e) = child.kill() {
                eprintln!("[OpenCode] Failed to kill sidecar for {}: {}", ws, e);
            }
        }
        if let Some(handle) = reader {
            handle.abort();
        }

        // Wait for port to be released with exponential backoff
        println!(
            "[OpenCode] Waiting for graceful shutdown of {} (port {})...",
            ws, port
        );
        let start_time = std::time::Instant::now();
        const MAX_WAIT_TIME: std::time::Duration = std::time::Duration::from_secs(5);
        let mut delay = std::time::Duration::from_millis(100);

        loop {
            if !is_port_in_use(port).await {
                println!(
                    "[OpenCode] Shutdown of {} complete after {:.1}s",
                    ws,
                    start_time.elapsed().as_secs_f32()
                );
                break;
            }

            if start_time.elapsed() >= MAX_WAIT_TIME {
                println!(
                    "[OpenCode] Warning: process for {} did not release port {} after 5s",
                    ws, port
                );
                break;
            }

            tokio::time::sleep(delay).await;
            delay = std::cmp::min(delay * 2, std::time::Duration::from_secs(1));
        }
    }

    Ok(())
}

/// Stop OpenCode server (back-compat: shuts down all instances).
#[tauri::command]
pub async fn stop_opencode(state: State<'_, OpenCodeState>) -> Result<(), String> {
    shutdown_opencode(&state, None).await
}

// ─── OpenCode DB allowlist commands ──────────────────────────────────

fn get_opencode_db_path(workspace_path: &str) -> Result<String, String> {
    // With XDG isolation, the DB lives at <workspace>/.opencode/data/opencode/opencode.db
    let isolated_path =
        std::path::PathBuf::from(workspace_path).join(".opencode/data/opencode/opencode.db");
    if isolated_path.exists() {
        return Ok(isolated_path.to_string_lossy().to_string());
    }

    // Fallback to legacy global path for workspaces that haven't been re-launched yet
    let home =
        std::env::var("HOME").map_err(|_| "HOME environment variable not set".to_string())?;
    let legacy_path = format!("{}/.local/share/opencode/opencode.db", home);
    if std::path::Path::new(&legacy_path).exists() {
        return Ok(legacy_path);
    }

    Err(format!(
        "OpenCode database not found at: {} or {}",
        isolated_path.display(),
        legacy_path
    ))
}

/// Look up the project_id for a given workspace path from the project table.
/// OpenCode assigns project_id based on the working directory:
///   - git repos get a SHA1 hash of the canonical path
///   - non-git directories use "global"
#[tauri::command]
pub async fn get_opencode_project_id(workspace_path: String) -> Result<String, String> {
    let db_path = get_opencode_db_path(&workspace_path)?;
    let normalized = workspace_path.trim_end_matches('/');

    let output = std::process::Command::new("sqlite3")
        .args([&db_path, "-json", "SELECT id, worktree FROM project;"])
        .output()
        .map_err(|e| format!("Failed to run sqlite3: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no such table") {
            return Ok("global".to_string());
        }
        return Err(format!("sqlite3 error: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok("global".to_string());
    }

    #[derive(Deserialize)]
    struct ProjectRow {
        id: String,
        worktree: String,
    }

    let rows: Vec<ProjectRow> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse output: {}", e))?;

    for row in &rows {
        let row_worktree = row.worktree.trim_end_matches('/');
        if row_worktree == normalized && row.id != "global" {
            return Ok(row.id.clone());
        }
    }

    // No matching project found — this workspace uses "global"
    Ok("global".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRule {
    pub permission: String,
    pub pattern: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowlistRow {
    pub project_id: String,
    pub rules: Vec<PermissionRule>,
    pub time_created: Option<i64>,
    pub time_updated: Option<i64>,
}

/// Read all permission allowlist rows from the opencode.db permission table.
#[tauri::command]
pub async fn read_opencode_allowlist(workspace_path: String) -> Result<Vec<AllowlistRow>, String> {
    let db_path = get_opencode_db_path(&workspace_path)?;

    let output = std::process::Command::new("sqlite3")
        .args([
            &db_path,
            "-json",
            "SELECT project_id, data, time_created, time_updated FROM permission;",
        ])
        .output()
        .map_err(|e| format!("Failed to run sqlite3: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no such table") {
            return Ok(Vec::new());
        }
        return Err(format!("sqlite3 error: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(Vec::new());
    }

    #[derive(Deserialize)]
    struct RawRow {
        project_id: String,
        data: String,
        time_created: Option<i64>,
        time_updated: Option<i64>,
    }

    let raw_rows: Vec<RawRow> = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse sqlite3 output: {}", e))?;

    let mut result = Vec::new();
    for row in raw_rows {
        let rules: Vec<PermissionRule> = serde_json::from_str(&row.data).unwrap_or_default();
        result.push(AllowlistRow {
            project_id: row.project_id,
            rules,
            time_created: row.time_created,
            time_updated: row.time_updated,
        });
    }

    Ok(result)
}

/// Write (replace) the allowlist rules for a specific project_id in opencode.db.
/// Pass an empty `rules` array to delete the entry.
#[tauri::command]
pub async fn write_opencode_allowlist(
    workspace_path: String,
    project_id: String,
    rules: Vec<PermissionRule>,
) -> Result<(), String> {
    let db_path = get_opencode_db_path(&workspace_path)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    if rules.is_empty() {
        let output = std::process::Command::new("sqlite3")
            .args([
                &db_path,
                &format!(
                    "DELETE FROM permission WHERE project_id = '{}';",
                    project_id.replace('\'', "''")
                ),
            ])
            .output()
            .map_err(|e| format!("Failed to run sqlite3: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("sqlite3 error: {}", stderr));
        }
    } else {
        let data_json = serde_json::to_string(&rules)
            .map_err(|e| format!("Failed to serialize rules: {}", e))?;
        let escaped_json = data_json.replace('\'', "''");
        let escaped_id = project_id.replace('\'', "''");

        let sql = format!(
            "INSERT OR REPLACE INTO permission (project_id, time_created, time_updated, data) \
             VALUES ('{}', {}, {}, '{}');",
            escaped_id, now_ms, now_ms, escaped_json,
        );

        let output = std::process::Command::new("sqlite3")
            .args([&db_path, &sql])
            .output()
            .map_err(|e| format!("Failed to run sqlite3: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("sqlite3 error: {}", stderr));
        }
    }

    println!(
        "[OpenCode] Updated allowlist for project '{}': {} rules",
        project_id,
        rules.len()
    );
    Ok(())
}

/// Path to the file that persists the last workspace for early launch.
fn last_workspace_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home)
        .join(super::TEAMCLAW_DIR)
        .join("last-workspace.json")
}

/// Read the last workspace path from ~/.teamclaw/last-workspace.json.
pub fn read_last_workspace() -> Option<String> {
    let path = last_workspace_path();
    let content = std::fs::read_to_string(&path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let ws = json.get("workspace_path")?.as_str()?;
    // Verify the directory still exists
    if std::path::Path::new(ws).is_dir() {
        Some(ws.to_string())
    } else {
        #[cfg(debug_assertions)]
        eprintln!(
            "[EarlyLaunch] Last workspace '{}' no longer exists, skipping",
            ws
        );
        None
    }
}

/// Persist the workspace path for next launch.
fn write_last_workspace(workspace_path: &str) {
    let path = last_workspace_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::json!({ "workspace_path": workspace_path });
    let _ = std::fs::write(
        &path,
        serde_json::to_string_pretty(&json).unwrap_or_default(),
    );
}

/// Remove the persisted last-workspace so the next launch shows the workspace picker.
#[tauri::command]
pub fn clear_last_workspace() {
    let path = last_workspace_path();
    let _ = std::fs::remove_file(&path);
}

/// Get OpenCode server status.
///
/// Single-instance flow: returns the lone instance's status. Zero instances:
/// returns a placeholder `is_running: false` on `DEFAULT_PORT` so the frontend
/// can boot before a workspace is selected. Two-or-more instances: error
/// (Phase 2 will add a workspace-aware variant).
#[tauri::command]
pub async fn get_opencode_status(
    state: State<'_, OpenCodeState>,
) -> Result<OpenCodeStatus, String> {
    let is_dev_mode = state.is_dev_mode;
    let instances = state.instances.lock().map_err(|e| e.to_string())?;
    match instances.len() {
        0 => Ok(OpenCodeStatus {
            is_running: false,
            port: DEFAULT_PORT,
            url: format!("http://127.0.0.1:{}", DEFAULT_PORT),
            is_dev_mode,
            workspace_path: None,
        }),
        1 => {
            let (ws, inner) = instances.iter().next().unwrap();
            Ok(OpenCodeStatus {
                is_running: inner.is_running,
                port: inner.port,
                url: format!("http://127.0.0.1:{}", inner.port),
                is_dev_mode,
                workspace_path: Some(ws.clone()),
            })
        }
        n => Err(format!(
            "{} OpenCode instances active; use a workspace-aware status query",
            n
        )),
    }
}

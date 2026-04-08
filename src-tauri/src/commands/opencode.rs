use serde::{Deserialize, Serialize};
use std::env;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::mpsc;

/// Default port for the OpenCode server.
/// This is the single source of truth for the port number.
const DEFAULT_PORT: u16 = 13141;

/// Mutable runtime state for the OpenCode sidecar, protected by a single Mutex.
pub struct OpenCodeInner {
    pub is_running: bool,
    pub port: u16,
    pub child_process: Option<CommandChild>,
    pub is_dev_mode: bool,
    pub workspace_path: Option<String>,
    /// Handle to the async task monitoring sidecar stdout/stderr.
    /// Aborted on shutdown to prevent resource leaks.
    pub reader_task: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// OpenCode server state
pub struct OpenCodeState {
    pub inner: Mutex<OpenCodeInner>,
    /// Async lock that serializes `start_opencode` calls to prevent concurrent spawns.
    pub start_lock: tokio::sync::Mutex<()>,
    /// Early launch state — set by setup hook, consumed by start_opencode.
    pub early_launch: tokio::sync::Mutex<Option<EarlyLaunchState>>,
}

impl Default for OpenCodeState {
    fn default() -> Self {
        // Check if dev mode is enabled (external OpenCode server)
        let is_dev = env::var("OPENCODE_DEV_MODE")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        Self {
            inner: Mutex::new(OpenCodeInner {
                is_running: false,
                port: DEFAULT_PORT,
                child_process: None,
                is_dev_mode: is_dev,
                workspace_path: None,
                reader_task: None,
            }),
            start_lock: tokio::sync::Mutex::new(()),
            early_launch: tokio::sync::Mutex::new(None),
        }
    }
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
pub async fn start_opencode_inner(
    app: AppHandle,
    state: &OpenCodeState,
    config: OpenCodeConfig,
) -> Result<OpenCodeStatus, String> {
    #[cfg(debug_assertions)]
    let inner_t0 = std::time::Instant::now();
    // Serialize concurrent calls — only one start_opencode runs at a time.
    let _start_guard = state.start_lock.lock().await;
    #[cfg(debug_assertions)]
    eprintln!(
        "[Startup] start_opencode_inner: lock acquired in {:.1}ms",
        inner_t0.elapsed().as_secs_f64() * 1000.0
    );

    let port = config.port.unwrap_or(DEFAULT_PORT);

    // Check if already running (extract values and drop guard before any await)
    let mut needs_restart = false;
    let is_dev_mode;
    {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        is_dev_mode = inner.is_dev_mode;

        if inner.is_running {
            let workspace_changed = inner.workspace_path.as_ref() != Some(&config.workspace_path);

            if !workspace_changed {
                return Ok(OpenCodeStatus {
                    is_running: true,
                    port: inner.port,
                    url: format!("http://127.0.0.1:{}", inner.port),
                    is_dev_mode,
                    workspace_path: inner.workspace_path.clone(),
                });
            }

            println!(
                "[OpenCode] Workspace changed from {:?} to {}, restarting...",
                inner.workspace_path.as_ref(),
                config.workspace_path
            );

            needs_restart = true;
        }
    }

    if needs_restart {
        // Stop the existing server
        if !is_dev_mode {
            let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
            if let Some(child) = inner.child_process.take() {
                println!("[OpenCode] Killing previous process...");
                let _ = child.kill();
            }
            // Abort old reader task
            if let Some(handle) = inner.reader_task.take() {
                handle.abort();
            }
            inner.is_running = false;
        } else {
            let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
            inner.is_running = false;
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
            let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
            inner.is_running = true;
            inner.port = port;
            inner.workspace_path = Some(requested_path.clone());
        }

        return Ok(OpenCodeStatus {
            is_running: true,
            port,
            url: format!("http://127.0.0.1:{}", port),
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
    //   3. read_keyring_secrets (reads OS keyring, independent)
    //
    // resolve_config_secret_refs runs AFTER all three complete (depends on
    // both the config writers finishing and keyring secrets being available).

    // Ensure system env vars exist (e.g. tc_api_key) before reading keyring secrets.
    // Runs synchronously — one keychain read + optional write.
    {
        let device_id = super::oss_commands::get_device_id().unwrap_or_default();
        let ws = workspace_path.clone();
        let did = device_id.clone();
        if let Err(e) = tokio::task::spawn_blocking(move || {
            super::env_vars::ensure_system_env_vars(&ws, &did)
        }).await.map_err(|e| e.to_string()).and_then(|r| r) {
            eprintln!("[OpenCode] Warning: failed to ensure system env vars: {}", e);
        }
    }

    let ws_for_config = workspace_path.clone();
    let ws_for_skills = workspace_path.clone();
    let ws_for_keyring = workspace_path.clone();

    let (config_result, skills_result, keyring_result) = tokio::join!(
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
        // Branch 3: keyring secrets
        tokio::task::spawn_blocking(move || read_keyring_secrets(&ws_for_keyring))
    );

    // Unwrap spawn results (panics inside spawn_blocking become JoinErrors)
    if let Err(e) = config_result {
        eprintln!("[OpenCode] Config setup task panicked: {}", e);
    }
    if let Err(e) = skills_result {
        eprintln!("[OpenCode] Skills setup task panicked: {}", e);
    }

    let (mut secrets, failed_keys) = keyring_result.unwrap_or_else(|e| {
        eprintln!("[OpenCode] spawn_blocking for keyring failed: {}", e);
        (Vec::new(), Vec::new())
    });

    // Keyring retry logic (unchanged from original)
    if !failed_keys.is_empty() {
        if failed_keys == ["__blob__"] {
            println!("[OpenCode] Keychain blob unavailable, retrying after keychain unlock...");
        } else {
            println!(
                "[OpenCode] {} secret(s) failed to read ({:?}), retrying after keychain unlock...",
                failed_keys.len(),
                failed_keys
            );
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        let ws_retry = workspace_path.clone();
        let (retry_secrets, still_failed) =
            tokio::task::spawn_blocking(move || read_keyring_secrets(&ws_retry))
                .await
                .unwrap_or_else(|e| {
                    eprintln!("[OpenCode] spawn_blocking for keyring retry failed: {}", e);
                    (Vec::new(), Vec::new())
                });

        if !still_failed.is_empty() {
            if still_failed == ["__blob__"] {
                eprintln!("[OpenCode] Warning: keychain blob still unavailable after retry");
            } else {
                eprintln!(
                    "[OpenCode] Warning: {} secret(s) still unavailable after retry: {:?}",
                    still_failed.len(),
                    still_failed
                );
            }
        }

        secrets = retry_secrets;
    }

    // Merge shared secrets (team KMS) into secrets vec.
    // Shared secrets take priority over local keyring entries with the same key.
    //
    // Lazy init: if shared secrets haven't been initialized yet (e.g. early launch
    // before oss_restore_sync), try to read team config and init from disk.
    if let Some(shared_state) = app.try_state::<super::shared_secrets::SharedSecretsState>() {
        {
            let dk = shared_state.derived_key.lock().unwrap_or_else(|p| p.into_inner());
            if dk.is_none() {
                drop(dk);
                // Try to init from workspace team config
                let config_path = format!(
                    "{}/{}/{}",
                    workspace_path,
                    super::TEAMCLAW_DIR,
                    super::CONFIG_FILE_NAME
                );
                if let Ok(content) = std::fs::read_to_string(&config_path) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(oss) = json.get("oss") {
                            if let (Some(team_id), Some(true)) = (
                                oss.get("teamId").and_then(|v| v.as_str()),
                                oss.get("enabled").and_then(|v| v.as_bool()),
                            ) {
                                if let Ok(team_secret) = super::oss_sync::load_team_secret(&workspace_path, team_id) {
                                    let team_dir = std::path::Path::new(&workspace_path)
                                        .join(super::TEAM_REPO_DIR);
                                    match super::shared_secrets::init_shared_secrets(
                                        &shared_state,
                                        &team_secret,
                                        &team_dir,
                                    ) {
                                        Ok(()) => println!("[OpenCode] Lazy-initialized shared secrets from disk"),
                                        Err(e) => eprintln!("[OpenCode] Failed to lazy-init shared secrets: {}", e),
                                    }
                                }
                            }
                        }
                    }
                }
            }
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
            println!("[OpenCode] Loaded shared secret: {} (also {})", key_id, upper_key);
            secrets.push((key_id.clone(), entry.key.clone()));
            if upper_key != *key_id {
                secrets.push((upper_key, entry.key.clone()));
            }
        }
    }

    #[cfg(debug_assertions)]
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

    // Store the child process
    {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.child_process = Some(child);
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
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.reader_task = Some(reader_handle);
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

    // Update state
    {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.is_running = true;
        inner.port = port;
        inner.workspace_path = Some(workspace_path.clone());
    }

    #[cfg(debug_assertions)]
    eprintln!(
        "[Startup] start_opencode_inner TOTAL: {:.1}ms",
        inner_t0.elapsed().as_secs_f64() * 1000.0
    );

    // Persist workspace for early launch on next startup
    write_last_workspace(&workspace_path);

    Ok(OpenCodeStatus {
        is_running: true,
        port,
        url: format!("http://127.0.0.1:{}", port),
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
// teamclaw stores API keys in the OS credential store (macOS Keychain /
// Windows Credential Manager / Linux Secret Service).  opencode.json
// references them via ${KEY_NAME}.  OpenCode passes environment values
// literally to MCP server processes, so we must:
//   1. Read secrets from the keyring
//   2. Write resolved values into opencode.json before OpenCode starts
//   3. Restore the ${KEY} references after all MCP servers have connected

/// Read all personal env vars from the single keychain blob.
/// Returns `(secrets, failed)` — failed is always empty on success, or contains
/// a diagnostic sentinel if the blob itself cannot be read.
fn read_keyring_secrets(workspace_path: &str) -> (Vec<(String, String)>, Vec<String>) {
    match super::env_vars::read_env_blob(workspace_path) {
        Ok(blob) => {
            let secrets: Vec<(String, String)> = blob
                .into_iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
                .collect();
            println!("[OpenCode] Loaded {} secrets from keychain blob", secrets.len());
            (secrets, Vec::new())
        }
        Err(e) => {
            eprintln!("[OpenCode] Failed to read keychain blob: {}", e);
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
            println!("[OpenCode] Replacing placeholder: {} (value length: {})", placeholder, value.len());
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

/// Stop OpenCode sidecar (production) or clear running state (dev). Shared by the
/// `stop_opencode` command and application exit (`RunEvent::Exit`).
pub async fn shutdown_opencode(state: &OpenCodeState) -> Result<(), String> {
    let (is_dev_mode, port) = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        (inner.is_dev_mode, inner.port)
    };

    // In dev mode, just update state (don't try to kill external process)
    if is_dev_mode {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.is_running = false;
        return Ok(());
    }

    // Production mode: kill sidecar and abort reader task
    {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        if let Some(child) = inner.child_process.take() {
            child
                .kill()
                .map_err(|e| format!("Failed to stop OpenCode: {}", e))?;
        }
        if let Some(handle) = inner.reader_task.take() {
            handle.abort();
        }
    }

    // Wait for port to be released with exponential backoff
    println!("[OpenCode] Waiting for graceful shutdown...");
    let start_time = std::time::Instant::now();
    const MAX_WAIT_TIME: std::time::Duration = std::time::Duration::from_secs(5);
    let mut delay = std::time::Duration::from_millis(100);

    loop {
        if !is_port_in_use(port).await {
            println!(
                "[OpenCode] Shutdown complete after {:.1}s",
                start_time.elapsed().as_secs_f32()
            );
            break;
        }

        if start_time.elapsed() >= MAX_WAIT_TIME {
            println!("[OpenCode] Warning: Process did not release port after 5s");
            break;
        }

        tokio::time::sleep(delay).await;
        delay = std::cmp::min(delay * 2, std::time::Duration::from_secs(1));
    }

    // Update state
    {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.is_running = false;
    }

    Ok(())
}

/// Stop OpenCode server
#[tauri::command]
pub async fn stop_opencode(state: State<'_, OpenCodeState>) -> Result<(), String> {
    shutdown_opencode(&state).await
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

/// Get OpenCode server status
#[tauri::command]
pub async fn get_opencode_status(
    state: State<'_, OpenCodeState>,
) -> Result<OpenCodeStatus, String> {
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    Ok(OpenCodeStatus {
        is_running: inner.is_running,
        port: inner.port,
        url: format!("http://127.0.0.1:{}", inner.port),
        is_dev_mode: inner.is_dev_mode,
        workspace_path: inner.workspace_path.clone(),
    })
}

use serde::{Deserialize, Serialize};
use std::env;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::mpsc;

/// Default port for the OpenCode server.
/// This is the single source of truth for the port number.
const DEFAULT_PORT: u16 = 13141;

/// OpenCode server state
pub struct OpenCodeState {
    pub is_running: Mutex<bool>,
    pub port: Mutex<u16>,
    pub child_process: Mutex<Option<CommandChild>>,
    pub is_dev_mode: Mutex<bool>,
    pub workspace_path: Mutex<Option<String>>,
    /// Async lock that serializes `start_opencode` calls to prevent concurrent spawns.
    pub start_lock: tokio::sync::Mutex<()>,
}

impl Default for OpenCodeState {
    fn default() -> Self {
        // Check if dev mode is enabled (external OpenCode server)
        let is_dev = env::var("OPENCODE_DEV_MODE")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        Self {
            is_running: Mutex::new(false),
            port: Mutex::new(DEFAULT_PORT),
            child_process: Mutex::new(None),
            is_dev_mode: Mutex::new(is_dev),
            workspace_path: Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
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

/// Start OpenCode server as a sidecar process (or connect to external in dev mode)
#[tauri::command]
pub async fn start_opencode(
    app: AppHandle,
    state: State<'_, OpenCodeState>,
    config: OpenCodeConfig,
) -> Result<OpenCodeStatus, String> {
    // Serialize concurrent calls — only one start_opencode runs at a time.
    let _start_guard = state.start_lock.lock().await;

    let is_dev_mode = *state.is_dev_mode.lock().map_err(|e| e.to_string())?;
    let port = config.port.unwrap_or(DEFAULT_PORT);

    // Check if already running (extract values and drop guards before any await)
    let mut needs_restart = false;
    {
        let is_running = *state.is_running.lock().map_err(|e| e.to_string())?;
        let current_workspace = state
            .workspace_path
            .lock()
            .map_err(|e| e.to_string())?
            .clone();

        if is_running {
            let workspace_changed = current_workspace.as_ref() != Some(&config.workspace_path);

            if !workspace_changed {
                let port = *state.port.lock().map_err(|e| e.to_string())?;
                return Ok(OpenCodeStatus {
                    is_running: true,
                    port,
                    url: format!("http://127.0.0.1:{}", port),
                    is_dev_mode,
                    workspace_path: current_workspace,
                });
            }

            println!(
                "[OpenCode] Workspace changed from {:?} to {}, restarting...",
                current_workspace.as_ref(),
                config.workspace_path
            );

            needs_restart = true;
        }
    }

    if needs_restart {
        // Stop the existing server
        if !is_dev_mode {
            let mut child_guard = state.child_process.lock().map_err(|e| e.to_string())?;
            if let Some(child) = child_guard.take() {
                println!("[OpenCode] Killing previous process...");
                let _ = child.kill();
            }
        }

        // Update state to not running
        {
            let mut is_running = state.is_running.lock().map_err(|e| e.to_string())?;
            *is_running = false;
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
            let mut is_running = state.is_running.lock().map_err(|e| e.to_string())?;
            *is_running = true;
            let mut port_guard = state.port.lock().map_err(|e| e.to_string())?;
            *port_guard = port;
            let mut workspace_guard = state.workspace_path.lock().map_err(|e| e.to_string())?;
            *workspace_guard = Some(requested_path.clone());
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

    let ws_for_config = workspace_path.clone();
    let ws_for_skills = workspace_path.clone();
    let ws_for_keyring = workspace_path.clone();

    let (config_result, skills_result, keyring_result) = tokio::join!(
        // Branch 1: opencode.json writers (must be sequential with each other)
        tokio::task::spawn_blocking(move || {
            if let Err(e) = ensure_default_permissions(&ws_for_config) {
                eprintln!("[OpenCode] Warning: failed to ensure default permissions: {}", e);
            }
            if let Err(e) = ensure_inherent_config(&ws_for_config) {
                eprintln!("[OpenCode] Warning: failed to ensure inherent configs: {}", e);
            }
            if let Err(e) = resolve_sidecar_binary_paths(&ws_for_config) {
                eprintln!("[OpenCode] Warning: failed to resolve binary paths: {}", e);
            }
        }),
        // Branch 2: inherent skills (writes to .opencode/skills/, no opencode.json conflict)
        tokio::task::spawn_blocking(move || {
            if let Err(e) = ensure_inherent_skills(&ws_for_skills) {
                eprintln!("[OpenCode] Warning: failed to ensure inherent skills: {}", e);
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
        println!(
            "[OpenCode] {} secret(s) failed to read ({:?}), retrying after keychain unlock...",
            failed_keys.len(),
            failed_keys
        );
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
            eprintln!(
                "[OpenCode] Warning: {} secret(s) still unavailable after retry: {:?}",
                still_failed.len(),
                still_failed
            );
        }

        secrets = retry_secrets;
    }

    let original_config = resolve_config_secret_refs(&workspace_path, &secrets);

    println!(
        "[OpenCode] Starting sidecar in directory: {}",
        workspace_path
    );

    // Build sidecar command, also injecting secrets as process env vars (backup)
    let mut sidecar_command = app
        .shell()
        .sidecar("opencode")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(["serve", "--port", &port_str])
        .current_dir(&workspace_path);
    for (key, value) in &secrets {
        sidecar_command = sidecar_command.env(key, value);
    }

    let (mut rx, child) = sidecar_command
        .spawn()
        .map_err(|e| format!("Failed to spawn OpenCode sidecar: {}", e))?;

    // Store the child process
    {
        let mut child_guard = state.child_process.lock().map_err(|e| e.to_string())?;
        *child_guard = Some(child);
    }

    // Wait for server to be ready
    let (ready_tx, mut ready_rx) = mpsc::channel::<bool>(1);

    let ready_tx_clone = ready_tx.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    println!("[OpenCode] {}", line_str);
                    if line_str.contains("listening")
                        || line_str.contains("started")
                        || line_str.contains("ready")
                    {
                        let _ = ready_tx_clone.send(true).await;
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    // opencode logs INFO to stderr, only print actual errors
                    if line_str.contains("Error") || line_str.contains("Failed") {
                        eprintln!("[OpenCode Error] {}", line_str);
                    } else {
                        println!("[OpenCode] {}", line_str);
                    }
                }
                CommandEvent::Error(err) => {
                    eprintln!("[OpenCode Error] {}", err);
                }
                CommandEvent::Terminated(payload) => {
                    println!(
                        "[OpenCode] Process terminated with code: {:?}",
                        payload.code
                    );
                }
                _ => {}
            }
        }
    });

    // Wait for ready signal with timeout
    let ready = tokio::time::timeout(std::time::Duration::from_secs(15), ready_rx.recv()).await;

    // If timeout, try to poll the health endpoint
    let is_ready = match ready {
        Ok(Some(true)) => true,
        _ => {
            // Fallback: poll health endpoint
            for _ in 0..20 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                if check_server_health(port).await {
                    break;
                }
            }
            check_server_health(port).await
        }
    };

    if !is_ready {
        restore_config(&workspace_path, &original_config);
        return Err("OpenCode server failed to start within timeout".to_string());
    }

    // Schedule async config restore: wait for MCP servers to connect (so they
    // read the resolved secrets), then put back the original ${KEY} references.
    if let Some(original) = original_config {
        let ws = workspace_path.clone();
        tauri::async_runtime::spawn(async move {
            schedule_config_restore(port, &ws, &original).await;
        });
    }

    // Verify the server is running in the correct workspace
    let (server_directory, _server_worktree) = get_server_paths(port).await;
    if let Some(ref dir) = server_directory {
        println!("[OpenCode] Server confirmed running in directory: {}", dir);
    }

    // Update state
    {
        let mut is_running = state.is_running.lock().map_err(|e| e.to_string())?;
        *is_running = true;
        let mut port_guard = state.port.lock().map_err(|e| e.to_string())?;
        *port_guard = port;
        let mut workspace_guard = state.workspace_path.lock().map_err(|e| e.to_string())?;
        *workspace_guard = Some(workspace_path.clone());
    }

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

/// Ensure autoui, playwright MCP configs and skill paths are present in opencode.json.
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

    // Ensure MCP section contains playwright and autoui
    {
        let mcp = obj.entry("mcp").or_insert_with(|| serde_json::json!({}));
        let mcp_obj = mcp.as_object_mut().ok_or("mcp is not an object")?;

        if !mcp_obj.contains_key("playwright") {
            mcp_obj.insert(
                "playwright".to_string(),
                serde_json::json!({
                    "type": "local",
                    "enabled": true,
                    "command": ["pnpm", "dlx", "@playwright/mcp@latest"]
                }),
            );
            changed = true;
            println!("[Config] Added inherent 'playwright' MCP config");
        }

        if !mcp_obj.contains_key("autoui") {
            mcp_obj.insert(
                "autoui".to_string(),
                serde_json::json!({
                    "type": "local",
                    "enabled": true,
                    "command": ["pnpm", "dlx", "autoui-mcp@latest"],
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

        let inherent_path = "teamclaw-team/skills";

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

/// All skills that TeamClaw treats as inherent (auto-provisioned, shown as built-in in UI).
/// Add new entries here to register additional inherent skills.
fn inherent_skills() -> Vec<InherentSkill> {
    vec![
        InherentSkill {
            dirname: "markdown-converter",
            content: include_str!(
                "../../../packages/app/src/lib/skills/markdown-converter/SKILL.md"
            ),
        },
        InherentSkill {
            dirname: "macos-control",
            content: include_str!("../../../packages/app/src/lib/skills/macos-control/SKILL.md"),
        },
        InherentSkill {
            dirname: "using-superpowers",
            content: include_str!(
                "../../../packages/app/src/lib/skills/using-superpowers/SKILL.md"
            ),
        },
    ]
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

/// Read all registered env-var secrets from the OS credential store.
///
/// Reads the key index from `.teamclaw/teamclaw.json`, looks up each value via
/// the `keyring` crate (cross-platform), and returns a tuple of
/// `(successful_secrets, failed_key_names)`.
///
/// On macOS the first access after login may trigger a system keychain
/// password dialog.  The caller should use `spawn_blocking` so the dialog
/// can block a dedicated thread without starving the async runtime.
fn read_keyring_secrets(workspace_path: &str) -> (Vec<(String, String)>, Vec<String>) {
    let path = format!("{}/{}/teamclaw.json", workspace_path, super::TEAMCLAW_DIR);
    let json: serde_json::Value = match std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
    {
        Some(v) => v,
        None => return (Vec::new(), Vec::new()),
    };

    let entries = match json.get("envVars").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return (Vec::new(), Vec::new()),
    };

    let mut secrets = Vec::new();
    let mut failed_keys = Vec::new();

    for entry in entries {
        let key = match entry.get("key").and_then(|k| k.as_str()) {
            Some(k) => k,
            None => continue,
        };
        let service = super::env_vars::keyring_service(key);
        match keyring::Entry::new(&service, "teamclaw").and_then(|e| e.get_password()) {
            Ok(value) => {
                println!(
                    "[OpenCode] Loaded secret from keyring: {} ({}...)",
                    key,
                    &value[..value.len().min(8)]
                );
                secrets.push((key.to_string(), value));
            }
            Err(e) => {
                eprintln!("[OpenCode] Failed to read keyring secret '{}': {}", key, e);
                failed_keys.push(key.to_string());
            }
        }
    }

    (secrets, failed_keys)
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

/// Restore the original opencode.json content (with ${KEY} placeholders).
fn restore_config(workspace_path: &str, original: &Option<String>) {
    if let Some(ref content) = original {
        let config_path = super::mcp::get_config_path(workspace_path);
        let _ = std::fs::write(&config_path, content);
    }
}

/// Wait for all MCP servers to connect, then restore the original config.
///
/// Polls the `/mcp` endpoint every 500ms up to 30s.  Restores unconditionally
/// on timeout to avoid leaving plaintext secrets on disk.
async fn schedule_config_restore(port: u16, workspace_path: &str, original: &str) {
    let config_path = super::mcp::get_config_path(workspace_path);
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(30);

    while start.elapsed() < timeout {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if check_mcp_servers_ready(port).await {
            let _ = std::fs::write(&config_path, original);
            println!(
                "[OpenCode] Restored opencode.json ({:.1}s, after MCP servers connected)",
                start.elapsed().as_secs_f32()
            );
            return;
        }
    }

    // Timeout — restore anyway
    eprintln!("[OpenCode] MCP servers not ready after 30s, restoring config anyway");
    let _ = std::fs::write(&config_path, original);
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

/// Check if OpenCode server is healthy
async fn check_server_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/project", port);
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

/// Stop OpenCode server
#[tauri::command]
pub async fn stop_opencode(state: State<'_, OpenCodeState>) -> Result<(), String> {
    let is_dev_mode = *state.is_dev_mode.lock().map_err(|e| e.to_string())?;
    let port = *state.port.lock().map_err(|e| e.to_string())?;

    // In dev mode, just update state (don't try to kill external process)
    if is_dev_mode {
        let mut is_running = state.is_running.lock().map_err(|e| e.to_string())?;
        *is_running = false;
        return Ok(());
    }

    // Production mode: kill sidecar
    {
        let mut child_guard = state.child_process.lock().map_err(|e| e.to_string())?;
        if let Some(child) = child_guard.take() {
            child
                .kill()
                .map_err(|e| format!("Failed to stop OpenCode: {}", e))?;
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
        let mut is_running = state.is_running.lock().map_err(|e| e.to_string())?;
        *is_running = false;
    }

    Ok(())
}

// ─── OpenCode DB allowlist commands ──────────────────────────────────

fn get_opencode_db_path() -> Result<String, String> {
    let home =
        std::env::var("HOME").map_err(|_| "HOME environment variable not set".to_string())?;
    let path = format!("{}/.local/share/opencode/opencode.db", home);
    if !std::path::Path::new(&path).exists() {
        return Err(format!("OpenCode database not found at: {}", path));
    }
    Ok(path)
}

/// Look up the project_id for a given workspace path from the project table.
/// OpenCode assigns project_id based on the working directory:
///   - git repos get a SHA1 hash of the canonical path
///   - non-git directories use "global"
#[tauri::command]
pub async fn get_opencode_project_id(workspace_path: String) -> Result<String, String> {
    let db_path = get_opencode_db_path()?;
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
pub async fn read_opencode_allowlist() -> Result<Vec<AllowlistRow>, String> {
    let db_path = get_opencode_db_path()?;

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
    project_id: String,
    rules: Vec<PermissionRule>,
) -> Result<(), String> {
    let db_path = get_opencode_db_path()?;
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

/// Get OpenCode server status
#[tauri::command]
pub async fn get_opencode_status(
    state: State<'_, OpenCodeState>,
) -> Result<OpenCodeStatus, String> {
    let is_running = *state.is_running.lock().map_err(|e| e.to_string())?;
    let port = *state.port.lock().map_err(|e| e.to_string())?;
    let is_dev_mode = *state.is_dev_mode.lock().map_err(|e| e.to_string())?;
    let workspace_path = state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

    Ok(OpenCodeStatus {
        is_running,
        port,
        url: format!("http://127.0.0.1:{}", port),
        is_dev_mode,
        workspace_path,
    })
}

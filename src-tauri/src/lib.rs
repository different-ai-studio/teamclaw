// Suppress cfg warnings from the legacy `objc` crate's `msg_send!` / `sel_impl!` macros.
#![allow(unexpected_cfgs)]

use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

mod commands;
mod stt;
mod rag;
mod telemetry;

/// Get the mtime of the user's shell profile file as a u64 (seconds since epoch).
/// Returns 0 if the file doesn't exist or can't be read.
fn get_shell_profile_mtime(shell: &str, home: &str) -> u64 {
    let profile = if shell.ends_with("zsh") {
        format!("{}/.zshrc", home)
    } else if shell.ends_with("bash") {
        format!("{}/.bashrc", home)
    } else {
        return 0;
    };
    std::fs::metadata(&profile)
        .and_then(|m| m.modified())
        .and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        })
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Read cached PATH if cache exists and profile mtime matches.
fn read_path_cache(cache_path: &std::path::Path, current_mtime: u64) -> Option<String> {
    let content = std::fs::read_to_string(cache_path).ok()?;
    let mut lines = content.lines();
    let cached_mtime: u64 = lines.next()?.parse().ok()?;
    if cached_mtime != current_mtime || current_mtime == 0 {
        return None;
    }
    let path = lines.next()?;
    if path.is_empty() {
        return None;
    }
    Some(path.to_string())
}

/// Write PATH cache file. Creates ~/.teamclaw/ if needed.
fn write_path_cache(cache_path: &std::path::Path, mtime: u64, path: &str) {
    if let Some(parent) = cache_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let content = format!("{}\n{}", mtime, path);
    let _ = std::fs::write(cache_path, content);
}

/// Fix PATH environment variable for GUI apps on macOS/Linux.
///
/// When launched from Dock/Spotlight (not a terminal), GUI apps inherit a minimal
/// system PATH (e.g. /usr/bin:/bin:/usr/sbin:/sbin) that doesn't include paths
/// added by Homebrew, nvm, etc. in the user's shell profile (.zshrc/.bashrc).
///
/// This function spawns a login shell to capture the user's full PATH and sets it
/// on the current process, so all subsequent Command::new() calls can find tools
/// like git, gh, node, npx, etc.
fn fix_path_env() {
    // Determine the user's default shell
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "windows") {
            "cmd".to_string()
        } else {
            "/bin/zsh".to_string()
        }
    });

    if cfg!(target_os = "windows") {
        // Windows GUI apps generally inherit the full PATH; skip for now
        return;
    }

    // Try cache first
    let home = std::env::var("HOME").unwrap_or_default();
    let cache_path = std::path::PathBuf::from(&home).join(".teamclaw").join("cached-path.txt");
    let profile_mtime = get_shell_profile_mtime(&shell, &home);

    if let Some(cached) = read_path_cache(&cache_path, profile_mtime) {
        std::env::set_var("PATH", &cached);
        #[cfg(debug_assertions)]
        eprintln!("[fix_path_env] PATH set from cache");
        return;
    }

    // Spawn a login shell to get the full PATH
    let output = std::process::Command::new(&shell)
        .args(["-l", "-c", "echo $PATH"])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let full_path = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !full_path.is_empty() {
                std::env::set_var("PATH", &full_path);
                #[cfg(debug_assertions)]
                eprintln!("[fix_path_env] PATH set to: {}", &full_path);
                // Write cache (fire-and-forget)
                write_path_cache(&cache_path, profile_mtime, &full_path);
            }
        }
        _ => {
            // Fallback: append common paths that might be missing
            let current = std::env::var("PATH").unwrap_or_default();
            let extra = [
                "/opt/homebrew/bin",              // macOS ARM Homebrew
                "/opt/homebrew/sbin",
                "/usr/local/bin",                 // macOS Intel Homebrew
                "/usr/local/sbin",
                "/home/linuxbrew/.linuxbrew/bin", // Linux Homebrew
            ];
            let mut path = current.clone();
            for p in extra {
                if !path.split(':').any(|seg| seg == p) {
                    path = format!("{}:{}", p, path);
                }
            }
            if path != current {
                std::env::set_var("PATH", &path);
                #[cfg(debug_assertions)]
                eprintln!("[fix_path_env] PATH fallback set to: {}", &path);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(debug_assertions)]
    let startup_t0 = std::time::Instant::now();

    // Fix PATH before anything else so all child processes can find tools
    fix_path_env();
    #[cfg(debug_assertions)]
    eprintln!("[Startup] fix_path_env: {:.1}ms", startup_t0.elapsed().as_secs_f64() * 1000.0);

    // Create RagState (HTTP server will be started in setup hook)
    let rag_state = commands::knowledge::RagState::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin({
            // Configure global shortcuts for Spotlight.
            // Errors in shortcut registration should not abort app startup, so we
            // log in debug builds and fall back to a plugin without shortcuts.
            let base = tauri_plugin_global_shortcut::Builder::new();
            let builder = base
                // Cross-platform Spotlight shortcut:
                // - macOS: Option+Space
                // - Windows/others: Alt+Space
                .with_shortcuts(["alt+space"])
                .unwrap_or_else(|err| {
                    #[cfg(debug_assertions)]
                    eprintln!("[global-shortcut] Failed to register Spotlight shortcuts: {err}");
                    tauri_plugin_global_shortcut::Builder::new()
                });

            builder
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }

                    // Alt/Option + Space
                    let is_alt_space = shortcut.matches(Modifiers::ALT, Code::Space);

                    if is_alt_space {
                        let app_clone = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            let state = app_clone.state::<commands::spotlight::SpotlightState>();
                            commands::spotlight::toggle_spotlight(app_clone.clone(), state);
                        });
                    }
                })
                .build()
        })
        .plugin({
            #[cfg(debug_assertions)]
            {
                tauri_plugin_mcp::init_with_config(
                    tauri_plugin_mcp::PluginConfig::new(String::from("teamclaw"))
                        .socket_path(std::path::PathBuf::from("/tmp/tauri-mcp.sock"))
                )
            }
            #[cfg(not(debug_assertions))]
            {
                tauri::plugin::Builder::<tauri::Wry, ()>::new("tauri-mcp").build()
            }
        })
        .manage(commands::opencode::OpenCodeState::default())
        .manage(commands::filewatcher::FileWatcherState::default())
        .manage(commands::gateway::GatewayState::default())
        .manage(commands::cron::CronState::default())
        .manage(rag_state)
        .manage(telemetry::commands::TelemetryState::default())
        .manage(crate::stt::SttState::default())
        .manage({
            let mut wvm = commands::webview::WebviewManager::default();
            #[cfg(target_os = "macos")]
            commands::webview::init_shared_config(&mut wvm);
            wvm
        })
        .manage(<commands::p2p_state::IrohState>::default())
        .manage(commands::spotlight::SpotlightState::default())
        .manage(tokio::sync::Mutex::new(commands::team_webdav::WebDavManagedState::default()))
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::show_in_folder,
            commands::open_with_default_app,
            commands::open_in_terminal,
            commands::stt::stt_is_available,
            commands::stt::stt_start_listening,
            commands::stt::stt_stop_listening,
            commands::stt::stt_list_downloadable_models,
            commands::stt::stt_download_model,
            commands::knowledge::convert_to_markdown,
            commands::knowledge::batch_convert_to_markdown,
            commands::knowledge::rag_index,
            commands::knowledge::rag_get_index_status,
            commands::knowledge::rag_search,
            commands::knowledge::rag_list_documents,
            commands::knowledge::rag_delete_document,
            commands::knowledge::rag_get_config,
            commands::knowledge::rag_save_config,
            commands::knowledge::rag_start_watcher,
            commands::knowledge::rag_stop_watcher,
            commands::knowledge::rag_list_memories,
            commands::knowledge::rag_save_memory,
            commands::knowledge::rag_delete_memory,
            commands::opencode::start_opencode,
            commands::opencode::stop_opencode,
            commands::opencode::get_opencode_status,
            commands::opencode::get_opencode_project_id,
            commands::opencode::read_opencode_allowlist,
            commands::opencode::write_opencode_allowlist,
            commands::mcp::get_mcp_config,
            commands::mcp::save_mcp_config,
            commands::mcp::add_mcp_server,
            commands::mcp::update_mcp_server,
            commands::mcp::remove_mcp_server,
            commands::mcp::toggle_mcp_server,
            commands::mcp::list_mcp_tools,
            commands::mcp::test_mcp_server,
            commands::filewatcher::watch_directory,
            commands::filewatcher::unwatch_directory,
            commands::filewatcher::unwatch_all,
            commands::filewatcher::get_watched_directories,
            commands::gateway::get_channel_config,
            commands::gateway::save_channel_config,
            commands::gateway::get_discord_config,
            commands::gateway::save_discord_config,
            commands::gateway::start_gateway,
            commands::gateway::stop_gateway,
            commands::gateway::get_gateway_status,
            commands::gateway::test_discord_token,
            commands::gateway::get_feishu_config,
            commands::gateway::save_feishu_config,
            commands::gateway::start_feishu_gateway,
            commands::gateway::stop_feishu_gateway,
            commands::gateway::get_feishu_gateway_status,
            commands::gateway::test_feishu_credentials,
            commands::gateway::get_email_config,
            commands::gateway::save_email_config,
            commands::gateway::start_email_gateway,
            commands::gateway::stop_email_gateway,
            commands::gateway::get_email_gateway_status,
            commands::gateway::test_email_connection,
            commands::gateway::gmail_authorize,
            commands::gateway::check_gmail_auth,
            commands::gateway::get_kook_config,
            commands::gateway::save_kook_config,
            commands::gateway::start_kook_gateway,
            commands::gateway::stop_kook_gateway,
            commands::gateway::get_kook_gateway_status,
            commands::gateway::test_kook_token,
            commands::gateway::get_wecom_config,
            commands::gateway::save_wecom_config,
            commands::gateway::start_wecom_gateway,
            commands::gateway::stop_wecom_gateway,
            commands::gateway::get_wecom_gateway_status,
            commands::gateway::test_wecom_credentials,
            commands::cron::cron_init,
            commands::cron::cron_list_jobs,
            commands::cron::cron_add_job,
            commands::cron::cron_update_job,
            commands::cron::cron_remove_job,
            commands::cron::cron_toggle_enabled,
            commands::cron::cron_run_job,
            commands::cron::cron_get_runs,
            commands::cron::cron_refresh_delivery,
            commands::clawhub::clawhub_search,
            commands::clawhub::clawhub_explore,
            commands::clawhub::clawhub_get_skill,
            commands::clawhub::clawhub_install,
            commands::clawhub::clawhub_uninstall,
            commands::clawhub::clawhub_list_installed,
            commands::clawhub::clawhub_check_updates,
            commands::clawhub::clawhub_update,
            commands::skillssh::fetch_skillssh_leaderboard,
            commands::skillssh::search_skillssh_skills,
            commands::skillssh::fetch_skillssh_content,
            commands::skillssh::install_skillssh_skill,
            commands::skillssh::install_skill_from_git_url,
            commands::updater::check_update,
            commands::updater::download_and_install_update,
            commands::git::git_check_available,
            commands::git::git_clone,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_commit,
            commands::git::git_add,
            commands::git::git_status,
            commands::git::git_diff,
            commands::git::git_show_file,
            commands::team::team_check_git_installed,
            commands::team::team_check_workspace_has_git,
            commands::team::team_init_repo,
            commands::team::team_generate_gitignore,
            commands::team::team_sync_repo,
            commands::team::team_disconnect_repo,
            commands::team::get_team_config,
            commands::team::save_team_config,
            commands::team::clear_team_config,
            #[cfg(feature = "p2p")]
            commands::team_p2p::get_device_node_id,
            #[cfg(feature = "p2p")]
            commands::team_p2p::get_device_info,
            #[cfg(feature = "p2p")]
            commands::team_p2p::team_add_member,
            #[cfg(feature = "p2p")]
            commands::team_p2p::team_remove_member,
            #[cfg(feature = "p2p")]
            commands::team_p2p::p2p_check_team_dir,
            #[cfg(feature = "p2p")]
            commands::team_p2p::p2p_create_team,
            #[cfg(feature = "p2p")]
            commands::team_p2p::p2p_publish_drive,
            #[cfg(feature = "p2p")]
            commands::team_p2p::p2p_join_drive,
            #[cfg(feature = "p2p")]
            commands::team_p2p::p2p_disconnect_source,
            #[cfg(feature = "p2p")]
            commands::team_p2p::p2p_reconnect,
            #[cfg(feature = "p2p")]
            commands::team_p2p::p2p_rotate_ticket,
            #[cfg(feature = "p2p")]
            commands::team_p2p::p2p_sync_status,
            #[cfg(feature = "p2p")]
            commands::team_p2p::get_p2p_config,
            #[cfg(feature = "p2p")]
            commands::team_p2p::save_p2p_config,
            #[cfg(feature = "p2p")]
            commands::team_p2p::p2p_skills_leaderboard,
            commands::deps::check_dependencies,
            commands::deps::install_dependency,
            commands::env_vars::env_var_set,
            commands::env_vars::env_var_get,
            commands::env_vars::env_var_delete,
            commands::env_vars::env_var_list,
            commands::env_vars::env_var_resolve,
            commands::local_stats::read_local_stats,
            commands::local_stats::write_local_stats,
            commands::local_stats::update_local_stats,
            commands::local_stats::reset_local_stats,
            telemetry::commands::telemetry_get_device_id,
            telemetry::commands::telemetry_get_consent,
            telemetry::commands::telemetry_set_consent,
            telemetry::commands::telemetry_set_feedback,
            telemetry::commands::telemetry_get_feedbacks,
            telemetry::commands::telemetry_remove_feedback,
            telemetry::commands::telemetry_set_star_rating,
            telemetry::commands::telemetry_remove_star_rating,
            telemetry::commands::telemetry_save_report,
            telemetry::commands::telemetry_get_reports,
            telemetry::commands::telemetry_export_team_feedback,
            telemetry::commands::telemetry_get_team_feedback_summary,
            telemetry::commands::telemetry_export_leaderboard,
            telemetry::commands::telemetry_get_team_leaderboard,
            telemetry::commands::telemetry_get_member_aggregated_stats,
            commands::webview::webview_eval_js,
            commands::webview::webview_create,
            commands::webview::webview_close,
            commands::webview::webview_hide,
            commands::webview::webview_show,
            commands::webview::webview_set_bounds,
            commands::webview::webview_focus,
            commands::webview::webview_go_back,
            commands::webview::webview_go_forward,
            commands::webview::webview_reload,
            commands::webview::webview_navigate,
            commands::webview::webview_get_url,
            commands::spotlight::toggle_spotlight,
            commands::spotlight::set_spotlight_pin,
            commands::spotlight::show_main_window,
            commands::spotlight::force_toggle_spotlight,
            commands::spotlight::get_spotlight_state,
            commands::spotlight::expand_to_main,
            commands::team_webdav::webdav_connect,
            commands::team_webdav::webdav_sync,
            commands::team_webdav::webdav_disconnect,
            commands::team_webdav::webdav_export_config,
            commands::team_webdav::webdav_import_config,
            commands::team_webdav::webdav_get_status,
            commands::team_webdav::get_team_mode,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            let setup_t0 = std::time::Instant::now();

            // Start RAG HTTP API server for MCP bridge
            let rag_state_handle = app.handle().state::<commands::knowledge::RagState>();
            let rag_state_for_http = std::sync::Arc::new(rag_state_handle.inner().clone());
            
            tauri::async_runtime::spawn(async move {
                if let Err(e) = commands::rag_http_server::start_http_server(rag_state_for_http, 13143).await {
                    eprintln!("[RAG HTTP] Failed to start HTTP server: {}", e);
                }
            });

            // Initialize iroh P2P node in background (non-blocking)
            #[cfg(feature = "p2p")]
            {
                let iroh_state = app.handle().state::<commands::p2p_state::IrohState>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    match commands::team_p2p::IrohNode::new_default().await {
                        Ok(node) => {
                            *iroh_state.lock().await = Some(node);
                            #[cfg(debug_assertions)]
                            eprintln!("[P2P] iroh node started");
                        }
                        Err(e) => {
                            eprintln!("[P2P] Failed to start iroh node (P2P disabled): {}", e);
                        }
                    }
                });
            }

            // Team sync will be triggered from the frontend after workspace is set,
            // since workspace_path is not available at setup time.
            // The frontend calls team_sync_repo on startup when team config is enabled.

            #[cfg(debug_assertions)]
            eprintln!("[Startup] Setup hook (before early launch): {:.1}ms", setup_t0.elapsed().as_secs_f64() * 1000.0);

            // --- Early sidecar launch ---
            // Read last workspace and start OpenCode before frontend renders.
            // The frontend's start_opencode call will reuse this result if the path matches.
            if std::env::var("TEAMCLAW_DISABLE_EARLY_LAUNCH").unwrap_or_default() != "1" {
                if let Some(workspace_path) = commands::opencode::read_last_workspace() {
                    println!("[EarlyLaunch] Starting sidecar for: {}", workspace_path);
                    let app_handle = app.handle().clone();
                    let (tx, rx) = tokio::sync::watch::channel(None);

                    // Store the early launch state so start_opencode can find it
                    let early_state = app_handle.state::<commands::opencode::OpenCodeState>();
                    {
                        let mut early = early_state.early_launch.blocking_lock();
                        *early = Some(commands::opencode::EarlyLaunchState {
                            workspace_path: workspace_path.clone(),
                            result_rx: rx,
                        });
                    }

                    tauri::async_runtime::spawn(async move {
                        let state = app_handle.state::<commands::opencode::OpenCodeState>();
                        let config = commands::opencode::OpenCodeConfig {
                            workspace_path,
                            port: None,
                        };
                        let result = commands::opencode::start_opencode_inner(
                            app_handle.clone(),
                            &state,
                            config,
                        ).await;
                        let _ = tx.send(Some(result));
                    });
                }
            }

            // --- System Tray ---
            use tauri::menu::{MenuBuilder, MenuItemBuilder};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            let show_main = MenuItemBuilder::with_id("show_main", "Show Main Window").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show_main)
                .item(&quit)
                .build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("TeamClaw")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray: &tauri::tray::TrayIcon, event: TrayIconEvent| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        let state = app.state::<commands::spotlight::SpotlightState>();
                        commands::spotlight::toggle_spotlight_from_tray(app.clone(), state);
                    }
                })
                .on_menu_event(|app: &tauri::AppHandle, event: tauri::menu::MenuEvent| {
                    match event.id().as_ref() {
                        "show_main" => {
                            let state = app.state::<commands::spotlight::SpotlightState>();
                            commands::spotlight::show_main_window(app.clone(), state);
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // --- Global Shortcut: Double-tap Ctrl for Spotlight ---
            //
            // NOTE: Disabled on macOS due to a crash in rdev's macOS keyboard
            // integration (`TSMGetInputSourceProperty` must run on a specific
            // dispatch queue; macOS 15+ asserts when called from our CGEvent tap
            // thread). Until rdev is patched upstream, we only enable this
            // listener on non-macOS platforms to avoid SIGTRAP crashes when
            // pressing Ctrl.
            #[cfg(not(target_os = "macos"))]
            {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    use std::sync::Mutex;
                    use std::time::Instant;

                    struct DoubleTapState {
                        last_ctrl_release: Instant,
                        ctrl_held: bool,
                        other_key_during_ctrl: bool,
                    }

                    let state = Mutex::new(DoubleTapState {
                        last_ctrl_release: Instant::now() - std::time::Duration::from_secs(10),
                        ctrl_held: false,
                        other_key_during_ctrl: false,
                    });

                    let _ = rdev::listen(move |event| {
                        let is_ctrl = matches!(
                            event.event_type,
                            rdev::EventType::KeyPress(rdev::Key::ControlLeft | rdev::Key::ControlRight)
                                | rdev::EventType::KeyRelease(rdev::Key::ControlLeft | rdev::Key::ControlRight)
                        );

                        let mut s = state.lock().unwrap();

                        match event.event_type {
                            rdev::EventType::KeyPress(rdev::Key::ControlLeft | rdev::Key::ControlRight) => {
                                s.ctrl_held = true;
                                s.other_key_during_ctrl = false;
                            }
                            rdev::EventType::KeyRelease(rdev::Key::ControlLeft | rdev::Key::ControlRight) => {
                                let now = Instant::now();
                                if !s.other_key_during_ctrl {
                                    let elapsed = now.duration_since(s.last_ctrl_release);
                                    if elapsed < std::time::Duration::from_millis(400) {
                                        // Double-tap detected — reset to prevent triple-tap trigger
                                        s.last_ctrl_release = now - std::time::Duration::from_secs(10);
                                        let app = app_handle.clone();
                                        let app_inner = app.clone();
                                        let _ = app.run_on_main_thread(move || {
                                            let st = app_inner.state::<commands::spotlight::SpotlightState>();
                                            commands::spotlight::toggle_spotlight(app_inner.clone(), st);
                                        });
                                    } else {
                                        s.last_ctrl_release = now;
                                    }
                                }
                                s.ctrl_held = false;
                            }
                            _ if s.ctrl_held && !is_ctrl => {
                                s.other_key_during_ctrl = true;
                            }
                            _ => {}
                        }
                    });
                });
            }

            // --- Reposition macOS traffic lights on startup ---
            #[cfg(target_os = "macos")]
            if let Some(main_win) = app.get_webview_window("main") {
                commands::spotlight::reposition_traffic_lights(&main_win);
            }

            // --- Window event handlers ---
            if let Some(main_win) = app.get_webview_window("main") {
                let main_win_clone = main_win.clone();
                let close_app_handle = app.handle().clone();
                main_win.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            // Save main geometry if in Main mode before hiding
                            let state = close_app_handle.state::<commands::spotlight::SpotlightState>();
                            {
                                let mode = state.mode.lock().unwrap();
                                if *mode == commands::spotlight::WindowMode::Main {
                                    commands::spotlight::save_main_geometry(&main_win_clone, &state);
                                }
                            }
                            let is_fullscreen = main_win_clone.is_fullscreen().unwrap_or(false);
                            if is_fullscreen {
                                // macOS doesn't allow hide() on fullscreen windows.
                                // Strategy: make window invisible via alpha, exit fullscreen
                                // (animation runs but is invisible), then hide + restore alpha.
                                #[cfg(target_os = "macos")]
                                if let Ok(ns_win) = main_win_clone.ns_window() {
                                    use cocoa::base::id;
                                    use objc::{msg_send, sel, sel_impl};
                                    unsafe {
                                        let _: () = msg_send![ns_win as id, setAlphaValue: 0.0f64];
                                    }
                                }
                                let _ = main_win_clone.set_fullscreen(false);
                                let win_for_hide = main_win_clone.clone();
                                std::thread::spawn(move || {
                                    // Wait for macOS fullscreen exit animation to complete
                                    std::thread::sleep(std::time::Duration::from_millis(1000));
                                    let _ = win_for_hide.hide();
                                    // Restore alpha so window is visible next time it's shown
                                    #[cfg(target_os = "macos")]
                                    if let Ok(ns_win) = win_for_hide.ns_window() {
                                        use cocoa::base::id;
                                        use objc::{msg_send, sel, sel_impl};
                                        unsafe {
                                            let _: () = msg_send![ns_win as id, setAlphaValue: 1.0f64];
                                        }
                                    }
                                });
                            } else {
                                let _ = main_win_clone.hide();
                            }
                        }
                        // Re-apply traffic light positions after window resize,
                        // because macOS resets button positions during resize/animations.
                        #[cfg(target_os = "macos")]
                        tauri::WindowEvent::Resized { .. } => {
                            let state = close_app_handle.state::<commands::spotlight::SpotlightState>();
                            let mode = *state.mode.lock().unwrap();
                            if mode == commands::spotlight::WindowMode::Main {
                                commands::spotlight::reposition_traffic_lights(&main_win_clone);
                            }
                        }
                        _ => {}
                    }
                });
            }

            // --- E2E Test Control Server (debug builds only) ---
            #[cfg(debug_assertions)]
            {
                let test_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use axum::{routing::post, Router, Json};
                    let app_handle = test_app;

                    let router = Router::new().route(
                        "/test/command",
                        post(move |Json(body): Json<serde_json::Value>| {
                            let app = app_handle.clone();
                            async move {
                                let cmd = body["command"].as_str().unwrap_or("");
                                // All spotlight commands touch AppKit/Cocoa window APIs
                                // and MUST run on the main thread (macOS requirement).
                                // The test control server runs on a tokio thread, so we
                                // dispatch all window-mutating commands via run_on_main_thread.
                                match cmd {
                                    "force_toggle_spotlight" => {
                                        let app_main = app.clone();
                                        let _ = app.run_on_main_thread(move || {
                                            let state = app_main.state::<commands::spotlight::SpotlightState>();
                                            commands::spotlight::force_toggle_spotlight(app_main.clone(), state);
                                        });
                                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                                        Json(serde_json::json!({"ok": true}))
                                    }
                                    "get_spotlight_state" => {
                                        // Read-only: no AppKit calls, safe from any thread
                                        let state = app.state::<commands::spotlight::SpotlightState>();
                                        let result = commands::spotlight::get_spotlight_state(app.clone(), state);
                                        Json(result)
                                    }
                                    "show_main_window" => {
                                        let app_main = app.clone();
                                        let _ = app.run_on_main_thread(move || {
                                            let state = app_main.state::<commands::spotlight::SpotlightState>();
                                            commands::spotlight::show_main_window(app_main.clone(), state);
                                        });
                                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                                        Json(serde_json::json!({"ok": true}))
                                    }
                                    "expand_to_main" => {
                                        let app_main = app.clone();
                                        let _ = app.run_on_main_thread(move || {
                                            let state = app_main.state::<commands::spotlight::SpotlightState>();
                                            let _ = commands::spotlight::expand_to_main(app_main.clone(), state);
                                        });
                                        // Wait for the animation (~300ms) to complete on the main thread
                                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                        Json(serde_json::json!({"ok": true}))
                                    }
                                    "toggle_fullscreen" => {
                                        let app_main = app.clone();
                                        let _ = app.run_on_main_thread(move || {
                                            if let Some(win) = app_main.get_webview_window("main") {
                                                let is_fs = win.is_fullscreen().unwrap_or(false);
                                                let _ = win.set_fullscreen(!is_fs);
                                            }
                                        });
                                        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                                        Json(serde_json::json!({"ok": true}))
                                    }
                                    "close_window" => {
                                        // Simulate close request by triggering the same logic
                                        let app_main = app.clone();
                                        let _ = app.run_on_main_thread(move || {
                                            if let Some(win) = app_main.get_webview_window("main") {
                                                // Trigger close which will be intercepted by on_window_event
                                                let _ = win.close();
                                            }
                                        });
                                        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                                        Json(serde_json::json!({"ok": true}))
                                    }
                                    "is_visible" => {
                                        let visible = app.get_webview_window("main")
                                            .map(|w| w.is_visible().unwrap_or(false))
                                            .unwrap_or(false);
                                        let fullscreen = app.get_webview_window("main")
                                            .map(|w| w.is_fullscreen().unwrap_or(false))
                                            .unwrap_or(false);
                                        Json(serde_json::json!({"visible": visible, "fullscreen": fullscreen}))
                                    }
                                    _ => Json(serde_json::json!({"error": "unknown command"})),
                                }
                            }
                        }),
                    );

                    let listener = tokio::net::TcpListener::bind("127.0.0.1:13199").await;
                    if let Ok(listener) = listener {
                        eprintln!("[Test] Control server listening on http://127.0.0.1:13199");
                        let _ = axum::serve(listener, router).await;
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // macOS: clicking the Dock icon when all windows are hidden should show the main window
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = _event {
                if !has_visible_windows {
                    let state = _app.state::<commands::spotlight::SpotlightState>();
                    commands::spotlight::show_main_window(_app.clone(), state);
                }
            }
        });
}

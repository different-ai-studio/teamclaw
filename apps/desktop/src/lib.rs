// Suppress cfg warnings from the legacy `objc` crate's `msg_send!` / `sel_impl!` macros.
#![allow(unexpected_cfgs)]
// Suppress dead-code and unused-import warnings from legacy/in-progress code.
#![allow(dead_code, unused_imports)]
// Suppress new_without_default for types that intentionally use new() with no args.
#![allow(clippy::new_without_default)]
// Suppress style/complexity clippy lints that are non-critical for this codebase.
#![allow(
    clippy::cloned_ref_to_slice_refs,
    clippy::collapsible_else_if,
    clippy::collapsible_if,
    clippy::derivable_impls,
    clippy::for_kv_map,
    clippy::io_other_error,
    clippy::iter_nth_zero,
    clippy::manual_clamp,
    clippy::manual_is_multiple_of,
    clippy::manual_map,
    clippy::manual_strip,
    clippy::map_identity,
    clippy::needless_borrow,
    clippy::needless_borrows_for_generic_args,
    clippy::ptr_arg,
    clippy::redundant_closure,
    clippy::redundant_guards,
    clippy::redundant_pattern_matching,
    clippy::same_item_push,
    clippy::too_many_arguments,
    clippy::trim_split_whitespace,
    clippy::type_complexity,
    clippy::unnecessary_lazy_evaluations,
    clippy::unnecessary_map_or,
    clippy::unnecessary_unwrap,
    clippy::unwrap_or_default,
    clippy::useless_asref,
    clippy::useless_format,
    clippy::useless_vec
)]

use tauri::Manager;
use tauri_plugin_aptabase::EventTracker;

mod branding;
pub mod commands;
mod local_cache;
pub mod mqtt;
pub mod opencode_paths;
pub mod process_util;
pub mod proto;
pub mod sentry_utils;
mod session_export;
mod telemetry;
mod terminal;
mod webview_recovery;

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

/// Timeout for the login-shell PATH probe. A user's shell profile should
/// return `echo $PATH` near-instantly; anything past this is treated as a
/// stuck profile and we fall back rather than block startup.
const SHELL_PATH_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

/// Run `<shell> -l -c 'echo $PATH'` with a hard wall-clock timeout.
///
/// Kept synchronous (it runs before the tokio runtime is created) and bounded
/// with std thread + `recv_timeout`. On timeout the child is killed and an
/// error is returned so the caller falls back to a minimal PATH.
fn spawn_shell_path_probe(shell: &str) -> std::io::Result<std::process::Output> {
    use crate::process_util::CommandNoWindow;
    use std::process::Stdio;

    let mut child = std::process::Command::new(shell)
        .no_window()
        .args(["-l", "-c", "echo $PATH"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()?;

    let deadline = std::time::Instant::now() + SHELL_PATH_PROBE_TIMEOUT;
    loop {
        match child.try_wait()? {
            Some(_) => {
                // Exited within budget; collect its output.
                return child.wait_with_output();
            }
            None => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    eprintln!(
                        "[fix_path_env] login-shell PATH probe timed out after {:?}; \
                         falling back to minimal PATH",
                        SHELL_PATH_PROBE_TIMEOUT
                    );
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "login-shell PATH probe timed out",
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
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
    let cache_path = std::path::PathBuf::from(&home)
        .join(commands::TEAMCLAW_DIR)
        .join("cached-path.txt");
    let profile_mtime = get_shell_profile_mtime(&shell, &home);

    if let Some(cached) = read_path_cache(&cache_path, profile_mtime) {
        std::env::set_var("PATH", &cached);
        #[cfg(debug_assertions)]
        eprintln!("[fix_path_env] PATH set from cache");
        return;
    }

    // Spawn a login shell to get the full PATH.
    //
    // A pathologically slow shell profile (network mounts, heavy `.zshrc`, etc.)
    // could otherwise block window creation indefinitely, so we cap the probe
    // with a hard timeout and fall back to a minimal PATH on timeout. This runs
    // before the tokio runtime exists, so it uses std threads only.
    let output = spawn_shell_path_probe(&shell);

    match output {
        Ok(o) if o.status.success() => {
            let full_path = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !full_path.is_empty() {
                std::env::set_var("PATH", &full_path);
                #[cfg(debug_assertions)]
                eprintln!("[fix_path_env] PATH set to: {}", full_path);
                // Write cache (fire-and-forget)
                write_path_cache(&cache_path, profile_mtime, &full_path);
            }
        }
        _ => {
            // Fallback: append common paths that might be missing
            let current = std::env::var("PATH").unwrap_or_default();
            let extra = [
                "/opt/homebrew/bin", // macOS ARM Homebrew
                "/opt/homebrew/sbin",
                "/usr/local/bin", // macOS Intel Homebrew
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
                eprintln!("[fix_path_env] PATH fallback set to: {}", path);
            }
        }
    }
}

// Foreground-activation heartbeat for Aptabase DAU.
// `app_started` only fires on cold start; on macOS users who keep the app
// running for days would otherwise show as DAU only on day 1. Firing
// `app_active` on focus / Reopen (rate-limited) closes that gap.
static LAST_ACTIVE_AT: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
const APP_ACTIVE_THRESHOLD_SECS: i64 = 4 * 3600;

fn now_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn record_activity() {
    LAST_ACTIVE_AT.store(now_unix_secs(), std::sync::atomic::Ordering::Relaxed);
}

fn maybe_emit_app_active(app: &tauri::AppHandle) {
    let now = now_unix_secs();
    let last = LAST_ACTIVE_AT.load(std::sync::atomic::Ordering::Relaxed);
    if last != 0 && now - last < APP_ACTIVE_THRESHOLD_SECS {
        return;
    }
    LAST_ACTIVE_AT.store(now, std::sync::atomic::Ordering::Relaxed);
    let _ = app.track_event(
        "app_active",
        Some(serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
        })),
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_t0 = std::time::Instant::now();

    // Fix PATH before anything else so all child processes can find tools
    fix_path_env();
    eprintln!(
        "[Startup] fix_path_env: {:.1}ms",
        startup_t0.elapsed().as_secs_f64() * 1000.0
    );

    // Create a Tokio runtime and register it with Tauri BEFORE plugin initialization.
    // tauri-plugin-aptabase calls tokio::spawn during init (start_polling),
    // which panics if no reactor is running on the main thread.
    let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
    let _guard = rt.enter();
    tauri::async_runtime::set(rt.handle().clone());

    // RAG state for Tauri commands (MCP bridge uses standalone rag-mcp-server; see binaries README)
    let rag_state = commands::knowledge::RagState::default();

    // The Cloud API URL comes solely from the frontend build config now; remove
    // any deprecated on-disk server config so a stale persisted cloudApiUrl can
    // never shadow it. Best-effort, non-fatal.
    commands::server_config::cleanup_deprecated_server_config();

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new()
            .level(log::LevelFilter::Info)
            .filter(|metadata| {
                // Suppress noisy third-party crate logs
                let target = metadata.target();
                !(target.starts_with("tracing::span")
                    || target.starts_with("hyper_util")
                    || target.starts_with("hyper::")
                    || target.starts_with("tauri_plugin_aptabase")
                    || target.starts_with("reqwest")
                    || target.starts_with("hickory_")
                    || target.starts_with("netwatch")
                    || target.starts_with("portmapper"))
            })
            .targets([
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
            ]).build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Restore window size + position across launches. Per-window state is
        // keyed by window label and stored under the OS app-data dir.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // NOTE: aptabase is registered in the setup() closure below so that
        // the Tokio runtime is available when its internal `tokio::spawn` runs.
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
        .manage(commands::window::WindowRegistry::default())
        .manage(commands::filewatcher::FileWatcherState::default())
        .manage(commands::gateway::GatewayState::default())
        .manage(commands::cron::CronState::default())
        .manage(rag_state)
        .manage(local_cache::commands::LocalCacheState::default())

        .manage(teamclaw_stt::SttState::default())
        .manage({
            #[allow(unused_mut)]
            let mut wvm = commands::webview::WebviewManager::default();
            #[cfg(target_os = "macos")]
            commands::webview::init_shared_config(&mut wvm);
            wvm
        })
        .manage(commands::window_chrome::MainWindowState::default())
        .manage(commands::shared_secrets::SharedSecretsState::default())
        .manage(commands::oauth_loopback::OAuthLoopbackState::default())
        .manage::<crate::mqtt::MqttBus>(std::sync::Arc::new(crate::mqtt::MqttBusInner::new()))
        .manage(std::sync::Arc::new(crate::terminal::Registry::new()))
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::os_full_name,
            commands::get_device_hostname,
            commands::daemon_http::daemon_rpc,
            commands::daemon_http::get_daemon_http_info,
            commands::daemon_http::get_daemon_team_id,
            commands::daemon_http::list_local_daemon_workspaces,
            commands::daemon_http::register_daemon_workspace,
            commands::show_in_folder,
            commands::acp_debug_log::acp_debug_append_log,
            commands::acp_debug_log::acp_debug_log_directory,
            commands::acp_debug_log::acp_debug_reveal_log,
            commands::open_with_default_app,
            commands::open_in_terminal,
            commands::system_appearance::get_system_accent_color,
            commands::stt::stt_is_available,
            commands::stt::stt_start_listening,
            commands::stt::stt_stop_listening,
            commands::stt::stt_list_downloadable_models,
            commands::stt::stt_download_model,
            commands::stt::stt_delete_model,
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
            commands::window::create_workspace_window,
            commands::window::register_window_workspace,
            commands::window::set_window_title,
            commands::mqtt_bus::mqtt_connect,
            commands::mqtt_bus::mqtt_subscribe,
            commands::mqtt_bus::mqtt_unsubscribe,
            commands::mqtt_bus::mqtt_publish,
            commands::mqtt_bus::mqtt_status,
            commands::oauth_loopback::oauth_loopback_start,
            commands::oauth_loopback::oauth_loopback_await,
            commands::oauth_loopback::oauth_loopback_cancel,
            commands::filewatcher::watch_directory,
            commands::filewatcher::unwatch_directory,
            commands::filewatcher::unwatch_all,
            commands::filewatcher::get_watched_directories,
            commands::gateway::list_channels,
            commands::gateway::list_wecom_bots_status,
            commands::gateway::load_channel_config,
            commands::gateway::save_channel_config,
            commands::gateway::reload_channels,
            commands::gateway::qr::start_wechat_qr_login,
            commands::gateway::qr::poll_wechat_qr_status,
            commands::gateway::qr::start_wecom_qr_auth,
            commands::gateway::qr::poll_wecom_qr_auth,
            commands::gateway::sync_gateway_session_model,
            commands::gateway::load_shortcuts,
            commands::gateway::save_shortcuts,
            commands::gateway::load_system_prompt,
            commands::gateway::save_system_prompt,
            commands::gateway::set_config_locale,
            commands::cron::cron_init,
            commands::cron::cron_list_jobs,
            commands::cron::cron_add_job,
            commands::cron::cron_update_job,
            commands::cron::cron_remove_job,
            commands::cron::cron_toggle_enabled,
            commands::cron::cron_run_job,
            commands::cron::cron_get_runs,
            commands::cron::cron_get_all_session_ids,
            commands::cron::cron_refresh_delivery,
            commands::daemon_installer::install_local_daemon,
            commands::daemon_installer::daemon_status,
            commands::daemon_installer::uninstall_local_daemon,
            commands::daemon_onboarding::daemon_init,
            commands::daemon_onboarding::daemon_install_service,
            commands::daemon_onboarding::daemon_clear,
            commands::setup::setup_list_requirements,
            commands::setup::setup_install,
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
            commands::skillssh::import_skill_from_zip,
            commands::skillssh::npx_skills_add,
            commands::skillssh::npx_skills_remove,
            commands::skillssh::npx_skills_update,
            commands::skillssh::npx_skills_check,
            commands::skillssh::npx_skills_list,
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
            commands::git::git_checkout_file,
            commands::git::git_show_file,
            commands::git::git_log_file,
            commands::terminal::terminal_close,
            commands::terminal::terminal_list,
            commands::terminal::terminal_open,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_subscribe,
            commands::terminal::terminal_write,
            commands::team::workspace_read_team_meta,
            commands::team::workspace_delete_team_repo,
            commands::team_share::disconnect::team_disconnect_repo,
            commands::team::get_team_config,
            commands::team_git::team_check_workspace_has_git,
            commands::team_git::team_git_join,
            commands::team_git::team_git_join_background,
            commands::team_git::init_git_team_secrets,
            commands::team_git::get_git_team_secret,
            commands::team_git::team_generate_gitignore,
            commands::team_sync_proxy::team_sync_repo,
            commands::team_sync_proxy::team_shared_git_validate,
            commands::team_sync_proxy::team_shared_git_setup,
            commands::team_sync_proxy::team_shared_git_sync,
            commands::team_sync_proxy::team_file_versions,
            commands::team_sync_proxy::team_file_content,
            commands::team_sync_proxy::team_changed_files,
            commands::team_sync_proxy::team_restore_file_version,
            commands::deps::check_dependencies,
            commands::deps::install_dependency,
            commands::deps::update_dependency,
            commands::env_vars::env_var_get,
            commands::env_vars::env_catalog_list,
            commands::env_vars::team_env_diagnostics,
            commands::env_vars::env_catalog_set,
            commands::env_vars::env_catalog_delete,
            commands::env_vars::env_var_resolve,
            commands::session_export::session_export,
            commands::local_stats::read_local_stats,
            commands::local_stats::write_local_stats,
            commands::local_stats::update_local_stats,
            commands::local_stats::reset_local_stats,
            local_cache::commands::local_cache_actor_upsert_batch,
            local_cache::commands::local_cache_actor_load_team,
            local_cache::commands::local_cache_actor_load_by_ids,
            local_cache::commands::local_cache_actor_soft_delete,
            local_cache::commands::local_cache_session_upsert_batch,
            local_cache::commands::local_cache_session_load_team,
            local_cache::commands::local_cache_session_workspace_upsert_batch,
            local_cache::commands::local_cache_session_workspace_load_team,
            local_cache::commands::local_cache_session_soft_delete,
            local_cache::commands::local_cache_session_participant_upsert_batch,
            local_cache::commands::local_cache_session_participant_load_session,
            local_cache::commands::local_cache_session_participant_soft_delete,
            local_cache::commands::local_cache_message_upsert_batch,
            local_cache::commands::local_cache_message_load_session,
            local_cache::commands::local_cache_message_soft_delete,
            local_cache::commands::local_cache_message_set_parts,
            local_cache::commands::local_cache_message_enrich_parts,
            local_cache::commands::local_cache_outbox_upsert,
            local_cache::commands::local_cache_outbox_delete,
            local_cache::commands::local_cache_outbox_list_all,
            local_cache::commands::local_cache_idea_upsert_batch,
            local_cache::commands::local_cache_idea_load_team,
            local_cache::commands::local_cache_idea_soft_delete,
            local_cache::commands::local_cache_claim_upsert_batch,
            local_cache::commands::local_cache_claim_load_idea,
            local_cache::commands::local_cache_claim_soft_delete,
            local_cache::commands::local_cache_submission_upsert_batch,
            local_cache::commands::local_cache_submission_load_idea,
            local_cache::commands::local_cache_submission_soft_delete,
            local_cache::commands::local_cache_agent_runtime_event_insert,
            local_cache::commands::local_cache_agent_runtime_event_load,
            local_cache::commands::local_cache_agent_runtime_event_prune,
            local_cache::commands::local_cache_watermark_get,
            local_cache::commands::local_cache_watermark_set,
            local_cache::commands::local_cache_clear_team,
            local_cache::commands::local_cache_set_current_team,
            local_cache::commands::local_cache_get_current_team,
            telemetry::commands::telemetry_get_consent,
            telemetry::commands::telemetry_set_consent,
            telemetry::commands::telemetry_track,
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
            commands::webview::webview_get_title,
            commands::webview::webview_read_local_storage,
            commands::webview::webview_get_favicon,
            commands::webview::webview_find_in_page,
            commands::webview::webview_clear_find,
            commands::webview::webview_set_zoom,
            commands::workspace_files::read_workspace_directory,
            commands::workspace_files::read_workspace_text_file,
            commands::workspace_files::read_workspace_binary_file,
            commands::window_chrome::show_main_window,
            commands::team_share::team_share_create,
            commands::team_share::enable::team_share_enable_oss,
            commands::team_share::enable::team_share_enable_managed_git,
            commands::team_share::enable::team_share_enable_custom_git,
            commands::team_share::enable::team_share_set_team_secret,
            commands::team_share::enable::team_share_get_team_secret,
            commands::team_share::enable::team_share_get_status,
            commands::team_share::enable::team_sync_paths,
            commands::team_share::join::team_share_join_existing,
            commands::team_litellm::team_litellm_setup,
            commands::team_sync_proxy::oss_sync_now,
            commands::team_sync_proxy::oss_sync_status,
            commands::team_sync_proxy::team_env_runtime_status,
            commands::team_sync_proxy::oss_sync_list_versions,
            commands::team_sync_proxy::oss_sync_get_version_content,
            commands::team_sync_proxy::oss_sync_restore_version,
            commands::team_sync_proxy::oss_sync_resolve_conflict,
            commands::team_sync_proxy::oss_sync_set_team_sync_mode,
            commands::team_sync_proxy::oss_sync_get_team_sync_mode,
        ])
        .setup(|app| {
            let setup_t0 = std::time::Instant::now();

            // Register aptabase here (inside setup) so the Tokio runtime is available
            // for its internal `tokio::spawn` polling loop.
            app.handle().plugin(tauri_plugin_aptabase::Builder::new("A-US-9094113207").build())?;

            // Start RAG HTTP API server for MCP bridge
            let rag_state_handle = app.handle().state::<commands::knowledge::RagState>();
            let rag_state_for_http = std::sync::Arc::new(rag_state_handle.inner().clone());

            tauri::async_runtime::spawn(async move {
                if let Err(e) = commands::rag_http_server::start_http_server(rag_state_for_http, 13143).await {
                    sentry_utils::capture_err("[RAG HTTP] Failed to start HTTP server", &e);
                    eprintln!("[RAG HTTP] Failed to start HTTP server: {}", e);
                }
            });

            // Start introspect MCP internal API server
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = commands::introspect_api::start_introspect_api(app_handle).await {
                        eprintln!("[IntrospectAPI] Failed to start: {}", e);
                    }
                });
            }

            // Local fast-path: mirror the local daemon's session/live publishes
            // over loopback SSE into the same `mqtt:envelopes` webview event the
            // MQTT bridge uses. Streaming from a local agent stays smooth (and
            // available) regardless of broker RTT; duplicates are dropped by the
            // webview's eventId dedup.
            commands::daemon_live::spawn(app.handle().clone());

            // Team sync will be triggered from the frontend after workspace is set,
            // since workspace_path is not available at setup time.
            // The frontend calls team_sync_repo on startup when team config is enabled.

            eprintln!("[Startup] Setup hook: {:.1}ms", setup_t0.elapsed().as_secs_f64() * 1000.0);

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
                .tooltip(branding::brand_name(app.config().product_name.as_deref()))
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
                        let state = app.state::<commands::window_chrome::MainWindowState>();
                        commands::window_chrome::show_main_window(app.clone(), state);
                    }
                })
                .on_menu_event(|app: &tauri::AppHandle, event: tauri::menu::MenuEvent| {
                    match event.id().as_ref() {
                        "show_main" => {
                            let state = app.state::<commands::window_chrome::MainWindowState>();
                            commands::window_chrome::show_main_window(app.clone(), state);
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // --- Reposition macOS traffic lights on startup ---
            #[cfg(target_os = "macos")]
            if let Some(main_win) = app.get_webview_window("main") {
                commands::window_chrome::reposition_traffic_lights(&main_win);
            }

            // --- Window event handlers ---
            if let Some(main_win) = app.get_webview_window("main") {
                let main_win_clone = main_win.clone();
                let close_app_handle = app.handle().clone();
                main_win.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            let state = close_app_handle.state::<commands::window_chrome::MainWindowState>();
                            commands::window_chrome::save_main_window_state(&main_win_clone, &state);
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
                            commands::window_chrome::reposition_traffic_lights(&main_win_clone);
                        }
                        // DAU heartbeat: fires `app_active` once the app
                        // returns to focus after >=4h idle.
                        tauri::WindowEvent::Focused(true) => {
                            maybe_emit_app_active(&close_app_handle);
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
                                // Window-mutating commands touch AppKit/Cocoa window APIs
                                // and MUST run on the main thread (macOS requirement).
                                // The test control server runs on a tokio thread, so we
                                // dispatch all window-mutating commands via run_on_main_thread.
                                match cmd {
                                    "show_main_window" => {
                                        let app_main = app.clone();
                                        let _ = app.run_on_main_thread(move || {
                                            let state = app_main.state::<commands::window_chrome::MainWindowState>();
                                            commands::window_chrome::show_main_window(app_main.clone(), state);
                                        });
                                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
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

            // Track app_started (always, regardless of consent)
            let _ = app.handle().track_event("app_started", Some(serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"),
                "platform": std::env::consts::OS,
            })));
            record_activity();

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if webview_recovery::request_restart_if_main_webview_unhealthy(app, "macOS reopen") {
                        return;
                    }
                    // Always show the main window when the dock icon is clicked.
                    // Tauri's `has_visible_windows` can report `true` even when
                    // the window was hidden via `win.hide()`, so we ignore it and
                    // unconditionally bring the window back.
                    let state = app.state::<commands::window_chrome::MainWindowState>();
                    commands::window_chrome::show_main_window(app.clone(), state);
                    maybe_emit_app_active(app);
                }
                tauri::RunEvent::Resumed => {
                    // Force-reconnect MQTT after system wake so the persistent
                    // session re-establishes quickly (broker drops the TCP connection
                    // during sleep but the client may not notice for 30s+).
                    if let Some(bus) = app.try_state::<crate::mqtt::MqttBus>() {
                        let bus = (*bus).clone();
                        tauri::async_runtime::spawn(async move {
                            bus.force_reconnect().await;
                        });
                    }

                    let app_handle = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(750));
                        let app_for_probe = app_handle.clone();
                        let _ = app_handle.run_on_main_thread(move || {
                            webview_recovery::request_restart_if_main_webview_unhealthy(
                                &app_for_probe,
                                "event loop resume",
                            );
                        });
                    });
                }
                tauri::RunEvent::Exit => {
                    // Fire-and-forget: enqueue the event but don't block on flush.
                    // The aptabase plugin's own Exit handler will attempt to flush,
                    // but we don't want to block exit for up to 10s on a network
                    // request (the aptabase HTTP timeout) if the server is slow.
                    let _ = app.track_event("app_exited", None);
                }
                tauri::RunEvent::ExitRequested { .. } => {
                    if let Some(registry) = app.try_state::<std::sync::Arc<crate::terminal::Registry>>() {
                        registry.kill_all();
                    }
                }
                _ => {}
            }
        });
}

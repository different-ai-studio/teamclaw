pub mod acp_debug_log;
pub mod agents_skills;
pub mod amuxd_supervisor;
pub mod app_menu;
pub mod clawhub;
pub mod cron;
pub mod daemon_http;
pub mod daemon_installer;
pub mod daemon_live;
pub mod daemon_onboarding;
pub mod deps;
pub mod diagnostics;
pub mod env_vars;
pub mod filewatcher;
pub mod gateway;
pub mod git;
pub mod introspect_api;
pub mod knowledge;
pub mod local_secret_store;
pub mod local_stats;
pub mod mcp;
pub mod mqtt_bus;
pub mod oauth_loopback;
pub mod oss_sync;
pub mod server_config;
pub mod session_export;
pub mod setup;
pub mod shared_secrets;
pub mod shared_secrets_crypto;
pub mod skillssh;
pub mod storage_migration;
pub mod system_appearance;
pub mod team;
pub mod team_git;
pub mod team_litellm;
pub mod team_secret_store;
pub mod team_share;
pub mod team_skills;
pub mod team_sync_proxy;
pub mod team_types;
pub mod team_unified;
pub mod terminal;
pub mod trash;
pub mod tray_menu;
pub mod updater;
pub mod webview;
pub mod window;
pub mod window_chrome;
pub mod workspace_files;

#[cfg(target_os = "windows")]
use crate::process_util::CommandNoWindow;

/// The short application name, injected at compile time via `build.rs`.
pub const APP_SHORT_NAME: &str = env!("APP_SHORT_NAME");
/// Workspace metadata directory (`.teamclu` for official builds).
pub const TEAMCLU_DIR: &str = env!("TEAMCLU_DIR");
/// Subfolder inside workspace where the team repo is cloned / symlinked.
/// Fixed across brands — must match the daemon's `TEAM_LINK_NAME` (`teamclu-team`).
pub const TEAM_REPO_DIR: &str = "teamclu-team";
/// Workspace config file name (`teamclu.json` for official builds).
pub const CONFIG_FILE_NAME: &str = env!("CONFIG_FILE_NAME");
/// Home-directory storage folder name without leading dot (`teamclu` for official).
pub fn home_storage_dir_name() -> &'static str {
    teamclu_runtime_env::resolve_storage_dir_name(APP_SHORT_NAME)
}

/// Local amuxd state directory for this desktop brand (`~/.amuxd` or `~/.amuxd-<brand>`).
pub fn amuxd_home_dir() -> std::path::PathBuf {
    teamclu_runtime_env::amuxd_home_for_brand(APP_SHORT_NAME)
}

/// Stamp brand + `AMUXD_HOME` onto a shell sidecar so CLI (`init` / `clear` /
/// `doctor`) reads the same state dir as the desktop-managed daemon.
pub fn with_amuxd_brand_env(
    command: tauri_plugin_shell::process::Command,
) -> tauri_plugin_shell::process::Command {
    command
        .env(teamclu_runtime_env::BRAND_SHORT_NAME_ENV, APP_SHORT_NAME)
        .env(
            teamclu_runtime_env::AMUXD_HOME_ENV,
            amuxd_home_dir().to_string_lossy().as_ref(),
        )
}

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to TeamClu.", name)
}

/// Best-effort OS account name used to seed a new member's default display
/// name (instead of the legacy "You"). Prefers the human "real name" — macOS
/// Directory Services full name, Windows account display name, Linux GECOS —
/// and falls back to the login username. Returns an empty string when nothing
/// usable is available, in which case the server synthesizes a handle.
#[tauri::command]
pub fn os_full_name() -> String {
    let real = whoami::realname();
    if !real.trim().is_empty() {
        return real.trim().to_string();
    }
    let user = whoami::username();
    if !user.trim().is_empty() {
        return user.trim().to_string();
    }
    String::new()
}

/// Best-effort machine hostname, used to seed a default name when onboarding
/// this machine's agent (e.g. "MacBook-Pro"). Strips a trailing ".local" the
/// way macOS appends it, and returns an empty string when nothing usable is
/// available so the caller can fall back to its own placeholder.
#[tauri::command]
pub fn get_device_hostname() -> String {
    let host = gethostname::gethostname().to_string_lossy().to_string();
    let host = host.trim();
    host.strip_suffix(".local")
        .unwrap_or(host)
        .trim()
        .to_string()
}

/// Reveal a file or folder in the native file manager (Finder on macOS, Explorer on Windows).
#[tauri::command]
pub fn show_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try xdg-open on the parent directory
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("Failed to reveal in file manager: {}", e))?;
    }

    Ok(())
}

/// Open a file with the system default application.
#[tauri::command]
pub fn open_with_default_app(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .no_window()
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
}

/// Open a terminal at the given directory path.
#[tauri::command]
pub fn open_in_terminal(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Terminal", &path])
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        // Hide the outer launcher's console; `start` spawns the user-visible
        // terminal in its own new console as intended.
        std::process::Command::new("cmd")
            .no_window()
            .args(["/C", "start", "cmd", "/K", &format!("cd /d {}", path)])
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try common terminal emulators
        let terminals = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];
        let mut opened = false;
        for term in &terminals {
            if std::process::Command::new(term)
                .current_dir(&path)
                .spawn()
                .is_ok()
            {
                opened = true;
                break;
            }
        }
        if !opened {
            return Err("No terminal emulator found".to_string());
        }
    }

    Ok(())
}

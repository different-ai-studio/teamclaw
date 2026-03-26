pub mod clawhub;
pub mod cron;
pub mod deps;
pub mod env_vars;
pub mod filewatcher;
pub mod gateway;
pub mod git;
pub mod knowledge;
pub mod local_stats;
pub mod mcp;
pub mod opencode;
pub mod oss_commands;
pub mod oss_sync;
pub mod oss_types;
pub mod p2p_state;
pub mod rag_http_server;
pub mod skillssh;
pub mod spotlight;
pub mod stt;
pub mod team;
#[cfg(feature = "p2p")]
pub mod team_p2p;
pub mod team_unified;
pub mod team_webdav;
pub mod updater;
pub mod version_commands;
pub mod version_store;
pub mod version_types;
pub mod webview;

/// The short application name, injected at compile time via `build.rs`.
#[allow(dead_code)]
pub const APP_SHORT_NAME: &str = env!("APP_SHORT_NAME");
/// Directory name for all TeamClaw local config/data files, created under the workspace root.
pub const TEAMCLAW_DIR: &str = concat!(".", env!("APP_SHORT_NAME"));
/// Subfolder inside workspace where the team repo is cloned.
pub const TEAM_REPO_DIR: &str = concat!(env!("APP_SHORT_NAME"), "-team");
/// Config file name (e.g. `teamclaw.json`).
pub const CONFIG_FILE_NAME: &str = concat!(env!("APP_SHORT_NAME"), ".json");

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to TeamClaw.", name)
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
        std::process::Command::new("cmd")
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

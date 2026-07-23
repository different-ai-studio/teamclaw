use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as AsyncCommand;

use crate::process_util::CommandNoWindow;

/// Installation commands for each platform
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformInstallCommands {
    pub macos: String,
    pub windows: String,
    pub linux: String,
}

/// Information about a single external dependency
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyInfo {
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub required: bool,
    pub description: String,
    pub install_commands: PlatformInstallCommands,
    pub affected_features: Vec<String>,
    /// Install priority — lower numbers install first (e.g., Homebrew = 0, others = 1)
    pub priority: u8,
}

/// Event payload emitted during dependency installation
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepInstallProgress {
    pub name: String,
    /// "started" | "installing" | "done" | "failed"
    pub status: String,
    pub output_line: Option<String>,
    pub error: Option<String>,
}

/// Resolve the program to probe for a dependency's `--version` check.
///
/// For most tools this is just the dependency name looked up on PATH. opencode
/// is the exception: its official installer hardcodes `~/.opencode/bin`, which is
/// NOT on the PATH a GUI app inherits when launched from Finder — so a bare
/// `Command::new("opencode")` probe fails even though the binary is installed and
/// amuxd (which resolves it by absolute path) runs it fine. Mirror amuxd's
/// resolution order here: `~/.opencode/bin/opencode` (absolute) -> PATH fallback.
/// See apps/daemon/src/opencode_install/mod.rs `resolve_binary`.
fn probe_program(name: &str) -> String {
    if name != "opencode" {
        return name.to_string();
    }
    let bin = if cfg!(windows) {
        "opencode.exe"
    } else {
        "opencode"
    };
    if let Some(home) = dirs::home_dir() {
        let p = home.join(".opencode").join("bin").join(bin);
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    "opencode".to_string()
}

/// Check a single dependency by running `cmd --version` (or a variant).
/// Returns a DependencyInfo with installed status and parsed version.
fn check_single_dependency(
    name: &str,
    version_args: &[&str],
    required: bool,
    description: &str,
    install_commands: PlatformInstallCommands,
    affected_features: Vec<String>,
    priority: u8,
) -> DependencyInfo {
    let output = Command::new(probe_program(name))
        .no_window()
        .args(version_args)
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let raw = String::from_utf8_lossy(&o.stdout).to_string();
            // Some tools output to stderr (e.g., git on some platforms)
            let raw_stderr = String::from_utf8_lossy(&o.stderr).to_string();
            let combined = if raw.trim().is_empty() {
                raw_stderr
            } else {
                raw
            };

            let version = parse_version(&combined);

            DependencyInfo {
                name: name.to_string(),
                installed: true,
                version,
                required,
                description: description.to_string(),
                install_commands,
                affected_features,
                priority,
            }
        }
        _ => DependencyInfo {
            name: name.to_string(),
            installed: false,
            version: None,
            required,
            description: description.to_string(),
            install_commands,
            affected_features,
            priority,
        },
    }
}

/// Try to extract a semantic version (X.Y.Z or X.Y) from a version string.
/// Handles common formats like:
///   - "git version 2.43.0"
///   - "gh version 2.40.1 (2024-01-15)"
///   - "v22.1.0"
///   - "node v22.1.0"
fn parse_version(raw: &str) -> Option<String> {
    // Scan for the first digit sequence that looks like a version (X.Y or X.Y.Z)
    let chars: Vec<char> = raw.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        // Find start of a digit sequence
        if chars[i].is_ascii_digit() {
            let start = i;
            // Consume digits and dots that form a version pattern
            let mut dot_count = 0;
            while i < len && (chars[i].is_ascii_digit() || chars[i] == '.') {
                if chars[i] == '.' {
                    dot_count += 1;
                }
                i += 1;
            }
            // Must have at least one dot (X.Y) and not end with a dot
            if dot_count >= 1 && !chars[i - 1].eq(&'.') {
                let version: String = chars[start..i].iter().collect();
                return Some(version);
            }
        } else {
            i += 1;
        }
    }

    None
}

/// Get the platform-specific install command for a dependency.
/// Used by both check_dependencies (for display) and install_dependency (for execution).
fn get_install_command(name: &str) -> Option<String> {
    let commands = get_install_commands_map(name)?;
    if cfg!(target_os = "macos") {
        Some(commands.macos)
    } else if cfg!(target_os = "windows") {
        Some(commands.windows)
    } else {
        Some(commands.linux)
    }
}

/// Get PlatformInstallCommands for a dependency by name.
fn get_install_commands_map(name: &str) -> Option<PlatformInstallCommands> {
    match name {
        "brew" => Some(PlatformInstallCommands {
            macos: r#"/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)""#.to_string(),
            windows: String::new(),
            linux: String::new(),
        }),
        "git" => Some(PlatformInstallCommands {
            macos: "xcode-select --install".to_string(),
            windows: "winget install Git.Git".to_string(),
            linux: "sudo apt install -y git".to_string(),
        }),
        "gh" => Some(PlatformInstallCommands {
            macos: "brew install gh".to_string(),
            windows: "winget install GitHub.cli".to_string(),
            linux: "sudo apt install -y gh".to_string(),
        }),
        "node" => Some(PlatformInstallCommands {
            macos: "brew install node".to_string(),
            windows: "winget install OpenJS.NodeJS".to_string(),
            linux: "sudo apt install -y nodejs".to_string(),
        }),
        "python3" => Some(PlatformInstallCommands {
            macos: "brew install python3".to_string(),
            windows: "winget install Python.Python.3".to_string(),
            linux: "sudo apt install -y python3".to_string(),
        }),
        // opencode is installed/updated via the bundled `amuxd install-opencode`
        // (same path as the first-run SetupWizard) — this string is display-only;
        // the real install is handled specially in `install_dependency`.
        "opencode" => Some(PlatformInstallCommands {
            macos: "amuxd install-opencode".to_string(),
            windows: "amuxd install-opencode".to_string(),
            linux: "amuxd install-opencode".to_string(),
        }),
        _ => None,
    }
}

/// Check if a dependency's install command requires Homebrew on macOS.
fn requires_brew(name: &str) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    matches!(name, "gh" | "node" | "python3")
}

/// Check all external dependencies and return their status.
/// Results are sorted by priority (lower first) for install ordering.
#[tauri::command]
pub fn check_dependencies() -> Vec<DependencyInfo> {
    let mut deps = Vec::new();

    // Homebrew — macOS only, required, priority 0
    if cfg!(target_os = "macos") {
        deps.push(check_single_dependency(
            "brew",
            &["--version"],
            false,
            "Package manager - needed to install other tools on macOS",
            get_install_commands_map("brew").unwrap(),
            vec!["Package Management".to_string()],
            0, // priority 0 — install first
        ));
    }

    // Git — required, priority 1
    deps.push(check_single_dependency(
        "git",
        &["--version"],
        false,
        "Version control - needed for team Git sync",
        get_install_commands_map("git").unwrap(),
        vec!["Team Git Sync".to_string(), "Version Control".to_string()],
        1,
    ));

    // GitHub CLI — optional, priority 1
    deps.push(check_single_dependency(
        "gh",
        &["--version"],
        false,
        "GitHub CLI - needed for spec-plan, spec-pr, and issue management",
        get_install_commands_map("gh").unwrap(),
        vec![
            "spec-plan".to_string(),
            "spec-pr".to_string(),
            "GitHub Issues".to_string(),
        ],
        1,
    ));

    // Node.js — optional, priority 1
    deps.push(check_single_dependency(
        "node",
        &["--version"],
        false,
        "Node.js runtime - needed to run some MCP servers (via npx)",
        get_install_commands_map("node").unwrap(),
        vec!["MCP Servers (npx-based)".to_string()],
        1,
    ));

    // Python 3 — optional, priority 1
    deps.push(check_single_dependency(
        "python3",
        &["--version"],
        false,
        "Python runtime - needed for uvx-based MCP servers and data analysis",
        get_install_commands_map("python3").unwrap(),
        vec![
            "MCP Servers (uvx-based)".to_string(),
            "Data Analysis".to_string(),
        ],
        1,
    ));

    // opencode — required, priority 1 (the local agent runtime).
    // Install/update is handled specially via `amuxd install-opencode`.
    deps.push(check_single_dependency(
        "opencode",
        &["--version"],
        true,
        "Agent runtime - required to run the local AI agent",
        get_install_commands_map("opencode").unwrap(),
        vec!["Local Agent".to_string()],
        1,
    ));

    // Sort by priority (lower first)
    deps.sort_by_key(|d| d.priority);
    deps
}

/// Install a single dependency using the platform's package manager.
/// Streams output via `dep-install-progress` events.
/// Returns true on success, false on failure.
/// `download_base` (opencode only) is the install mirror base from
/// `buildConfig.opencode.downloadBase`; ignored for other dependencies.
#[tauri::command]
pub async fn install_dependency<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    download_base: Option<String>,
) -> Result<bool, String> {
    // opencode is installed via the same `amuxd install-opencode` path as the
    // first-run SetupWizard (official opencode, pinned to opencode.lock.json).
    if name == "opencode" {
        return Ok(install_opencode_via_amuxd(&app, download_base).await);
    }

    // On macOS, if the dependency requires brew and brew is not installed, install brew first
    if requires_brew(&name) {
        let brew_check = Command::new("brew").no_window().arg("--version").output();
        let brew_installed = matches!(brew_check, Ok(o) if o.status.success());
        if !brew_installed {
            let brew_result = run_install(&app, "brew").await;
            if !brew_result {
                return Err(
                    "Failed to install Homebrew, which is required to install this dependency"
                        .to_string(),
                );
            }
        }
    }

    let success = run_install(&app, &name).await;
    Ok(success)
}

/// Update an already-installed dependency to the required version.
/// Only opencode supports this (re-runs `amuxd install-opencode`, idempotent).
#[tauri::command]
pub async fn update_dependency<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    download_base: Option<String>,
) -> Result<bool, String> {
    if name == "opencode" {
        return Ok(install_opencode_via_amuxd(&app, download_base).await);
    }
    Err(format!("No update path available for '{}'", name))
}

/// Install-or-update opencode via the bundled `amuxd install-opencode`, bridging
/// its progress onto `dep-install-progress` events (the settings Dependencies UI
/// contract). Shares the exact install path used by the first-run SetupWizard.
async fn install_opencode_via_amuxd<R: Runtime>(
    app: &AppHandle<R>,
    download_base: Option<String>,
) -> bool {
    let emit_app = app.clone();
    let result = crate::commands::setup::run_amuxd_install_opencode(
        app,
        download_base,
        move |status, line, error| {
            // amuxd emits "running"; the deps UI expects "installing".
            let status = if status == "running" {
                "installing"
            } else {
                status
            };
            let _ = emit_app.emit(
                "dep-install-progress",
                DepInstallProgress {
                    name: "opencode".to_string(),
                    status: status.to_string(),
                    output_line: line,
                    error,
                },
            );
        },
    )
    .await;
    result.is_ok()
}

/// Execute the actual install command and stream output via events.
async fn run_install<R: Runtime>(app: &AppHandle<R>, name: &str) -> bool {
    let install_cmd = match get_install_command(name) {
        Some(cmd) if !cmd.is_empty() => cmd,
        _ => {
            let _ = app.emit(
                "dep-install-progress",
                DepInstallProgress {
                    name: name.to_string(),
                    status: "failed".to_string(),
                    output_line: None,
                    error: Some(format!(
                        "No install command available for '{}' on this platform",
                        name
                    )),
                },
            );
            return false;
        }
    };

    // Emit started event
    let _ = app.emit(
        "dep-install-progress",
        DepInstallProgress {
            name: name.to_string(),
            status: "started".to_string(),
            output_line: None,
            error: None,
        },
    );

    // Spawn the install process via shell
    let shell = if cfg!(target_os = "windows") {
        "cmd"
    } else {
        "/bin/bash"
    };
    let shell_args: Vec<&str> = if cfg!(target_os = "windows") {
        vec!["/C", &install_cmd]
    } else {
        vec!["-c", &install_cmd]
    };

    let child = AsyncCommand::new(shell)
        .no_window()
        .args(&shell_args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit(
                "dep-install-progress",
                DepInstallProgress {
                    name: name.to_string(),
                    status: "failed".to_string(),
                    output_line: None,
                    error: Some(format!("Failed to spawn install process: {}", e)),
                },
            );
            return false;
        }
    };

    // Stream stdout
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_clone = app.clone();
    let name_owned = name.to_string();

    let stdout_handle = tokio::spawn({
        let app = app_clone.clone();
        let name = name_owned.clone();
        async move {
            if let Some(stdout) = stdout {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let _ = app.emit(
                        "dep-install-progress",
                        DepInstallProgress {
                            name: name.clone(),
                            status: "installing".to_string(),
                            output_line: Some(line),
                            error: None,
                        },
                    );
                }
            }
        }
    });

    let stderr_handle = tokio::spawn({
        let app = app_clone;
        let name = name_owned.clone();
        async move {
            if let Some(stderr) = stderr {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let _ = app.emit(
                        "dep-install-progress",
                        DepInstallProgress {
                            name: name.clone(),
                            status: "installing".to_string(),
                            output_line: Some(line),
                            error: None,
                        },
                    );
                }
            }
        }
    });

    // Wait for streams to finish
    let _ = stdout_handle.await;
    let _ = stderr_handle.await;

    // Wait for process to exit
    let exit_status = child.wait().await;
    let success = matches!(exit_status, Ok(s) if s.success());

    if success {
        let _ = app.emit(
            "dep-install-progress",
            DepInstallProgress {
                name: name_owned,
                status: "done".to_string(),
                output_line: None,
                error: None,
            },
        );
    } else {
        let error_msg = match exit_status {
            Ok(s) => format!("Process exited with code: {}", s.code().unwrap_or(-1)),
            Err(e) => format!("Failed to wait for process: {}", e),
        };
        let _ = app.emit(
            "dep-install-progress",
            DepInstallProgress {
                name: name_owned,
                status: "failed".to_string(),
                output_line: None,
                error: Some(error_msg),
            },
        );
    }

    success
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_program_passes_through_non_opencode() {
        assert_eq!(probe_program("git"), "git");
        assert_eq!(probe_program("node"), "node");
    }

    #[test]
    fn probe_program_resolves_opencode_absolute_when_present() {
        // opencode's official installer targets ~/.opencode/bin; when that binary
        // exists the probe must use its absolute path, not the bare PATH name a
        // Finder-launched GUI can't resolve.
        let bin = if cfg!(windows) { "opencode.exe" } else { "opencode" };
        let expected = dirs::home_dir().map(|h| h.join(".opencode").join("bin").join(bin));
        let got = probe_program("opencode");
        match expected {
            Some(p) if p.exists() => assert_eq!(got, p.to_string_lossy()),
            // No installed binary in this environment: falls back to PATH lookup.
            _ => assert_eq!(got, "opencode"),
        }
    }
}

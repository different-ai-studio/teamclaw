use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Tauri event name carrying `SetupProgress` to the first-run wizard UI.
const SETUP_PROGRESS_EVENT: &str = "setup-progress";

/// One installable/checkable prerequisite shown in the first-run wizard.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementStatus {
    pub id: String,
    pub title: String,
    pub optional: bool,
    pub present: bool,
    pub version: Option<String>,
}

/// Rust target triple for the current host (matches the sidecar naming convention).
fn target_triple() -> String {
    let arch = std::env::consts::ARCH;
    match std::env::consts::OS {
        "macos" => format!("{arch}-apple-darwin"),
        "linux" => format!("{arch}-unknown-linux-gnu"),
        "windows" => format!("{arch}-pc-windows-msvc"),
        other => format!("{arch}-unknown-{other}"),
    }
}

/// `git --version` first line, or None if git is unavailable.
fn detect_git() -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["--version"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Resolve an executable path, trying a `.exe` suffix on Windows. Mirrors opencode.rs.
fn resolve_exe(path: PathBuf) -> Option<PathBuf> {
    if path.exists() {
        return Some(path);
    }
    if cfg!(windows) {
        let mut with_exe = path.into_os_string();
        with_exe.push(".exe");
        let with_exe = PathBuf::from(with_exe);
        if with_exe.exists() {
            return Some(with_exe);
        }
    }
    None
}

/// Locate the amuxd binary bundled with the app (dev: apps/desktop/binaries; prod: next to exe).
fn locate_bundled_amuxd() -> Option<PathBuf> {
    locate_bundled_sidecar("amuxd")
}

fn locate_bundled_sidecar(base_name: &str) -> Option<PathBuf> {
    let triple = target_triple();
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{base_name}-{triple}"));
    if let Some(p) = resolve_exe(dev) {
        return Some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for cand in [format!("{base_name}-{triple}"), base_name.to_string()] {
        if let Some(p) = resolve_exe(dir.join(cand)) {
            return Some(p);
        }
    }
    None
}

/// Run the bundled `amuxd doctor` and return its parsed JSON (opencode/git/amuxd
/// status). amuxd resolves opencode/amuxd by absolute path, so this is accurate
/// even when the app/daemon PATH excludes those dirs.
async fn read_doctor<R: Runtime>(
    app: &AppHandle<R>,
    local_agent: Option<&str>,
) -> Option<serde_json::Value> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;
    let mut command = app.shell().sidecar("amuxd").ok()?.args(["doctor"]);
    // Reflect the build's target runtime (buildConfig.localAgent) so the wizard
    // shows pi vs opencode status regardless of the current daemon.toml config.
    if let Some(agent) = local_agent.map(str::trim).filter(|a| !a.is_empty()) {
        command = command.env("AMUXD_DOCTOR_LOCAL_AGENT", agent);
    }
    let (mut rx, _child) = command.spawn().ok()?;
    let mut buf = String::new();
    while let Some(event) = rx.recv().await {
        if let CommandEvent::Stdout(bytes) = event {
            buf.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    serde_json::from_str(buf.trim()).ok()
}

#[tauri::command]
pub async fn setup_list_requirements<R: Runtime>(
    app: AppHandle<R>,
    local_agent: Option<String>,
) -> Result<Vec<RequirementStatus>, String> {
    // Which local runtime this build targets ("opencode" default | "pi").
    let use_pi = local_agent.as_deref().map(str::trim) == Some("pi");
    let git_version = detect_git();
    let doctor = read_doctor(&app, local_agent.as_deref()).await;

    // `present` = no action needed (installed AND new enough). `version` = the
    // installed version, so the UI can show 安装 (none) vs 升级 (older) and which.
    // amuxd: desktop-managed sidecar — satisfied when the bundle includes it.
    let amuxd_version = doctor
        .as_ref()
        .and_then(|d| d["amuxd"]["installedVersion"].as_str())
        .map(|s| s.to_string());

    // The agent-runtime row reflects the build's target: pi or opencode. Its
    // status comes from the matching key in `amuxd doctor` output (pi is only
    // present when this build/daemon targets pi, which we force via env above).
    let runtime_key = if use_pi { "pi" } else { "opencode" };
    let runtime = doctor.as_ref().map(|d| &d[runtime_key]);
    let runtime_satisfied = runtime
        .and_then(|r| r["satisfied"].as_bool())
        .unwrap_or(false);
    let runtime_version = runtime
        .and_then(|r| r["version"].as_str())
        .map(|s| s.to_string());
    let (runtime_id, runtime_title) = if use_pi {
        ("pi", "Pi runtime")
    } else {
        ("opencode", "OpenCode runtime")
    };

    Ok(vec![
        RequirementStatus {
            id: "amuxd".into(),
            title: "Agent daemon (amuxd)".into(),
            optional: false,
            // Desktop-managed: the bundled sidecar is the binary we run — no
            // copy into ~/.amuxd/bin is required.
            present: locate_bundled_amuxd().is_some(),
            version: amuxd_version.or_else(|| {
                locate_bundled_amuxd().and_then(|p| {
                    std::process::Command::new(&p)
                        .arg("--version")
                        .output()
                        .ok()
                        .and_then(|o| {
                            let s = String::from_utf8_lossy(&o.stdout);
                            s.split_whitespace()
                                .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()))
                                .map(|t| t.to_string())
                        })
                })
            }),
        },
        RequirementStatus {
            id: runtime_id.into(),
            title: runtime_title.into(),
            optional: false,
            present: runtime_satisfied,
            version: runtime_version,
        },
        RequirementStatus {
            id: "git".into(),
            title: "Git".into(),
            optional: true,
            present: git_version.is_some(),
            version: git_version,
        },
    ])
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupProgress {
    pub id: String,
    /// "started" | "running" | "done" | "failed"
    pub status: String,
    pub line: Option<String>,
    pub error: Option<String>,
}

fn emit_progress<R: Runtime>(app: &AppHandle<R>, p: SetupProgress) {
    let _ = app.emit(SETUP_PROGRESS_EVENT, p);
}

/// Run a bundled `amuxd <args>` to completion; Err on non-zero exit.
async fn run_amuxd_sidecar<R: Runtime>(app: &AppHandle<R>, args: &[&str]) -> Result<(), String> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;
    let (mut rx, _child) = app
        .shell()
        .sidecar("amuxd")
        .map_err(|e| format!("sidecar amuxd: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("spawn amuxd: {e}"))?;
    let mut code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        if let CommandEvent::Terminated(p) = event {
            code = Some(p.code.unwrap_or(-1));
        }
    }
    if code != Some(0) {
        return Err(format!("amuxd {} exited with {:?}", args.join(" "), code));
    }
    Ok(())
}

/// Ensure the desktop-managed amuxd sidecar is running. No longer copies into
/// `~/.amuxd/bin` or registers a background service.
async fn install_amuxd<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    emit_progress(
        app,
        SetupProgress {
            id: "amuxd".into(),
            status: "started".into(),
            line: Some("starting managed amuxd".into()),
            error: None,
        },
    );
    match crate::commands::amuxd_supervisor::AmuxdSupervisor::ensure_started(app).await {
        Ok(()) => {
            emit_progress(
                app,
                SetupProgress {
                    id: "amuxd".into(),
                    status: "done".into(),
                    line: None,
                    error: None,
                },
            );
            Ok(())
        }
        Err(e) => {
            emit_progress(
                app,
                SetupProgress {
                    id: "amuxd".into(),
                    status: "failed".into(),
                    line: None,
                    error: Some(e.clone()),
                },
            );
            Err(e)
        }
    }
}

/// Run the bundled `amuxd install-opencode` sidecar, streaming its JSON progress lines.
/// `download_base`, when set (from `buildConfig.opencode.downloadBase`), is passed
/// to the daemon as `OPENCODE_DOWNLOAD_BASE` so it pulls the opencode release
/// archive from a mirror (e.g. a domestic OSS bucket) instead of the official source.
/// Run `amuxd install-opencode`, streaming progress through `emit`.
///
/// `emit(status, line, error)` — status is "started" | "running" | "failed" |
/// "done". This is the ONE opencode install/update path (official opencode,
/// pinned to the daemon's `opencode.lock.json` minimum version; direct-download
/// on Windows / mirror). Shared by the first-run SetupWizard and the settings
/// Dependencies page so both surfaces install/update opencode identically.
/// `install-opencode` is idempotent, so the same call both installs and upgrades.
pub(crate) async fn run_amuxd_install_opencode<R, F>(
    app: &AppHandle<R>,
    download_base: Option<String>,
    emit: F,
) -> Result<(), String>
where
    R: Runtime,
    F: Fn(&str, Option<String>, Option<String>) + Send,
{
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    emit("started", None, None);
    let mut command = app
        .shell()
        .sidecar("amuxd")
        .map_err(|e| format!("sidecar amuxd: {e}"))?
        .args(["install-opencode"]);
    if let Some(base) = download_base
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
    {
        command = command.env("OPENCODE_DOWNLOAD_BASE", base);
    }
    // `_child_guard` must stay alive until `rx` is fully drained: dropping the
    // CommandChild early can terminate the sidecar before install finishes.
    let (mut rx, _child_guard) = command.spawn().map_err(|e| format!("spawn amuxd: {e}"))?;

    // Note: we record failure in `last_err` and only act on it after the event
    // loop ends — Terminated is not guaranteed to be the final event, so we keep
    // draining stdout/stderr after it before deciding success/failure.
    let mut last_err: Option<String> = None;
    // Track the most recent stderr line so a non-zero exit surfaces amuxd's real
    // reason (e.g. an HTTP 404) instead of a bare exit code.
    let mut last_stderr: Option<String> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    emit("running", Some(line), None);
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    last_stderr = Some(line.clone());
                    emit("running", Some(line), None);
                }
            }
            CommandEvent::Terminated(payload) if payload.code.unwrap_or(-1) != 0 => {
                last_err = Some(match &last_stderr {
                    Some(s) => format!("amuxd install-opencode failed: {s}"),
                    None => format!("amuxd install-opencode exited with code {:?}", payload.code),
                });
            }
            _ => {}
        }
    }
    if let Some(e) = last_err {
        emit("failed", None, Some(e.clone()));
        return Err(e);
    }
    emit("done", None, None);
    Ok(())
}

async fn install_opencode<R: Runtime>(
    app: &AppHandle<R>,
    download_base: Option<String>,
) -> Result<(), String> {
    run_amuxd_install_opencode(app, download_base, |status, line, error| {
        emit_progress(
            app,
            SetupProgress {
                id: "opencode".into(),
                status: status.into(),
                line,
                error,
            },
        );
    })
    .await
}

/// Run the bundled `amuxd install-pi` sidecar, streaming its JSON progress lines
/// under the "pi" requirement id. Idempotent (installs or upgrades to the pinned
/// `pi.lock.json` minimum), mirroring the opencode install path.
async fn install_pi<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    emit_progress(
        app,
        SetupProgress {
            id: "pi".into(),
            status: "started".into(),
            line: None,
            error: None,
        },
    );
    let (mut rx, _child_guard) = app
        .shell()
        .sidecar("amuxd")
        .map_err(|e| format!("sidecar amuxd: {e}"))?
        .args(["install-pi"])
        .spawn()
        .map_err(|e| format!("spawn amuxd: {e}"))?;

    let mut last_err: Option<String> = None;
    let mut last_stderr: Option<String> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    emit_progress(
                        app,
                        SetupProgress {
                            id: "pi".into(),
                            status: "running".into(),
                            line: Some(line),
                            error: None,
                        },
                    );
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    last_stderr = Some(line);
                }
            }
            CommandEvent::Terminated(payload) if payload.code.unwrap_or(-1) != 0 => {
                last_err = Some(match &last_stderr {
                    Some(s) => format!("amuxd install-pi failed: {s}"),
                    None => format!("amuxd install-pi exited with code {:?}", payload.code),
                });
            }
            _ => {}
        }
    }
    if let Some(e) = last_err {
        emit_progress(
            app,
            SetupProgress {
                id: "pi".into(),
                status: "failed".into(),
                line: None,
                error: Some(e.clone()),
            },
        );
        return Err(e);
    }
    emit_progress(
        app,
        SetupProgress {
            id: "pi".into(),
            status: "done".into(),
            line: None,
            error: None,
        },
    );
    Ok(())
}

/// Best-effort git install guidance. macOS triggers the Xcode CLT installer; other
/// platforms return an error so the UI shows manual instructions (git is optional).
///
/// On macOS this returns Ok as soon as the Xcode CLT dialog is spawned — git is
/// not actually present yet, and `xcode-select --install` exits non-zero when the
/// tools are already installed (we intentionally don't treat that as an error).
/// The caller should re-poll `setup_list_requirements` to confirm git presence.
fn install_git<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    emit_progress(
        app,
        SetupProgress {
            id: "git".into(),
            status: "started".into(),
            line: None,
            error: None,
        },
    );
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("xcode-select")
            .arg("--install")
            .status()
            .map_err(|e| format!("xcode-select: {e}"))?;
        emit_progress(
            app,
            SetupProgress {
                id: "git".into(),
                status: "running".into(),
                line: Some(
                    "Follow the macOS installer dialog to install Command Line Tools.".into(),
                ),
                error: None,
            },
        );
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Please install git from https://git-scm.com/downloads and re-check.".into())
    }
}

/// Restart the desktop-managed amuxd so it re-reads `daemon.toml`.
#[tauri::command]
pub async fn restart_local_daemon<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::commands::amuxd_supervisor::AmuxdSupervisor::restart(&app).await
}

#[tauri::command]
pub async fn setup_install<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    opencode_download_base: Option<String>,
) -> Result<(), String> {
    match id.as_str() {
        "amuxd" => install_amuxd(&app).await,
        "opencode" => install_opencode(&app, opencode_download_base).await,
        "pi" => install_pi(&app).await,
        "git" => install_git(&app),
        other => Err(format!("unknown requirement: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_triple_has_dash() {
        assert!(target_triple().contains('-'));
    }

    #[test]
    fn resolve_exe_finds_plain_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("amuxd-some-triple");
        assert!(resolve_exe(p.clone()).is_none());
        std::fs::write(&p, b"x").unwrap();
        assert_eq!(resolve_exe(p.clone()), Some(p));
    }
}

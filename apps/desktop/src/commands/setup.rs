use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Tauri event name carrying `SetupProgress` to the first-run wizard UI.
const SETUP_PROGRESS_EVENT: &str = "setup-progress";
/// Per-user amuxd state directory (under the home dir).
const AMUXD_DIR: &str = ".amuxd";

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

/// Locate the teamclaw-introspect MCP sidecar bundled with the app.
fn locate_bundled_introspect() -> Option<PathBuf> {
    locate_bundled_sidecar("teamclaw-introspect")
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

fn copy_sidecar_into_amuxd_bin(src: &Path, dest_name: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let bin_dir = home.join(AMUXD_DIR).join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
    let dest = bin_dir.join(dest_name);
    if let Err(copy_err) = std::fs::copy(src, &dest) {
        #[cfg(windows)]
        {
            let old = dest.with_extension("exe.old");
            let _ = std::fs::remove_file(&old);
            std::fs::rename(&dest, &old).map_err(|e| {
                format!("copy {dest_name} failed: {copy_err}; rename aside failed: {e}")
            })?;
            std::fs::copy(src, &dest)
                .map_err(|e| format!("copy {dest_name} failed after rename: {e}"))?;
        }
        #[cfg(not(windows))]
        {
            return Err(format!("copy {dest_name} failed: {copy_err}"));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms).map_err(|e| e.to_string())?;
    }
    Ok(())
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
    let amuxd = doctor.as_ref().map(|d| &d["amuxd"]);
    let amuxd_satisfied = amuxd
        .and_then(|a| a["satisfied"].as_bool())
        .unwrap_or(false);
    let amuxd_version = amuxd
        .and_then(|a| a["installedVersion"].as_str())
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
            present: amuxd_satisfied,
            version: amuxd_version,
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

/// True if the amuxd background service is already registered (so an amuxd copy is
/// an in-place UPGRADE that must restart the running service, vs a fresh install).
fn amuxd_service_registered() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    #[cfg(target_os = "macos")]
    {
        home.join("Library/LaunchAgents/cc.ucar.amuxd.plist")
            .exists()
    }
    #[cfg(target_os = "linux")]
    {
        home.join(".config/systemd/user/amuxd.service").exists()
    }
    #[cfg(target_os = "windows")]
    {
        let _ = home;
        // Mirrors amuxd's own service registration (schtasks task "amuxd").
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("schtasks")
            .args(["/Query", "/TN", "amuxd"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = home;
        false
    }
}

/// Path to the installed amuxd binary under ~/.amuxd/bin.
fn installed_amuxd_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let name = if cfg!(windows) { "amuxd.exe" } else { "amuxd" };
    Some(home.join(AMUXD_DIR).join("bin").join(name))
}

/// True when ~/.amuxd/amuxd.pid records a still-alive process. Mirrors amuxd's
/// own pidfile convention (written by `amuxd start`). A stale pidfile whose
/// process is gone reads as not-running.
fn amuxd_pid_is_running() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let pid_path = home.join(AMUXD_DIR).join("amuxd.pid");
    let Ok(body) = std::fs::read_to_string(&pid_path) else {
        return false;
    };
    let Ok(pid) = body.trim().parse::<i32>() else {
        return false;
    };
    pid_alive(pid)
}

/// Poll the amuxd pidfile until the recorded process has exited (or `timeout`
/// elapses). `amuxd stop` only sends SIGTERM and returns; the old process may
/// hold the lock (~/.amuxd/amuxd.lock) for a moment longer while it shuts down.
/// Starting the new amuxd before that lock is released is the root of the
/// "amuxd is already running (lock held)" failure after an app update, so we
/// wait for the old instance to actually go before relaunching.
async fn wait_for_amuxd_stopped(timeout: std::time::Duration) {
    let start = std::time::Instant::now();
    while amuxd_pid_is_running() {
        if start.elapsed() >= timeout {
            eprintln!("[setup] warning: amuxd still running after stop timeout; proceeding anyway");
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // kill(pid, 0): 0 if the process exists and we may signal it.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(windows)]
fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE as u32
    }
}

#[cfg(not(any(unix, windows)))]
fn pid_alive(_pid: i32) -> bool {
    false
}

/// Launch the freshly-installed amuxd binary detached from the desktop process
/// (new session on unix, DETACHED_PROCESS on Windows) so it outlives the app and
/// serves the upgraded code. Used when no supervising service is registered.
fn start_installed_amuxd_detached() -> Result<(), String> {
    let exe = installed_amuxd_path().ok_or_else(|| "no home dir".to_string())?;
    if !exe.exists() {
        return Err(format!("amuxd binary not found at {}", exe.display()));
    }
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("start");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // setsid so the child detaches from the desktop's session/controlling
        // terminal and survives the app exiting.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.spawn().map_err(|e| format!("spawn amuxd start: {e}"))?;
    Ok(())
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

/// Copy the bundled amuxd binary into ~/.amuxd/bin/amuxd. On a fresh install this
/// only places the binary (service registration happens after team onboarding). On
/// an UPGRADE (service already registered) it re-registers + restarts the service so
/// the new binary takes effect.
async fn install_amuxd<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    emit_progress(
        app,
        SetupProgress {
            id: "amuxd".into(),
            status: "started".into(),
            line: None,
            error: None,
        },
    );
    let src = locate_bundled_amuxd().ok_or_else(|| "bundled amuxd binary not found".to_string())?;
    let amuxd_dest_name = if cfg!(windows) { "amuxd.exe" } else { "amuxd" };
    copy_sidecar_into_amuxd_bin(&src, amuxd_dest_name)?;
    if let Some(introspect_src) = locate_bundled_introspect() {
        let introspect_dest_name = if cfg!(windows) {
            "teamclaw-introspect.exe"
        } else {
            "teamclaw-introspect"
        };
        if let Err(e) = copy_sidecar_into_amuxd_bin(&introspect_src, introspect_dest_name) {
            eprintln!("[setup] warning: failed to install teamclaw-introspect sidecar: {e}");
        }
    } else {
        eprintln!("[setup] warning: bundled teamclaw-introspect binary not found");
    }
    let service_registered = amuxd_service_registered();
    let was_running = amuxd_pid_is_running();
    // Always stop any amuxd currently running BEFORE launching the new binary,
    // whether it's service-managed or a stray detached instance left over from a
    // previous version. Replacing the on-disk binary alone leaves the old process
    // serving stale code AND holding ~/.amuxd/amuxd.lock; the freshly-started
    // amuxd then exits with "amuxd is already running (lock held)" and the app
    // reports "后台服务启动失败". Stopping unconditionally (and waiting for the
    // lock to release) closes that failure across app updates.
    if service_registered || was_running {
        emit_progress(
            app,
            SetupProgress {
                id: "amuxd".into(),
                status: "running".into(),
                line: Some("stopping old amuxd".into()),
                error: None,
            },
        );
        // `amuxd stop` SIGTERMs the running instance via its pidfile.
        if let Err(e) = run_amuxd_sidecar(app, &["stop"]).await {
            eprintln!("[setup] warning: failed to stop running amuxd before restart: {e}");
        }
        // Wait for the old process to release the lock so the new one can bind it.
        wait_for_amuxd_stopped(std::time::Duration::from_secs(5)).await;
    }
    if service_registered {
        emit_progress(
            app,
            SetupProgress {
                id: "amuxd".into(),
                status: "running".into(),
                line: Some("restarting amuxd service".into()),
                error: None,
            },
        );
        // install-service does bootout+bootstrap (i.e. restart) when already registered.
        run_amuxd_sidecar(app, &["install-service"]).await?;
    } else if was_running {
        // No supervising service, but an old amuxd was running (started detached).
        // Relaunch the freshly-copied binary detached so it outlives the app. A
        // fresh install (nothing running, no service) intentionally falls through
        // here without starting amuxd — service registration happens after team
        // onboarding, matching the prior behaviour.
        emit_progress(
            app,
            SetupProgress {
                id: "amuxd".into(),
                status: "running".into(),
                line: Some("restarting amuxd".into()),
                error: None,
            },
        );
        if let Err(e) = start_installed_amuxd_detached() {
            eprintln!("[setup] warning: failed to restart amuxd after upgrade: {e}");
        }
    }
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

/// Restart the locally-installed amuxd so it re-reads `daemon.toml`. Used after
/// changing a restart-required config key (e.g. `agents.local_agent`, switching
/// the local runtime between opencode and pi). Restarts the ALREADY-INSTALLED
/// binary at `~/.amuxd/bin/amuxd` (never the bundled dev sidecar), so a running
/// custom build is preserved across the switch.
///
/// When a supervising service is registered, `install-service` does a
/// bootout+bootstrap (clean restart under launchd/systemd). Otherwise the
/// running instance is stopped and relaunched detached. The daemon mints a new
/// HTTP token on restart; callers re-exchange it on the next request (401 retry).
#[tauri::command]
pub async fn restart_local_daemon() -> Result<(), String> {
    let exe = installed_amuxd_path().ok_or_else(|| "no home dir".to_string())?;
    if !exe.exists() {
        return Err(format!("amuxd binary not found at {}", exe.display()));
    }
    if amuxd_service_registered() {
        // install-service = bootout + bootstrap when already registered.
        let out = std::process::Command::new(&exe)
            .arg("install-service")
            .output()
            .map_err(|e| format!("spawn amuxd install-service: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "amuxd install-service exited with {:?}: {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        return Ok(());
    }
    // No supervisor: stop the running instance (best-effort) and relaunch detached.
    let _ = std::process::Command::new(&exe).arg("stop").output();
    start_installed_amuxd_detached()
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

use crate::config::DaemonConfig;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Write `std::process::id()` to `DaemonConfig::pid_path()`. Called from
/// `start` so `status` and `stop` can find the running daemon.
pub fn write_pidfile() -> anyhow::Result<()> {
    let path = DaemonConfig::pid_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, std::process::id().to_string())?;
    Ok(())
}

/// Best-effort cleanup; called on SIGTERM/SIGINT. Swallows errors.
pub fn remove_pidfile() {
    let _ = fs::remove_file(DaemonConfig::pid_path());
}

/// Read the recorded pid, or `Ok(None)` if no pidfile exists.
fn read_pidfile() -> anyhow::Result<Option<(i32, PathBuf)>> {
    let path = DaemonConfig::pid_path();
    if !path.exists() {
        return Ok(None);
    }
    let body = fs::read_to_string(&path)?;
    let pid: i32 = body
        .trim()
        .parse()
        .map_err(|e| anyhow::anyhow!("bad pid in {}: {e}", path.display()))?;
    Ok(Some((pid, path)))
}

/// libc::kill(pid, 0) — returns 0 if the process exists and we can signal it.
fn is_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

pub fn run_status() -> anyhow::Result<()> {
    match read_pidfile()? {
        None => {
            println!(
                "amuxd: not running (no pidfile at {}).",
                DaemonConfig::pid_path().display()
            );
        }
        Some((pid, path)) => {
            if is_alive(pid) {
                println!("amuxd: running (pid {})", pid);
            } else {
                println!("amuxd: stale pidfile — recorded pid {pid} is not alive.");
                println!("       Removing {}.", path.display());
                let _ = fs::remove_file(&path);
            }
        }
    }
    Ok(())
}

pub fn run_stop() -> anyhow::Result<()> {
    let (pid, path) = match read_pidfile()? {
        Some(x) => x,
        None => {
            println!("amuxd: not running (no pidfile).");
            return Ok(());
        }
    };

    if !is_alive(pid) {
        println!("amuxd: recorded pid {pid} is not alive; clearing stale pidfile.");
        let _ = fs::remove_file(&path);
        return Ok(());
    }

    println!("amuxd: sending SIGTERM to pid {pid}…");
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        let err = std::io::Error::last_os_error();
        anyhow::bail!("kill({pid}, SIGTERM) failed: {err}");
    }

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if !is_alive(pid) {
            let _ = fs::remove_file(&path);
            println!("amuxd: stopped.");
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    println!("amuxd: still running after 5s; sending SIGKILL.");
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
    let _ = fs::remove_file(&path);
    Ok(())
}

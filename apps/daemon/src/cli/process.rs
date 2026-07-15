use crate::config::DaemonConfig;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub struct DaemonLockGuard {
    file: File,
}

impl Drop for DaemonLockGuard {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

/// Send a single-line control command to a running amuxd via its control
/// endpoint (Unix socket on unix, named pipe on Windows).
pub fn send_control(sock_path: &Path, cmd: &str) -> anyhow::Result<()> {
    let mut s = connect_control(sock_path)?;
    s.write_all(format!("{cmd}\n").as_bytes())?;
    Ok(())
}

/// Open a synchronous client connection to the daemon's control endpoint.
#[cfg(unix)]
pub(crate) fn connect_control(sock_path: &Path) -> std::io::Result<UnixStream> {
    UnixStream::connect(sock_path)
}

/// Named-pipe client: opening the pipe path as a file gives a byte-mode
/// duplex stream. ERROR_PIPE_BUSY (231) means every server instance is
/// taken — retry briefly, like WaitNamedPipe would.
#[cfg(windows)]
pub(crate) fn connect_control(sock_path: &Path) -> std::io::Result<File> {
    const ERROR_PIPE_BUSY: i32 = 231;
    for _ in 0..50 {
        match OpenOptions::new().read(true).write(true).open(sock_path) {
            Ok(f) => return Ok(f),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        "amuxd control pipe busy",
    ))
}

/// How long `start` waits for a previous instance to release the singleton
/// lock before giving up. A graceful restart — very common under the launchd
/// `KeepAlive` job, whose async `bootout` overlaps the new `RunAtLoad` start —
/// briefly has the dying instance still holding the flock. Failing fast there
/// makes the new process exit "already running", which `KeepAlive` then
/// respawns into a flapping loop with no HTTP listener up, so the desktop
/// onboarding probe fails and shows "amuxd 启动失败". Waiting it out instead
/// lets the new instance take over once the old one finishes shutting down.
const LOCK_WAIT: Duration = Duration::from_secs(10);
const LOCK_POLL: Duration = Duration::from_millis(100);

pub fn acquire_daemon_lock() -> anyhow::Result<DaemonLockGuard> {
    acquire_daemon_lock_at(&DaemonConfig::lock_path(), LOCK_WAIT)
}

fn acquire_daemon_lock_at(path: &Path, wait: Duration) -> anyhow::Result<DaemonLockGuard> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false) // lock file is just an flock target; never clobber it
        .open(path)?;

    let deadline = Instant::now() + wait;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(DaemonLockGuard { file }),
            Err(std::fs::TryLockError::WouldBlock) => {}
            Err(std::fs::TryLockError::Error(err)) => return Err(err.into()),
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "amuxd is already running (lock held at {}). Use `amuxd status` or `amuxd stop`.",
                path.display()
            );
        }
        std::thread::sleep(LOCK_POLL);
    }
}

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
pub(crate) fn read_pidfile_for_service() -> anyhow::Result<Option<(i32, PathBuf)>> {
    read_pidfile()
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
#[cfg(unix)]
fn is_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

/// OpenProcess + GetExitCodeProcess == STILL_ACTIVE. PROCESS_QUERY_LIMITED_INFORMATION
/// succeeds across elevation boundaries that full query rights would not.
#[cfg(windows)]
pub(crate) fn pid_is_alive(pid: i32) -> bool {
    is_alive(pid)
}

#[cfg(unix)]
pub(crate) fn pid_is_alive(pid: i32) -> bool {
    is_alive(pid)
}

/// OpenProcess + GetExitCodeProcess == STILL_ACTIVE. PROCESS_QUERY_LIMITED_INFORMATION
/// succeeds across elevation boundaries that full query rights would not.
#[cfg(windows)]
fn is_alive(pid: i32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid <= 0 {
        return false;
    }
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

    request_graceful_stop(pid)?;

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if !is_alive(pid) {
            let _ = fs::remove_file(&path);
            println!("amuxd: stopped.");
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    println!("amuxd: still running after 5s; killing.");
    force_kill(pid);
    let _ = fs::remove_file(&path);
    Ok(())
}

#[cfg(unix)]
fn request_graceful_stop(pid: i32) -> anyhow::Result<()> {
    println!("amuxd: sending SIGTERM to pid {pid}…");
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        let err = std::io::Error::last_os_error();
        anyhow::bail!("kill({pid}, SIGTERM) failed: {err}");
    }
    Ok(())
}

/// Windows has no SIGTERM. Ask the daemon to exit via its own control
/// command (handled as SockCommand::Shutdown in the main loop); if the pipe
/// is gone the force-kill fallback below still applies after the wait loop.
#[cfg(windows)]
fn request_graceful_stop(pid: i32) -> anyhow::Result<()> {
    println!("amuxd: sending shutdown command to pid {pid}…");
    if let Err(e) = send_control(&DaemonConfig::sock_path(), "shutdown") {
        println!("amuxd: control pipe unavailable ({e}); will force-kill.");
    }
    Ok(())
}

#[cfg(unix)]
fn force_kill(pid: i32) {
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn force_kill(pid: i32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_lock_is_exclusive_until_guard_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("amuxd.lock");

        // wait=0 ⇒ fail fast when contended (the historical behavior).
        let first =
            acquire_daemon_lock_at(&lock_path, Duration::ZERO).expect("first lock should succeed");
        let second = acquire_daemon_lock_at(&lock_path, Duration::ZERO);
        assert!(second.is_err(), "second lock should be rejected");

        drop(first);

        acquire_daemon_lock_at(&lock_path, Duration::ZERO)
            .expect("lock should be available after guard drop");
    }

    #[test]
    fn daemon_lock_waits_for_a_releasing_holder() {
        // Regression: a graceful restart races the dying instance's lock. The
        // new acquirer must poll and take over once the holder releases, not
        // bail "already running" the way the old non-blocking flock did.
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("amuxd.lock");

        let held = acquire_daemon_lock_at(&lock_path, Duration::ZERO).expect("hold lock");

        let release_path = lock_path.clone();
        let waiter = std::thread::spawn(move || {
            // Generous window; the holder releases well within it.
            acquire_daemon_lock_at(&release_path, Duration::from_secs(5))
        });

        // Let the waiter start polling, then release the lock.
        std::thread::sleep(Duration::from_millis(300));
        drop(held);

        waiter
            .join()
            .expect("waiter thread panicked")
            .expect("waiter should acquire the lock once it is released");
    }

    #[test]
    fn daemon_lock_times_out_when_holder_never_releases() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("amuxd.lock");

        let _held = acquire_daemon_lock_at(&lock_path, Duration::ZERO).expect("hold lock");
        let start = Instant::now();
        let contended = acquire_daemon_lock_at(&lock_path, Duration::from_millis(300));
        assert!(contended.is_err(), "should give up once the wait elapses");
        assert!(
            start.elapsed() >= Duration::from_millis(300),
            "should have waited out the full window before failing"
        );
    }
}

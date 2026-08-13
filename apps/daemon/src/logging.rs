//! Size-capped rotating log for the daemon's own tracing output.
//!
//! One diary regardless of how the daemon was launched. v1 had three unbounded
//! ones — `amuxd.managed.log` (desktop spawn redirect), `amuxd.out.log` /
//! `amuxd.err.log` (launchd/systemd redirects) — which accumulated 116 MB on
//! the audited machine because nothing ever truncated any of them. Those
//! redirect targets still exist, but once tracing writes here they only catch
//! what tracing cannot: pre-init prints, panics, child-process output.
//!
//! Rotation is by size, not time: a daemon can idle for weeks or log a burst
//! in a minute, so age says nothing about volume. `amuxd.log` is renamed to
//! `amuxd.log.1` (shifting `.1` → `.2`, dropping the oldest) when a write
//! would cross the cap. Defaults are 32 MB × 3 files; override in
//! `daemon.toml`'s `[log]` section.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Cap on the active file. A write that would cross it triggers rotation.
pub const DEFAULT_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// Rotated files kept beside the active one (`amuxd.log.1`, `amuxd.log.2`).
pub const DEFAULT_ROTATED_KEEP: u32 = 2;

/// The `[log]` section of `daemon.toml`, read with a probe (like
/// `layout::active_team`) because tracing must initialise before the full
/// config loads — and before the v1 purge may replace the file entirely.
#[derive(Debug, Default, serde::Deserialize)]
struct LogProbe {
    #[serde(default)]
    log: LogSection,
}

#[derive(Debug, Default, serde::Deserialize)]
struct LogSection {
    max_bytes: Option<u64>,
    keep: Option<u32>,
}

/// `(max_bytes, rotated_keep)` from `daemon.toml`'s `[log]`, or the defaults.
/// Any read/parse problem is the defaults — logging must never block boot.
pub fn settings_from(daemon_toml: &Path) -> (u64, u32) {
    let section = std::fs::read_to_string(daemon_toml)
        .ok()
        .and_then(|body| toml::from_str::<LogProbe>(&body).ok())
        .unwrap_or_default()
        .log;
    (
        section.max_bytes.unwrap_or(DEFAULT_MAX_BYTES).max(4096),
        section.keep.unwrap_or(DEFAULT_ROTATED_KEEP).clamp(1, 16),
    )
}

/// Cloneable handle for `tracing_subscriber`'s `with_writer`.
#[derive(Clone)]
pub struct RotatingLog {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    max_bytes: u64,
    rotated_keep: u32,
    state: Mutex<Option<State>>,
}

struct State {
    file: File,
    len: u64,
}

impl RotatingLog {
    pub fn new(path: PathBuf, max_bytes: u64, rotated_keep: u32) -> Self {
        Self {
            inner: Arc::new(Inner {
                path,
                max_bytes: max_bytes.max(4096),
                rotated_keep: rotated_keep.max(1),
                state: Mutex::new(None),
            }),
        }
    }

    /// Best-effort by design: a full disk or a deleted directory must degrade
    /// to lost log lines, never to a wedged daemon. Errors drop the handle so
    /// the next write retries a fresh open.
    fn write_all_bytes(&self, buf: &[u8]) {
        let inner = &*self.inner;
        let mut guard = inner.state.lock().unwrap_or_else(|e| e.into_inner());

        if guard.is_none() {
            *guard = inner.open().ok();
        }
        let Some(state) = guard.as_mut() else {
            return;
        };

        if state.len.saturating_add(buf.len() as u64) > inner.max_bytes {
            // Close before renaming — Windows cannot rename an open file.
            guard.take();
            inner.rotate();
            match inner.open() {
                Ok(fresh) => *guard = Some(fresh),
                Err(_) => return,
            }
        }

        let Some(state) = guard.as_mut() else {
            return;
        };
        match state.file.write_all(buf) {
            Ok(()) => state.len += buf.len() as u64,
            Err(_) => {
                guard.take();
            }
        }
    }

    fn flush_file(&self) {
        let mut guard = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(state) = guard.as_mut() {
            let _ = state.file.flush();
        }
    }
}

impl Inner {
    fn open(&self) -> io::Result<State> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(State { file, len })
    }

    fn rotated(&self, n: u32) -> PathBuf {
        let mut os = self.path.clone().into_os_string();
        os.push(format!(".{n}"));
        PathBuf::from(os)
    }

    fn rotate(&self) {
        for n in (1..self.rotated_keep).rev() {
            let _ = std::fs::rename(self.rotated(n), self.rotated(n + 1));
        }
        let _ = std::fs::rename(&self.path, self.rotated(1));
    }
}

/// One writer per event; delegates to the shared state.
pub struct RotatingLogWriter(RotatingLog);

impl io::Write for RotatingLogWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write_all_bytes(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush_file();
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for RotatingLog {
    type Writer = RotatingLogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        RotatingLogWriter(self.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_line(log: &RotatingLog, line: &str) {
        log.write_all_bytes(line.as_bytes());
        log.flush_file();
    }

    #[test]
    fn appends_below_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("amuxd.log");
        let log = RotatingLog::new(path.clone(), 4096, 2);

        write_line(&log, "one\n");
        write_line(&log, "two\n");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\ntwo\n");
        assert!(!path.with_extension("log.1").exists());
    }

    #[test]
    fn rotation_shifts_and_drops_the_oldest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("amuxd.log");
        // Cap floors at 4096, so build lines that cross it.
        let log = RotatingLog::new(path.clone(), 4096, 2);
        let a = format!("a{}\n", "x".repeat(4000));
        let b = format!("b{}\n", "x".repeat(4000));
        let c = format!("c{}\n", "x".repeat(4000));
        let d = "tail\n";

        write_line(&log, &a);
        write_line(&log, &b); // rotates: a → .1
        write_line(&log, &c); // rotates: a → .2, b → .1
        write_line(&log, d); // fits after c

        let active = std::fs::read_to_string(&path).unwrap();
        assert!(active.starts_with('c') && active.ends_with("tail\n"));
        assert!(std::fs::read_to_string(dir.path().join("amuxd.log.1"))
            .unwrap()
            .starts_with('b'));
        assert!(std::fs::read_to_string(dir.path().join("amuxd.log.2"))
            .unwrap()
            .starts_with('a'));

        write_line(&log, &a); // rotates again: b's file drops off the end
        assert!(std::fs::read_to_string(dir.path().join("amuxd.log.2"))
            .unwrap()
            .starts_with('b'));
        assert!(!dir.path().join("amuxd.log.3").exists());
    }

    #[test]
    fn reopens_an_existing_file_at_its_current_length() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("amuxd.log");
        std::fs::write(&path, "x".repeat(4090)).unwrap();

        // 10 more bytes would cross the 4096 cap: the pre-existing length must
        // count, or a restart would let every file grow one cap further.
        let log = RotatingLog::new(path.clone(), 4096, 1);
        write_line(&log, "0123456789");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "0123456789");
        assert!(dir.path().join("amuxd.log.1").exists());
    }

    #[test]
    fn settings_probe_reads_the_log_section_and_survives_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.toml");

        assert_eq!(
            settings_from(&path),
            (DEFAULT_MAX_BYTES, DEFAULT_ROTATED_KEEP),
            "missing file → defaults"
        );

        std::fs::write(&path, "[log]\nmax_bytes = 1048576\nkeep = 5\n").unwrap();
        assert_eq!(settings_from(&path), (1048576, 5));

        std::fs::write(&path, "not toml [[[").unwrap();
        assert_eq!(
            settings_from(&path),
            (DEFAULT_MAX_BYTES, DEFAULT_ROTATED_KEEP)
        );
    }
}

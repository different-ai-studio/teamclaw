//! Atomic file writes for shared config files (notably `opencode.json`).
//!
//! `opencode.json` has many independent writers spread across the daemon, the
//! runtime-env crate, and the desktop process. A plain `std::fs::write` opens
//! with `O_TRUNC`, but the byte stream is written at the fd's own offset — so
//! two concurrent writers of different lengths can leave the shorter object
//! followed by the longer writer's stale tail ("trailing characters at line N").
//!
//! Writing to a unique sibling temp file and `rename`-ing it into place makes
//! every write an all-or-nothing swap: a reader always sees exactly one
//! complete file, and a partial/short writer can never leave stale bytes behind
//! a later writer. The temp name embeds pid + a per-process counter so
//! concurrent writers never clobber each other's temp file either.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Atomically write `content` to `path` via a unique temp file + rename.
///
/// The temp file is created next to `path` (same directory, so `rename` stays
/// on one filesystem). On success `path` is replaced atomically; on any error
/// the temp file is best-effort removed and the original `path` is untouched.
pub fn atomic_write(path: &Path, content: &str) -> std::io::Result<()> {
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".to_string());
    let tmp_name = format!("{file_name}.{}.{seq}.tmp", std::process::id());
    let tmp = match path.parent() {
        Some(dir) => dir.join(tmp_name),
        None => Path::new(&tmp_name).to_path_buf(),
    };

    if let Err(e) = std::fs::write(&tmp, content) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

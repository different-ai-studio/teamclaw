//! Per-PTY state. Holds the master handle, child, ring buffer, and reader thread.

use std::path::PathBuf;

pub struct PtyHandle {
    pub id: String,
    pub workspace_id: String,
    pub cwd: PathBuf,
    pub shell: String,
    pub pid: u32,
}

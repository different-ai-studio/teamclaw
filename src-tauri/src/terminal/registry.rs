use std::collections::HashMap;
use std::sync::{Arc, RwLock};

pub type TerminalId = String;

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Running,
    Exited,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TerminalSummary {
    pub id: TerminalId,
    pub shell: String,
    pub pid: u32,
    pub status: TerminalStatus,
    pub exit_code: Option<i32>,
}

#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TerminalError {
    #[error("shell not found")]
    ShellNotFound,
    #[error("cwd not allowed: {0}")]
    CwdNotAllowed(String),
    #[error("cwd not found: {0}")]
    CwdNotFound(String),
    #[error("pty closed")]
    PtyClosed,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("spawn failed: {0}")]
    SpawnFailed(String),
}

pub struct Registry {
    handles: RwLock<HashMap<TerminalId, Arc<crate::terminal::pty::PtyHandle>>>,
}

impl Registry {
    pub fn new() -> Self {
        Self { handles: RwLock::new(HashMap::new()) }
    }
}

impl Default for Registry {
    fn default() -> Self { Self::new() }
}

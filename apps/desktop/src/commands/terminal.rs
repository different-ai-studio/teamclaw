use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, State};

use crate::terminal::pty::{EmitContext, PtyHandle, SpawnArgs};
use crate::terminal::registry::{Registry, TerminalError, TerminalStatus, TerminalSummary};

#[derive(serde::Serialize)]
pub struct OpenResult {
    pub id: String,
    pub shell: String,
    pub pid: u32,
}

#[derive(serde::Serialize)]
pub struct SubscribeResult {
    pub ring_snapshot: Vec<u8>,
    pub cols: u16,
    pub rows: u16,
    pub status: TerminalStatus,
    pub exit_code: Option<i32>,
}

#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    registry: State<'_, Arc<Registry>>,
    workspace_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    allowed_roots: Vec<String>,
) -> Result<OpenResult, TerminalError> {
    let cwd_path = canonicalize_cwd(&cwd, &allowed_roots)?;
    let shell = resolve_shell(shell);
    let id = uuid::Uuid::now_v7().to_string();

    let app_for_data = app.clone();
    let app_for_exit = app.clone();
    let emit = EmitContext {
        emit_data: Arc::new(move |name, payload| {
            let _ = app_for_data.emit(name, payload);
        }),
        emit_exit: Arc::new(move |name, code| {
            let _ = app_for_exit.emit(name, code);
        }),
    };

    let handle = PtyHandle::spawn(
        SpawnArgs {
            id: id.clone(),
            workspace_id,
            cwd: cwd_path,
            shell: shell.clone(),
            cols,
            rows,
        },
        emit,
    )?;
    let pid = handle.pid;
    registry.insert(id.clone(), handle);

    Ok(OpenResult { id, shell, pid })
}

#[tauri::command]
pub async fn terminal_subscribe(
    registry: State<'_, Arc<Registry>>,
    id: String,
) -> Result<SubscribeResult, TerminalError> {
    let h = registry.get(&id).ok_or(TerminalError::NotFound(id))?;
    Ok(SubscribeResult {
        ring_snapshot: h.snapshot(),
        cols: 80,
        rows: 24,
        status: h.status(),
        exit_code: h.exit_code(),
    })
}

/// Writes raw bytes to a PTY.
///
/// Uses Tauri raw-body IPC instead of a JSON `Vec<u8>` to keep per-keystroke
/// latency low — JSON-encoding each byte as a decimal number doubles to triples
/// the payload size and adds parse work on both sides for every keypress. The
/// terminal id rides in the `x-terminal-id` header so the body can stay raw.
#[tauri::command]
pub async fn terminal_write(
    registry: State<'_, Arc<Registry>>,
    request: Request<'_>,
) -> Result<(), TerminalError> {
    let id = request
        .headers()
        .get("x-terminal-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| TerminalError::BadRequest("missing x-terminal-id header".into()))?
        .to_string();
    let bytes: &[u8] = match request.body() {
        InvokeBody::Raw(b) => b.as_slice(),
        InvokeBody::Json(_) => {
            return Err(TerminalError::BadRequest(
                "terminal_write expects raw body, got JSON".into(),
            ))
        }
    };
    let h = registry.get(&id).ok_or(TerminalError::NotFound(id))?;
    h.write(bytes)
}

#[tauri::command]
pub async fn terminal_resize(
    registry: State<'_, Arc<Registry>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), TerminalError> {
    let h = registry.get(&id).ok_or(TerminalError::NotFound(id))?;
    h.resize(cols, rows)
}

#[tauri::command]
pub async fn terminal_close(
    registry: State<'_, Arc<Registry>>,
    id: String,
) -> Result<(), TerminalError> {
    if let Some(h) = registry.remove(&id) {
        h.kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_list(
    registry: State<'_, Arc<Registry>>,
    workspace_id: Option<String>,
) -> Result<Vec<TerminalSummary>, TerminalError> {
    Ok(registry.list_summaries(workspace_id.as_deref()))
}

fn resolve_shell(explicit: Option<String>) -> String {
    if let Some(s) = explicit.filter(|s| !s.is_empty()) {
        return s;
    }
    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() && Path::new(&s).exists() {
            return s;
        }
    }
    #[cfg(target_os = "macos")]
    {
        "/bin/zsh".into()
    }
    #[cfg(target_os = "linux")]
    {
        "/bin/bash".into()
    }
    #[cfg(target_os = "windows")]
    {
        "powershell.exe".into()
    }
}

fn canonicalize_cwd(cwd: &str, allowed_roots: &[String]) -> Result<PathBuf, TerminalError> {
    let raw = PathBuf::from(cwd);
    let canon = match raw.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // Fall back to home dir
            return dirs::home_dir().ok_or(TerminalError::CwdNotFound(cwd.to_string()));
        }
    };

    if allowed_roots.is_empty() {
        // Defensive: never allow arbitrary cwd if frontend didn't supply roots.
        return Err(TerminalError::CwdNotAllowed(cwd.to_string()));
    }

    let allowed: Vec<PathBuf> = allowed_roots
        .iter()
        .filter_map(|r| PathBuf::from(r).canonicalize().ok())
        .collect();

    let permitted = allowed.iter().any(|root| canon.starts_with(root))
        || dirs::home_dir().map(|h| canon == h).unwrap_or(false);

    if !permitted {
        return Err(TerminalError::CwdNotAllowed(cwd.to_string()));
    }

    Ok(canon)
}

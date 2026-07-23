//! Opt-in Tauri command for recording IPC activity into the Rust-side ring
//! buffer surfaced by `manage_ipc`. Tauri v2 freezes
//! `__TAURI_INTERNALS__.invoke` (non-writable/non-configurable), so the
//! plugin CANNOT passively wrap it to observe frontend calls. An app that
//! wants its own invoke traffic in the buffer can wrap its `invoke` and
//! call `invoke('plugin:mcp|push_ipc', {...})` from that wrapper. Otherwise
//! the buffer is filled only by IPC that `manage_ipc` itself mediates.
//! Best-effort observability channel: minimal validation, previews capped
//! by the buffer.

use crate::ipc_buffer;

#[tauri::command]
pub fn push_ipc(
    name: Option<String>,
    kind: Option<String>,
    status: Option<String>,
    duration_ms: Option<u64>,
    args_preview: Option<String>,
    result_preview: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    let name = match name {
        Some(n) if !n.is_empty() => n,
        _ => return Ok(()), // nameless entries are useless — drop silently
    };
    let kind = match kind.as_deref() {
        Some("event") => "event",
        _ => "invoke",
    };
    let status = match status.as_deref() {
        Some("error") => "error",
        Some("emitted") => "emitted",
        _ => "ok",
    };
    // Tag as webview-origin: any page script can call this command, so
    // manage_ipc labels these entries self-reported/untrusted.
    ipc_buffer::global().push_with_origin(
        "webview", kind, name, status, duration_ms, args_preview, result_preview, error,
    );
    Ok(())
}

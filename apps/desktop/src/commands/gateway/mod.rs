// Thin RPC client over `amuxd.sock`. The desktop app no longer runs the
// channel gateways itself — amuxd owns those instances and persists their
// config in `daemon.toml`. The three commands here just forward to amuxd.
//
// Cron and `introspect_api` still reach into the underlying
// `teamclaw_gateway::*` modules for direct send helpers (e.g.
// `gateway::email::send_notification_email`, `gateway::wecom::send_proactive_message`),
// so we keep `pub use teamclaw_gateway::*` to preserve their `crate::commands::gateway::*`
// import paths. Likewise we keep a slim `GatewayState` carrying just the
// shared `SessionMapping` (cron consumes it for session lookup); the legacy
// per-platform `*Gateway` slots that used to live here are gone.

pub use teamclaw_gateway::*;

pub mod qr;

use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Slim per-app state. The legacy `*Gateway` slots were removed (amuxd owns
/// those now); only the cross-component session map remains, used by the
/// cron scheduler for session-id <-> chat-target lookup.
pub struct GatewayState {
    pub shared_session_mapping: SessionMapping,
    pub session_initialized: Mutex<bool>,
}

impl Default for GatewayState {
    fn default() -> Self {
        Self {
            shared_session_mapping: SessionMapping::new(),
            session_initialized: Mutex::new(false),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelStatus {
    pub platform: String,
    pub enabled: bool,
    pub connected: bool,
    #[serde(default, rename = "last_error", alias = "lastError")]
    pub last_error: Option<String>,
}

fn amuxd_unavailable() -> String {
    "amuxd daemon is not available on Windows".to_string()
}

pub(crate) fn sock_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".amuxd")
        .join("amuxd.sock")
}

fn daemon_config_path() -> PathBuf {
    let path = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".amuxd")
        .join("daemon.toml");
    let legacy_path = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("amux")
        .join("daemon.toml");
    if !path.exists() && legacy_path.exists() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::copy(&legacy_path, &path);
    }
    path
}

/// List the six known channel platforms with their `enabled` / `connected`
/// state as reported by amuxd over `amuxd.sock`. Errors out clearly when the
/// daemon is not running so the UI can surface an "amuxd unreachable" state.
#[tauri::command]
pub async fn list_channels() -> Result<Vec<ChannelStatus>, String> {
    #[cfg(windows)]
    return Err(amuxd_unavailable());
    #[cfg(unix)]
    {
        let mut s =
            UnixStream::connect(sock_path()).map_err(|e| format!("amuxd not reachable: {e}"))?;
        s.write_all(b"channel-status\n")
            .map_err(|e| format!("write failed: {e}"))?;
        s.shutdown(std::net::Shutdown::Write)
            .map_err(|e| format!("shutdown write half failed: {e}"))?;
        let mut buf = String::new();
        s.read_to_string(&mut buf)
            .map_err(|e| format!("read failed: {e}"))?;
        serde_json::from_str(buf.trim())
            .map_err(|e| format!("bad response from amuxd: {e} (body={buf:?})"))
    }
}

/// Per-bot WeCom connection status as reported by amuxd over `amuxd.sock`.
/// The daemon emits camelCase keys (`botId`, `connected`, `error`), which we
/// re-expose unchanged to the frontend (matching the TS `WeComBotStatus`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeComBotStatus {
    pub bot_id: String,
    pub connected: bool,
    #[serde(default)]
    pub error: Option<String>,
}

/// List per-bot WeCom connection status. Mirrors `list_channels`' socket
/// plumbing: writes `wecom-bots-status` to `amuxd.sock`, reads the single
/// JSON-array line, and deserializes it into `Vec<WeComBotStatus>`.
#[tauri::command]
pub async fn list_wecom_bots_status() -> Result<Vec<WeComBotStatus>, String> {
    #[cfg(windows)]
    return Err(amuxd_unavailable());
    #[cfg(unix)]
    {
        let mut s =
            UnixStream::connect(sock_path()).map_err(|e| format!("amuxd not reachable: {e}"))?;
        s.write_all(b"wecom-bots-status\n")
            .map_err(|e| format!("write failed: {e}"))?;
        s.shutdown(std::net::Shutdown::Write)
            .map_err(|e| format!("shutdown write half failed: {e}"))?;
        let mut buf = String::new();
        s.read_to_string(&mut buf)
            .map_err(|e| format!("read failed: {e}"))?;
        serde_json::from_str(buf.trim())
            .map_err(|e| format!("bad response from amuxd: {e} (body={buf:?})"))
    }
}

/// Load a persisted channel config from daemon.toml. This is local-only data:
/// secrets already live on this machine, and the settings UI needs to
/// rehydrate forms after the panel is closed and reopened.
#[tauri::command]
pub fn load_channel_config(platform: String) -> Result<Option<serde_json::Value>, String> {
    if !matches!(
        platform.as_str(),
        "discord" | "wecom" | "feishu" | "kook" | "wechat" | "email"
    ) {
        return Err(format!("unknown platform: {platform}"));
    }

    let path = daemon_config_path();
    if !path.exists() {
        return Ok(None);
    }

    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let parsed: toml::Value =
        toml::from_str(&content).map_err(|e| format!("parse {}: {e}", path.display()))?;

    let Some(config) = parsed
        .get("channels")
        .and_then(|channels| channels.get(&platform))
    else {
        return Ok(None);
    };

    serde_json::to_value(config)
        .map(Some)
        .map_err(|e| format!("serialize channel config: {e}"))
}

/// Replace `daemon.toml`'s `[channels.<platform>]` section with the JSON in
/// `config_json` (one of the daemon's per-platform config structs). amuxd
/// auto-reloads the channel manager so the change takes effect immediately.
#[tauri::command]
pub async fn save_channel_config(platform: String, config_json: String) -> Result<(), String> {
    #[cfg(windows)]
    return Err(amuxd_unavailable());
    #[cfg(unix)]
    {
        let mut s =
            UnixStream::connect(sock_path()).map_err(|e| format!("amuxd not reachable: {e}"))?;
        // Single-line JSON keeps the framing simple — the daemon reads exactly
        // three newline-terminated tokens off the sock.
        let single_line = config_json.replace('\n', " ");
        let payload = format!("channel-save\n{platform}\n{single_line}\n");
        s.write_all(payload.as_bytes())
            .map_err(|e| format!("write failed: {e}"))?;
        Ok(())
    }
}

/// Tell amuxd to re-read `daemon.toml` and restart all channels. Cheap;
/// useful when the daemon-managed config file was edited out-of-band.
#[tauri::command]
pub async fn reload_channels() -> Result<(), String> {
    #[cfg(windows)]
    return Err(amuxd_unavailable());
    #[cfg(unix)]
    {
        let mut s =
            UnixStream::connect(sock_path()).map_err(|e| format!("amuxd not reachable: {e}"))?;
        s.write_all(b"channel-reload\n")
            .map_err(|e| format!("write failed: {e}"))?;
        Ok(())
    }
}

/// Persist a per-session model preference for gateway-backed chats.
/// The mapping is keyed by the logical session id used by the desktop UI.
#[tauri::command]
pub async fn sync_gateway_session_model(
    session_id: String,
    model: Option<String>,
    gateway_state: State<'_, GatewayState>,
) -> Result<bool, String> {
    if session_id.trim().is_empty() {
        return Ok(false);
    }

    match model {
        Some(model_key) if !model_key.trim().is_empty() => {
            gateway_state
                .shared_session_mapping
                .set_model(session_id, model_key)
                .await;
        }
        _ => {
            gateway_state
                .shared_session_mapping
                .remove_model(&session_id)
                .await;
        }
    }

    Ok(true)
}

// ─── Workspace teamclaw.json helpers (not channel-specific) ───────────────────
//
// These four commands manage non-channel fields of the workspace-level
// `teamclaw.json` (shortcuts list, system prompt, UI locale). They lived in
// this module historically because the file-reader helper was here; rather
// than scatter them across new modules we keep them here as siblings of the
// new sock-RPC commands. The H1 channel rewrite intentionally leaves them
// untouched.

use tauri::State;

/// Load personal shortcuts from the workspace config file (teamclaw.json).
#[tauri::command]
pub fn load_shortcuts(
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    workspace_path: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    let config = teamclaw_gateway::read_config(&workspace_path)?;
    let shortcuts = config
        .other
        .get("shortcuts")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    Ok(shortcuts.as_array().cloned().unwrap_or_default())
}

/// Save personal shortcuts to the workspace config file (teamclaw.json).
#[tauri::command]
pub fn save_shortcuts(
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    nodes: Vec<serde_json::Value>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    teamclaw_gateway::patch_config_value(&workspace_path, "shortcuts", serde_json::json!(nodes))
}

/// Load the per-workspace system prompt from teamclaw.json. Returns "" if unset.
#[tauri::command]
pub fn load_system_prompt(
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    let config = teamclaw_gateway::read_config(&workspace_path)?;
    Ok(config
        .other
        .get("systemPrompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

/// Save the per-workspace system prompt to teamclaw.json.
#[tauri::command]
pub fn save_system_prompt(
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    prompt: String,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    teamclaw_gateway::patch_config_value(
        &workspace_path,
        "systemPrompt",
        serde_json::json!(prompt),
    )?;
    teamclaw_gateway::sync_teamclaw_claude_md(&workspace_path, &prompt)
}

/// Set the locale in teamclaw.json for UI i18n.
#[tauri::command]
pub async fn set_config_locale(
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    locale: String,
) -> Result<(), String> {
    let workspace_path = crate::commands::window::current_workspace_for_window(&window, &registry)?;
    teamclaw_gateway::patch_config_value(&workspace_path, "locale", serde_json::json!(locale))
}

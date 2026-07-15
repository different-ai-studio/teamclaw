//! Thin Tauri command wrappers around amuxd.sock's QR-login frames.
//!
//! The desktop app does not call the WeChat/WeCom HTTP APIs directly anymore;
//! amuxd owns the gateway crate and exposes four control commands over
//! `amuxd.sock`:
//!
//!   wechat-qr-start            -> JSON `{ok, result?, error?}` with `QrData`
//!   wechat-qr-poll <qrcode>    -> JSON `{ok, result?, error?}` with `QrStatusResponse`
//!   wecom-qr-start             -> JSON `{ok, result?, error?}` with `WeComQrAuthStart`
//!   wecom-qr-poll <scode>      -> JSON `{ok, result?, error?}` with `WeComQrAuthPollResult`
//!
//! Each helper opens a fresh unix socket, writes the line-based request,
//! reads the single-line JSON reply, and unwraps the envelope.

#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixStream;

use serde::{Deserialize, Serialize};

use teamclaw_gateway::wechat_config::{WeChatQrLoginResponse, WeChatQrStatusResponse};
use teamclaw_gateway::wecom_config::{WeComQrAuthPollResult, WeComQrAuthStart};

use super::sock_path;

fn amuxd_unavailable() -> String {
    "amuxd daemon is not available on Windows".to_string()
}

/// One round-trip against amuxd.sock for the four QR control commands.
/// `request_lines` is the literal payload (terminate the last line with `\n`
/// yourself). Returns the raw `result` JSON value on `ok:true`, or the
/// `error` string on `ok:false`.
#[cfg(unix)]
async fn sock_roundtrip(request: &str) -> Result<serde_json::Value, String> {
    let path = sock_path();
    let mut stream = UnixStream::connect(&path)
        .await
        .map_err(|e| format!("amuxd not reachable at {}: {e}", path.display()))?;

    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("amuxd sock write: {e}"))?;
    stream
        .flush()
        .await
        .map_err(|e| format!("amuxd sock flush: {e}"))?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("amuxd sock read: {e}"))?;

    #[derive(Deserialize)]
    struct Wire {
        ok: bool,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        result: Option<serde_json::Value>,
    }

    let parsed: Wire = serde_json::from_str(line.trim())
        .map_err(|e| format!("amuxd bad response: {e} (body={line:?})"))?;

    if !parsed.ok {
        return Err(parsed
            .error
            .unwrap_or_else(|| "unknown amuxd error".to_string()));
    }
    parsed
        .result
        .ok_or_else(|| "amuxd bad response: ok=true but missing result".to_string())
}

/// Frontend-facing shape for WeChat QR start. Mirrors the React
/// `QrData` interface in `Wechat.tsx` exactly (camelCase, optional
/// `qrcodeImgContent`). The underlying ilink response already serializes
/// to this shape via `WeChatQrLoginResponse`'s camelCase rename.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrData {
    pub qrcode: String,
    pub qrcode_img_content: Option<String>,
}

impl From<WeChatQrLoginResponse> for QrData {
    fn from(v: WeChatQrLoginResponse) -> Self {
        Self {
            qrcode: v.qrcode,
            qrcode_img_content: v.qrcode_img_content,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrStatusResponse {
    pub status: String,
    pub bot_token: Option<String>,
    pub ilink_bot_id: Option<String>,
    pub baseurl: Option<String>,
}

impl From<WeChatQrStatusResponse> for QrStatusResponse {
    fn from(v: WeChatQrStatusResponse) -> Self {
        Self {
            status: v.status,
            bot_token: v.bot_token,
            ilink_bot_id: v.ilink_bot_id,
            baseurl: v.baseurl,
        }
    }
}

#[tauri::command]
pub async fn start_wechat_qr_login() -> Result<QrData, String> {
    #[cfg(windows)]
    return Err(amuxd_unavailable());
    #[cfg(unix)]
    {
        let raw = sock_roundtrip("wechat-qr-start\n").await?;
        let parsed: WeChatQrLoginResponse = serde_json::from_value(raw)
            .map_err(|e| format!("decode WeChatQrLoginResponse: {e}"))?;
        Ok(parsed.into())
    }
}

#[tauri::command]
pub async fn poll_wechat_qr_status(qrcode: String) -> Result<QrStatusResponse, String> {
    #[cfg(windows)]
    return Err(amuxd_unavailable());
    #[cfg(unix)]
    {
        // The qrcode token never contains a newline in practice — strip just in case
        // to keep the line framing intact on the daemon side.
        let qrcode = qrcode.replace(['\n', '\r'], "");
        let req = format!("wechat-qr-poll\n{qrcode}\n");
        let raw = sock_roundtrip(&req).await?;
        let parsed: WeChatQrStatusResponse = serde_json::from_value(raw)
            .map_err(|e| format!("decode WeChatQrStatusResponse: {e}"))?;
        Ok(parsed.into())
    }
}

#[tauri::command]
pub async fn start_wecom_qr_auth() -> Result<WeComQrAuthStart, String> {
    #[cfg(windows)]
    return Err(amuxd_unavailable());
    #[cfg(unix)]
    {
        let raw = sock_roundtrip("wecom-qr-start\n").await?;
        serde_json::from_value(raw).map_err(|e| format!("decode WeComQrAuthStart: {e}"))
    }
}

#[tauri::command]
pub async fn poll_wecom_qr_auth(scode: String) -> Result<WeComQrAuthPollResult, String> {
    #[cfg(windows)]
    return Err(amuxd_unavailable());
    #[cfg(unix)]
    {
        let scode = scode.replace(['\n', '\r'], "");
        let req = format!("wecom-qr-poll\n{scode}\n");
        let raw = sock_roundtrip(&req).await?;
        serde_json::from_value(raw).map_err(|e| format!("decode WeComQrAuthPollResult: {e}"))
    }
}

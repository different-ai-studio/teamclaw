//! Async UnixSocket client for amuxd's `prompt-await` command. Used by
//! the cron scheduler to drive one ACP turn per cron run.
//!
//! Spec: docs/superpowers/specs/2026-05-17-cron-to-amuxd-design.md §1, §2.

use serde::Serialize;
use std::path::Path;
#[cfg(unix)]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(unix)]
use tokio::net::UnixStream;

const AMUXD_UNSUPPORTED: &str = "amuxd is not available on Windows";

#[derive(Serialize)]
pub struct PromptAwaitRequest<'a> {
    pub cmd: &'static str,
    pub session_key: &'a str,
    pub message: &'a str,
    /// Human-readable name of the cron job. amuxd uses this to build the
    /// Cloud session title ("Cron: <job_name>") so the desktop UI's "view
    /// session" button on cron records resolves to a labeled chat thread.
    /// Optional — if absent amuxd falls back to "Cron job".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_override: Option<ModelOverride<'a>>,
    /// Backend the job pins, e.g. "opencode" | "claude" | "codex". When `None`
    /// the field is omitted and amuxd falls back to its `default_agent_type`
    /// (the "auto" selection). A pinned backend ensures a Claude-configured job
    /// runs on Claude even when OpenCode is the daemon default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<&'a str>,
    pub timeout_secs: u64,
}

#[derive(Serialize)]
pub struct ModelOverride<'a> {
    pub provider: &'a str,
    pub model: &'a str,
}

#[derive(Debug)]
pub struct PromptAwaitResponse {
    pub text: String,
    /// Cloud `sessions.id` (UUID) that the agent's AgentReply was persisted
    /// under. The cron scheduler stamps this into `CronRunRecord.session_id`
    /// so the UI's "view session" button can navigate to it.
    pub session_id: String,
    /// Set when the cloud session was created but the ACP turn itself failed
    /// (e.g. timeout). The scheduler should still record `session_id` and
    /// surface the error, so the user can navigate to the partial conversation.
    pub agent_error: Option<String>,
}

/// Convenience entry point: connect to amuxd's default sock path (resolved
/// via `crate::commands::gateway::sock_path()`), run a `prompt-await`
/// round-trip.
pub async fn prompt_await(req: PromptAwaitRequest<'_>) -> Result<PromptAwaitResponse, String> {
    #[cfg(windows)]
    {
        let _ = req;
        return Err(AMUXD_UNSUPPORTED.into());
    }
    #[cfg(unix)]
    {
        let path = crate::commands::gateway::sock_path();
        prompt_await_at(&path, req).await
    }
}

/// Test-friendly variant: takes the sock path explicitly.
#[cfg(windows)]
pub async fn prompt_await_at(
    _sock_path: &Path,
    _req: PromptAwaitRequest<'_>,
) -> Result<PromptAwaitResponse, String> {
    Err(AMUXD_UNSUPPORTED.into())
}

#[cfg(unix)]
pub async fn prompt_await_at(
    sock_path: &Path,
    req: PromptAwaitRequest<'_>,
) -> Result<PromptAwaitResponse, String> {
    let mut stream = UnixStream::connect(sock_path)
        .await
        .map_err(|e| format!("amuxd unreachable at {}: {e}", sock_path.display()))?;

    let line = serde_json::to_string(&req).map_err(|e| format!("encode request: {e}"))?;
    stream
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("amuxd sock IO (write): {e}"))?;
    stream
        .write_all(b"\n")
        .await
        .map_err(|e| format!("amuxd sock IO (write nl): {e}"))?;
    stream
        .flush()
        .await
        .map_err(|e| format!("amuxd sock IO (flush): {e}"))?;

    const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    let mut buf = Vec::with_capacity(4096);
    let mut byte = [0u8; 1];
    loop {
        if buf.len() >= MAX_RESPONSE_BYTES {
            return Err("amuxd response exceeded 16 MB".into());
        }
        match stream.read(&mut byte).await {
            Ok(0) => break,
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => buf.push(byte[0]),
            Err(e) => return Err(format!("amuxd sock IO (read): {e}")),
        }
    }
    let body = String::from_utf8(buf).map_err(|e| format!("amuxd bad response: not utf8: {e}"))?;

    #[derive(serde::Deserialize)]
    struct Wire {
        ok: bool,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        result: Option<WireResult>,
    }
    #[derive(serde::Deserialize)]
    struct WireResult {
        #[serde(default)]
        text: String,
        session_id: String,
        /// Set when the cloud session was created but the ACP turn failed
        /// (e.g. model timeout). The client receives both the error message
        /// and the session_id so the run record can still link to the
        /// partial conversation in the chat panel.
        #[serde(default)]
        agent_error: Option<String>,
    }

    let parsed: Wire = serde_json::from_str(body.trim())
        .map_err(|e| format!("amuxd bad response: {e} (body={body:?})"))?;
    if !parsed.ok {
        return Err(parsed
            .error
            .unwrap_or_else(|| "unknown amuxd error".to_string()));
    }
    let r = parsed
        .result
        .ok_or_else(|| "amuxd bad response: ok=true but missing result".to_string())?;
    // agent_error means the session was created but the turn itself failed.
    if let Some(ref ae) = r.agent_error {
        return Ok(PromptAwaitResponse {
            text: String::new(),
            session_id: r.session_id,
            agent_error: Some(ae.clone()),
        });
    }
    if r.text.is_empty() {
        return Err("amuxd returned empty text".into());
    }
    Ok(PromptAwaitResponse {
        text: r.text,
        session_id: r.session_id,
        agent_error: None,
    })
}

/// Send a proactive message through amuxd's running channel gateway.
/// `target` must use the daemon dispatch shape: `user:<id>` or `chat:<id>`.
pub async fn channel_send(channel: &str, target: &str, message: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = (channel, target, message);
        return Err(AMUXD_UNSUPPORTED.into());
    }
    #[cfg(unix)]
    {
        let path = crate::commands::gateway::sock_path();
        channel_send_at(&path, channel, target, message).await
    }
}

#[cfg(windows)]
pub async fn channel_send_at(
    _sock_path: &Path,
    _channel: &str,
    _target: &str,
    _message: &str,
) -> Result<(), String> {
    Err(AMUXD_UNSUPPORTED.into())
}

#[cfg(unix)]
pub async fn channel_send_at(
    sock_path: &Path,
    channel: &str,
    target: &str,
    message: &str,
) -> Result<(), String> {
    let payload = serde_json::json!({
        "cmd": "mcp-send",
        // Placeholder binding — cron delivery supplies explicit overrides.
        "binding": "wecom://cron/cron/single/placeholder",
        "message": message,
        "channel_override": channel,
        "target_override": target,
    });
    amuxd_json_roundtrip(sock_path, &payload).await
}

#[cfg(unix)]
async fn amuxd_json_roundtrip(sock_path: &Path, payload: &serde_json::Value) -> Result<(), String> {
    let mut stream = UnixStream::connect(sock_path)
        .await
        .map_err(|e| format!("amuxd unreachable at {}: {e}", sock_path.display()))?;

    let line = serde_json::to_string(payload).map_err(|e| format!("encode request: {e}"))?;
    stream
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("amuxd sock IO (write): {e}"))?;
    stream
        .write_all(b"\n")
        .await
        .map_err(|e| format!("amuxd sock IO (write nl): {e}"))?;
    stream
        .flush()
        .await
        .map_err(|e| format!("amuxd sock IO (flush): {e}"))?;

    const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
    let mut buf = Vec::with_capacity(4096);
    let mut byte = [0u8; 1];
    loop {
        if buf.len() >= MAX_RESPONSE_BYTES {
            return Err("amuxd response exceeded 1 MB".into());
        }
        match stream.read(&mut byte).await {
            Ok(0) => break,
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => buf.push(byte[0]),
            Err(e) => return Err(format!("amuxd sock IO (read): {e}")),
        }
    }

    #[derive(serde::Deserialize)]
    struct Wire {
        ok: bool,
        #[serde(default)]
        error: Option<String>,
    }

    let body = String::from_utf8(buf).map_err(|e| format!("amuxd bad response: not utf8: {e}"))?;
    let parsed: Wire = serde_json::from_str(body.trim())
        .map_err(|e| format!("amuxd bad response: {e} (body={body:?})"))?;
    if !parsed.ok {
        return Err(parsed
            .error
            .unwrap_or_else(|| "unknown amuxd error".to_string()));
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::PathBuf;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    /// Spawn a one-shot mock server that accepts one connection, reads one
    /// JSON line, calls `responder` to produce a reply, writes it back, and
    /// closes. Returns the sock path so the test can point the client at it.
    async fn mock_server<F>(responder: F) -> PathBuf
    where
        F: FnOnce(Value) -> String + Send + 'static,
    {
        // macOS sun_path is ~104 bytes; std::env::temp_dir() on macOS is
        // already ~50 chars, so keep the rest minimal.
        let short = &uuid::Uuid::new_v4().simple().to_string()[..12];
        let dir = PathBuf::from("/tmp").join(format!("amx-{short}"));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let path_clone = path.clone();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let req: Value = serde_json::from_str(line.trim()).unwrap();
            let resp = responder(req);
            let mut stream = reader.into_inner();
            stream.write_all(resp.as_bytes()).await.unwrap();
            stream.write_all(b"\n").await.unwrap();
        });
        path_clone
    }

    #[tokio::test]
    async fn encodes_minimal_request_and_parses_ok_response() {
        let sock_path = mock_server(|req| {
            // Verify the request shape.
            assert_eq!(req["cmd"].as_str(), Some("prompt-await"));
            assert_eq!(req["session_key"].as_str(), Some("cron/j1/r1"));
            assert_eq!(req["message"].as_str(), Some("hi"));
            assert_eq!(req["timeout_secs"].as_u64(), Some(300));
            assert!(req.get("job_name").is_none());
            assert!(req.get("working_directory").is_none());
            assert!(req.get("model_override").is_none());
            serde_json::json!({
                "ok": true,
                "result": { "text": "hello back", "session_id": "sid-1" }
            })
            .to_string()
        })
        .await;

        let resp = prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                job_name: None,
                working_directory: None,
                model_override: None,
                agent_type: None,
                timeout_secs: 300,
            },
        )
        .await
        .unwrap();

        assert_eq!(resp.text, "hello back");
        assert_eq!(resp.session_id, "sid-1");
    }

    #[tokio::test]
    async fn omits_agent_type_when_none() {
        let sock_path = mock_server(|req| {
            assert!(
                req.get("agent_type").is_none(),
                "agent_type must be omitted for the 'auto' selection so amuxd \
                 falls back to default_agent_type; got: {req}"
            );
            serde_json::json!({
                "ok": true,
                "result": { "text": "ok", "session_id": "sid-auto" }
            })
            .to_string()
        })
        .await;

        prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                job_name: None,
                working_directory: None,
                model_override: None,
                agent_type: None,
                timeout_secs: 300,
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn includes_optional_fields_when_set() {
        let sock_path = mock_server(|req| {
            assert_eq!(req["job_name"].as_str(), Some("Nightly digest"));
            assert_eq!(req["working_directory"].as_str(), Some("/tmp/wt"));
            assert_eq!(
                req["model_override"]["provider"].as_str(),
                Some("anthropic")
            );
            assert_eq!(req["model_override"]["model"].as_str(), Some("sonnet"));
            assert_eq!(req["agent_type"].as_str(), Some("claude"));
            serde_json::json!({
                "ok": true,
                "result": { "text": "ok", "session_id": "sid-2" }
            })
            .to_string()
        })
        .await;

        prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                job_name: Some("Nightly digest"),
                working_directory: Some("/tmp/wt"),
                model_override: Some(ModelOverride {
                    provider: "anthropic",
                    model: "sonnet",
                }),
                agent_type: Some("claude"),
                timeout_secs: 300,
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn surfaces_amuxd_error_passthrough() {
        let sock_path = mock_server(|_req| {
            serde_json::json!({ "ok": false, "error": "no local agent runtime" }).to_string()
        })
        .await;

        let err = prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                job_name: None,
                working_directory: None,
                model_override: None,
                agent_type: None,
                timeout_secs: 300,
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("no local agent runtime"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_empty_text() {
        let sock_path = mock_server(|_req| {
            serde_json::json!({
                "ok": true,
                "result": { "text": "", "session_id": "sid-3" }
            })
            .to_string()
        })
        .await;

        let err = prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                job_name: None,
                working_directory: None,
                model_override: None,
                agent_type: None,
                timeout_secs: 300,
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("empty text"), "got: {err}");
    }

    #[tokio::test]
    async fn surfaces_connect_failure_when_sock_missing() {
        let nowhere = PathBuf::from("/tmp/this-sock-does-not-exist-xyz");
        let err = prompt_await_at(
            &nowhere,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                job_name: None,
                working_directory: None,
                model_override: None,
                agent_type: None,
                timeout_secs: 300,
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("amuxd unreachable"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_bad_response_shape() {
        let sock_path = mock_server(|_req| {
            // ok:true but missing result.
            serde_json::json!({ "ok": true }).to_string()
        })
        .await;

        let err = prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                job_name: None,
                working_directory: None,
                model_override: None,
                agent_type: None,
                timeout_secs: 300,
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("missing result"), "got: {err}");
    }

    #[tokio::test]
    async fn channel_send_uses_mcp_send_with_overrides() {
        let sock_path = mock_server(|req| {
            assert_eq!(req["cmd"].as_str(), Some("mcp-send"));
            assert_eq!(req["channel_override"].as_str(), Some("wecom"));
            assert_eq!(req["target_override"].as_str(), Some("user:alice"));
            assert_eq!(req["message"].as_str(), Some("hello"));
            serde_json::json!({ "ok": true, "result": {} }).to_string()
        })
        .await;

        channel_send_at(&sock_path, "wecom", "user:alice", "hello")
            .await
            .unwrap();
    }
}

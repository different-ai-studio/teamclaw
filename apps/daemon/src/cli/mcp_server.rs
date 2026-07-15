//! `amuxd mcp-server` — stdio MCP (Model Context Protocol) bridge.
//!
//! Spawned by claude-code (and other ACP agents) as a child process via
//! `--mcp-config`. Speaks JSON-RPC on stdin/stdout and forwards tool calls
//! to the running amuxd over `amuxd.sock` (line-based JSON envelope with
//! `cmd: "mcp-send"`).
//!
//! Exposes a single tool, `send`, that lets the agent proactively send a
//! text message and/or file back to the gateway chat that originated the
//! ACP session. The session_id + binding URI are captured at spawn time
//! from CLI args, so the agent doesn't have to know them — it can call
//! `send` with just `{ "message": "..." }`.
//!
//! Top-to-bottom synchronous: stdin reads block, sock I/O is synchronous.
//! No tokio runtime here — the bridge is a thin pipe and we avoid pulling
//! a runtime in for what is effectively a serial request/response loop.

use std::io::{BufRead, BufReader, BufWriter, Read, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

/// Block on stdin, dispatch JSON-RPC requests, write JSON-RPC responses.
/// Exits cleanly on EOF (parent process closed stdin).
pub fn run(session_id: &str, binding: &str, sock_path: &Path) -> anyhow::Result<()> {
    eprintln!(
        "[amuxd mcp-server] starting (session_id={}, binding={}, sock={})",
        session_id,
        binding,
        sock_path.display()
    );

    let stdin = std::io::stdin();
    let reader = BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut writer = BufWriter::new(stdout.lock());

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[amuxd mcp-server] stdin read error: {e}");
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let req: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                let err = json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": format!("parse error: {e}") }
                });
                writeln!(writer, "{err}")?;
                writer.flush()?;
                continue;
            }
        };

        // Notifications carry no id and expect no response.
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        if matches!(
            method,
            "notifications/initialized" | "notifications/cancelled"
        ) {
            continue;
        }

        let id = req.get("id").cloned().unwrap_or(Value::Null);

        let result: Result<Value, (i64, String)> = match method {
            "initialize" => Ok(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "amuxd-send", "version": "0.1.0" }
            })),
            "tools/list" => Ok(json!({ "tools": [tool_definition_send()] })),
            "tools/call" => {
                match handle_tool_call(session_id, binding, sock_path, req.get("params")) {
                    Ok(v) => Ok(v),
                    Err(e) => Ok(tool_err(&e)),
                }
            }
            other => Err((-32601, format!("method not found: {other}"))),
        };

        let resp = match result {
            Ok(v) => json!({ "jsonrpc": "2.0", "id": id, "result": v }),
            Err((code, msg)) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": code, "message": msg }
            }),
        };
        writeln!(writer, "{resp}")?;
        writer.flush()?;
    }

    eprintln!("[amuxd mcp-server] stdin closed, exiting");
    Ok(())
}

fn tool_definition_send() -> Value {
    json!({
        "name": "send",
        "description": "Send a text message and/or file to a chat target on a gateway channel (WeCom, Feishu, Discord, Kook, WeChat). \
    By default, sends to the current session's bound chat — provide `target` only to override. \
    Use this when you've generated a file or want to send a follow-up message without waiting for the user to ask.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "message":   { "type": "string", "description": "Text body (optional if file_path provided)" },
                "file_path": { "type": "string", "description": "Absolute path to a file to upload as attachment" },
                "target":    { "type": "string", "description": "Override target ('user:<id>' or 'chat:<id>'). Defaults to current session." },
                "channel":   { "type": "string", "description": "Override channel (wecom/feishu/discord/kook/wechat). Defaults to current session." }
            }
        }
    })
}

fn tool_ok(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

fn tool_err(text: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": true
    })
}

fn handle_tool_call(
    session_id: &str,
    binding: &str,
    sock_path: &Path,
    params: Option<&Value>,
) -> Result<Value, String> {
    let params = params.ok_or_else(|| "missing params".to_string())?;
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing tool name".to_string())?;
    if name != "send" {
        return Err(format!("unknown tool: {name}"));
    }
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let message = args.get("message").and_then(|v| v.as_str());
    let file_path = args.get("file_path").and_then(|v| v.as_str());
    if message.map(|s| s.is_empty()).unwrap_or(true) && file_path.is_none() {
        return Err("at least one of 'message' or 'file_path' is required".to_string());
    }

    let mut payload = json!({
        "cmd": "mcp-send",
        "session_id": session_id,
        "binding": binding,
    });
    if let Some(m) = message {
        payload["message"] = json!(m);
    }
    if let Some(fp) = file_path {
        payload["file_path"] = json!(fp);
    }
    if let Some(t) = args.get("target").and_then(|v| v.as_str()) {
        payload["target_override"] = json!(t);
    }
    if let Some(c) = args.get("channel").and_then(|v| v.as_str()) {
        payload["channel_override"] = json!(c);
    }

    let resp = sock_roundtrip(sock_path, &payload.to_string())
        .map_err(|e| format!("amuxd.sock roundtrip failed: {e}"))?;

    let parsed: Value =
        serde_json::from_str(&resp).map_err(|e| format!("invalid response from amuxd: {e}"))?;

    let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        let err = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error")
            .to_string();
        return Ok(tool_err(&err));
    }

    let body = parsed.get("result").cloned().unwrap_or(Value::Null);
    let text = serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string());
    Ok(tool_ok(&text))
}

/// Connect to `amuxd.sock`, write a single line, read a single line back.
/// Read timeout is bounded so a stalled daemon can't hang the agent.
pub(crate) fn sock_roundtrip(sock_path: &Path, line: &str) -> std::io::Result<String> {
    sock_roundtrip_with_read_timeout(sock_path, line, Duration::from_secs(30))
}

pub(crate) fn sock_roundtrip_with_read_timeout(
    sock_path: &Path,
    line: &str,
    read_timeout: Duration,
) -> std::io::Result<String> {
    #[cfg(unix)]
    let mut stream = {
        let s = UnixStream::connect(sock_path)?;
        s.set_read_timeout(Some(read_timeout))?;
        s.set_write_timeout(Some(Duration::from_secs(10)))?;
        s
    };
    // Windows: byte-mode pipe client. File-based pipe handles have no
    // read/write timeouts; the daemon always answers a roundtrip command
    // with one line (or closes), which bounds the blocking read in practice.
    #[cfg(windows)]
    let mut stream = crate::cli::process::connect_control(sock_path)?;
    stream.write_all(line.as_bytes())?;
    if !line.ends_with('\n') {
        stream.write_all(b"\n")?;
    }
    stream.flush()?;

    // Read until newline. We can't use BufReader::read_line here because we
    // need to operate on the raw stream so the writer half stays alive for
    // the daemon to write its reply.
    let mut buf = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                buf.push(byte[0]);
            }
            Err(e) => return Err(e),
        }
    }
    String::from_utf8(buf).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

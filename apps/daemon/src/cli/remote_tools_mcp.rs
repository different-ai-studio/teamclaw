//! `amuxd remote-tools-mcp` — stdio MCP bridge for client-side remote tools.
//!
//! Spawned by ACP agents via per-session `--mcp-config`. Forwards tool calls to
//! amuxd over `amuxd.sock` (`cmd: "remote-tool-call"`), which publishes an RPC to
//! the member actor topic; capable online clients reply, others stay silent.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use crate::remote_tools::registry::{all_tool_names, tool_description, tool_input_schema, DEFAULT_TIMEOUT_MS};

pub fn run(session_id: &str, team_id: &str, member_actor_id: &str, sock_path: &Path) -> anyhow::Result<()> {
    use std::io::{BufRead, BufReader, BufWriter, Write};

    eprintln!(
        "[amuxd remote-tools-mcp] starting (session_id={}, team_id={}, member_actor_id={}, sock={})",
        session_id,
        team_id,
        member_actor_id,
        sock_path.display()
    );
    let _ = team_id;

    let stdin = std::io::stdin();
    let reader = BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut writer = BufWriter::new(stdout.lock());

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[amuxd remote-tools-mcp] stdin read error: {e}");
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
                "serverInfo": { "name": "amuxd-remote-tools", "version": "0.1.0" }
            })),
            "tools/list" => Ok(json!({ "tools": list_tools() })),
            "tools/call" => match handle_tool_call(session_id, member_actor_id, sock_path, req.get("params")) {
                Ok(v) => Ok(v),
                Err(e) => Ok(tool_err(&e)),
            },
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

    eprintln!("[amuxd remote-tools-mcp] stdin closed, exiting");
    Ok(())
}

fn list_tools() -> Vec<Value> {
    all_tool_names()
        .iter()
        .filter_map(|name| {
            Some(json!({
                "name": name,
                "description": tool_description(name)?,
                "inputSchema": tool_input_schema(name)?,
            }))
        })
        .collect()
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
    member_actor_id: &str,
    sock_path: &Path,
    params: Option<&Value>,
) -> Result<Value, String> {
    let params = params.ok_or_else(|| "missing params".to_string())?;
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing tool name".to_string())?;
    if !crate::remote_tools::registry::is_known_tool(name) {
        return Err(format!("unknown tool: {name}"));
    }
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let payload = json!({
        "cmd": "remote-tool-call",
        "session_id": session_id,
        "tool_name": name,
        "arguments": args,
    });

    let resp = super::mcp_server::sock_roundtrip_with_read_timeout(
        sock_path,
        &payload.to_string(),
        Duration::from_millis(DEFAULT_TIMEOUT_MS.max(1) as u64 + 12_000),
    )
    .map_err(sock_roundtrip_error)?;

    let parsed: Value =
        serde_json::from_str(&resp).map_err(|e| format!("invalid response from amuxd: {e}"))?;

    let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        let code = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown_error");
        let message = parsed
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or(code);
        return Ok(tool_err(&format!("{code}: {message}")));
    }

    let body = parsed.get("result").cloned().unwrap_or(Value::Null);
    let text = serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string());
    Ok(tool_ok(&text))
}

fn sock_roundtrip_error(err: std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::WouldBlock
        || err.kind() == std::io::ErrorKind::TimedOut
        || err.raw_os_error() == Some(35)
    {
        return "daemon response timeout: no capable client replied (is the TeamClaw browser extension side panel open and connected?)".to_string();
    }
    format!("amuxd.sock roundtrip failed: {err}")
}

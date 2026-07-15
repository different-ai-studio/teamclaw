mod capabilities;
mod channels;
mod config;
mod cron;
mod env_vars;
mod knowledge;
mod roles;
mod send;
mod session;
mod sync;

use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/// Default port of the internal TeamClaw introspect HTTP API (must match
/// `commands::introspect_api::INTROSPECT_API_PORT` in the desktop crate).
const DEFAULT_INTROSPECT_API_PORT: u16 = 13144;

#[derive(Parser, Debug)]
#[command(
    name = "teamclaw-introspect",
    about = "TeamClaw MCP introspection server"
)]
struct Args {
    /// Path to the TeamClaw workspace directory
    #[arg(long, default_value = ".")]
    workspace: String,

    /// Port of the local TeamClaw API server
    #[arg(long, default_value_t = 1420)]
    api_port: u16,

    #[command(subcommand)]
    command: Option<Cmd>,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Fetch a stored Git credential for the `teamclaw-askpass` helper.
    ///
    /// Reads `_git_credential.{ref}` from the workspace's local encrypted
    /// env_blob by calling the running TeamClaw app's internal HTTP API.
    /// Prints the credential value to stdout (trailing newline). Exits with
    /// non-zero on failure and writes a diagnostic message to stderr.
    GetCredential {
        /// Absolute path to the workspace whose env_blob holds the credential.
        #[arg(long)]
        workspace: String,
        /// Credential ref, e.g. `custom_git:t1` or `managed_git:t1`.
        #[arg(long = "ref")]
        credential_ref: String,
        /// Port of the running TeamClaw introspect HTTP API.
        #[arg(long, default_value_t = DEFAULT_INTROSPECT_API_PORT)]
        api_port: u16,
    },
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

fn tool_definitions() -> Value {
    json!([
        {
            "name": "get_my_capabilities",
            "description": "Query the AI agent's configured capabilities including channels, role, team members, environment variables, team info, and cron jobs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "description": "Optional category filter",
                        "enum": ["channels", "role", "team_members", "env_vars", "team_info", "cron_jobs"]
                    }
                }
            }
        },
        {
            "name": "send_channel_message",
            "description": "Send a text or image message via a configured channel gateway.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "channel": {
                        "type": "string",
                        "description": "The channel to send through, or 'all' to broadcast to all configured channels.",
                        "enum": ["all", "wecom", "discord", "email", "feishu", "kook", "wechat"]
                    },
                    "message": {
                        "type": "string",
                        "description": "The message text to send. Can be empty if sending an image only."
                    },
                    "target": {
                        "type": "string",
                        "description": "Target recipient within the channel. Format varies by channel: wecom: 'single:<userid>' or 'group:<chatid>' (default: single); discord: 'dm:<user_id>' or 'channel:<channel_id>'; feishu: open_id (ou_xxx), user_id (on_xxx), or chat_id (oc_xxx); kook: 'dm:<user_id>' or 'channel:<channel_id>'; wechat: user identifier. If omitted for wecom, sends to the last active conversation."
                    },
                    "file_path": {
                        "type": "string",
                        "description": "Absolute path to a media file to send. The file will be uploaded and sent natively. Type is auto-detected from extension: image (jpg/png/gif/webp), voice (mp3/amr/wav), video (mp4/mov), or file (any other)."
                    }
                },
                "required": ["channel"]
            }
        },
        {
            "name": "manage_cron_job",
            "description": "Create, pause, resume, delete, or inspect cron jobs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The action to perform.",
                        "enum": ["create", "pause", "resume", "delete", "run", "get_runs"]
                    },
                    "job_id": {
                        "type": "string",
                        "description": "The cron job ID (required for pause/resume/delete/run/get_runs)."
                    },
                    "name": {
                        "type": "string",
                        "description": "Job name (required for create)."
                    },
                    "description": {
                        "type": "string",
                        "description": "Human-readable description of what the job does."
                    },
                    "schedule": {
                        "description": "Schedule for the job (required for create). A plain string is treated as a 5-field cron expression, e.g. '0 9 * * 1-5'. For one-time or interval jobs, pass an object such as {\"kind\":\"at\",\"at\":\"2026-05-07T09:00:00Z\"}, {\"kind\":\"every\",\"everyMs\":3600000}, or {\"kind\":\"cron\",\"expr\":\"0 9 * * 1-5\",\"tz\":\"Asia/Shanghai\"}.",
                        "anyOf": [
                            { "type": "string" },
                            {
                                "type": "object",
                                "properties": {
                                    "kind": { "type": "string", "enum": ["at", "every", "cron"] },
                                    "at": { "type": "string" },
                                    "everyMs": { "type": "integer" },
                                    "expr": { "type": "string" },
                                    "tz": { "type": "string" }
                                },
                                "required": ["kind"]
                            }
                        ]
                    },
                    "message": {
                        "type": "string",
                        "description": "Message or prompt to execute on each run (required for create)."
                    },
                    "delivery": {
                        "type": "object",
                        "description": "Optional delivery settings for cron results.",
                        "properties": {
                            "mode": { "type": "string", "enum": ["announce", "none"] },
                            "channel": { "type": "string", "enum": ["discord", "feishu", "email", "kook", "wechat", "wecom"] },
                            "to": { "type": "string" },
                            "bestEffort": { "type": "boolean" }
                        },
                        "required": ["mode", "channel", "to"]
                    }
                },
                "required": ["action"]
            }
        },
        {
            "name": "sync_team_dir",
            "description": "Sync the shared team directory. Pulls remote Git changes, pushes local changes, and returns a summary.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "manage_knowledge",
            "description": "Manage the knowledge base: search entries, add a memory note, list all memory entries, or delete one. Use 'search' to find relevant information. Use 'add' to persist content for future reference.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["search", "add", "list", "delete"],
                        "description": "The action to perform."
                    },
                    "query": {
                        "type": "string",
                        "description": "Search query (required for action=search)."
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "Max results to return for search (default 5)."
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to save (required for action=add)."
                    },
                    "title": {
                        "type": "string",
                        "description": "Title of the memory note (optional for action=add)."
                    },
                    "filename": {
                        "type": "string",
                        "description": "Filename for the note (optional for add/delete). Auto-generated if omitted for add. Required for delete."
                    }
                },
                "required": ["action"]
            }
        },
        {
            "name": "manage_roles",
            "description": "Manage AI agent roles: list available roles, create a new role, update an existing role, or delete one. Roles are defined by a name, description, and working style.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "create", "update", "delete"],
                        "description": "The action to perform."
                    },
                    "slug": {
                        "type": "string",
                        "description": "Role identifier (directory name). Required for update/delete. Auto-generated from name if omitted for create."
                    },
                    "name": {
                        "type": "string",
                        "description": "Display name for the role (required for create)."
                    },
                    "description": {
                        "type": "string",
                        "description": "Short description of what this role does."
                    },
                    "working_style": {
                        "type": "string",
                        "description": "Working style instructions for the role."
                    }
                },
                "required": ["action"]
            }
        },
        {
            "name": "manage_env_vars",
            "description": "Manage environment variables: list registered keys (no values returned), set a key-value pair, or delete a key. Values are stored securely in the system keychain.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "set", "delete"],
                        "description": "The action to perform."
                    },
                    "key": {
                        "type": "string",
                        "description": "The environment variable name (required for set/delete)."
                    },
                    "value": {
                        "type": "string",
                        "description": "The value to store (required for set). Never returned by list."
                    },
                    "description": {
                        "type": "string",
                        "description": "Optional description for the env var (used for set)."
                    }
                },
                "required": ["action"]
            }
        },
        {
            "name": "manage_channels",
            "description": "View or update message channel configuration (WeCom, Discord, Feishu, Email, KOOK, WeChat). Use 'get' to check what's configured (sensitive values are redacted). Use 'set' to configure a channel with the provided fields.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["get", "set"],
                        "description": "The action to perform."
                    },
                    "channel": {
                        "type": "string",
                        "enum": ["wecom", "discord", "feishu", "email", "kook", "wechat"],
                        "description": "Target channel. Required for set; optional for get (omit to get all channels)."
                    },
                    "config": {
                        "type": "object",
                        "description": "Channel config fields to set. Required for set. Fields vary by channel:\n- wecom: botId, secret, encodingAesKey, ownerId\n- discord: token, dm, guilds\n- feishu: appId, appSecret, chats\n- email: provider, gmailEmail, gmailClientId, gmailClientSecret (or imapServer, smtpServer, username, password for custom)\n- kook: token, dm, guilds\n- wechat: botToken, accountId, baseUrl"
                    }
                },
                "required": ["action"]
            }
        },
        {
            "name": "get_session_deeplink",
            "description": "Export a shareable deep link that opens a TeamClaw session in the desktop or mobile app. Returns a URL like teamclaw://session/<uuid>.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Cloud session UUID to link to."
                    },
                    "scheme": {
                        "type": "string",
                        "description": "Optional URL scheme override (defaults to teamclaw, or TEAMCLAW_APP_SCHEME env var for white-label builds)."
                    }
                },
                "required": ["session_id"]
            }
        }
    ])
}

// ---------------------------------------------------------------------------
// MCP response helpers
// ---------------------------------------------------------------------------

fn mcp_result(id: &Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn mcp_error(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    })
}

fn tool_ok(text: &str) -> Value {
    json!({
        "content": [{"type": "text", "text": text}]
    })
}

fn tool_err(text: &str) -> Value {
    json!({
        "content": [{"type": "text", "text": text}],
        "isError": true
    })
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

async fn handle_request(req: &Value, workspace: &str, api_port: u16) -> Option<Value> {
    let method = req.get("method")?.as_str()?;
    let id = req.get("id").cloned().unwrap_or(Value::Null);

    match method {
        // Notifications — no response needed
        "notifications/initialized" | "notifications/cancelled" => None,

        "initialize" => {
            let params = req.get("params");
            let client_info = params.and_then(|p| p.get("clientInfo"));
            eprintln!(
                "[introspect] initialize from {:?}",
                client_info
                    .and_then(|c| c.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("unknown")
            );

            Some(mcp_result(
                &id,
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": "teamclaw-introspect",
                        "version": "0.1.0"
                    }
                }),
            ))
        }

        "tools/list" => Some(mcp_result(&id, json!({ "tools": tool_definitions() }))),

        "tools/call" => {
            let params = match req.get("params") {
                Some(p) => p,
                None => return Some(mcp_error(&id, -32602, "Missing params")),
            };
            let tool_name = match params.get("name").and_then(|n| n.as_str()) {
                Some(n) => n,
                None => return Some(mcp_error(&id, -32602, "Missing tool name")),
            };
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));

            let tool_result = match tool_name {
                "get_my_capabilities" => match capabilities::handle(workspace, &arguments).await {
                    Ok(v) => {
                        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                        tool_ok(&text)
                    }
                    Err(e) => tool_err(&e),
                },
                "send_channel_message" => {
                    match send::handle(workspace, api_port, &arguments).await {
                        Ok(v) => {
                            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                            tool_ok(&text)
                        }
                        Err(e) => tool_err(&e),
                    }
                }
                "manage_cron_job" => match cron::handle(workspace, api_port, &arguments).await {
                    Ok(v) => {
                        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                        tool_ok(&text)
                    }
                    Err(e) => tool_err(&e),
                },
                "sync_team_dir" => match sync::handle(workspace, api_port, &arguments).await {
                    Ok(v) => {
                        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                        tool_ok(&text)
                    }
                    Err(e) => tool_err(&e),
                },
                "manage_knowledge" => {
                    match knowledge::handle(workspace, api_port, &arguments).await {
                        Ok(v) => {
                            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                            tool_ok(&text)
                        }
                        Err(e) => tool_err(&e),
                    }
                }
                "manage_roles" => match roles::handle(workspace, &arguments).await {
                    Ok(v) => {
                        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                        tool_ok(&text)
                    }
                    Err(e) => tool_err(&e),
                },
                "manage_env_vars" => {
                    match env_vars::handle(workspace, api_port, &arguments).await {
                        Ok(v) => {
                            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                            tool_ok(&text)
                        }
                        Err(e) => tool_err(&e),
                    }
                }
                "manage_channels" => {
                    match channels::handle(workspace, api_port, &arguments).await {
                        Ok(v) => {
                            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                            tool_ok(&text)
                        }
                        Err(e) => tool_err(&e),
                    }
                }
                "get_session_deeplink" => match session::handle(&arguments) {
                    Ok(v) => {
                        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                        tool_ok(&text)
                    }
                    Err(e) => tool_err(&e),
                },
                unknown => tool_err(&format!("Unknown tool: {unknown}")),
            };

            Some(mcp_result(&id, tool_result))
        }

        unknown => {
            eprintln!("[introspect] Unknown method: {unknown}");
            Some(mcp_error(
                &id,
                -32601,
                &format!("Method not found: {unknown}"),
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async fn run_get_credential(workspace: &str, credential_ref: &str, api_port: u16) -> i32 {
    match fetch_credential(workspace, credential_ref, api_port).await {
        Ok(value) => {
            // Print the credential value with a trailing newline. Git's
            // GIT_ASKPASS treats either form (with or without newline) as the
            // credential, so this is the conventional shape.
            println!("{}", value);
            0
        }
        Err(e) => {
            eprintln!("[introspect] get-credential failed: {e}");
            1
        }
    }
}

async fn fetch_credential(
    workspace: &str,
    credential_ref: &str,
    api_port: u16,
) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{api_port}/git-credential-get");
    let body = json!({
        "workspace_path": workspace,
        "credential_ref": credential_ref,
    });
    // 10s timeout so a hung introspect API can't deadlock `git clone` (which
    // blocks on GIT_ASKPASS) indefinitely. Applied at the client level so it
    // covers connect + read.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("build http client failed: {e}"))?;
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}. Is the TeamClaw app running?"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("read body failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("API error ({status}): {text}"));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("parse response failed: {e} (body: {text})"))?;
    v.get("credential")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("response missing `credential` field: {text}"))
}

#[tokio::main]
async fn main() {
    let args = Args::parse();

    if let Some(Cmd::GetCredential {
        workspace,
        credential_ref,
        api_port,
    }) = args.command
    {
        let code = run_get_credential(&workspace, &credential_ref, api_port).await;
        std::process::exit(code);
    }

    let workspace = args.workspace.clone();
    let api_port = args.api_port;

    eprintln!(
        "[introspect] Starting MCP server (workspace={}, api_port={})",
        workspace, api_port
    );

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let reader = BufReader::new(stdin.lock());

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[introspect] stdin read error: {e}");
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
                eprintln!("[introspect] JSON parse error: {e}");
                let err_resp = json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": {"code": -32700, "message": format!("Parse error: {e}")}
                });
                let mut out = stdout.lock();
                let _ = writeln!(out, "{}", err_resp);
                let _ = out.flush();
                continue;
            }
        };

        if let Some(response) = handle_request(&req, &workspace, api_port).await {
            let mut out = stdout.lock();
            let _ = writeln!(out, "{}", response);
            let _ = out.flush();
        }
    }

    eprintln!("[introspect] stdin closed, exiting");
}

#[cfg(test)]
mod get_credential_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Spawns a tiny one-shot HTTP responder on an ephemeral port that
    /// returns `body` for a single request, then exits. Returns the bound
    /// port.
    async fn spawn_stub(body: &'static str, status: u16) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                // Drain request — we don't validate it here.
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let reason = if status == 200 { "OK" } else { "Error" };
                let resp = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        port
    }

    #[tokio::test]
    async fn fetch_credential_returns_value_on_success() {
        let port = spawn_stub(
            r#"{"ok":true,"authKind":"https_token","credential":"ghp_secret"}"#,
            200,
        )
        .await;
        let value = fetch_credential("/ws", "custom_git:t1", port).await.unwrap();
        assert_eq!(value, "ghp_secret");
    }

    #[tokio::test]
    async fn fetch_credential_errors_on_missing_field() {
        let port = spawn_stub(r#"{"ok":true,"authKind":"ssh_key"}"#, 200).await;
        let err = fetch_credential("/ws", "custom_git:t1", port).await.unwrap_err();
        assert!(err.contains("missing `credential`"), "got: {err}");
    }

    #[tokio::test]
    async fn fetch_credential_errors_on_http_error() {
        let port = spawn_stub("git credential not found: custom_git:t1", 500).await;
        let err = fetch_credential("/ws", "custom_git:t1", port).await.unwrap_err();
        assert!(err.contains("API error"), "got: {err}");
    }

    #[tokio::test]
    async fn fetch_credential_errors_when_api_down() {
        // Port that nothing is listening on (use 1 which is privileged + unused).
        let err = fetch_credential("/ws", "custom_git:t1", 1).await.unwrap_err();
        assert!(err.contains("request failed"), "got: {err}");
    }
}

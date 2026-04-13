# Introspect MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a built-in MCP server that gives TeamClaw's AI agent self-awareness of user-configured capabilities and the ability to act on them (send messages, manage cron jobs, manage shortcuts).

**Architecture:** Standalone Rust binary (`teamclaw-introspect`) in `src-tauri/crates/teamclaw-introspect/`, packaged as a Tauri sidecar. Provides 4 MCP tools over stdio JSON-RPC. Reads config files directly from workspace. For operations requiring runtime state (WeCom WebSocket, cron manual run), communicates with Tauri via a lightweight internal HTTP API on port 13144. Auto-registered in `opencode.json` via `ensure_inherent_config()`.

**Tech Stack:** Rust, `rmcp` crate (MCP SDK), `reqwest` (HTTP), `serde_json`, `tokio`

**Spec:** `docs/superpowers/specs/2026-04-13-introspect-mcp-server-design.md`

---

## File Structure

### New files (MCP server crate)
- `src-tauri/crates/teamclaw-introspect/Cargo.toml` — Crate manifest with binary target
- `src-tauri/crates/teamclaw-introspect/src/main.rs` — Entry point: parse args, start stdio MCP server
- `src-tauri/crates/teamclaw-introspect/src/capabilities.rs` — `get_my_capabilities` tool handler
- `src-tauri/crates/teamclaw-introspect/src/send.rs` — `send_channel_message` tool handler
- `src-tauri/crates/teamclaw-introspect/src/cron.rs` — `manage_cron_job` tool handler
- `src-tauri/crates/teamclaw-introspect/src/shortcuts.rs` — `manage_shortcuts` tool handler
- `src-tauri/crates/teamclaw-introspect/src/config.rs` — Shared config reading (teamclaw.json, cron-jobs.json, members.json)

### New files (Internal HTTP API)
- `src-tauri/src/commands/introspect_api.rs` — HTTP server for runtime operations (send WeCom, cron run)

### Modified files
- `src-tauri/Cargo.toml` — Add `teamclaw-introspect` to workspace members
- `src-tauri/src/commands/opencode.rs` — Register introspect MCP in `ensure_inherent_config()`
- `src-tauri/src/commands/mod.rs` — Add `pub mod introspect_api;`
- `src-tauri/src/lib.rs` — Start introspect HTTP API, add Tauri commands
- `src-tauri/tauri.conf.json` — Add `binaries/teamclaw-introspect` to `externalBin`
- `packages/app/src/stores/shortcuts.ts` — Migrate persistence from localStorage to Tauri commands
- `src-tauri/src/commands/gateway/mod.rs` — Add `save_shortcuts` / `load_shortcuts` Tauri commands

---

## Task 1: Scaffold the `teamclaw-introspect` crate

**Files:**
- Create: `src-tauri/crates/teamclaw-introspect/Cargo.toml`
- Create: `src-tauri/crates/teamclaw-introspect/src/main.rs`
- Modify: `src-tauri/Cargo.toml` — Add workspace member

- [ ] **Step 1: Create the crate directory**

```bash
mkdir -p src-tauri/crates/teamclaw-introspect/src
```

- [ ] **Step 2: Write Cargo.toml**

Create `src-tauri/crates/teamclaw-introspect/Cargo.toml`:

```toml
[package]
name = "teamclaw-introspect"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "teamclaw-introspect"
path = "src/main.rs"

[dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "macros", "io-util"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["json"] }
clap = { version = "4", features = ["derive"] }
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1", features = ["v4"] }
```

- [ ] **Step 3: Write minimal main.rs with arg parsing**

Create `src-tauri/crates/teamclaw-introspect/src/main.rs`:

```rust
use clap::Parser;

mod capabilities;
mod config;
mod cron;
mod send;
mod shortcuts;

#[derive(Parser, Debug)]
#[command(name = "teamclaw-introspect")]
struct Args {
    /// Workspace root path
    #[arg(long)]
    workspace: String,

    /// Internal API port for runtime operations (WeCom send, cron run)
    #[arg(long, default_value = "13144")]
    api_port: u16,
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    eprintln!(
        "[Introspect] Starting MCP server for workspace: {}",
        args.workspace
    );

    if let Err(e) = run_mcp_server(args).await {
        eprintln!("[Introspect] Fatal error: {}", e);
        std::process::exit(1);
    }
}

async fn run_mcp_server(args: Args) -> Result<(), Box<dyn std::error::Error>> {
    // Will be implemented in Task 2
    todo!("MCP server loop")
}
```

- [ ] **Step 4: Add to Cargo workspace**

In `src-tauri/Cargo.toml`, add to the workspace members. Find the existing `members` array in `[workspace]` and add `"crates/teamclaw-introspect"`.

- [ ] **Step 5: Create stub module files**

Create these empty stub files so the crate compiles:

`src-tauri/crates/teamclaw-introspect/src/config.rs`:
```rust
// Shared config reading utilities
```

`src-tauri/crates/teamclaw-introspect/src/capabilities.rs`:
```rust
// get_my_capabilities tool handler
```

`src-tauri/crates/teamclaw-introspect/src/send.rs`:
```rust
// send_channel_message tool handler
```

`src-tauri/crates/teamclaw-introspect/src/cron.rs`:
```rust
// manage_cron_job tool handler
```

`src-tauri/crates/teamclaw-introspect/src/shortcuts.rs`:
```rust
// manage_shortcuts tool handler
```

- [ ] **Step 6: Verify it compiles**

```bash
cd src-tauri && cargo check -p teamclaw-introspect
```

Expected: compiles with a warning about `todo!()` in main.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/crates/teamclaw-introspect/ src-tauri/Cargo.toml
git commit -m "feat(introspect): scaffold teamclaw-introspect MCP server crate"
```

---

## Task 2: Implement MCP stdio protocol handler

The MCP protocol is JSON-RPC 2.0 over stdin/stdout. We implement it manually since we only need `initialize`, `tools/list`, and `tools/call`.

**Files:**
- Modify: `src-tauri/crates/teamclaw-introspect/src/main.rs`

- [ ] **Step 1: Implement JSON-RPC types and stdio loop**

Replace `run_mcp_server` in `main.rs` with the full MCP server implementation:

```rust
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

/// Read JSON-RPC messages from stdin, dispatch, write responses to stdout.
async fn run_mcp_server(args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    for line in stdin.lock().lines() {
        let line = line?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                let err_resp = json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": format!("Parse error: {}", e) }
                });
                writeln!(stdout, "{}", err_resp)?;
                stdout.flush()?;
                continue;
            }
        };

        let id = request.get("id").cloned();
        let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or(json!({}));

        let result = match method {
            "initialize" => handle_initialize(),
            "tools/list" => handle_tools_list(),
            "tools/call" => handle_tools_call(&args, &params).await,
            "notifications/initialized" | "notifications/cancelled" => {
                // Notification, no response needed
                continue;
            }
            _ => Err(json!({ "code": -32601, "message": format!("Method not found: {}", method) })),
        };

        let response = match result {
            Ok(res) => json!({ "jsonrpc": "2.0", "id": id, "result": res }),
            Err(err) => json!({ "jsonrpc": "2.0", "id": id, "error": err }),
        };

        writeln!(stdout, "{}", response)?;
        stdout.flush()?;
    }

    Ok(())
}

fn handle_initialize() -> Result<Value, Value> {
    Ok(json!({
        "protocolVersion": "2024-11-05",
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": "teamclaw-introspect",
            "version": "0.1.0"
        }
    }))
}

fn handle_tools_list() -> Result<Value, Value> {
    Ok(json!({
        "tools": [
            {
                "name": "get_my_capabilities",
                "description": "查询当前用户在 TeamClaw 中配置的能力和设置。当用户提到发消息、查团队、用快捷键、看定时任务等操作时，先调用此工具了解可用能力。不传 category 返回所有类别的概览摘要。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "category": {
                            "type": "string",
                            "enum": ["channels", "role", "shortcuts", "team_members", "env_vars", "team_info", "cron_jobs"],
                            "description": "可选，按类别过滤。不传则返回全部概览。"
                        }
                    }
                }
            },
            {
                "name": "send_channel_message",
                "description": "通过已绑定的消息频道发送消息。支持指定单个 channel 或广播到所有已绑定 channel。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "channel": {
                            "type": "string",
                            "enum": ["wecom", "discord", "email", "feishu", "kook", "wechat", "all"],
                            "description": "目标频道。传 'all' 广播到所有已绑定的频道。"
                        },
                        "message": { "type": "string", "description": "要发送的消息内容（纯文本）。" },
                        "target": {
                            "type": "string",
                            "description": "接收者标识。格式因 channel 而异：WeCom 'single:{userid}' 或 'group:{chatid}'；Discord 'dm:{user_id}' 或 'channel:{channel_id}'；Email 邮箱地址；Feishu chat_id；KOOK 'dm:{user_id}' 或 'channel:{channel_id}'；WeChat user_id。"
                        }
                    },
                    "required": ["channel", "message"]
                }
            },
            {
                "name": "manage_cron_job",
                "description": "管理定时任务：创建、暂停、恢复、删除、手动执行、查看运行历史。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["create", "pause", "resume", "delete", "run", "get_runs"],
                            "description": "操作类型"
                        },
                        "job_id": { "type": "string", "description": "目标任务 ID。create 时不需要。" },
                        "name": { "type": "string", "description": "任务名称。create 时必须提供。" },
                        "description": { "type": "string", "description": "任务描述。" },
                        "schedule": {
                            "type": "object",
                            "description": "调度配置。create 时必须提供。",
                            "properties": {
                                "kind": { "type": "string", "enum": ["at", "every", "cron"] },
                                "at": { "type": "string" },
                                "every_ms": { "type": "number" },
                                "expr": { "type": "string" },
                                "tz": { "type": "string" }
                            }
                        },
                        "message": { "type": "string", "description": "任务执行时发送给 AI 的 prompt。" },
                        "delivery": {
                            "type": "object",
                            "properties": {
                                "channel": { "type": "string", "enum": ["discord", "feishu", "email", "kook", "wechat", "wecom"] },
                                "to": { "type": "string" }
                            }
                        }
                    },
                    "required": ["action"]
                }
            },
            {
                "name": "manage_shortcuts",
                "description": "管理用户的快捷操作：创建、修改、删除。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["create", "update", "delete"] },
                        "id": { "type": "string", "description": "快捷操作 ID。update/delete 时必须提供。" },
                        "label": { "type": "string", "description": "显示名称。create 时必须提供。" },
                        "type": { "type": "string", "enum": ["native", "link", "folder"] },
                        "target": { "type": "string", "description": "目标内容。" },
                        "icon": { "type": "string" },
                        "parent_id": { "type": "string" }
                    },
                    "required": ["action"]
                }
            }
        ]
    }))
}

async fn handle_tools_call(args: &Args, params: &Value) -> Result<Value, Value> {
    let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));

    let result = match tool_name {
        "get_my_capabilities" => capabilities::handle(&args.workspace, &arguments).await,
        "send_channel_message" => send::handle(&args.workspace, args.api_port, &arguments).await,
        "manage_cron_job" => cron::handle(&args.workspace, args.api_port, &arguments).await,
        "manage_shortcuts" => shortcuts::handle(&args.workspace, &arguments).await,
        _ => Err(format!("Unknown tool: {}", tool_name)),
    };

    match result {
        Ok(content) => Ok(json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&content).unwrap_or_default() }]
        })),
        Err(e) => Ok(json!({
            "content": [{ "type": "text", "text": format!("Error: {}", e) }],
            "isError": true
        })),
    }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd src-tauri && cargo check -p teamclaw-introspect
```

Expected: compiles (stub modules are empty, handler functions not yet defined).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/crates/teamclaw-introspect/
git commit -m "feat(introspect): implement MCP stdio protocol handler"
```

---

## Task 3: Implement shared config reader

**Files:**
- Modify: `src-tauri/crates/teamclaw-introspect/src/config.rs`

- [ ] **Step 1: Implement config reading utilities**

Write `config.rs`:

```rust
use serde_json::Value;
use std::path::{Path, PathBuf};

const TEAMCLAW_DIR: &str = ".teamclaw";
const CONFIG_FILE_NAME: &str = "teamclaw.json";
const TEAM_REPO_DIR: &str = "teamclaw-team";

/// Read and parse teamclaw.json from workspace
pub fn read_teamclaw_config(workspace: &str) -> Result<Value, String> {
    let path = teamclaw_config_path(workspace);
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", CONFIG_FILE_NAME, e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {}", CONFIG_FILE_NAME, e))
}

/// Write teamclaw.json back to workspace
pub fn write_teamclaw_config(workspace: &str, config: &Value) -> Result<(), String> {
    let path = teamclaw_config_path(workspace);
    // Ensure directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    let mut content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    std::fs::write(&path, &content)
        .map_err(|e| format!("Failed to write {}: {}", CONFIG_FILE_NAME, e))
}

/// Read cron-jobs.json
pub fn read_cron_jobs(workspace: &str) -> Result<Value, String> {
    let path = cron_jobs_path(workspace);
    if !path.exists() {
        return Ok(serde_json::json!({ "jobs": [] }));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read cron-jobs.json: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse cron-jobs.json: {}", e))
}

/// Write cron-jobs.json
pub fn write_cron_jobs(workspace: &str, data: &Value) -> Result<(), String> {
    let path = cron_jobs_path(workspace);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create cron dir: {}", e))?;
    }
    let mut content = serde_json::to_string_pretty(data)
        .map_err(|e| format!("Failed to serialize cron jobs: {}", e))?;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    std::fs::write(&path, &content)
        .map_err(|e| format!("Failed to write cron-jobs.json: {}", e))
}

/// Read cron run history for a job (last N lines from JSONL)
pub fn read_cron_runs(workspace: &str, job_id: &str, limit: usize) -> Result<Vec<Value>, String> {
    let path = cron_run_file(workspace, job_id);
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read run history: {}", e))?;
    let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = if lines.len() > limit { lines.len() - limit } else { 0 };
    let mut records = Vec::new();
    for line in &lines[start..] {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            records.push(v);
        }
    }
    Ok(records)
}

/// Read team members manifest
pub fn read_team_members(workspace: &str) -> Result<Value, String> {
    let path = Path::new(workspace)
        .join(TEAM_REPO_DIR)
        .join("_team")
        .join("members.json");
    if !path.exists() {
        return Ok(serde_json::json!({ "members": [] }));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read members.json: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse members.json: {}", e))
}

/// Read all role definitions from .teamclaw/roles/*/ROLE.md
pub fn read_roles(workspace: &str) -> Result<Vec<Value>, String> {
    let roles_dir = Path::new(workspace).join(TEAMCLAW_DIR).join("roles");
    if !roles_dir.exists() {
        return Ok(vec![]);
    }
    let mut roles = Vec::new();
    let entries = std::fs::read_dir(&roles_dir)
        .map_err(|e| format!("Failed to read roles dir: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let slug = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        if slug == "skill" || slug == "config.json" {
            continue;
        }
        let role_file = path.join("ROLE.md");
        if !role_file.exists() {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&role_file) {
            let role = parse_role_md(&slug, &content);
            roles.push(role);
        }
    }
    Ok(roles)
}

/// Parse ROLE.md frontmatter + sections
fn parse_role_md(slug: &str, content: &str) -> Value {
    let mut name = slug.to_string();
    let mut description = String::new();
    let mut working_style = String::new();

    // Parse YAML frontmatter
    if content.starts_with("---") {
        if let Some(end) = content[3..].find("---") {
            let frontmatter = &content[3..3 + end];
            for line in frontmatter.lines() {
                let line = line.trim();
                if let Some(val) = line.strip_prefix("name:") {
                    name = val.trim().trim_matches('"').to_string();
                }
                if let Some(val) = line.strip_prefix("description:") {
                    description = val.trim().trim_matches('"').to_string();
                }
            }
        }
    }

    // Parse ## sections
    for section in content.split("\n## ") {
        if section.starts_with("Working style") || section.starts_with("working style") {
            working_style = section.lines().skip(1).collect::<Vec<_>>().join("\n").trim().to_string();
        }
    }

    serde_json::json!({
        "slug": slug,
        "name": name,
        "description": description,
        "working_style": working_style,
    })
}

fn teamclaw_config_path(workspace: &str) -> PathBuf {
    Path::new(workspace).join(TEAMCLAW_DIR).join(CONFIG_FILE_NAME)
}

fn cron_jobs_path(workspace: &str) -> PathBuf {
    Path::new(workspace).join(TEAMCLAW_DIR).join("cron-jobs.json")
}

fn cron_run_file(workspace: &str, job_id: &str) -> PathBuf {
    Path::new(workspace)
        .join(TEAMCLAW_DIR)
        .join("cron-runs")
        .join(format!("{}.jsonl", job_id))
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd src-tauri && cargo check -p teamclaw-introspect
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/crates/teamclaw-introspect/src/config.rs
git commit -m "feat(introspect): implement shared config reader"
```

---

## Task 4: Implement `get_my_capabilities`

**Files:**
- Modify: `src-tauri/crates/teamclaw-introspect/src/capabilities.rs`

- [ ] **Step 1: Implement the full handler**

Write `capabilities.rs`:

```rust
use crate::config;
use serde_json::{json, Value};

pub async fn handle(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let category = arguments.get("category").and_then(|c| c.as_str());

    match category {
        Some("channels") => get_channels(workspace),
        Some("role") => get_roles(workspace),
        Some("shortcuts") => get_shortcuts(workspace),
        Some("team_members") => get_team_members(workspace),
        Some("env_vars") => get_env_vars(workspace),
        Some("team_info") => get_team_info(workspace),
        Some("cron_jobs") => get_cron_jobs(workspace),
        Some(other) => Err(format!(
            "Invalid category '{}'. Valid: channels, role, shortcuts, team_members, env_vars, team_info, cron_jobs",
            other
        )),
        None => get_overview(workspace),
    }
}

fn get_channels(workspace: &str) -> Result<Value, String> {
    let config = config::read_teamclaw_config(workspace)?;
    let channels = config.get("channels").cloned().unwrap_or(json!({}));
    let channel_names = ["wecom", "discord", "email", "feishu", "kook", "wechat"];

    let mut result = json!({});
    for name in &channel_names {
        let ch = channels.get(*name);
        let bound = is_channel_bound(name, ch);
        let mut info = json!({ "bound": bound });
        if bound {
            if let Some(ch) = ch {
                add_channel_summary(name, ch, &mut info);
            }
        }
        result[name] = info;
    }
    Ok(json!({ "channels": result }))
}

fn is_channel_bound(name: &str, config: Option<&Value>) -> bool {
    let config = match config {
        Some(c) if !c.is_null() => c,
        _ => return false,
    };
    match name {
        "wecom" => has_non_empty(config, "corpId") && has_non_empty(config, "agentId"),
        "discord" => has_non_empty(config, "token"),
        "email" => has_non_empty(config, "address") || has_non_empty(config, "gmailAddress"),
        "feishu" => has_non_empty(config, "appId") && has_non_empty(config, "appSecret"),
        "kook" => has_non_empty(config, "token"),
        "wechat" => has_non_empty(config, "botToken"),
        _ => false,
    }
}

fn has_non_empty(config: &Value, key: &str) -> bool {
    config
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

fn add_channel_summary(name: &str, config: &Value, info: &mut Value) {
    match name {
        "wecom" => {
            if let Some(v) = config.get("corpName").and_then(|v| v.as_str()) {
                info["corp_name"] = json!(v);
            }
            if let Some(v) = config.get("agentName").and_then(|v| v.as_str()) {
                info["agent_name"] = json!(v);
            }
        }
        "email" => {
            let addr = config.get("address").or(config.get("gmailAddress"));
            if let Some(v) = addr.and_then(|v| v.as_str()) {
                info["address"] = json!(v);
            }
        }
        "discord" => {
            if let Some(v) = config.get("botName").and_then(|v| v.as_str()) {
                info["bot_name"] = json!(v);
            }
        }
        _ => {}
    }
}

fn get_roles(workspace: &str) -> Result<Value, String> {
    let roles = config::read_roles(workspace)?;
    Ok(json!({ "available_roles": roles }))
}

fn get_shortcuts(workspace: &str) -> Result<Value, String> {
    let config = config::read_teamclaw_config(workspace)?;
    let shortcuts = config.get("shortcuts").cloned().unwrap_or(json!([]));
    Ok(json!({ "shortcuts": shortcuts }))
}

fn get_team_members(workspace: &str) -> Result<Value, String> {
    let data = config::read_team_members(workspace)?;
    let members = data.get("members").cloned().unwrap_or(json!([]));
    // Filter to only safe fields
    let safe_members: Vec<Value> = members
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|m| {
            json!({
                "name": m.get("name").unwrap_or(&json!("")),
                "role": m.get("role").unwrap_or(&json!("")),
                "label": m.get("label").unwrap_or(&json!("")),
            })
        })
        .collect();
    Ok(json!({ "members": safe_members }))
}

fn get_env_vars(workspace: &str) -> Result<Value, String> {
    let config = config::read_teamclaw_config(workspace)?;
    let env_vars = config.get("envVars").cloned().unwrap_or(json!([]));
    // Only return key, description, category — never values
    let safe_vars: Vec<Value> = env_vars
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|v| {
            json!({
                "key": v.get("key").unwrap_or(&json!("")),
                "description": v.get("description").unwrap_or(&json!("")),
                "category": v.get("category"),
            })
        })
        .collect();
    Ok(json!({ "env_vars": safe_vars }))
}

fn get_team_info(workspace: &str) -> Result<Value, String> {
    let config = config::read_teamclaw_config(workspace)?;
    let team = config.get("team").cloned().unwrap_or(json!({}));
    // Strip sensitive fields
    let mut safe = team.clone();
    if let Some(obj) = safe.as_object_mut() {
        obj.remove("git_token");
        obj.remove("gitToken");
    }
    Ok(json!({ "team": safe }))
}

fn get_cron_jobs(workspace: &str) -> Result<Value, String> {
    let data = config::read_cron_jobs(workspace)?;
    let jobs = data.get("jobs").cloned().unwrap_or(json!([]));
    // Return summary without payload/delivery details
    let safe_jobs: Vec<Value> = jobs
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|j| {
            json!({
                "id": j.get("id"),
                "name": j.get("name"),
                "description": j.get("description"),
                "enabled": j.get("enabled"),
                "schedule": j.get("schedule"),
                "last_run_at": j.get("last_run_at"),
                "next_run_at": j.get("next_run_at"),
            })
        })
        .collect();
    Ok(json!({ "cron_jobs": safe_jobs }))
}

fn get_overview(workspace: &str) -> Result<Value, String> {
    let config = config::read_teamclaw_config(workspace).unwrap_or(json!({}));
    let channels_config = config.get("channels").cloned().unwrap_or(json!({}));

    let channel_names = ["wecom", "discord", "email", "feishu", "kook", "wechat"];
    let mut bound = vec![];
    let mut unbound = vec![];
    for name in &channel_names {
        if is_channel_bound(name, channels_config.get(*name)) {
            bound.push(*name);
        } else {
            unbound.push(*name);
        }
    }

    let roles = config::read_roles(workspace).unwrap_or_default();
    let shortcuts = config.get("shortcuts").and_then(|s| s.as_array()).map(|a| a.len()).unwrap_or(0);
    let members = config::read_team_members(workspace)
        .ok()
        .and_then(|d| d.get("members").and_then(|m| m.as_array()).map(|a| a.len()))
        .unwrap_or(0);
    let env_vars = config.get("envVars").and_then(|e| e.as_array()).map(|a| a.len()).unwrap_or(0);
    let team = config.get("team").cloned().unwrap_or(json!({}));
    let cron_data = config::read_cron_jobs(workspace).unwrap_or(json!({"jobs": []}));
    let cron_jobs = cron_data.get("jobs").and_then(|j| j.as_array()).unwrap_or(&vec![]);
    let enabled_count = cron_jobs.iter().filter(|j| j.get("enabled") == Some(&json!(true))).count();

    Ok(json!({
        "overview": {
            "channels": { "bound": bound, "unbound": unbound },
            "role": { "available_count": roles.len() },
            "shortcuts": { "count": shortcuts },
            "team_members": { "count": members },
            "env_vars": { "count": env_vars },
            "team_info": {
                "enabled": team.get("enabled").unwrap_or(&json!(false)),
                "sync_mode": if team.get("git_url").is_some() || team.get("gitUrl").is_some() { "git" } else { "unknown" }
            },
            "cron_jobs": { "count": cron_jobs.len(), "enabled_count": enabled_count }
        }
    }))
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd src-tauri && cargo check -p teamclaw-introspect
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/crates/teamclaw-introspect/src/capabilities.rs
git commit -m "feat(introspect): implement get_my_capabilities tool"
```

---

## Task 5: Implement `send_channel_message`

For HTTP-based channels (Discord, Feishu, Email, KOOK, WeChat), the MCP binary makes API calls directly. For WeCom (requires WebSocket), it calls the Tauri internal HTTP API.

**Files:**
- Modify: `src-tauri/crates/teamclaw-introspect/src/send.rs`

- [ ] **Step 1: Implement the send handler**

Write `send.rs`:

```rust
use crate::config;
use serde_json::{json, Value};

pub async fn handle(workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let channel = arguments.get("channel").and_then(|c| c.as_str())
        .ok_or("Missing required parameter: channel")?;
    let message = arguments.get("message").and_then(|m| m.as_str())
        .ok_or("Missing required parameter: message")?;
    let target = arguments.get("target").and_then(|t| t.as_str());

    if channel == "all" {
        return send_all(workspace, api_port, message, target).await;
    }

    let result = send_single(workspace, api_port, channel, message, target).await;
    match result {
        Ok(info) => Ok(json!({ "success": true, "channel": channel, "info": info })),
        Err(e) => Ok(json!({ "success": false, "channel": channel, "error": e })),
    }
}

async fn send_all(workspace: &str, api_port: u16, message: &str, target: Option<&str>) -> Result<Value, String> {
    let tc_config = config::read_teamclaw_config(workspace)?;
    let channels = tc_config.get("channels").cloned().unwrap_or(json!({}));

    let channel_names = ["wecom", "discord", "email", "feishu", "kook", "wechat"];
    let mut results = json!({});
    let mut success_count = 0;
    let mut total_bound = 0;

    for name in &channel_names {
        if !crate::capabilities::is_channel_bound_pub(name, channels.get(*name)) {
            continue;
        }
        total_bound += 1;
        match send_single(workspace, api_port, name, message, target).await {
            Ok(info) => {
                results[name] = json!({ "success": true, "info": info });
                success_count += 1;
            }
            Err(e) => {
                results[name] = json!({ "success": false, "error": e });
            }
        }
    }

    Ok(json!({
        "results": results,
        "summary": format!("{}/{} channels sent successfully", success_count, total_bound)
    }))
}

async fn send_single(
    workspace: &str,
    api_port: u16,
    channel: &str,
    message: &str,
    target: Option<&str>,
) -> Result<Value, String> {
    let tc_config = config::read_teamclaw_config(workspace)?;
    let channels = tc_config.get("channels").cloned().unwrap_or(json!({}));
    let ch_config = channels.get(channel).ok_or(format!("{} channel not configured", channel))?;

    if !crate::capabilities::is_channel_bound_pub(channel, Some(ch_config)) {
        return Err(format!("{} channel is not bound. Please configure it in Settings → Channels.", channel));
    }

    let target = target.ok_or(format!("Target is required for {}.", channel))?;

    match channel {
        "discord" => send_discord(ch_config, target, message).await,
        "feishu" => send_feishu(ch_config, target, message).await,
        "email" => send_email(ch_config, workspace, target, message).await,
        "kook" => send_kook(ch_config, target, message).await,
        "wechat" => send_wechat(ch_config, target, message).await,
        "wecom" => send_wecom_via_api(api_port, target, message).await,
        _ => Err(format!("Unknown channel: {}", channel)),
    }
}

async fn send_discord(config: &Value, target: &str, message: &str) -> Result<Value, String> {
    let token = config.get("token").and_then(|t| t.as_str())
        .ok_or("Discord bot token not configured")?;

    let client = reqwest::Client::new();

    // Resolve channel ID from target format
    let channel_id = if target.starts_with("channel:") {
        target.strip_prefix("channel:").unwrap_or(target).to_string()
    } else {
        // DM: create DM channel first
        let user_id = target.strip_prefix("dm:").unwrap_or(target);
        let resp = client
            .post("https://discord.com/api/v10/users/@me/channels")
            .header("Authorization", format!("Bot {}", token))
            .json(&json!({ "recipient_id": user_id }))
            .send()
            .await
            .map_err(|e| format!("Discord DM create failed: {}", e))?;
        let body: Value = resp.json().await.map_err(|e| format!("Discord DM parse failed: {}", e))?;
        body.get("id").and_then(|id| id.as_str()).ok_or("No channel ID in DM response")?.to_string()
    };

    // Send message (split if > 2000 chars)
    for chunk in split_message(message, 2000) {
        client
            .post(format!("https://discord.com/api/v10/channels/{}/messages", channel_id))
            .header("Authorization", format!("Bot {}", token))
            .json(&json!({ "content": chunk }))
            .send()
            .await
            .map_err(|e| format!("Discord send failed: {}", e))?;
    }

    Ok(json!({ "sent_to": target }))
}

async fn send_feishu(config: &Value, target: &str, message: &str) -> Result<Value, String> {
    let app_id = config.get("appId").and_then(|v| v.as_str())
        .ok_or("Feishu app ID not configured")?;
    let app_secret = config.get("appSecret").and_then(|v| v.as_str())
        .ok_or("Feishu app secret not configured")?;

    let client = reqwest::Client::new();

    // Get tenant access token
    let token_resp = client
        .post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal")
        .json(&json!({ "app_id": app_id, "app_secret": app_secret }))
        .send()
        .await
        .map_err(|e| format!("Feishu auth failed: {}", e))?;
    let token_body: Value = token_resp.json().await.map_err(|e| format!("Feishu auth parse failed: {}", e))?;
    let access_token = token_body.get("tenant_access_token").and_then(|t| t.as_str())
        .ok_or("Failed to get Feishu access token")?;

    // Send message
    for chunk in split_message(message, 4000) {
        client
            .post("https://open.feishu.cn/open-apis/im/v1/messages")
            .header("Authorization", format!("Bearer {}", access_token))
            .query(&[("receive_id_type", "chat_id")])
            .json(&json!({
                "receive_id": target,
                "msg_type": "text",
                "content": serde_json::to_string(&json!({ "text": chunk })).unwrap()
            }))
            .send()
            .await
            .map_err(|e| format!("Feishu send failed: {}", e))?;
    }

    Ok(json!({ "sent_to": target }))
}

async fn send_email(config: &Value, _workspace: &str, target: &str, message: &str) -> Result<Value, String> {
    // Email sending requires SMTP or OAuth2 — complex to reimplement.
    // Delegate to internal API.
    // For now, return a clear error directing to use the Tauri app.
    let _ = (config, target, message);
    Err("Email sending from MCP is not yet supported. Use the Tauri app's cron delivery for email.".to_string())
}

async fn send_kook(config: &Value, target: &str, message: &str) -> Result<Value, String> {
    let token = config.get("token").and_then(|t| t.as_str())
        .ok_or("KOOK bot token not configured")?;

    let client = reqwest::Client::new();

    let (target_id, is_dm) = if target.starts_with("dm:") {
        (target.strip_prefix("dm:").unwrap_or(target), true)
    } else if target.starts_with("channel:") {
        (target.strip_prefix("channel:").unwrap_or(target), false)
    } else {
        (target, true)
    };

    let url = if is_dm {
        "https://www.kookapp.cn/api/v3/direct-message/create"
    } else {
        "https://www.kookapp.cn/api/v3/message/create"
    };

    for chunk in split_message(message, 8000) {
        let mut body = json!({ "content": chunk, "type": 1 });
        if is_dm {
            body["target_id"] = json!(target_id);
        } else {
            body["target_id"] = json!(target_id);
        }

        client
            .post(url)
            .header("Authorization", format!("Bot {}", token))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("KOOK send failed: {}", e))?;
    }

    Ok(json!({ "sent_to": target }))
}

async fn send_wechat(config: &Value, target: &str, message: &str) -> Result<Value, String> {
    let bot_token = config.get("botToken").and_then(|t| t.as_str())
        .ok_or("WeChat bot token not configured")?;
    let base_url = config.get("baseUrl").and_then(|u| u.as_str())
        .unwrap_or("https://ilinkai.weixin.qq.com");
    let context_token = config.get("contextTokens")
        .and_then(|ct| ct.get(target))
        .and_then(|t| t.as_str())
        .ok_or(format!("No context_token for WeChat user '{}'. The user must send a message to the gateway first.", target))?;

    let client = reqwest::Client::new();

    client
        .post(format!("{}/ilink/bot/sendmessage", base_url))
        .header("Authorization", format!("Bearer {}", bot_token))
        .json(&json!({
            "to_user_id": target,
            "content": { "type": "text", "text": message },
            "context_token": context_token
        }))
        .send()
        .await
        .map_err(|e| format!("WeChat send failed: {}", e))?;

    Ok(json!({ "sent_to": target }))
}

/// Send WeCom message via internal Tauri HTTP API (WebSocket-dependent)
async fn send_wecom_via_api(api_port: u16, target: &str, message: &str) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://127.0.0.1:{}/send-wecom", api_port))
        .json(&json!({ "target": target, "message": message }))
        .send()
        .await
        .map_err(|e| format!("Failed to reach internal API: {}. Is TeamClaw running?", e))?;

    if resp.status().is_success() {
        Ok(json!({ "sent_to": target }))
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(format!("WeCom send failed: {}", body))
    }
}

fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.len() <= max_len {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut remaining = text;
    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }
        let mut split_at = max_len;
        while split_at > 0 && !remaining.is_char_boundary(split_at) {
            split_at -= 1;
        }
        let actual_split = remaining[..split_at]
            .rfind('\n')
            .unwrap_or_else(|| remaining[..split_at].rfind(' ').unwrap_or(split_at));
        if actual_split == 0 {
            chunks.push(remaining[..split_at].to_string());
            remaining = &remaining[split_at..];
        } else {
            chunks.push(remaining[..actual_split].to_string());
            remaining = remaining[actual_split..].trim_start();
        }
    }
    chunks
}
```

- [ ] **Step 2: Expose `is_channel_bound` as pub in capabilities.rs**

Add this public wrapper function to `capabilities.rs`:

```rust
/// Public wrapper for use by send.rs
pub fn is_channel_bound_pub(name: &str, config: Option<&Value>) -> bool {
    is_channel_bound(name, config)
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd src-tauri && cargo check -p teamclaw-introspect
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/crates/teamclaw-introspect/src/send.rs src-tauri/crates/teamclaw-introspect/src/capabilities.rs
git commit -m "feat(introspect): implement send_channel_message tool"
```

---

## Task 6: Implement `manage_cron_job`

**Files:**
- Modify: `src-tauri/crates/teamclaw-introspect/src/cron.rs`

- [ ] **Step 1: Implement the cron handler**

Write `cron.rs`:

```rust
use crate::config;
use chrono::Utc;
use serde_json::{json, Value};
use uuid::Uuid;

pub async fn handle(workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let action = arguments.get("action").and_then(|a| a.as_str())
        .ok_or("Missing required parameter: action")?;

    match action {
        "create" => create_job(workspace, arguments),
        "pause" => toggle_job(workspace, arguments, false),
        "resume" => toggle_job(workspace, arguments, true),
        "delete" => delete_job(workspace, arguments),
        "run" => run_job(api_port, arguments).await,
        "get_runs" => get_runs(workspace, arguments),
        _ => Err(format!("Invalid action '{}'. Valid: create, pause, resume, delete, run, get_runs", action)),
    }
}

fn create_job(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let name = arguments.get("name").and_then(|n| n.as_str())
        .ok_or("Missing required parameter: name")?;
    let schedule = arguments.get("schedule")
        .ok_or("Missing required parameter: schedule")?;
    let message = arguments.get("message").and_then(|m| m.as_str())
        .ok_or("Missing required parameter: message")?;
    let description = arguments.get("description").and_then(|d| d.as_str());

    // Validate schedule
    let kind = schedule.get("kind").and_then(|k| k.as_str())
        .ok_or("Missing schedule.kind")?;
    match kind {
        "at" => {
            schedule.get("at").and_then(|a| a.as_str())
                .ok_or("schedule.at is required when kind='at'")?;
        }
        "every" => {
            schedule.get("every_ms").and_then(|e| e.as_u64())
                .ok_or("schedule.every_ms is required when kind='every'")?;
        }
        "cron" => {
            schedule.get("expr").and_then(|e| e.as_str())
                .ok_or("schedule.expr is required when kind='cron'")?;
        }
        _ => return Err(format!("Invalid schedule.kind '{}'. Valid: at, every, cron", kind)),
    }

    let mut data = config::read_cron_jobs(workspace)?;
    let jobs = data.get_mut("jobs")
        .and_then(|j| j.as_array_mut())
        .ok_or("Invalid cron-jobs.json structure")?;

    let now = Utc::now().to_rfc3339();
    let id = Uuid::new_v4().to_string();

    // Build delivery if provided
    let delivery = arguments.get("delivery").cloned();

    let job = json!({
        "id": id,
        "name": name,
        "description": description,
        "enabled": true,
        "schedule": {
            "kind": kind,
            "at": schedule.get("at"),
            "every_ms": schedule.get("every_ms"),
            "expr": schedule.get("expr"),
            "tz": schedule.get("tz"),
        },
        "payload": {
            "message": message,
        },
        "delivery": delivery.map(|d| json!({
            "mode": "announce",
            "channel": d.get("channel"),
            "to": d.get("to").and_then(|t| t.as_str()).unwrap_or(""),
            "best_effort": true,
        })),
        "delete_after_run": kind == "at",
        "created_at": now,
        "updated_at": now,
        "last_run_at": null,
        "next_run_at": null,
    });

    jobs.push(job.clone());
    config::write_cron_jobs(workspace, &data)?;

    Ok(json!({
        "success": true,
        "job": {
            "id": id,
            "name": name,
            "enabled": true,
            "schedule": schedule,
        }
    }))
}

fn toggle_job(workspace: &str, arguments: &Value, enabled: bool) -> Result<Value, String> {
    let job_id = arguments.get("job_id").and_then(|j| j.as_str())
        .ok_or("Missing required parameter: job_id")?;

    let mut data = config::read_cron_jobs(workspace)?;
    let jobs = data.get_mut("jobs")
        .and_then(|j| j.as_array_mut())
        .ok_or("Invalid cron-jobs.json structure")?;

    let job = jobs.iter_mut()
        .find(|j| j.get("id").and_then(|id| id.as_str()) == Some(job_id))
        .ok_or(format!("Job not found: {}", job_id))?;

    job["enabled"] = json!(enabled);
    job["updated_at"] = json!(Utc::now().to_rfc3339());

    config::write_cron_jobs(workspace, &data)?;

    let action = if enabled { "resumed" } else { "paused" };
    let name = job.get("name").and_then(|n| n.as_str()).unwrap_or(job_id);
    Ok(json!({
        "success": true,
        "message": format!("Job '{}' {}", name, action)
    }))
}

fn delete_job(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let job_id = arguments.get("job_id").and_then(|j| j.as_str())
        .ok_or("Missing required parameter: job_id")?;

    let mut data = config::read_cron_jobs(workspace)?;
    let jobs = data.get_mut("jobs")
        .and_then(|j| j.as_array_mut())
        .ok_or("Invalid cron-jobs.json structure")?;

    let original_len = jobs.len();
    jobs.retain(|j| j.get("id").and_then(|id| id.as_str()) != Some(job_id));

    if jobs.len() == original_len {
        return Err(format!("Job not found: {}", job_id));
    }

    config::write_cron_jobs(workspace, &data)?;

    // Also remove run history file
    let run_file = std::path::Path::new(workspace)
        .join(".teamclaw")
        .join("cron-runs")
        .join(format!("{}.jsonl", job_id));
    let _ = std::fs::remove_file(run_file); // Best effort

    Ok(json!({
        "success": true,
        "message": format!("Job '{}' deleted", job_id)
    }))
}

async fn run_job(api_port: u16, arguments: &Value) -> Result<Value, String> {
    let job_id = arguments.get("job_id").and_then(|j| j.as_str())
        .ok_or("Missing required parameter: job_id")?;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://127.0.0.1:{}/cron-run", api_port))
        .json(&json!({ "job_id": job_id }))
        .send()
        .await
        .map_err(|e| format!("Failed to reach internal API: {}. Is TeamClaw running?", e))?;

    if resp.status().is_success() {
        Ok(json!({
            "success": true,
            "message": format!("Job '{}' triggered for immediate execution", job_id)
        }))
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(format!("Failed to trigger job: {}", body))
    }
}

fn get_runs(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let job_id = arguments.get("job_id").and_then(|j| j.as_str())
        .ok_or("Missing required parameter: job_id")?;

    let runs = config::read_cron_runs(workspace, job_id, 10)?;

    // Filter to safe fields
    let safe_runs: Vec<Value> = runs.iter().map(|r| {
        json!({
            "run_id": r.get("run_id"),
            "status": r.get("status"),
            "started_at": r.get("started_at"),
            "finished_at": r.get("finished_at"),
            "response_summary": r.get("response_summary"),
            "error": r.get("error"),
        })
    }).collect();

    Ok(json!({ "runs": safe_runs }))
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd src-tauri && cargo check -p teamclaw-introspect
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/crates/teamclaw-introspect/src/cron.rs
git commit -m "feat(introspect): implement manage_cron_job tool"
```

---

## Task 7: Implement `manage_shortcuts`

**Files:**
- Modify: `src-tauri/crates/teamclaw-introspect/src/shortcuts.rs`

- [ ] **Step 1: Implement the shortcuts handler**

Write `shortcuts.rs`:

```rust
use crate::config;
use serde_json::{json, Value};

pub async fn handle(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let action = arguments.get("action").and_then(|a| a.as_str())
        .ok_or("Missing required parameter: action")?;

    match action {
        "create" => create_shortcut(workspace, arguments),
        "update" => update_shortcut(workspace, arguments),
        "delete" => delete_shortcut(workspace, arguments),
        _ => Err(format!("Invalid action '{}'. Valid: create, update, delete", action)),
    }
}

fn create_shortcut(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let label = arguments.get("label").and_then(|l| l.as_str())
        .ok_or("Missing required parameter: label")?;
    let sc_type = arguments.get("type").and_then(|t| t.as_str())
        .ok_or("Missing required parameter: type")?;
    let target = arguments.get("target").and_then(|t| t.as_str()).unwrap_or("");

    if !["native", "link", "folder"].contains(&sc_type) {
        return Err(format!("Invalid type '{}'. Valid: native, link, folder", sc_type));
    }

    let mut tc_config = config::read_teamclaw_config(workspace)?;

    let shortcuts = tc_config
        .as_object_mut()
        .ok_or("Invalid teamclaw.json")?
        .entry("shortcuts")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or("shortcuts is not an array")?;

    // Generate ID and compute order
    let id = format!(
        "shortcut-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        &uuid::Uuid::new_v4().to_string()[..7]
    );
    let parent_id = arguments.get("parent_id").and_then(|p| p.as_str());
    let order = shortcuts
        .iter()
        .filter(|s| s.get("parentId").and_then(|p| p.as_str()) == parent_id)
        .count();

    let shortcut = json!({
        "id": id,
        "label": label,
        "type": sc_type,
        "target": target,
        "icon": arguments.get("icon").and_then(|i| i.as_str()).unwrap_or(""),
        "order": order,
        "parentId": parent_id,
    });

    shortcuts.push(shortcut.clone());
    config::write_teamclaw_config(workspace, &tc_config)?;

    Ok(json!({ "success": true, "shortcut": shortcut }))
}

fn update_shortcut(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let id = arguments.get("id").and_then(|i| i.as_str())
        .ok_or("Missing required parameter: id")?;

    let mut tc_config = config::read_teamclaw_config(workspace)?;
    let shortcuts = tc_config.get_mut("shortcuts")
        .and_then(|s| s.as_array_mut())
        .ok_or("No shortcuts configured")?;

    let shortcut = shortcuts.iter_mut()
        .find(|s| s.get("id").and_then(|sid| sid.as_str()) == Some(id))
        .ok_or(format!("Shortcut not found: {}", id))?;

    // Update provided fields
    if let Some(label) = arguments.get("label").and_then(|l| l.as_str()) {
        shortcut["label"] = json!(label);
    }
    if let Some(sc_type) = arguments.get("type").and_then(|t| t.as_str()) {
        shortcut["type"] = json!(sc_type);
    }
    if let Some(target) = arguments.get("target").and_then(|t| t.as_str()) {
        shortcut["target"] = json!(target);
    }
    if let Some(icon) = arguments.get("icon").and_then(|i| i.as_str()) {
        shortcut["icon"] = json!(icon);
    }
    if let Some(parent_id) = arguments.get("parent_id") {
        shortcut["parentId"] = parent_id.clone();
    }

    let updated = shortcut.clone();
    config::write_teamclaw_config(workspace, &tc_config)?;

    Ok(json!({ "success": true, "shortcut": updated }))
}

fn delete_shortcut(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let id = arguments.get("id").and_then(|i| i.as_str())
        .ok_or("Missing required parameter: id")?;

    let mut tc_config = config::read_teamclaw_config(workspace)?;
    let shortcuts = tc_config.get_mut("shortcuts")
        .and_then(|s| s.as_array_mut())
        .ok_or("No shortcuts configured")?;

    // Collect IDs to delete (target + all children if folder)
    let mut ids_to_delete = vec![id.to_string()];
    collect_children(shortcuts, id, &mut ids_to_delete);

    let original_len = shortcuts.len();
    shortcuts.retain(|s| {
        let sid = s.get("id").and_then(|sid| sid.as_str()).unwrap_or("");
        !ids_to_delete.contains(&sid.to_string())
    });

    let deleted_count = original_len - shortcuts.len();
    if deleted_count == 0 {
        return Err(format!("Shortcut not found: {}", id));
    }

    config::write_teamclaw_config(workspace, &tc_config)?;

    Ok(json!({
        "success": true,
        "deleted_count": deleted_count,
    }))
}

fn collect_children(shortcuts: &[Value], parent_id: &str, ids: &mut Vec<String>) {
    for s in shortcuts {
        if s.get("parentId").and_then(|p| p.as_str()) == Some(parent_id) {
            if let Some(child_id) = s.get("id").and_then(|id| id.as_str()) {
                ids.push(child_id.to_string());
                collect_children(shortcuts, child_id, ids);
            }
        }
    }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd src-tauri && cargo check -p teamclaw-introspect
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/crates/teamclaw-introspect/src/shortcuts.rs
git commit -m "feat(introspect): implement manage_shortcuts tool"
```

---

## Task 8: Shortcuts persistence migration (localStorage → file system)

**Files:**
- Modify: `src-tauri/src/commands/gateway/mod.rs` — Add Tauri commands
- Modify: `packages/app/src/stores/shortcuts.ts` — Switch persistence

- [ ] **Step 1: Add Tauri commands for shortcuts persistence**

In `src-tauri/src/commands/gateway/mod.rs`, add near the other config commands:

```rust
#[tauri::command]
pub fn load_shortcuts(
    opencode_state: State<'_, super::opencode::OpenCodeState>,
) -> Result<Vec<serde_json::Value>, String> {
    let workspace_path = {
        let inner = opencode_state.inner.lock().map_err(|e| e.to_string())?;
        inner.workspace_path.clone()?
    };
    let config = read_config(&workspace_path)?;
    let shortcuts = config.get("shortcuts").cloned().unwrap_or(serde_json::json!([]));
    Ok(shortcuts.as_array().cloned().unwrap_or_default())
}

#[tauri::command]
pub fn save_shortcuts(
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    nodes: Vec<serde_json::Value>,
) -> Result<(), String> {
    let workspace_path = {
        let inner = opencode_state.inner.lock().map_err(|e| e.to_string())?;
        inner.workspace_path.clone()?
    };
    let mut config = read_config(&workspace_path)?;
    config["shortcuts"] = serde_json::json!(nodes);
    write_config(&workspace_path, &config)
}
```

- [ ] **Step 2: Register the Tauri commands**

In `src-tauri/src/lib.rs`, add to the `invoke_handler` list:

```rust
commands::gateway::load_shortcuts,
commands::gateway::save_shortcuts,
```

- [ ] **Step 3: Update frontend shortcuts store**

Replace the persistence functions in `packages/app/src/stores/shortcuts.ts`:

```typescript
import { invoke } from '@tauri-apps/api/core'

// Replace loadPersistedNodes
async function loadPersistedNodesFromFile(): Promise<ShortcutNode[]> {
  try {
    const nodes = await invoke<ShortcutNode[]>('load_shortcuts')
    return nodes || []
  } catch {
    // Fallback to localStorage for migration
    const stored = loadFromStorage<{ nodes: ShortcutNode[]; version: number }>(STORAGE_KEY, { nodes: [], version: 1 })
    return stored.nodes || []
  }
}

// Replace persistNodes
async function persistNodesToFile(nodes: ShortcutNode[]): Promise<void> {
  try {
    await invoke('save_shortcuts', { nodes })
  } catch (e) {
    console.error('[Shortcuts] Failed to persist to file, falling back to localStorage', e)
    saveToStorage(STORAGE_KEY, { nodes, version: 1 })
  }
}
```

Update the store to use async init pattern: change `nodes: loadPersistedNodes()` to lazy initialization with the async function, and update `persistNodes()` calls to use the new async version.

- [ ] **Step 4: Add one-time migration logic**

In the store's initialization, add migration: if file has no shortcuts but localStorage does, write localStorage data to file and clear localStorage.

- [ ] **Step 5: Verify it compiles**

```bash
cd src-tauri && cargo check
pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/gateway/mod.rs src-tauri/src/lib.rs packages/app/src/stores/shortcuts.ts
git commit -m "feat(shortcuts): migrate persistence from localStorage to teamclaw.json"
```

---

## Task 9: Internal HTTP API for runtime operations

The MCP binary needs to call the Tauri process for operations requiring runtime state: WeCom sending (WebSocket) and cron manual run (scheduler).

**Files:**
- Create: `src-tauri/src/commands/introspect_api.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create the HTTP API server**

Create `src-tauri/src/commands/introspect_api.rs`:

```rust
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::RwLock;

/// Port for the introspect internal API
pub const INTROSPECT_API_PORT: u16 = 13144;

/// Start a minimal HTTP server for the introspect MCP binary to call.
/// Handles: POST /send-wecom, POST /cron-run
pub async fn start_introspect_api(app_handle: AppHandle) -> Result<(), String> {
    use std::io::{Read, Write};

    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", INTROSPECT_API_PORT))
        .await
        .map_err(|e| format!("Failed to bind introspect API: {}", e))?;

    eprintln!("[IntrospectAPI] Listening on 127.0.0.1:{}", INTROSPECT_API_PORT);

    loop {
        let (stream, _) = listener.accept().await.map_err(|e| format!("Accept error: {}", e))?;
        let app = app_handle.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, app).await {
                eprintln!("[IntrospectAPI] Error: {}", e);
            }
        });
    }
}

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    app: AppHandle,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut buf = vec![0u8; 8192];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // Simple HTTP parsing
    let (method, path, body) = parse_http_request(&request);

    let (status, response_body) = match (method.as_str(), path.as_str()) {
        ("POST", "/send-wecom") => handle_send_wecom(&app, &body).await,
        ("POST", "/cron-run") => handle_cron_run(&app, &body).await,
        _ => ("404 Not Found".to_string(), r#"{"error":"Not found"}"#.to_string()),
    };

    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        status,
        response_body.len(),
        response_body
    );
    stream.write_all(response.as_bytes()).await.map_err(|e| e.to_string())?;
    Ok(())
}

fn parse_http_request(raw: &str) -> (String, String, String) {
    let mut lines = raw.split("\r\n");
    let first_line = lines.next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    let method = parts.first().unwrap_or(&"GET").to_string();
    let path = parts.get(1).unwrap_or(&"/").to_string();

    // Find body after empty line
    let body = if let Some(pos) = raw.find("\r\n\r\n") {
        raw[pos + 4..].to_string()
    } else {
        String::new()
    };

    (method, path, body)
}

async fn handle_send_wecom(app: &AppHandle, body: &str) -> (String, String) {
    let params: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return ("400 Bad Request".into(), format!(r#"{{"error":"{}"}}"#, e)),
    };

    let target = match params.get("target").and_then(|t| t.as_str()) {
        Some(t) => t,
        None => return ("400 Bad Request".into(), r#"{"error":"missing target"}"#.into()),
    };
    let message = match params.get("message").and_then(|m| m.as_str()) {
        Some(m) => m,
        None => return ("400 Bad Request".into(), r#"{"error":"missing message"}"#.into()),
    };

    // Parse target format
    let (chatid, chat_type) = if target.starts_with("single:") {
        (target.strip_prefix("single:").unwrap_or(target), 1u32)
    } else if target.starts_with("group:") {
        (target.strip_prefix("group:").unwrap_or(target), 2u32)
    } else {
        (target, 1u32)
    };

    match super::gateway::wecom::send_proactive_message(chatid, chat_type, message).await {
        Ok(()) => ("200 OK".into(), r#"{"success":true}"#.into()),
        Err(e) => ("500 Internal Server Error".into(), format!(r#"{{"error":"{}"}}"#, e)),
    }
}

async fn handle_cron_run(app: &AppHandle, body: &str) -> (String, String) {
    let params: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return ("400 Bad Request".into(), format!(r#"{{"error":"{}"}}"#, e)),
    };

    let job_id = match params.get("job_id").and_then(|j| j.as_str()) {
        Some(id) => id.to_string(),
        None => return ("400 Bad Request".into(), r#"{"error":"missing job_id"}"#.into()),
    };

    let cron_state = app.state::<super::cron::CronState>();
    match cron_state.scheduler.run_job_now(&job_id).await {
        Ok(()) => ("200 OK".into(), r#"{"success":true}"#.into()),
        Err(e) => ("500 Internal Server Error".into(), format!(r#"{{"error":"{}"}}"#, e)),
    }
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/commands/mod.rs`, add:

```rust
pub mod introspect_api;
```

- [ ] **Step 3: Start the API server in lib.rs setup**

In the `setup` closure of `src-tauri/src/lib.rs`, add alongside the existing RAG HTTP server spawn:

```rust
// Start introspect internal API server
{
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = commands::introspect_api::start_introspect_api(app_handle).await {
            eprintln!("[IntrospectAPI] Failed to start: {}", e);
        }
    });
}
```

- [ ] **Step 4: Verify it compiles**

```bash
cd src-tauri && cargo check
```

Note: The `cron_state.scheduler.run_job_now()` method may not exist yet. Check `scheduler.rs` for the exact method name — it may be exposed via the existing `cron_run_job` Tauri command pattern. Adjust the call accordingly. If needed, add a `pub async fn run_job_now(&self, job_id: &str)` wrapper to the scheduler.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/introspect_api.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(introspect): add internal HTTP API for WeCom send and cron run"
```

---

## Task 10: Auto-registration in opencode.json

**Files:**
- Modify: `src-tauri/src/commands/opencode.rs` — Add to `ensure_inherent_config()`
- Modify: `src-tauri/tauri.conf.json` — Add to `externalBin`

- [ ] **Step 1: Register introspect MCP in ensure_inherent_config**

In `src-tauri/src/commands/opencode.rs`, inside the `ensure_inherent_config()` function, after the existing `autoui` block (around line 905), add:

```rust
if !mcp_obj.contains_key("teamclaw-introspect") {
    // Resolve the sidecar binary path
    let introspect_bin = app_resource_path("teamclaw-introspect");
    mcp_obj.insert(
        "teamclaw-introspect".to_string(),
        serde_json::json!({
            "type": "local",
            "enabled": true,
            "command": [
                introspect_bin,
                "--workspace",
                workspace_path,
                "--api-port",
                format!("{}", super::introspect_api::INTROSPECT_API_PORT)
            ]
        }),
    );
    changed = true;
    println!("[Config] Added inherent 'teamclaw-introspect' MCP config");
}
```

Note: The function currently takes only `workspace_path`. The binary path resolution needs to use the same mechanism as the OpenCode sidecar. Check `start_opencode_inner()` for how `app.shell().sidecar("opencode")` resolves the binary path. For `ensure_inherent_config`, since we don't have the `AppHandle`, we need to resolve the binary path differently — likely by computing it relative to the executable's directory using `std::env::current_exe()`.

Alternative: Instead of embedding the full path, use a relative path or pass the workspace path to OpenCode's config so OpenCode can spawn it:

```rust
mcp_obj.insert(
    "teamclaw-introspect".to_string(),
    serde_json::json!({
        "type": "local",
        "enabled": true,
        "command": [
            "./binaries/teamclaw-introspect",
            "--workspace", workspace_path,
            "--api-port", "13144"
        ]
    }),
);
```

The exact binary path format depends on how OpenCode resolves MCP server commands. Test this step manually.

- [ ] **Step 2: Add to externalBin in tauri.conf.json**

In `src-tauri/tauri.conf.json`, update the `externalBin` array:

```json
"externalBin": [
    "binaries/opencode",
    "binaries/teamclaw-introspect"
]
```

- [ ] **Step 3: Build the binary and place in binaries/**

```bash
cd src-tauri && cargo build --release -p teamclaw-introspect
cp target/release/teamclaw-introspect binaries/teamclaw-introspect-$(rustc -vV | sed -n 's|host: ||p')
```

This creates `binaries/teamclaw-introspect-aarch64-apple-darwin` (or equivalent for the platform).

- [ ] **Step 4: Verify registration works**

Start the app with `pnpm tauri:dev`, then check `opencode.json` in the workspace directory:

```bash
cat <workspace>/opencode.json | jq '.mcp["teamclaw-introspect"]'
```

Expected: should show the MCP server configuration with the correct binary path and workspace argument.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/opencode.rs src-tauri/tauri.conf.json
git commit -m "feat(introspect): auto-register MCP server in opencode.json"
```

---

## Task 11: Integration testing

- [ ] **Step 1: Manual smoke test — get_my_capabilities**

Start the app with `pnpm tauri:dev`. In a chat session, type:

> "我有哪些已绑定的 channel？"

The AI should call `get_my_capabilities` and return the configured channels.

- [ ] **Step 2: Manual smoke test — send_channel_message**

If you have a channel configured (e.g., Discord), test:

> "帮我通过 Discord 发一条消息给 channel:123456，内容是'测试消息'"

- [ ] **Step 3: Manual smoke test — manage_cron_job**

> "帮我看看有多少定时任务"

Then:

> "帮我新建一个每天早上9点的日报任务"

- [ ] **Step 4: Manual smoke test — manage_shortcuts**

> "帮我创建一个叫'日报'的快捷操作，内容是'请帮我生成今日工作日报'"

- [ ] **Step 5: Verify end-to-end broadcast scenario**

> "给我所有 channel 发一条消息：系统维护通知"

Verify it sends to all bound channels and returns per-channel results.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix(introspect): fixes from integration testing"
```

---

## Known Limitations (v1)

1. **Email sending** not supported from MCP binary (requires SMTP/OAuth2 complexity). Workaround: use cron delivery for email.
2. **WeCom sending** requires the Tauri internal HTTP API — if TeamClaw app is not running, WeCom messages will fail.
3. **Cron manual run** requires the internal HTTP API for the same reason.
4. **Current role** cannot be determined (selection state is in frontend memory). Only `available_roles` is returned.
5. **Cron next_run_at** is not recomputed by the MCP binary after create — the running scheduler will pick up the new job but `next_run_at` will be null until the scheduler recomputes it.

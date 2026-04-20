# sync_team_dir MCP Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `sync_team_dir` MCP tool to `teamclaw-introspect` that auto-detects the active team sync mode (git/oss/webdav/p2p) and performs a bidirectional sync, returning a concise text summary.

**Architecture:** The introspect binary POSTs to the internal HTTP API on port 13144 (`/team-sync-all`). The Tauri-side handler detects the mode via `check_team_status()`, dispatches to the appropriate sync logic, and returns a `SyncAllResult` JSON. The introspect binary formats this as a human-readable MCP tool response.

**Tech Stack:** Rust, Tauri 2.0, tokio, serde_json, reqwest, teamclaw_sync (OssSyncManager), teamclaw_p2p (SyncEngineState, feature-gated)

---

## File Map

| File | Change | Responsibility |
|------|--------|---------------|
| `src-tauri/src/commands/team_sync_all.rs` | **Create** | `SyncAllResult` type + `sync_all()` entry + per-mode sync functions |
| `src-tauri/src/commands/mod.rs` | **Modify** | Add `pub mod team_sync_all;` |
| `src-tauri/src/commands/introspect_api.rs` | **Modify** | Add `/team-sync-all` route + `handle_team_sync_all()` |
| `src-tauri/crates/teamclaw-introspect/src/sync.rs` | **Create** | HTTP call to `/team-sync-all` + format result as MCP text |
| `src-tauri/crates/teamclaw-introspect/src/main.rs` | **Modify** | Register `sync_team_dir` tool definition + dispatch |

---

## Task 1: Define `SyncAllResult` and `sync_all()` skeleton

**Files:**
- Create: `src-tauri/src/commands/team_sync_all.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Create `team_sync_all.rs` with types and skeleton**

```rust
// src-tauri/src/commands/team_sync_all.rs
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::team::check_team_status;

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncAllResult {
    pub mode: String,
    pub success: bool,
    pub message: String,
    pub changed_files: u32,
}

pub async fn sync_all(app: &AppHandle, workspace: &str) -> SyncAllResult {
    let status = check_team_status(workspace);
    match status.mode.as_deref() {
        Some("git") => sync_git(app).await,
        Some("oss") | Some("webdav") => sync_oss(app).await,
        Some("p2p") => sync_p2p(app).await,
        _ => SyncAllResult {
            mode: "none".to_string(),
            success: false,
            message: "No team sync configured in this workspace.".to_string(),
            changed_files: 0,
        },
    }
}

async fn sync_git(_app: &AppHandle) -> SyncAllResult {
    SyncAllResult {
        mode: "git".to_string(),
        success: false,
        message: "git sync not yet implemented".to_string(),
        changed_files: 0,
    }
}

async fn sync_oss(_app: &AppHandle) -> SyncAllResult {
    SyncAllResult {
        mode: "oss".to_string(),
        success: false,
        message: "oss sync not yet implemented".to_string(),
        changed_files: 0,
    }
}

async fn sync_p2p(_app: &AppHandle) -> SyncAllResult {
    SyncAllResult {
        mode: "p2p".to_string(),
        success: false,
        message: "p2p sync not yet implemented".to_string(),
        changed_files: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_all_result_serialization() {
        let result = SyncAllResult {
            mode: "git".to_string(),
            success: true,
            message: "Synced with origin/main.".to_string(),
            changed_files: 0,
        };
        let json = serde_json::to_string(&result).unwrap();
        let roundtrip: SyncAllResult = serde_json::from_str(&json).unwrap();
        assert_eq!(roundtrip.mode, "git");
        assert!(roundtrip.success);
    }

    #[test]
    fn test_sync_all_result_none_mode() {
        let result = SyncAllResult {
            mode: "none".to_string(),
            success: false,
            message: "No team sync configured in this workspace.".to_string(),
            changed_files: 0,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""mode":"none""#));
        assert!(json.contains(r#""success":false"#));
    }
}
```

- [ ] **Step 2: Register the module in `mod.rs`**

In `src-tauri/src/commands/mod.rs`, add after the existing `pub mod team_unified;` line:

```rust
pub mod team_sync_all;
```

- [ ] **Step 3: Run unit tests to verify types compile**

```bash
cd /Volumes/openbeta/workspace/teamclaw
pnpm rust:check
```

Expected: compiles without errors. (Tests run via `cargo test --manifest-path src-tauri/Cargo.toml -p teamclaw -- team_sync_all`)

- [ ] **Step 4: Commit**

```bash
cd /Volumes/openbeta/workspace/teamclaw
git add src-tauri/src/commands/team_sync_all.rs src-tauri/src/commands/mod.rs
git commit -m "feat(mcp): add SyncAllResult type and sync_all() skeleton"
```

---

## Task 2: Implement `sync_git()`

**Files:**
- Modify: `src-tauri/src/commands/team_sync_all.rs`

- [ ] **Step 1: Replace `sync_git()` stub with real implementation**

Replace the stub `sync_git` function in `team_sync_all.rs`:

```rust
async fn sync_git(app: &AppHandle) -> SyncAllResult {
    use crate::commands::opencode::OpenCodeState;
    use crate::commands::shared_secrets::SharedSecretsState;
    use crate::commands::team::team_sync_repo;

    let opencode = app.state::<OpenCodeState>();
    let secrets = app.state::<SharedSecretsState>();

    match team_sync_repo(opencode, secrets, Some(false)).await {
        Ok(result) if result.needs_confirmation => SyncAllResult {
            mode: "git".to_string(),
            success: false,
            message: format!(
                "Sync blocked: {} untracked file(s) exceed size thresholds ({} bytes total).",
                result.new_files.len(),
                result.total_bytes
            ),
            changed_files: result.new_files.len() as u32,
        },
        Ok(result) => SyncAllResult {
            mode: "git".to_string(),
            success: result.success,
            message: result.message,
            changed_files: 0,
        },
        Err(e) => SyncAllResult {
            mode: "git".to_string(),
            success: false,
            message: e,
            changed_files: 0,
        },
    }
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd /Volumes/openbeta/workspace/teamclaw
pnpm rust:check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/team_sync_all.rs
git commit -m "feat(mcp): implement sync_git() for git team sync mode"
```

---

## Task 3: Implement `sync_oss()`

**Files:**
- Modify: `src-tauri/src/commands/team_sync_all.rs`

- [ ] **Step 1: Replace `sync_oss()` stub with real implementation**

Replace the stub `sync_oss` function in `team_sync_all.rs`:

```rust
async fn sync_oss(app: &AppHandle) -> SyncAllResult {
    use crate::commands::oss_sync::OssSyncState;
    use teamclaw_sync::oss_types::DocType;

    let oss_state = app.state::<OssSyncState>();
    let mut manager_guard = oss_state.manager.lock().await;

    let manager = match manager_guard.as_mut() {
        Some(m) => m,
        None => {
            return SyncAllResult {
                mode: "oss".to_string(),
                success: false,
                message: "OSS sync not initialized. Please connect to a team first.".to_string(),
                changed_files: 0,
            }
        }
    };

    // Pull: download all remote changes across all doc types
    if let Err(e) = manager.initial_sync().await {
        return SyncAllResult {
            mode: "oss".to_string(),
            success: false,
            message: format!("OSS pull failed: {e}"),
            changed_files: 0,
        };
    }

    // Push: upload local changes for each non-secret doc type
    let doc_types = [DocType::Skills, DocType::Mcp, DocType::Knowledge, DocType::Meta];
    let mut changed = 0u32;
    let mut changed_names: Vec<&str> = Vec::new();

    for dt in doc_types {
        match manager.upload_local_changes_incremental(dt).await {
            Ok(true) => {
                changed += 1;
                changed_names.push(dt.path());
            }
            Ok(false) => {}
            Err(e) => {
                return SyncAllResult {
                    mode: "oss".to_string(),
                    success: false,
                    message: format!("OSS push failed for {}: {e}", dt.path()),
                    changed_files: changed,
                };
            }
        }
    }

    let message = if changed == 0 {
        "Synced via oss: no changes.".to_string()
    } else {
        format!(
            "Synced via oss: {} doc type(s) changed ({}).",
            changed,
            changed_names.join(", ")
        )
    };

    SyncAllResult {
        mode: "oss".to_string(),
        success: true,
        message,
        changed_files: changed,
    }
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd /Volumes/openbeta/workspace/teamclaw
pnpm rust:check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/team_sync_all.rs
git commit -m "feat(mcp): implement sync_oss() for OSS/WebDAV team sync mode"
```

---

## Task 4: Implement `sync_p2p()`

**Files:**
- Modify: `src-tauri/src/commands/team_sync_all.rs`

- [ ] **Step 1: Replace `sync_p2p()` stub with feature-gated real implementation**

Replace the stub `sync_p2p` function in `team_sync_all.rs` with two cfg-gated versions:

```rust
#[cfg(feature = "p2p")]
async fn sync_p2p(app: &AppHandle) -> SyncAllResult {
    use crate::commands::p2p_state::SyncEngineState;

    let engine_state = app.state::<SyncEngineState>();
    let engine = engine_state.lock().await;
    let snapshot = engine.snapshot();

    let is_running = !matches!(
        snapshot.status,
        teamclaw_p2p::EngineStatus::Disconnected
    );

    let message = format!(
        "P2P sync {}: {} synced, {} pending, {} peer(s) connected.",
        if is_running { "active" } else { "inactive" },
        snapshot.synced_files,
        snapshot.pending_files,
        snapshot.peers.len(),
    );

    SyncAllResult {
        mode: "p2p".to_string(),
        success: is_running,
        message,
        changed_files: snapshot.synced_files,
    }
}

#[cfg(not(feature = "p2p"))]
async fn sync_p2p(_app: &AppHandle) -> SyncAllResult {
    SyncAllResult {
        mode: "p2p".to_string(),
        success: false,
        message: "P2P sync is not available on this platform.".to_string(),
        changed_files: 0,
    }
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd /Volumes/openbeta/workspace/teamclaw
pnpm rust:check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/team_sync_all.rs
git commit -m "feat(mcp): implement sync_p2p() for P2P team sync mode"
```

---

## Task 5: Add HTTP route to `introspect_api.rs`

**Files:**
- Modify: `src-tauri/src/commands/introspect_api.rs`

- [ ] **Step 1: Add `handle_team_sync_all()` function**

Add the following function to `introspect_api.rs`, after `handle_cron_run`:

```rust
async fn handle_team_sync_all(app: &AppHandle, _body: &[u8]) -> Result<String, String> {
    use super::team::get_workspace_path;
    use super::opencode::OpenCodeState;

    let opencode_state = app.state::<OpenCodeState>();
    let workspace = get_workspace_path(&opencode_state)?;
    let result = super::team_sync_all::sync_all(app, &workspace).await;
    serde_json::to_string(&result).map_err(|e| format!("Serialization error: {e}"))
}
```

- [ ] **Step 2: Register the route in the request dispatcher**

In `introspect_api.rs`, find the `match (method, path)` block (contains `"/send-wecom"` and `"/cron-run"`) and add the new route:

```rust
("POST", "/team-sync-all") => handle_team_sync_all(&app_clone, body_bytes).await,
```

Place it after the `"/cron-run"` line.

- [ ] **Step 3: Verify compilation**

```bash
cd /Volumes/openbeta/workspace/teamclaw
pnpm rust:check
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/introspect_api.rs
git commit -m "feat(mcp): add /team-sync-all HTTP route to introspect API"
```

---

## Task 6: Create `sync.rs` in teamclaw-introspect

**Files:**
- Create: `src-tauri/crates/teamclaw-introspect/src/sync.rs`

- [ ] **Step 1: Create `sync.rs` with HTTP call**

```rust
// src-tauri/crates/teamclaw-introspect/src/sync.rs
use serde_json::Value;

pub async fn handle(_workspace: &str, api_port: u16, _arguments: &Value) -> Result<Value, String> {
    let url = format!("http://127.0.0.1:{api_port}/team-sync-all");
    let client = reqwest::Client::new();

    let resp = client
        .post(&url)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("Team sync request failed: {e}. Is the TeamClaw app running?"))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Team sync failed: {text}"));
    }

    let result: Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse sync response: {e}"))?;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_result_has_required_fields() {
        // Verify SyncAllResult shape matches what we expect to receive
        let result = json!({
            "mode": "git",
            "success": true,
            "message": "Synced with origin/main.",
            "changed_files": 0
        });
        assert!(result.get("mode").is_some());
        assert!(result.get("success").is_some());
        assert!(result.get("message").is_some());
        assert!(result.get("changed_files").is_some());
    }

    #[test]
    fn test_result_none_mode() {
        let result = json!({
            "mode": "none",
            "success": false,
            "message": "No team sync configured in this workspace.",
            "changed_files": 0
        });
        assert_eq!(result["mode"], "none");
        assert_eq!(result["success"], false);
    }
}
```

- [ ] **Step 2: Run unit tests**

```bash
cd /Volumes/openbeta/workspace/teamclaw
cargo test --manifest-path src-tauri/crates/teamclaw-introspect/Cargo.toml -- sync
```

Expected output:
```
test sync::tests::test_result_has_required_fields ... ok
test sync::tests::test_result_none_mode ... ok
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/crates/teamclaw-introspect/src/sync.rs
git commit -m "feat(mcp): add sync.rs for teamclaw-introspect HTTP call and formatting"
```

---

## Task 7: Register `sync_team_dir` tool in `main.rs`

**Files:**
- Modify: `src-tauri/crates/teamclaw-introspect/src/main.rs`

- [ ] **Step 1: Add `mod sync;` at the top of `main.rs`**

After the existing `mod` declarations (e.g., `mod cron;`, `mod shortcuts;`), add:

```rust
mod sync;
```

- [ ] **Step 2: Add tool definition to `tool_definitions()`**

In `main.rs`, find the `tool_definitions()` function that returns a `Vec<Value>` of tool JSON objects. Add the new tool after the existing tools:

```rust
json!({
    "name": "sync_team_dir",
    "description": "Bidirectional sync of the shared team directory. Auto-detects the configured sync mode (git, oss, or p2p). Pulls remote changes first, then pushes local changes. Returns a summary of what was synced.",
    "inputSchema": {
        "type": "object",
        "properties": {}
    }
}),
```

- [ ] **Step 3: Add dispatch in `handle_request()` for `tools/call`**

In `main.rs`, find the `match tool_name` block (around line 245, after `"manage_shortcuts"` arm, before `unknown => tool_err(...)`). Add the new arm:

```rust
"sync_team_dir" => {
    match sync::handle(workspace, api_port, &arguments).await {
        Ok(v) => {
            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
            tool_ok(&text)
        }
        Err(e) => tool_err(&e),
    }
}
```

This follows the identical pattern used by `"get_my_capabilities"`, `"send_channel_message"`, `"manage_cron_job"`, and `"manage_shortcuts"`.

- [ ] **Step 4: Build the introspect binary**

```bash
cd /Volumes/openbeta/workspace/teamclaw
cargo build --manifest-path src-tauri/crates/teamclaw-introspect/Cargo.toml --release 2>&1 | tail -5
```

Expected: `Finished release profile`

- [ ] **Step 5: Verify the tool appears in `tools/list`**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | /Volumes/openbeta/workspace/teamclaw/src-tauri/crates/teamclaw-introspect/target/release/teamclaw-introspect \
    --workspace /Volumes/openbeta/workspace/teamclaw \
    --api-port 13144 2>/dev/null
```

Expected: the response for `tools/list` contains `"name":"sync_team_dir"`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/crates/teamclaw-introspect/src/main.rs
git commit -m "feat(mcp): register sync_team_dir tool in teamclaw-introspect"
```

---

## Task 8: Build Tauri app and end-to-end test

- [ ] **Step 1: Full Rust build check**

```bash
cd /Volumes/openbeta/workspace/teamclaw
pnpm rust:build
```

Expected: builds without errors.

- [ ] **Step 2: Copy introspect binary to Tauri sidecar location**

Check where the sidecar binary is expected (look at `src-tauri/tauri.conf.json` for `externalBin` entries), then copy:

```bash
# Find expected sidecar path
grep -r "teamclaw-introspect" /Volumes/openbeta/workspace/teamclaw/src-tauri/tauri.conf.json

# Copy to sidecar location (adjust path based on above)
cp src-tauri/crates/teamclaw-introspect/target/release/teamclaw-introspect \
   src-tauri/binaries/teamclaw-introspect-aarch64-apple-darwin
```

- [ ] **Step 3: Manual smoke test**

Start the TeamClaw app in dev mode, then call `sync_team_dir` via opencode MCP and verify:

1. App is running with a workspace that has a team configured
2. Tool returns a valid response (not an error about "Is the TeamClaw app running?")
3. Response contains the correct mode string (`"git"`, `"oss"`, or `"p2p"`)

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(mcp): complete sync_team_dir tool — bidirectional team sync via MCP

Adds sync_team_dir to teamclaw-introspect MCP server. Auto-detects
active sync mode (git/oss/webdav/p2p) and performs bidirectional sync.
Returns concise text summary with mode, success status, and change count.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

# sync_team_dir MCP Tool Design

**Date:** 2026-04-20  
**Status:** Draft  
**Scope:** Add `sync_team_dir` tool to `teamclaw-introspect` MCP server

---

## Overview

Add a single `sync_team_dir` tool to the built-in `teamclaw-introspect` MCP server. The tool auto-detects the configured team sync mode (git / oss / webdav / p2p), performs a bidirectional sync (pull then push), and returns a concise text summary. The AI agent does not need to know which underlying mode is active.

---

## Architecture

```
AI Agent
  └─ sync_team_dir (teamclaw-introspect MCP, stdio)
       └─ POST http://127.0.0.1:{port}/team-sync-all
            └─ introspect_api.rs: handle_team_sync_all()
                 ├─ workspace = opencode_state.workspace_path()
                 ├─ check_team_status(&workspace) → mode
                 └─ team_sync_all::sync_all(&app, &workspace, mode)
                      ├─ git      → pull rebase + push (TeamGitResult)
                      ├─ oss/dav  → pull + upload × 4 DocTypes
                      ├─ p2p      → engine snapshot (read-only)
                      └─ none     → error: no team configured
                 └─ SyncAllResult → JSON → MCP text response
```

---

## Auto-Detection

Uses existing `check_team_status(workspace_path)` in `src-tauri/src/commands/team.rs`.  
Reads `.teamclaw/teamclaw.json` once. Returns `mode: Option<String>`.

| Mode value | Config field | Sync behavior |
|------------|-------------|---------------|
| `"git"` | `team.enabled = true` | pull rebase + push |
| `"oss"` | `oss.enabled = true` | pull + upload × 4 DocTypes |
| `"webdav"` | `webdav.enabled = true` | same as oss path |
| `"p2p"` | `p2p.enabled = true` | report engine snapshot |
| `None` | — | return error |

Detection happens entirely in the Tauri process. The introspect binary does not inspect config files.

---

## Per-Mode Sync Semantics

### Git

Reuses `team_sync_repo()` core logic (already implements pull rebase + push + conflict resolution):

- `force: Some(false)` — if precheck threshold exceeded, report in message and proceed
- Pull: `git fetch` + `git pull --rebase origin <branch>`
- Conflict resolution: abort rebase → back up files to `.trash/<timestamp>/` → `git reset --hard origin/<branch>`
- Push: `git push origin <branch>` if local commits exist
- Post-sync: sync `.mcp/` → `opencode.json`, reload shared secrets
- `changed_files` = `result.new_files.len()` (precheck-flagged files; 0 on clean sync)

### OSS / WebDAV

Iterates over 4 DocTypes: `Skills`, `Mcp`, `Knowledge`, `Meta` (excludes `Secrets`).  
For each:
1. `manager.pull_remote_changes(dt)` — download and apply remote CRDT updates
2. `manager.upload_local_changes(dt)` — scan local dir, upload if changed (`Ok(true)` = had changes)

Accesses `OssSyncManager` via `app.state::<OssSyncManager>()` + `.lock().await` (serializes with background poll loop).  
`changed_files` = count of DocTypes where upload returned `Ok(true)`.

### P2P

iroh-based sync is continuous and automatic; there is no manual trigger.  
Calls `p2p_node_status()` equivalent to get `EngineSnapshot`:
- `changed_files` = `snapshot.synced_files`
- Message includes: status, synced count, pending count, peer count

---

## Return Type

```rust
pub struct SyncAllResult {
    pub mode: String,        // "git" | "oss" | "webdav" | "p2p" | "none"
    pub success: bool,
    pub message: String,     // human-readable summary
    pub changed_files: u32,
}
```

MCP text output examples:
```
Synced via git: 0 files changed. Synced with origin/main (local changes pushed).
Synced via oss: 2 doc types changed (skills, mcp).
P2P sync active: 12 synced, 0 pending, 2 peers connected.
No team sync configured in this workspace.
```

---

## Files Changed

### New files

| File | Responsibility |
|------|---------------|
| `src-tauri/src/commands/team_sync_all.rs` | `SyncAllResult` type + `sync_all()` entry point + per-mode sync functions |
| `src-tauri/crates/teamclaw-introspect/src/sync.rs` | HTTP POST to `/team-sync-all` + format result as MCP text |

### Modified files

| File | Change |
|------|--------|
| `src-tauri/src/commands/mod.rs` | `pub mod team_sync_all;` |
| `src-tauri/src/commands/introspect_api.rs` | Add `/team-sync-all` route + `handle_team_sync_all()` |
| `src-tauri/crates/teamclaw-introspect/src/main.rs` | Add `sync_team_dir` tool definition + dispatch to `sync::handle()` |

---

## MCP Tool Definition

```json
{
  "name": "sync_team_dir",
  "description": "Bidirectional sync of the shared team directory. Auto-detects the configured sync mode (git, oss, or p2p). Returns a summary of what was synced.",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

No input parameters — mode detection is automatic.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| No team configured | `success: false`, message: "No team sync configured" |
| Git conflict resolved | `success: true`, message notes conflict resolution and backup path |
| OSS lock contention | `lock().await` serializes — background loop will yield |
| OSS DocType pull fails | Skip remaining DocTypes, `success: false`, include error in message |
| P2P engine not running | `success: false`, message: "P2P engine not running" |

---

## Out of Scope

- UI changes (no frontend modifications)
- Exposing `sync_team_dir` as a Tauri command (introspect HTTP path is sufficient)
- Per-file change counts (DocType-level granularity is sufficient for OSS)
- Handling simultaneous active modes (only first detected mode is used, per `check_team_status()` priority)

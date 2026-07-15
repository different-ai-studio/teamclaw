use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tauri::State;

use crate::commands::mcp::{self, MCPServerConfig};

// Re-export for backward compat (other modules use `crate::commands::team::TEAM_REPO_DIR`)
pub use super::TEAM_REPO_DIR;

// Re-export types that moved to sub-modules but are still referenced via `team::`.
pub use crate::commands::team_git::{
    TeamGitCreateResult, TeamGitResult, TeamMeta, WorkspaceGitCheckResult,
};

// ─── Types ───────────────────────────────────────────────────────────────────

/// Git team configuration stored in .teamclaw/teamclaw.json under "team".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamConfig {
    pub git_url: String,
    pub enabled: bool,
    pub last_sync_at: Option<String>,
    #[serde(default = "default_shared_dir_name")]
    pub shared_dir_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fc_endpoint: Option<String>,
}

fn default_shared_dir_name() -> String {
    "teamclaw".to_string()
}

// ─── MCP Sync ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TeamMCPFile {
    #[serde(rename = "mcpServers", default)]
    mcp_servers: HashMap<String, TeamMCPServer>,
}

#[derive(Debug, Deserialize)]
struct TeamMCPServer {
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    url: Option<String>,
    headers: Option<HashMap<String, String>>,
}

/// Scan .mcp/*.json from a directory and merge into opencode.json's mcp section.
/// Team MCP servers are added/updated but never remove existing user-configured servers.
/// Returns the number of servers synced.
pub fn sync_team_mcp_configs_from_dir(
    mcp_source_dir: &str,
    workspace_path: &str,
) -> Result<usize, String> {
    let mcp_dir = Path::new(mcp_source_dir).join(".mcp");

    if !mcp_dir.exists() || !mcp_dir.is_dir() {
        return Ok(0);
    }

    let entries = std::fs::read_dir(&mcp_dir)
        .map_err(|e| format!("Failed to read .mcp/ directory: {}", e))?;

    let mut team_servers: IndexMap<String, MCPServerConfig> = IndexMap::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();

        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                println!("[Team MCP Sync] Failed to read {}: {}", path.display(), e);
                continue;
            }
        };

        let team_file: TeamMCPFile = match serde_json::from_str(&content) {
            Ok(f) => f,
            Err(e) => {
                println!("[Team MCP Sync] Failed to parse {}: {}", path.display(), e);
                continue;
            }
        };

        for (name, server) in team_file.mcp_servers {
            let opencode_config = convert_team_server_to_opencode(&server);
            team_servers.insert(name, opencode_config);
        }
    }

    if team_servers.is_empty() {
        return Ok(0);
    }

    let count = team_servers.len();

    let mut config = mcp::read_config(workspace_path)?;
    let mut mcp_map = config.mcp.unwrap_or_default();

    for (name, server_config) in team_servers {
        mcp_map.insert(name, server_config);
    }

    config.mcp = Some(mcp_map);
    mcp::write_config(workspace_path, &config)?;

    Ok(count)
}

/// Scan .mcp/*.json from the workspace and merge into opencode.json (legacy path).
#[allow(dead_code)]
pub fn sync_team_mcp_configs(workspace_path: &str) -> Result<usize, String> {
    sync_team_mcp_configs_from_dir(workspace_path, workspace_path)
}

fn convert_team_server_to_opencode(server: &TeamMCPServer) -> MCPServerConfig {
    if server.url.is_some() {
        MCPServerConfig {
            server_type: "remote".to_string(),
            enabled: Some(true),
            command: None,
            environment: None,
            url: server.url.clone(),
            headers: server
                .headers
                .as_ref()
                .map(|h| h.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
            timeout: None,
        }
    } else {
        let mut cmd: Vec<String> = Vec::new();
        if let Some(ref command) = server.command {
            cmd.push(command.clone());
        }
        if let Some(ref args) = server.args {
            cmd.extend(args.clone());
        }

        MCPServerConfig {
            server_type: "local".to_string(),
            enabled: Some(true),
            command: if cmd.is_empty() { None } else { Some(cmd) },
            environment: server
                .env
                .as_ref()
                .map(|e| e.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
            url: None,
            headers: None,
            timeout: None,
        }
    }
}

// ─── Workspace Helpers ───────────────────────────────────────────────────────

/// Get the workspace path for the calling window.
pub fn get_workspace_path(
    window: &tauri::WebviewWindow,
    registry: &crate::commands::window::WindowRegistry,
) -> Result<String, String> {
    crate::commands::window::current_workspace_for_window(window, registry)
}

/// Resolve a workspace path from an explicit frontend argument when provided,
/// otherwise fall back to the calling window's registered workspace.
pub fn resolve_workspace_path(
    workspace_path: Option<String>,
    window: &tauri::WebviewWindow,
    registry: &crate::commands::window::WindowRegistry,
) -> Result<String, String> {
    if let Some(path) = workspace_path.filter(|path| !path.is_empty()) {
        return Ok(path);
    }
    get_workspace_path(window, registry)
}

// ─── Config Helpers ──────────────────────────────────────────────────────────

pub fn read_workspace_config(workspace_path: &str) -> Result<serde_json::Value, String> {
    let config_path = Path::new(workspace_path)
        .join(crate::commands::TEAMCLAW_DIR)
        .join(super::CONFIG_FILE_NAME);

    if !config_path.exists() {
        return Ok(serde_json::json!({}));
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read {}: {}", super::CONFIG_FILE_NAME, e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {}", super::CONFIG_FILE_NAME, e))
}

pub fn write_workspace_config(
    workspace_path: &str,
    json: &serde_json::Value,
) -> Result<(), String> {
    let teamclaw_dir = Path::new(workspace_path).join(crate::commands::TEAMCLAW_DIR);
    std::fs::create_dir_all(&teamclaw_dir)
        .map_err(|e| format!("Failed to create {}: {}", super::TEAMCLAW_DIR, e))?;

    let config_path = teamclaw_dir.join(super::CONFIG_FILE_NAME);
    let content = serde_json::to_string_pretty(json)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write {}: {}", super::CONFIG_FILE_NAME, e))
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_team_config(
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<Option<TeamConfig>, String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    let json = read_workspace_config(&workspace_path)?;
    json.get("team")
        .cloned()
        .map(serde_json::from_value::<TeamConfig>)
        .transpose()
        .map_err(|e| format!("Failed to parse team config: {}", e))
}

/// Read `teamclaw-team/_meta/team.json` from the given workspace, if present.
#[tauri::command]
pub fn workspace_read_team_meta(workspace_path: String) -> Result<Option<TeamMeta>, String> {
    let meta_path = Path::new(&workspace_path)
        .join(TEAM_REPO_DIR)
        .join("_meta")
        .join("team.json");
    if !meta_path.exists() {
        return Ok(None);
    }
    let content = match std::fs::read_to_string(&meta_path) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    match serde_json::from_str::<TeamMeta>(&content) {
        Ok(meta) => Ok(Some(meta)),
        Err(_) => Ok(None),
    }
}

/// Delete the `teamclaw-team/` directory inside `workspace_path`.
#[tauri::command]
pub fn workspace_delete_team_repo(workspace_path: String) -> Result<(), String> {
    crate::commands::team_share::disconnect::remove_workspace_team_repo_entry(&workspace_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn team_config_accepts_legacy_team_id_but_does_not_serialize_it() {
        let config: TeamConfig = serde_json::from_value(serde_json::json!({
            "gitUrl": "https://example.com/shared.git",
            "enabled": true,
            "lastSyncAt": null,
            "sharedDirName": "teamclaw",
            "envSecret": "secret",
            "gitToken": "token",
            "gitBranch": "main",
            "teamId": "legacy-team-id"
        }))
        .unwrap();

        let value = serde_json::to_value(config).unwrap();
        assert_eq!(value["gitUrl"], "https://example.com/shared.git");
        assert_eq!(value["gitBranch"], "main");
        assert_eq!(value["gitToken"], "token");
        assert!(value.get("teamId").is_none());
    }
}

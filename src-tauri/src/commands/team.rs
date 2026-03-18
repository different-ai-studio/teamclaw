use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use tauri::State;

use crate::commands::mcp::{self, MCPServerConfig};
use crate::commands::opencode::OpenCodeState;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Team configuration stored in teamclaw.json
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamConfig {
    pub git_url: String,
    pub enabled: bool,
    pub last_sync_at: Option<String>,
    /// Personal Access Token for HTTPS authentication (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_token: Option<String>,
}

/// Result of a git operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamGitResult {
    pub success: bool,
    pub message: String,
}

/// Result of git availability check
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCheckResult {
    pub installed: bool,
    pub version: Option<String>,
}

/// Result of workspace git check
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitCheckResult {
    pub has_git: bool,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Run a git command in a given directory
fn run_git(args: &[&str], cwd: &str) -> Result<(bool, String, String), String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0") // Never prompt for credentials interactively
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

/// Embed a Personal Access Token into an HTTPS git URL.
/// - `https://git.garena.com/path` → `https://oauth2:TOKEN@git.garena.com/path`
/// - SSH URLs are returned as-is (they don't use tokens).
fn embed_token_in_url(url: &str, token: &str) -> String {
    if token.is_empty() {
        return url.to_string();
    }
    // Handle https:// URLs
    if let Some(rest) = url.strip_prefix("https://") {
        // If there's already a user@ prefix, replace or inject password
        if let Some(at_pos) = rest.find('@') {
            let user_part = &rest[..at_pos];
            let host_part = &rest[at_pos + 1..];
            if user_part.contains(':') {
                // Already has user:password — replace password
                let user = user_part.split(':').next().unwrap_or("oauth2");
                format!("https://{}:{}@{}", user, token, host_part)
            } else {
                // Has user but no password — add token as password
                format!("https://{}:{}@{}", user_part, token, host_part)
            }
        } else {
            // No credentials at all — add oauth2:token
            format!("https://oauth2:{}@{}", token, rest)
        }
    } else if let Some(rest) = url.strip_prefix("http://") {
        if let Some(at_pos) = rest.find('@') {
            let user_part = &rest[..at_pos];
            let host_part = &rest[at_pos + 1..];
            let user = user_part.split(':').next().unwrap_or("oauth2");
            format!("http://{}:{}@{}", user, token, host_part)
        } else {
            format!("http://oauth2:{}@{}", token, rest)
        }
    } else {
        // SSH or other protocol — return as-is
        url.to_string()
    }
}

/// Check if a URL is an HTTPS URL
fn is_https_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// Get the workspace path from OpenCodeState
pub fn get_workspace_path(opencode_state: &OpenCodeState) -> Result<String, String> {
    opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.".to_string())
}

/// Read team config from teamclaw.json
fn read_team_config_from_file(workspace_path: &str) -> Result<Option<TeamConfig>, String> {
    let config_path = format!("{}/{}/teamclaw.json", workspace_path, crate::commands::TEAMCLAW_DIR);

    if !Path::new(&config_path).exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read teamclaw.json: {}", e))?;

    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse teamclaw.json: {}", e))?;

    match json.get("team") {
        Some(team_val) => {
            let team: TeamConfig = serde_json::from_value(team_val.clone())
                .map_err(|e| format!("Failed to parse team config: {}", e))?;
            Ok(Some(team))
        }
        None => Ok(None),
    }
}

/// Write team config to teamclaw.json (preserving other fields)
fn write_team_config_to_file(
    workspace_path: &str,
    team: Option<&TeamConfig>,
) -> Result<(), String> {
    let teamclaw_dir = format!("{}/{}", workspace_path, crate::commands::TEAMCLAW_DIR);
    let _ = std::fs::create_dir_all(&teamclaw_dir);
    let config_path = format!("{}/teamclaw.json", teamclaw_dir);

    // Read existing config or create empty object
    let mut json: serde_json::Value = if Path::new(&config_path).exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read teamclaw.json: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse teamclaw.json: {}", e))?
    } else {
        serde_json::json!({
            "$schema": "https://opencode.ai/config.json"
        })
    };

    // Update or remove team field
    if let Some(team_config) = team {
        let team_val = serde_json::to_value(team_config)
            .map_err(|e| format!("Failed to serialize team config: {}", e))?;
        json.as_object_mut()
            .ok_or("teamclaw.json is not an object")?
            .insert("team".to_string(), team_val);
    } else {
        json.as_object_mut()
            .ok_or("teamclaw.json is not an object")?
            .remove("team");
    }

    let content = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write teamclaw.json: {}", e))
}

/// Subfolder inside workspace where the team repo is cloned (not workspace root)
pub const TEAM_REPO_DIR: &str = "teamclaw-team";

fn get_team_repo_path(workspace_path: &str) -> String {
    let p = Path::new(workspace_path).join(TEAM_REPO_DIR);
    p.to_string_lossy().to_string()
}

/// Default teamclaw.yaml content for new team repos
pub const DEFAULT_TEAMCLAW_YAML: &str = r#"llm:
  baseUrl: "https://ai.ucar.cc/v1"
  model: "default"
  modelName: "default"
"#;

/// The whitelist .gitignore content
const GITIGNORE_CONTENT: &str = r#"# ============================================
# TeamClaw Workspace — Whitelist mode
# Ignore everything by default, only allow shared layer
# ============================================

# 1. Ignore all files by default
*

# 2. Allow shared layer: skills
!skills/
!skills/**

# 3. Allow shared layer: MCP config
!.mcp/
!.mcp/**

# 4. Allow shared layer: knowledge base
!knowledge/
!knowledge/**

# 5. Allow workspace config
!teamclaw.yaml
!.gitignore

# 6. Allow Git collaboration config (team mode)
!.github/
!.github/**
"#;

// ─── Team MCP Sync ──────────────────────────────────────────────────────────

/// Team MCP config format (Cursor / standard MCP format)
/// Each .json file in .mcp/ contains:
/// ```json
/// {
///   "mcpServers": {
///     "name": {
///       "command": "npx",
///       "args": ["@playwright/mcp@latest"],
///       "env": { "KEY": "value" }
///     }
///   }
/// }
/// ```
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

/// Scan .mcp/*.json from a directory and merge into opencode.json's mcp section (in workspace).
/// Team MCP servers are added/updated but never remove existing user-configured servers.
/// Returns the number of servers synced.
fn sync_team_mcp_configs_from_dir(
    mcp_source_dir: &str,
    workspace_path: &str,
) -> Result<usize, String> {
    let mcp_dir = Path::new(mcp_source_dir).join(".mcp");

    if !mcp_dir.exists() || !mcp_dir.is_dir() {
        return Ok(0); // No .mcp directory — nothing to sync
    }

    // Read all .json files from .mcp/
    let entries = std::fs::read_dir(&mcp_dir)
        .map_err(|e| format!("Failed to read .mcp/ directory: {}", e))?;

    let mut team_servers: IndexMap<String, MCPServerConfig> = IndexMap::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();

        // Only process .json files
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                println!(
                    "[Team MCP Sync] Failed to read {}: {}",
                    path.display(),
                    e
                );
                continue;
            }
        };

        let team_file: TeamMCPFile = match serde_json::from_str(&content) {
            Ok(f) => f,
            Err(e) => {
                println!(
                    "[Team MCP Sync] Failed to parse {}: {}",
                    path.display(),
                    e
                );
                continue;
            }
        };

        // Convert each team server to OpenCode MCPServerConfig
        for (name, server) in team_file.mcp_servers {
            let opencode_config = convert_team_server_to_opencode(&server);
            team_servers.insert(name, opencode_config);
        }
    }

    if team_servers.is_empty() {
        return Ok(0);
    }

    let count = team_servers.len();

    // Read existing opencode.json config (in workspace) and merge team servers into it
    let mut config = mcp::read_config(workspace_path)?;
    let mut mcp_map = config.mcp.unwrap_or_default();

    // Merge team servers — add or update, never remove existing user servers
    for (name, server_config) in team_servers {
        mcp_map.insert(name, server_config);
    }

    config.mcp = Some(mcp_map);
    mcp::write_config(workspace_path, &config)?;

    Ok(count)
}

/// Scan .mcp/*.json from the workspace and merge into opencode.json (legacy: when team repo was at workspace root).
pub fn sync_team_mcp_configs(workspace_path: &str) -> Result<usize, String> {
    sync_team_mcp_configs_from_dir(workspace_path, workspace_path)
}

/// Convert a team MCP server config to OpenCode format
fn convert_team_server_to_opencode(server: &TeamMCPServer) -> MCPServerConfig {
    // Determine if this is a local or remote server
    if server.url.is_some() {
        // Remote server
        MCPServerConfig {
            server_type: "remote".to_string(),
            enabled: Some(true),
            command: None,
            environment: None,
            url: server.url.clone(),
            headers: server.headers.as_ref().map(|h| h.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
            timeout: None,
        }
    } else {
        // Local server: combine command + args into a single command array
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
            environment: server.env.as_ref().map(|e| e.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
            url: None,
            headers: None,
            timeout: None,
        }
    }
}

// ─── Tauri Commands: Git Operations ─────────────────────────────────────────

/// 1.1 - Check if git is installed on the system
#[tauri::command]
pub fn team_check_git_installed() -> Result<GitCheckResult, String> {
    match Command::new("git").args(["--version"]).output() {
        Ok(output) => {
            let success = output.status.success();
            let version = if success {
                Some(
                    String::from_utf8_lossy(&output.stdout)
                        .trim()
                        .to_string(),
                )
            } else {
                None
            };
            Ok(GitCheckResult {
                installed: success,
                version,
            })
        }
        Err(_) => Ok(GitCheckResult {
            installed: false,
            version: None,
        }),
    }
}

/// 1.2 - Check if workspace already has a .git directory
#[tauri::command]
pub async fn team_check_workspace_has_git(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<WorkspaceGitCheckResult, String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    let git_dir = Path::new(&workspace_path).join(".git");
    Ok(WorkspaceGitCheckResult {
        has_git: git_dir.exists(),
    })
}

/// 1.3 - Initialize team repo: clone into workspace/teamclaw-team (not workspace root)
#[tauri::command]
pub async fn team_init_repo(
    git_url: String,
    git_token: Option<String>,
    opencode_state: State<'_, OpenCodeState>,
) -> Result<TeamGitResult, String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    let team_dir = get_team_repo_path(&workspace_path);

    if Path::new(&team_dir).exists() {
        return Err(format!(
            "{} already exists. Remove it first or disconnect the team repo to re-initialize.",
            TEAM_REPO_DIR
        ));
    }

    // Build the remote URL: embed token for HTTPS URLs
    let remote_url = match &git_token {
        Some(token) if !token.is_empty() && is_https_url(&git_url) => {
            embed_token_in_url(&git_url, token)
        }
        _ => git_url.clone(),
    };

    // Clone into workspace/teamclaw-team (cwd = workspace, so clone creates teamclaw-team/)
    let (ok, _, stderr) = run_git(
        &["clone", &remote_url, TEAM_REPO_DIR],
        &workspace_path,
    )?;
    if !ok {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err(format!(
            "git clone failed (check URL and authentication): {}",
            stderr.trim()
        ));
    }

    // Write default teamclaw.yaml if the cloned repo doesn't have one
    let teamclaw_yaml_path = Path::new(&team_dir).join("teamclaw.yaml");
    if !teamclaw_yaml_path.exists() {
        std::fs::write(&teamclaw_yaml_path, DEFAULT_TEAMCLAW_YAML)
            .map_err(|e| format!("Failed to write default teamclaw.yaml: {}", e))?;
        println!("[Team Init] Created default teamclaw.yaml with team LLM config");

        // Commit the default config so it's shared with the team
        let _ = run_git(&["add", "teamclaw.yaml"], &team_dir);
        let _ = run_git(
            &["commit", "-m", "chore: add default team LLM configuration"],
            &team_dir,
        );
    }

    // Sync .mcp/ from team dir into workspace opencode.json
    match sync_team_mcp_configs_from_dir(&team_dir, &workspace_path) {
        Ok(count) if count > 0 => {
            println!("[Team Init] Synced {} MCP server(s) from .mcp/ to opencode.json", count);
        }
        Ok(_) => {}
        Err(e) => {
            println!("[Team Init] Warning: Failed to sync MCP configs: {}", e);
        }
    }

    Ok(TeamGitResult {
        success: true,
        message: format!(
            "Team repository cloned into {}/{}",
            workspace_path,
            TEAM_REPO_DIR
        ),
    })
}

/// 1.4 - Generate whitelist .gitignore in team repo dir (skip if remote already has one)
#[tauri::command]
pub async fn team_generate_gitignore(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<TeamGitResult, String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    let team_dir = get_team_repo_path(&workspace_path);
    let gitignore_path = Path::new(&team_dir).join(".gitignore");

    if gitignore_path.exists() {
        return Ok(TeamGitResult {
            success: true,
            message: ".gitignore already exists (from remote), skipping generation".to_string(),
        });
    }

    std::fs::write(&gitignore_path, GITIGNORE_CONTENT)
        .map_err(|e| format!("Failed to write .gitignore: {}", e))?;

    Ok(TeamGitResult {
        success: true,
        message: "Generated whitelist .gitignore".to_string(),
    })
}

/// 1.5 - Sync team repo: fetch + reset --hard (in workspace/teamclaw-team)
#[tauri::command]
pub async fn team_sync_repo(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<TeamGitResult, String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    let team_dir = get_team_repo_path(&workspace_path);

    let git_dir = Path::new(&team_dir).join(".git");
    if !git_dir.exists() {
        return Err(format!(
            "Team directory '{}' is not a git repository. Please clone or initialize it first.",
            team_dir
        ));
    }

    if let Ok(Some(config)) = read_team_config_from_file(&workspace_path) {
        if let Some(ref token) = config.git_token {
            if !token.is_empty() && is_https_url(&config.git_url) {
                let auth_url = embed_token_in_url(&config.git_url, token);
                let _ = run_git(
                    &["remote", "set-url", "origin", &auth_url],
                    &team_dir,
                );
            }
        }
    }

    let (ok, _, stderr) = run_git(&["fetch", "origin"], &team_dir)?;
    if !ok {
        return Err(format!("git fetch failed: {}", stderr.trim()));
    }

    let (ok, stdout, _) = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], &team_dir)?;
    let branch = if ok {
        stdout.trim().to_string()
    } else {
        "main".to_string()
    };

    let (ok, _, stderr) = run_git(
        &["reset", "--hard", &format!("origin/{}", branch)],
        &team_dir,
    )?;
    if !ok {
        return Err(format!("git reset failed: {}", stderr.trim()));
    }

    let mcp_msg = match sync_team_mcp_configs_from_dir(&team_dir, &workspace_path) {
        Ok(count) if count > 0 => {
            println!("[Team Sync] Synced {} MCP server(s) from .mcp/ to opencode.json", count);
            format!(". Synced {} MCP server(s)", count)
        }
        Ok(_) => String::new(),
        Err(e) => {
            println!("[Team Sync] Warning: Failed to sync MCP configs: {}", e);
            String::new()
        }
    };

    Ok(TeamGitResult {
        success: true,
        message: format!("Synced to latest origin/{}{}", branch, mcp_msg),
    })
}

/// 1.6 - Disconnect team repo: remove workspace/teamclaw-team directory
#[tauri::command]
pub async fn team_disconnect_repo(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<TeamGitResult, String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    let team_dir = get_team_repo_path(&workspace_path);

    if !Path::new(&team_dir).exists() {
        return Ok(TeamGitResult {
            success: true,
            message: "Team folder not found, already disconnected".to_string(),
        });
    }

    std::fs::remove_dir_all(&team_dir)
        .map_err(|e| format!("Failed to remove {}: {}", TEAM_REPO_DIR, e))?;

    Ok(TeamGitResult {
        success: true,
        message: "Team repository disconnected".to_string(),
    })
}

// ─── Tauri Commands: Config Management ──────────────────────────────────────

/// 2.2 - Get team config from teamclaw.json
#[tauri::command]
pub async fn get_team_config(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<Option<TeamConfig>, String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    read_team_config_from_file(&workspace_path)
}

/// 2.3 - Save team config to teamclaw.json
#[tauri::command]
pub async fn save_team_config(
    team: TeamConfig,
    opencode_state: State<'_, OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    write_team_config_to_file(&workspace_path, Some(&team))
}

/// 2.4 - Clear team config from teamclaw.json
#[tauri::command]
pub async fn clear_team_config(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    write_team_config_to_file(&workspace_path, None)
}

// NOTE: Startup team sync is triggered from the frontend after workspace is set,
// since workspace_path is not available at Tauri setup time.
// The frontend calls team_sync_repo on startup when team config is enabled.

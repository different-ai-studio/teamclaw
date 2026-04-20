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
    /// Git branch to sync (e.g. "main", "master", "dev"). If None, auto-detect.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    /// Team ID for shared secrets (generated on create, provided on join)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
}

/// A single model entry in the team LLM configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmModelEntry {
    pub id: String,
    pub name: String,
}

/// LLM configuration stored in teamclaw.json under "llm" key.
/// Replaces the old teamclaw-team/teamclaw.yaml file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub base_url: String,
    pub model: String,
    pub model_name: String,
    /// Multiple selectable models. When present, users can switch between these.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<LlmModelEntry>,
}

/// Unified team status returned by check_team_status().
/// Single source of truth for "is this workspace in team mode?"
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamStatus {
    /// Whether a team mode is currently active
    pub active: bool,
    /// Which team mode: "p2p", "webdav", or "git"
    pub mode: Option<String>,
    /// Team LLM configuration, if present
    pub llm: Option<LlmConfig>,
}

/// Result of a git operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamGitResult {
    pub success: bool,
    pub message: String,
}

/// Team metadata stored in _meta/team.json (committed to Git)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMeta {
    pub team_id: String,
    pub team_name: String,
    /// HMAC-SHA256(team_secret, "teamclaw-verify") as hex — for join verification
    pub secret_verify: String,
    pub created_at: String,
    pub owner_node_id: String,
}

/// Result of team git create
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamGitCreateResult {
    pub team_id: String,
    pub team_secret: String,
}

/// Compute HMAC-SHA256(secret_hex, "teamclaw-verify") and return hex string.
fn compute_secret_verify(team_secret: &str) -> Result<String, String> {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;

    let secret_bytes =
        hex::decode(team_secret).map_err(|e| format!("Invalid hex secret: {e}"))?;
    let mut mac = HmacSha256::new_from_slice(&secret_bytes)
        .map_err(|e| format!("HMAC init failed: {e}"))?;
    mac.update(b"teamclaw-verify");
    Ok(hex::encode(mac.finalize().into_bytes()))
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

/// Parse the NUL-delimited output of `git status --porcelain -z -uall`
/// and return only the paths of untracked entries (records starting with `?? `).
fn parse_untracked_paths(porcelain_bytes: &[u8]) -> Vec<String> {
    porcelain_bytes
        .split(|&b| b == 0)
        .filter_map(|record| {
            if record.len() > 3 && &record[..3] == b"?? " {
                Some(String::from_utf8_lossy(&record[3..]).to_string())
            } else {
                None
            }
        })
        .collect()
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
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.".to_string())
}

/// Read team config from teamclaw.json
fn read_team_config_from_file(workspace_path: &str) -> Result<Option<TeamConfig>, String> {
    let config_path = format!(
        "{}/{}/{}",
        workspace_path,
        crate::commands::TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME
    );

    if !Path::new(&config_path).exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read {}: {}", super::CONFIG_FILE_NAME, e))?;

    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {}", super::CONFIG_FILE_NAME, e))?;

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
    let config_path = format!("{}/{}", teamclaw_dir, super::CONFIG_FILE_NAME);

    // Read existing config or create empty object
    let mut json: serde_json::Value = if Path::new(&config_path).exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {}", super::CONFIG_FILE_NAME, e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse {}: {}", super::CONFIG_FILE_NAME, e))?
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
            .ok_or_else(|| format!("{} is not an object", super::CONFIG_FILE_NAME))?
            .insert("team".to_string(), team_val);
    } else {
        json.as_object_mut()
            .ok_or_else(|| format!("{} is not an object", super::CONFIG_FILE_NAME))?
            .remove("team");
    }

    let content = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write {}: {}", super::CONFIG_FILE_NAME, e))
}

// Re-export TEAM_REPO_DIR from parent so existing `crate::commands::team::TEAM_REPO_DIR` paths work.
pub use super::TEAM_REPO_DIR;

/// Scaffold the teamclaw-team directory with default structure if it doesn't exist or is empty.
pub fn scaffold_team_dir(team_dir: &str) -> Result<(), String> {
    let team_path = Path::new(team_dir);

    let is_empty = !team_path.exists()
        || team_path
            .read_dir()
            .map(|mut d| d.next().is_none())
            .unwrap_or(true);

    if !is_empty {
        return Ok(());
    }

    let dirs = ["skills", ".mcp", "knowledge", "_feedback", "_meta", "_secrets"];
    for d in &dirs {
        std::fs::create_dir_all(team_path.join(d))
            .map_err(|e| format!("Failed to create {}: {}", d, e))?;
    }

    let readme_path = team_path.join("README.md");
    if !readme_path.exists() {
        let readme = "# TeamClaw Team Drive\n\nShared team resources.\n\n## Structure\n\n- `skills/` - Shared agent skills\n- `.mcp/` - MCP server configurations\n- `knowledge/` - Shared knowledge base\n- `_feedback/` - Member feedback summaries (auto-synced)\n- `_meta/` - Shared team metadata and app-managed files\n";
        std::fs::write(&readme_path, readme)
            .map_err(|e| format!("Failed to write README.md: {}", e))?;
    }

    Ok(())
}

/// Ensure the .gitignore in team_dir has all rules from GITIGNORE_CONTENT.
/// Appends missing rules if the file exists, or creates it if missing.
fn ensure_gitignore_rules(team_dir: &str) {
    let gitignore_path = Path::new(team_dir).join(".gitignore");
    if !gitignore_path.exists() {
        let _ = std::fs::write(&gitignore_path, GITIGNORE_CONTENT);
        return;
    }
    let existing = match std::fs::read_to_string(&gitignore_path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut missing = Vec::new();
    for line in GITIGNORE_CONTENT.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if !existing.lines().any(|l| l.trim() == t) {
            missing.push(t.to_string());
        }
    }
    if missing.is_empty() {
        return;
    }
    let mut content = existing;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str("\n# Auto-added by TeamClaw\n");
    for line in &missing {
        content.push_str(line);
        content.push('\n');
    }
    let _ = std::fs::write(&gitignore_path, content);
}

fn get_team_repo_path(workspace_path: &str) -> String {
    let p = Path::new(workspace_path).join(TEAM_REPO_DIR);
    p.to_string_lossy().to_string()
}

/// Build an LlmConfig from optional parameters.
/// Returns None when no base_url is provided (user chose not to host LLM).
pub fn build_llm_config(
    base_url: Option<String>,
    model: Option<String>,
    model_name: Option<String>,
    models_json: Option<String>,
) -> Option<LlmConfig> {
    let url = base_url.filter(|s| !s.is_empty())?;
    let models: Vec<LlmModelEntry> = models_json
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // Use first model from array as default if model/model_name not explicitly set
    let default_model = models.first();
    Some(LlmConfig {
        base_url: url,
        model: model
            .filter(|s| !s.is_empty())
            .or_else(|| default_model.map(|m| m.id.clone()))
            .unwrap_or_else(|| "default".to_string()),
        model_name: model_name
            .filter(|s| !s.is_empty())
            .or_else(|| default_model.map(|m| m.name.clone()))
            .unwrap_or_else(|| "default".to_string()),
        models,
    })
}

/// Write LLM config to teamclaw.json under "llm" key, preserving other fields.
pub fn write_llm_config(workspace_path: &str, config: Option<&LlmConfig>) -> Result<(), String> {
    let teamclaw_dir = format!("{}/{}", workspace_path, crate::commands::TEAMCLAW_DIR);
    let _ = std::fs::create_dir_all(&teamclaw_dir);
    let config_path = format!("{}/{}", teamclaw_dir, super::CONFIG_FILE_NAME);

    let mut json: serde_json::Value = if Path::new(&config_path).exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {}", super::CONFIG_FILE_NAME, e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse {}: {}", super::CONFIG_FILE_NAME, e))?
    } else {
        serde_json::json!({
            "$schema": "https://opencode.ai/config.json"
        })
    };

    if let Some(llm_config) = config {
        let llm_val = serde_json::to_value(llm_config)
            .map_err(|e| format!("Failed to serialize llm config: {}", e))?;
        json.as_object_mut()
            .ok_or_else(|| format!("{} is not an object", super::CONFIG_FILE_NAME))?
            .insert("llm".to_string(), llm_val);
    } else {
        json.as_object_mut()
            .ok_or_else(|| format!("{} is not an object", super::CONFIG_FILE_NAME))?
            .remove("llm");
    }

    let content = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write {}: {}", super::CONFIG_FILE_NAME, e))
}

/// Single source of truth: check whether this workspace has an active team mode.
/// Reads .teamclaw/teamclaw.json once and returns TeamStatus with mode + LLM config.
pub fn check_team_status(workspace_path: &str) -> TeamStatus {
    let config_path = Path::new(workspace_path)
        .join(crate::commands::TEAMCLAW_DIR)
        .join(super::CONFIG_FILE_NAME);

    let json = match std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
    {
        Some(v) => v,
        None => {
            return TeamStatus {
                active: false,
                mode: None,
                llm: None,
            }
        }
    };

    // Determine mode: explicit field first, then infer from enabled flags
    let mode = json
        .get("team_mode")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            if json
                .get("webdav")
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool())
                == Some(true)
            {
                Some("webdav".to_string())
            } else if json
                .get("p2p")
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool())
                == Some(true)
            {
                Some("p2p".to_string())
            } else if json
                .get("oss")
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool())
                == Some(true)
            {
                Some("oss".to_string())
            } else if json
                .get("team")
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool())
                == Some(true)
            {
                Some("git".to_string())
            } else {
                None
            }
        });

    // Read LLM config
    let llm = json
        .get("llm")
        .and_then(|v| serde_json::from_value::<LlmConfig>(v.clone()).ok());

    let active = mode.is_some();
    TeamStatus { active, mode, llm }
}

/// Write the team_mode field in .teamclaw/teamclaw.json.
/// Pass None to clear it (on disconnect).
pub fn write_team_mode(workspace_path: &str, mode: Option<&str>) -> Result<(), String> {
    let teamclaw_dir = Path::new(workspace_path).join(crate::commands::TEAMCLAW_DIR);
    std::fs::create_dir_all(&teamclaw_dir)
        .map_err(|e| format!("Failed to create {}: {}", super::TEAMCLAW_DIR, e))?;

    let config_path = teamclaw_dir.join(super::CONFIG_FILE_NAME);
    let mut json: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {}", super::CONFIG_FILE_NAME, e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    match mode {
        Some(m) => json["team_mode"] = serde_json::Value::String(m.to_string()),
        None => {
            json.as_object_mut().map(|o| o.remove("team_mode"));
        }
    }

    let content = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write {}: {}", super::CONFIG_FILE_NAME, e))
}

/// The whitelist .gitignore content
const GITIGNORE_CONTENT: &str = r#"# ============================================
# TeamClaw Team Drive — Whitelist mode
# Ignore everything by default, only allow shared layer
# ============================================

# 1. Ignore all files by default
*

# 2. Allow shared layers
!skills/
!skills/**
!.mcp/
!.mcp/**
!knowledge/
!knowledge/**
!_feedback/
!_feedback/**
!_meta/
!_meta/**
!_secrets/
!_secrets/**

# 3. Allow workspace config
!.gitignore
!README.md

# 4. Explicitly ignore (never sync)
.trash/
.DS_Store
node_modules/
.git/
target/
dist/
build/
out/
.cache/
.turbo/
.next/
.nuxt/
.output/
__pycache__/
.venv/
venv/
.tox/
vendor/
.gradle/
.m2/
*.log
*.tmp
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
#[allow(dead_code)]
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
            headers: server
                .headers
                .as_ref()
                .map(|h| h.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
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

// ─── Tauri Commands: Team Status ─────────────────────────────────────────────

/// Unified team status check — single source of truth for frontend.
/// Accepts an optional `workspace_path` override so the frontend can pass
/// the correct path during workspace switches (before `start_opencode` updates
/// `OpenCodeState`).
#[tauri::command]
pub fn get_team_status(
    workspace_path: Option<String>,
    opencode_state: State<'_, OpenCodeState>,
) -> Result<TeamStatus, String> {
    let ws = workspace_path
        .filter(|p| !p.is_empty())
        .or_else(|| get_workspace_path(&opencode_state).ok())
        .ok_or("No workspace path set. Please select a workspace first.".to_string())?;
    Ok(check_team_status(&ws))
}

/// Update LLM config for an existing team (any mode: P2P, OSS, Git, WebDAV).
/// Called from the "服务配置" section in team settings.
#[tauri::command]
pub fn update_team_llm_config(
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
    llm_models: Option<String>,
    opencode_state: State<'_, OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    let llm_config = build_llm_config(llm_base_url, llm_model, llm_model_name, llm_models);
    write_llm_config(&workspace_path, llm_config.as_ref())?;
    Ok(())
}

// ─── Tauri Commands: Git Operations ─────────────────────────────────────────

/// 1.1 - Check if git is installed on the system
#[tauri::command]
pub fn team_check_git_installed() -> Result<GitCheckResult, String> {
    match Command::new("git").args(["--version"]).output() {
        Ok(output) => {
            let success = output.status.success();
            let version = if success {
                Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
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
    git_branch: Option<String>,
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
    llm_models: Option<String>,
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

    // Clone into workspace/teamclaw-team, optionally specifying a branch
    let clone_args: Vec<&str> = if let Some(ref branch) = git_branch {
        if !branch.is_empty() {
            vec!["clone", "-b", branch.as_str(), &remote_url, TEAM_REPO_DIR]
        } else {
            vec!["clone", &remote_url, TEAM_REPO_DIR]
        }
    } else {
        vec!["clone", &remote_url, TEAM_REPO_DIR]
    };
    let (ok, _, stderr) = run_git(&clone_args, &workspace_path)?;
    if !ok {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err(format!(
            "git clone failed (check URL and authentication): {}",
            stderr.trim()
        ));
    }

    // Ensure standard team directory structure exists (same as OSS/P2P)
    // scaffold_team_dir skips non-empty dirs, so we create them explicitly after clone
    let team_path = Path::new(&team_dir);
    for d in &["skills", ".mcp", "knowledge", "_feedback", "_meta"] {
        let _ = std::fs::create_dir_all(team_path.join(d));
    }
    let readme_path = team_path.join("README.md");
    if !readme_path.exists() {
        let readme = "# TeamClaw Team Drive\n\nShared team resources.\n\n## Structure\n\n- `skills/` - Shared agent skills\n- `.mcp/` - MCP server configurations\n- `knowledge/` - Shared knowledge base\n- `_feedback/` - Member feedback summaries (auto-synced)\n- `_meta/` - Shared team metadata and app-managed files\n";
        let _ = std::fs::write(&readme_path, readme);
    }
    println!("[Team Init] Ensured standard team directory structure");

    // Write LLM config to .teamclaw/teamclaw.json (only if user chose to host LLM)
    let llm_config = build_llm_config(llm_base_url, llm_model, llm_model_name, llm_models);
    write_llm_config(&workspace_path, llm_config.as_ref())?;
    println!(
        "[Team Init] Wrote LLM config to {}/{}",
        super::TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME
    );

    // Ensure _meta/members.json exists (create with self as owner if missing)
    let meta_path = Path::new(&team_dir).join("_meta").join("members.json");
    if !meta_path.exists() {
        use crate::commands::team_unified::{TeamManifest, TeamMember, MemberRole};
        let node_id = crate::commands::oss_commands::get_device_id()?;
        let manifest = TeamManifest {
            owner_node_id: node_id.clone(),
            members: vec![TeamMember {
                node_id,
                name: String::new(),
                role: MemberRole::Owner,
                label: String::new(),
                platform: std::env::consts::OS.to_string(),
                arch: std::env::consts::ARCH.to_string(),
                hostname: gethostname::gethostname().to_string_lossy().to_string(),
                added_at: chrono::Utc::now().to_rfc3339(),
            }],
        };
        if let Some(parent) = meta_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("Failed to serialize members.json: {}", e))?;
        std::fs::write(&meta_path, json)
            .map_err(|e| format!("Failed to write members.json: {}", e))?;
        println!("[Team Init] Created _meta/members.json with self as owner");
    }

    // Sync .mcp/ from team dir into workspace opencode.json
    match sync_team_mcp_configs_from_dir(&team_dir, &workspace_path) {
        Ok(count) if count > 0 => {
            println!(
                "[Team Init] Synced {} MCP server(s) from .mcp/ to opencode.json",
                count
            );
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
            workspace_path, TEAM_REPO_DIR
        ),
    })
}

/// 1.3b - Create a new team: clone repo, generate team_id + team_secret, scaffold, commit & push.
#[tauri::command]
pub async fn team_git_create(
    git_url: String,
    git_token: Option<String>,
    git_branch: Option<String>,
    team_name: String,
    member_name: String,
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
    llm_models: Option<String>,
    opencode_state: State<'_, OpenCodeState>,
    secrets_state: State<'_, crate::commands::shared_secrets::SharedSecretsState>,
) -> Result<TeamGitCreateResult, String> {
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

    // Clone into workspace/teamclaw-team, optionally specifying a branch
    let clone_args: Vec<&str> = if let Some(ref branch) = git_branch {
        if !branch.is_empty() {
            vec!["clone", "-b", branch.as_str(), &remote_url, TEAM_REPO_DIR]
        } else {
            vec!["clone", &remote_url, TEAM_REPO_DIR]
        }
    } else {
        vec!["clone", &remote_url, TEAM_REPO_DIR]
    };
    let (ok, _, stderr) = run_git(&clone_args, &workspace_path)?;
    if !ok {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err(format!(
            "git clone failed (check URL and authentication): {}",
            stderr.trim()
        ));
    }

    // Generate team_id
    let team_id = format!("tc-{}", nanoid::nanoid!(12));

    // Generate team_secret (32 random bytes → hex)
    let mut secret_bytes = [0u8; 32];
    getrandom::getrandom(&mut secret_bytes)
        .map_err(|e| format!("Failed to generate random secret: {e}"))?;
    let team_secret = hex::encode(secret_bytes);

    // Scaffold standard team directories
    let team_path = Path::new(&team_dir);
    for d in &["skills", ".mcp", "knowledge", "_feedback", "_meta", "_secrets"] {
        std::fs::create_dir_all(team_path.join(d))
            .map_err(|e| format!("Failed to create {}: {}", d, e))?;
    }

    // Write README.md if missing
    let readme_path = team_path.join("README.md");
    if !readme_path.exists() {
        let readme = "# TeamClaw Team Drive\n\nShared team resources.\n\n## Structure\n\n- `skills/` - Shared agent skills\n- `.mcp/` - MCP server configurations\n- `knowledge/` - Shared knowledge base\n- `_feedback/` - Member feedback summaries (auto-synced)\n- `_meta/` - Shared team metadata and app-managed files\n";
        let _ = std::fs::write(&readme_path, readme);
    }

    // Compute HMAC verification hash
    let secret_verify = compute_secret_verify(&team_secret)?;

    // Get device node_id
    let node_id = crate::commands::oss_commands::get_device_id()?;

    // Write _meta/team.json
    let team_meta = TeamMeta {
        team_id: team_id.clone(),
        team_name: team_name.clone(),
        secret_verify,
        created_at: chrono::Utc::now().to_rfc3339(),
        owner_node_id: node_id.clone(),
    };
    let team_meta_path = team_path.join("_meta").join("team.json");
    let team_meta_json = serde_json::to_string_pretty(&team_meta)
        .map_err(|e| format!("Failed to serialize team.json: {}", e))?;
    std::fs::write(&team_meta_path, team_meta_json)
        .map_err(|e| format!("Failed to write team.json: {}", e))?;
    println!("[Team Create] Wrote _meta/team.json with team_id={}", team_id);

    // Write _meta/members.json with self as owner
    let git_user_name = member_name.clone();
    {
        use crate::commands::team_unified::{MemberRole, TeamManifest, TeamMember};
        let manifest = TeamManifest {
            owner_node_id: node_id.clone(),
            members: vec![TeamMember {
                node_id: node_id.clone(),
                name: member_name,
                role: MemberRole::Owner,
                label: String::new(),
                platform: std::env::consts::OS.to_string(),
                arch: std::env::consts::ARCH.to_string(),
                hostname: gethostname::gethostname().to_string_lossy().to_string(),
                added_at: chrono::Utc::now().to_rfc3339(),
            }],
        };
        let meta_path = team_path.join("_meta").join("members.json");
        let json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("Failed to serialize members.json: {}", e))?;
        std::fs::write(&meta_path, json)
            .map_err(|e| format!("Failed to write members.json: {}", e))?;
        println!("[Team Create] Created _meta/members.json with self as owner");
    }

    // Ensure .gitignore has all required rules
    ensure_gitignore_rules(&team_dir);

    // Git add, commit, push
    let (ok, _, stderr) = run_git(&["add", "-A"], &team_dir)?;
    if !ok {
        println!("[Team Create] git add warning: {}", stderr.trim());
    }
    // Set git user identity for this repo (so commits show the member's name)
    let _ = run_git(&["config", "user.name", &git_user_name], &team_dir);
    let _ = run_git(&["config", "user.email", &format!("{}@teamclaw.local", node_id.chars().take(8).collect::<String>())], &team_dir);
    let (ok, _, stderr) = run_git(&["commit", "-m", "chore: initialize team"], &team_dir)?;
    if !ok {
        println!("[Team Create] git commit warning: {}", stderr.trim());
    }
    let branch = git_branch
        .as_deref()
        .filter(|b| !b.is_empty())
        .unwrap_or("main");
    let (ok, _, stderr) = run_git(&["push", "origin", branch], &team_dir)?;
    if !ok {
        // Try pushing to current HEAD branch if specified branch fails
        let (ok2, head_out, _) =
            run_git(&["rev-parse", "--abbrev-ref", "HEAD"], &team_dir)?;
        if ok2 {
            let head_branch = head_out.trim();
            if head_branch != branch {
                let (ok3, _, stderr3) =
                    run_git(&["push", "origin", head_branch], &team_dir)?;
                if !ok3 {
                    println!(
                        "[Team Create] git push warning: {}",
                        stderr3.trim()
                    );
                }
            } else {
                println!("[Team Create] git push warning: {}", stderr.trim());
            }
        }
    }

    // Write LLM config to .teamclaw/teamclaw.json
    let llm_config = build_llm_config(llm_base_url, llm_model, llm_model_name, llm_models);
    write_llm_config(&workspace_path, llm_config.as_ref())?;
    println!(
        "[Team Create] Wrote LLM config to {}/{}",
        super::TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME
    );

    // Save team_secret to keychain
    crate::commands::oss_sync::save_team_secret(&workspace_path, &team_id, &team_secret)?;
    println!("[Team Create] Saved team_secret to keychain");

    // Init shared secrets
    crate::commands::shared_secrets::init_shared_secrets(
        &secrets_state,
        &team_secret,
        team_path,
    )?;
    println!("[Team Create] Initialized shared secrets");

    // Sync MCP configs
    match sync_team_mcp_configs_from_dir(&team_dir, &workspace_path) {
        Ok(count) if count > 0 => {
            println!(
                "[Team Create] Synced {} MCP server(s) from .mcp/ to opencode.json",
                count
            );
        }
        Ok(_) => {}
        Err(e) => {
            println!("[Team Create] Warning: Failed to sync MCP configs: {}", e);
        }
    }

    Ok(TeamGitCreateResult {
        team_id,
        team_secret,
    })
}

/// Join an existing team repo: clone, verify HMAC secret, add self as member.
#[tauri::command]
pub async fn team_git_join(
    git_url: String,
    git_token: Option<String>,
    git_branch: Option<String>,
    team_id: String,
    team_secret: String,
    member_name: String,
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
    llm_models: Option<String>,
    opencode_state: State<'_, OpenCodeState>,
    secrets_state: State<'_, crate::commands::shared_secrets::SharedSecretsState>,
) -> Result<TeamGitResult, String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    let team_dir = get_team_repo_path(&workspace_path);

    // 1. Validate team_dir doesn't exist
    if Path::new(&team_dir).exists() {
        return Err(format!(
            "{} already exists. Remove it first or disconnect the team repo to re-initialize.",
            TEAM_REPO_DIR
        ));
    }

    // 2. Clone repo (same pattern as team_git_create)
    let remote_url = match &git_token {
        Some(token) if !token.is_empty() && is_https_url(&git_url) => {
            embed_token_in_url(&git_url, token)
        }
        _ => git_url.clone(),
    };

    let clone_args: Vec<&str> = if let Some(ref branch) = git_branch {
        if !branch.is_empty() {
            vec!["clone", "-b", branch.as_str(), &remote_url, TEAM_REPO_DIR]
        } else {
            vec!["clone", &remote_url, TEAM_REPO_DIR]
        }
    } else {
        vec!["clone", &remote_url, TEAM_REPO_DIR]
    };
    let (ok, _, stderr) = run_git(&clone_args, &workspace_path)?;
    if !ok {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err(format!(
            "git clone failed (check URL and authentication): {}",
            stderr.trim()
        ));
    }

    // 3. Read _meta/team.json
    let team_path = Path::new(&team_dir);
    let team_meta_path = team_path.join("_meta").join("team.json");
    let team_meta: TeamMeta = match std::fs::read_to_string(&team_meta_path) {
        Ok(content) => serde_json::from_str(&content).map_err(|e| {
            let _ = std::fs::remove_dir_all(&team_dir);
            format!("Failed to parse _meta/team.json: {}", e)
        })?,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&team_dir);
            return Err(format!(
                "Failed to read _meta/team.json: {}. Is this a valid TeamClaw team repo?",
                e
            ));
        }
    };

    // 4. Verify team_id matches
    if team_meta.team_id != team_id {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err(format!(
            "Team ID mismatch: expected '{}' but repo has '{}'",
            team_id, team_meta.team_id
        ));
    }

    // 5. Verify team_secret via HMAC comparison
    let computed_verify = match compute_secret_verify(&team_secret) {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&team_dir);
            return Err(e);
        }
    };
    if computed_verify != team_meta.secret_verify {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err("Team Secret is incorrect".to_string());
    }

    // 6. Read _meta/members.json
    let members_path = team_path.join("_meta").join("members.json");
    let mut manifest: crate::commands::team_unified::TeamManifest = {
        let content = match std::fs::read_to_string(&members_path) {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&team_dir);
                return Err(format!("Failed to read _meta/members.json: {}", e));
            }
        };
        match serde_json::from_str(&content) {
            Ok(m) => m,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&team_dir);
                return Err(format!("Failed to parse _meta/members.json: {}", e));
            }
        }
    };

    // 7. Dedup: update existing member or add new
    let node_id = match crate::commands::oss_commands::get_device_id() {
        Ok(id) => id,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&team_dir);
            return Err(e);
        }
    };
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(existing) = manifest.members.iter_mut().find(|m| m.node_id == node_id) {
        existing.name = member_name.clone();
        existing.platform = std::env::consts::OS.to_string();
        existing.arch = std::env::consts::ARCH.to_string();
        existing.hostname = gethostname::gethostname().to_string_lossy().to_string();
    } else {
        use crate::commands::team_unified::{MemberRole, TeamMember};
        manifest.members.push(TeamMember {
            node_id: node_id.clone(),
            name: member_name.clone(),
            role: MemberRole::Editor,
            label: String::new(),
            platform: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            hostname: gethostname::gethostname().to_string_lossy().to_string(),
            added_at: now,
        });
    }

    // 8. Write updated members.json
    let members_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| {
            let _ = std::fs::remove_dir_all(&team_dir);
            format!("Failed to serialize members.json: {}", e)
        })?;
    if let Err(e) = std::fs::write(&members_path, members_json) {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err(format!("Failed to write members.json: {}", e));
    }

    // 9. Set git user identity for this repo (so commits show the member's name)
    let _ = run_git(&["config", "user.name", &member_name], &team_dir);
    let _ = run_git(&["config", "user.email", &format!("{}@teamclaw.local", node_id.chars().take(8).collect::<String>())], &team_dir);

    // 10. Git add, commit, push
    let (ok, _, stderr) = run_git(&["add", "-A"], &team_dir)?;
    if !ok {
        println!("[Team Join] git add warning: {}", stderr.trim());
    }
    let (ok, _, stderr) =
        run_git(&["commit", "-m", "chore: member joined team"], &team_dir)?;
    if !ok {
        println!("[Team Join] git commit warning: {}", stderr.trim());
    }
    let branch = git_branch
        .as_deref()
        .filter(|b| !b.is_empty())
        .unwrap_or("main");
    let (ok, _, stderr) = run_git(&["push", "origin", branch], &team_dir)?;
    if !ok {
        let (ok2, head_out, _) =
            run_git(&["rev-parse", "--abbrev-ref", "HEAD"], &team_dir)?;
        if ok2 {
            let head_branch = head_out.trim();
            if head_branch != branch {
                let (ok3, _, stderr3) =
                    run_git(&["push", "origin", head_branch], &team_dir)?;
                if !ok3 {
                    println!("[Team Join] git push warning: {}", stderr3.trim());
                }
            } else {
                println!("[Team Join] git push warning: {}", stderr.trim());
            }
        }
    }

    // 10. Write LLM config
    let llm_config = build_llm_config(llm_base_url, llm_model, llm_model_name, llm_models);
    write_llm_config(&workspace_path, llm_config.as_ref())?;
    println!(
        "[Team Join] Wrote LLM config to {}/{}",
        super::TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME
    );

    // 11. Save team_secret to keychain
    crate::commands::oss_sync::save_team_secret(&workspace_path, &team_id, &team_secret)?;
    println!("[Team Join] Saved team_secret to keychain");

    // 12. Init shared secrets
    crate::commands::shared_secrets::init_shared_secrets(
        &secrets_state,
        &team_secret,
        team_path,
    )?;
    println!("[Team Join] Initialized shared secrets");

    // 13. Sync MCP configs
    match sync_team_mcp_configs_from_dir(&team_dir, &workspace_path) {
        Ok(count) if count > 0 => {
            println!(
                "[Team Join] Synced {} MCP server(s) from .mcp/ to opencode.json",
                count
            );
        }
        Ok(_) => {}
        Err(e) => {
            println!("[Team Join] Warning: Failed to sync MCP configs: {}", e);
        }
    }

    // 14. Return success
    Ok(TeamGitResult {
        success: true,
        message: format!("Joined team '{}' successfully", team_meta.team_name),
    })
}

/// 1.4 - Ensure .gitignore in team repo dir has all required rules.
/// Creates the file if missing, or appends missing rules if it already exists.
#[tauri::command]
pub async fn team_generate_gitignore(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<TeamGitResult, String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    let team_dir = get_team_repo_path(&workspace_path);
    ensure_gitignore_rules(&team_dir);
    Ok(TeamGitResult {
        success: true,
        message: ".gitignore ensured".to_string(),
    })
}

/// 1.5 - Sync team repo: fetch + reset --hard (in workspace/teamclaw-team)
#[tauri::command]
pub async fn team_sync_repo(
    opencode_state: State<'_, OpenCodeState>,
    secrets_state: State<'_, crate::commands::shared_secrets::SharedSecretsState>,
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

    // Read saved config for token and branch
    let saved_config = read_team_config_from_file(&workspace_path).ok().flatten();
    if let Some(ref config) = saved_config {
        if let Some(ref token) = config.git_token {
            if !token.is_empty() && is_https_url(&config.git_url) {
                let auth_url = embed_token_in_url(&config.git_url, token);
                let _ = run_git(&["remote", "set-url", "origin", &auth_url], &team_dir);
            }
        }
    }

    // Auto-commit local changes if any
    let (_, status_out, _) = run_git(&["status", "--porcelain"], &team_dir)?;
    let had_local_changes = !status_out.trim().is_empty();
    if had_local_changes {
        let _ = run_git(&["add", "-A"], &team_dir);
        // Build commit message with changed file names
        let changed_files: Vec<&str> = status_out
            .lines()
            .filter_map(|line| {
                let file = line.get(3..)?.split(" -> ").last()?.trim();
                if file.is_empty() || file.starts_with(".trash") {
                    None
                } else {
                    Some(file)
                }
            })
            .collect();
        let msg = if changed_files.len() <= 5 {
            format!("chore: sync ({})", changed_files.join(", "))
        } else {
            format!(
                "chore: sync ({}, ... +{} more)",
                changed_files[..3].join(", "),
                changed_files.len() - 3
            )
        };
        let _ = run_git(&["commit", "-m", &msg], &team_dir);
    }

    // Determine the branch to sync: saved config → current HEAD → remote default → "main"
    let branch = saved_config
        .as_ref()
        .and_then(|c| c.git_branch.as_deref())
        .filter(|b| !b.is_empty())
        .map(|b| b.to_string())
        .unwrap_or_else(|| {
            let (ok, stdout, _) = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], &team_dir)
                .unwrap_or((false, String::new(), String::new()));
            if ok && !stdout.trim().is_empty() && stdout.trim() != "HEAD" {
                stdout.trim().to_string()
            } else {
                let (ok2, stdout2, _) = run_git(
                    &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
                    &team_dir,
                )
                .unwrap_or((false, String::new(), String::new()));
                if ok2 && !stdout2.trim().is_empty() {
                    stdout2
                        .trim()
                        .strip_prefix("origin/")
                        .unwrap_or(stdout2.trim())
                        .to_string()
                } else {
                    "main".to_string()
                }
            }
        });

    let remote_ref = format!("origin/{}", branch);
    let (ok, _, stderr) = run_git(&["fetch", "origin"], &team_dir)?;
    if !ok {
        return Err(format!("git fetch failed: {}", stderr.trim()));
    }
    let (ref_exists, _, _) = run_git(&["rev-parse", "--verify", &remote_ref], &team_dir)?;
    if !ref_exists {
        return Err(format!(
            "Remote branch '{}' not found. The remote repository may be empty or use a different default branch.",
            remote_ref
        ));
    }

    // Try pull --rebase to merge local commits with remote
    let (rebase_ok, _, _) = run_git(&["pull", "--rebase", "origin", &branch], &team_dir)?;
    let mut conflict_resolved = false;

    if !rebase_ok {
        // Conflict — abort rebase, backup local changed files, then reset to remote
        let _ = run_git(&["rebase", "--abort"], &team_dir);

        // Identify files that differ from remote to backup only conflicting content
        let (_, diff_out, _) = run_git(&["diff", "--name-only", &remote_ref], &team_dir)?;
        if !diff_out.trim().is_empty() {
            let ts = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
            let trash_dir = Path::new(&team_dir).join(".trash").join(&ts);
            let _ = std::fs::create_dir_all(&trash_dir);

            for file in diff_out.lines() {
                let file = file.trim();
                if file.is_empty() || file.starts_with(".trash") {
                    continue;
                }
                let src = Path::new(&team_dir).join(file);
                if src.is_file() {
                    let dest = trash_dir.join(file);
                    if let Some(parent) = dest.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::copy(&src, &dest);
                }
            }
            println!("[Team Sync] conflict detected, backed up local files to .trash/{}", ts);
        }

        // Force reset to remote
        let (ok, _, stderr) = run_git(&["reset", "--hard", &remote_ref], &team_dir)?;
        if !ok {
            return Err(format!("git reset failed: {}", stderr.trim()));
        }
        conflict_resolved = true;
    } else if had_local_changes {
        // Rebase succeeded — push local commits to remote
        let (ok, _, stderr) = run_git(&["push", "origin", &branch], &team_dir)?;
        if !ok {
            println!("[Team Sync] push failed (non-fatal): {}", stderr.trim());
        }
    }

    // Ensure .gitignore has all required rules (auto-upgrade for existing repos)
    ensure_gitignore_rules(&team_dir);

    let mcp_msg = match sync_team_mcp_configs_from_dir(&team_dir, &workspace_path) {
        Ok(count) if count > 0 => {
            println!(
                "[Team Sync] Synced {} MCP server(s) from .mcp/ to opencode.json",
                count
            );
            format!(". Synced {} MCP server(s)", count)
        }
        Ok(_) => String::new(),
        Err(e) => {
            println!("[Team Sync] Warning: Failed to sync MCP configs: {}", e);
            String::new()
        }
    };

    // Reload shared secrets from disk (other members may have added/updated secrets)
    if let Err(e) = crate::commands::shared_secrets::load_all_secrets(&secrets_state) {
        println!("[Team Sync] Warning: Failed to reload shared secrets: {}", e);
    }

    // Persist last sync timestamp to teamclaw.json so the UI can display it
    if let Ok(Some(mut cfg)) = read_team_config_from_file(&workspace_path) {
        cfg.last_sync_at = Some(chrono::Utc::now().to_rfc3339());
        let _ = write_team_config_to_file(&workspace_path, Some(&cfg));
    }

    let sync_detail = if conflict_resolved {
        format!("Synced with origin/{} (conflict resolved, local backup in .trash/){}", branch, mcp_msg)
    } else if had_local_changes {
        format!("Synced with origin/{} (local changes pushed){}", branch, mcp_msg)
    } else {
        format!("Synced with origin/{}{}", branch, mcp_msg)
    };
    Ok(TeamGitResult {
        success: true,
        message: sync_detail,
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

/// Initialize shared secrets for an already-configured Git team.
/// Called on app startup when team config has a team_id.
#[tauri::command]
pub async fn init_git_team_secrets(
    team_id: String,
    opencode_state: State<'_, OpenCodeState>,
    secrets_state: State<'_, crate::commands::shared_secrets::SharedSecretsState>,
) -> Result<(), String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    let team_dir = get_team_repo_path(&workspace_path);
    let team_path = Path::new(&team_dir);

    if !team_path.join("_meta").join("team.json").exists() {
        return Ok(()); // No team metadata yet, skip
    }

    let team_secret =
        crate::commands::oss_sync::load_team_secret(&workspace_path, &team_id)
            .map_err(|e| format!("Failed to load team secret: {e}"))?;

    crate::commands::shared_secrets::init_shared_secrets(
        &secrets_state,
        &team_secret,
        team_path,
    )?;

    Ok(())
}

/// Load the team secret from keychain for display in settings.
#[tauri::command]
pub async fn get_git_team_secret(
    team_id: String,
    opencode_state: State<'_, OpenCodeState>,
) -> Result<String, String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    crate::commands::oss_sync::load_team_secret(&workspace_path, &team_id)
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
pub async fn clear_team_config(opencode_state: State<'_, OpenCodeState>) -> Result<(), String> {
    let workspace_path = get_workspace_path(&opencode_state)?;
    write_team_config_to_file(&workspace_path, None)
}

// NOTE: Startup team sync is triggered from the frontend after workspace is set,
// since workspace_path is not available at Tauri setup time.
// The frontend calls team_sync_repo on startup when team config is enabled.

#[cfg(test)]
mod sync_precheck_tests {
    use super::*;

    #[test]
    fn test_parse_untracked_paths_basic() {
        let input = b"?? new.txt\x00 M modified.txt\x00?? subdir/other.bin\x00";
        let paths = parse_untracked_paths(input);
        assert_eq!(paths, vec!["new.txt".to_string(), "subdir/other.bin".to_string()]);
    }

    #[test]
    fn test_parse_untracked_paths_ignores_staged_modified_deleted() {
        let input = b"A  staged.txt\x00MM both.txt\x00 D gone.txt\x00?? real.txt\x00";
        let paths = parse_untracked_paths(input);
        assert_eq!(paths, vec!["real.txt".to_string()]);
    }

    #[test]
    fn test_parse_untracked_paths_empty() {
        assert!(parse_untracked_paths(b"").is_empty());
    }

    #[test]
    fn test_parse_untracked_paths_handles_spaces_in_name() {
        let input = b"?? my new file.txt\x00";
        let paths = parse_untracked_paths(input);
        assert_eq!(paths, vec!["my new file.txt".to_string()]);
    }
}

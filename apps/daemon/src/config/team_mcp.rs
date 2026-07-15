//! Team-shared MCP definitions from `teamclaw-team/.mcp/*.json`.
//!
//! Merged at read time with workspace `opencode.json` entries. On name
//! collision the workspace layer wins (user local override).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::global_team_store::{resolve_team_dir, TEAM_LINK_NAME};
use super::workspace_control::{McpServerConfig, WorkspaceControlError};

pub const INHERENT_MCP_NAMES: &[&str] =
    &["playwright", "chrome-control", "autoui", "teamclaw-introspect"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpSource {
    Workspace,
    Team,
    Inherent,
}

impl McpSource {
    pub fn as_str(self) -> &'static str {
        match self {
            McpSource::Workspace => "workspace",
            McpSource::Team => "team",
            McpSource::Inherent => "inherent",
        }
    }
}

#[derive(Debug, Deserialize)]
struct TeamMcpFile {
    #[serde(rename = "mcpServers", default)]
    mcp_servers: HashMap<String, CursorMcpServer>,
}

#[derive(Debug, Deserialize)]
struct CursorMcpServer {
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    url: Option<String>,
    headers: Option<HashMap<String, String>>,
}

fn io_err(e: std::io::Error) -> WorkspaceControlError {
    WorkspaceControlError::Io(e.to_string())
}

fn parse_err(e: serde_json::Error) -> WorkspaceControlError {
    WorkspaceControlError::Parse(e.to_string())
}

fn is_inherent(name: &str) -> bool {
    INHERENT_MCP_NAMES.contains(&name)
}

fn onboarded_team_id() -> Option<String> {
    super::DaemonConfig::load(&super::DaemonConfig::default_path())
        .ok()
        .and_then(|cfg| {
            cfg.team_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
}

fn team_mcp_dir(workspace: &Path) -> PathBuf {
    if let Some(team_id) = onboarded_team_id() {
        resolve_team_dir(workspace, &team_id).join(".mcp")
    } else {
        workspace.join(TEAM_LINK_NAME).join(".mcp")
    }
}

fn convert_cursor_server(server: &CursorMcpServer) -> McpServerConfig {
    if server.url.is_some() {
        McpServerConfig {
            server_type: "remote".to_owned(),
            enabled: Some(true),
            command: vec![],
            environment: HashMap::new(),
            url: server.url.clone(),
            headers: server.headers.clone().unwrap_or_default(),
            timeout: None,
            source: None,
            extra: HashMap::new(),
        }
    } else {
        let mut command = Vec::new();
        if let Some(cmd) = &server.command {
            command.push(cmd.clone());
        }
        if let Some(args) = &server.args {
            command.extend(args.clone());
        }
        McpServerConfig {
            server_type: "local".to_owned(),
            enabled: Some(true),
            command,
            environment: server.env.clone().unwrap_or_default(),
            url: None,
            headers: HashMap::new(),
            timeout: None,
            source: None,
            extra: HashMap::new(),
        }
    }
}

/// Scan `teamclaw-team/.mcp/*.json` (Cursor `mcpServers` format).
pub fn scan_team_mcp(workspace: &Path) -> HashMap<String, McpServerConfig> {
    let mcp_dir = team_mcp_dir(workspace);
    if !mcp_dir.is_dir() {
        return HashMap::new();
    }

    let entries = match std::fs::read_dir(&mcp_dir) {
        Ok(entries) => entries,
        Err(_) => return HashMap::new(),
    };

    let mut team_servers = HashMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let team_file: TeamMcpFile = match serde_json::from_str(&content) {
            Ok(file) => file,
            Err(_) => continue,
        };
        for (name, server) in team_file.mcp_servers {
            team_servers.insert(name, convert_cursor_server(&server));
        }
    }
    team_servers
}

pub fn read_persisted_mcp(workspace: &Path) -> Result<HashMap<String, McpServerConfig>, WorkspaceControlError> {
    let path = workspace.join("opencode.json");
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = std::fs::read_to_string(&path).map_err(io_err)?;
    let json: serde_json::Value = serde_json::from_str(&content).map_err(parse_err)?;
    Ok(json
        .get("mcp")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default())
}

fn configs_equal(a: &McpServerConfig, b: &McpServerConfig) -> bool {
    a.server_type == b.server_type
        && a.enabled == b.enabled
        && a.command == b.command
        && a.environment == b.environment
        && a.url == b.url
        && a.headers == b.headers
        && a.timeout == b.timeout
}

fn classify_source(
    name: &str,
    persisted: Option<&McpServerConfig>,
    team: &HashMap<String, McpServerConfig>,
) -> McpSource {
    if is_inherent(name) {
        return McpSource::Inherent;
    }
    match (team.get(name), persisted) {
        (Some(team_cfg), Some(disk_cfg)) if configs_equal(team_cfg, disk_cfg) => McpSource::Team,
        (Some(_), Some(_)) => McpSource::Workspace,
        (Some(_), None) => McpSource::Team,
        (None, Some(_)) => McpSource::Workspace,
        (None, None) => McpSource::Workspace,
    }
}

fn with_source(mut cfg: McpServerConfig, source: McpSource) -> McpServerConfig {
    cfg.source = Some(source.as_str().to_owned());
    cfg
}

/// Merge team + workspace layers. Workspace `opencode.json` wins on conflicts.
pub fn merge_mcp_layers(
    team: &HashMap<String, McpServerConfig>,
    persisted: &HashMap<String, McpServerConfig>,
) -> HashMap<String, McpServerConfig> {
    let mut names: HashSet<String> = team.keys().cloned().collect();
    names.extend(persisted.keys().cloned());

    let mut merged = HashMap::new();
    for name in names {
        let source = classify_source(&name, persisted.get(&name), team);
        let cfg = match (team.get(&name), persisted.get(&name)) {
            (_, Some(disk)) => disk.clone(),
            (Some(team_cfg), None) => team_cfg.clone(),
            (None, None) => continue,
        };
        merged.insert(name, with_source(cfg, source));
    }
    merged
}

pub fn load_merged_mcp(workspace: &Path) -> Result<HashMap<String, McpServerConfig>, WorkspaceControlError> {
    let team = scan_team_mcp(workspace);
    let persisted = read_persisted_mcp(workspace)?;
    Ok(merge_mcp_layers(&team, &persisted))
}

/// Strip team/inherent overlay entries from a PUT body; persist workspace-owned only.
pub fn filter_put_body(
    workspace: &Path,
    body: HashMap<String, McpServerConfig>,
) -> HashMap<String, McpServerConfig> {
    let team_names: HashSet<String> = scan_team_mcp(workspace).into_keys().collect();
    body.into_iter()
        .filter(|(name, cfg)| {
            match cfg.source.as_deref() {
                Some("team") => false,
                Some("workspace") | Some("inherent") => true,
                _ => is_inherent(name) || !team_names.contains(name),
            }
        })
        .map(|(name, mut cfg)| {
            cfg.source = None;
            (name, cfg)
        })
        .collect()
}

/// Add team-only MCP entries into `opencode.json` for agent runtimes (workspace wins).
pub fn materialize_team_mcp_for_runtime(workspace: &Path) -> Result<bool, WorkspaceControlError> {
    let team = scan_team_mcp(workspace);
    if team.is_empty() {
        return Ok(false);
    }

    let path = workspace.join("opencode.json");
    let mut json: serde_json::Value = if path.exists() {
        let content = std::fs::read_to_string(&path).map_err(io_err)?;
        serde_json::from_str(&content).map_err(parse_err)?
    } else {
        serde_json::json!({ "$schema": "https://opencode.ai/config.json" })
    };

    let obj = json
        .as_object_mut()
        .ok_or_else(|| WorkspaceControlError::Parse("opencode.json root is not an object".into()))?;
    let mcp = obj.entry("mcp").or_insert_with(|| serde_json::json!({}));
    let mcp_obj = mcp
        .as_object_mut()
        .ok_or_else(|| WorkspaceControlError::Parse("mcp is not an object".into()))?;

    let mut changed = false;
    for (name, cfg) in team {
        if !mcp_obj.contains_key(&name) {
            let value = serde_json::to_value(cfg).map_err(parse_err)?;
            mcp_obj.insert(name, value);
            changed = true;
        }
    }

    if changed {
        let mut content = serde_json::to_string_pretty(&json).map_err(parse_err)?;
        content.push('\n');
        std::fs::write(&path, content).map_err(io_err)?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_cfg(command: &[&str]) -> McpServerConfig {
        McpServerConfig {
            server_type: "local".to_owned(),
            enabled: Some(true),
            command: command.iter().map(|s| (*s).to_owned()).collect(),
            environment: HashMap::new(),
            url: None,
            headers: HashMap::new(),
            timeout: None,
            source: None,
            extra: HashMap::new(),
        }
    }

    #[test]
    fn scan_team_mcp_parses_cursor_json_files() {
        let ws = tempfile::tempdir().unwrap();
        let mcp_dir = ws.path().join(TEAM_LINK_NAME).join(".mcp");
        std::fs::create_dir_all(&mcp_dir).unwrap();
        std::fs::write(
            mcp_dir.join("shared.json"),
            r#"{
  "mcpServers": {
    "team-db": {
      "command": "npx",
      "args": ["-y", "team-db-mcp"]
    }
  }
}"#,
        )
        .unwrap();

        let team = scan_team_mcp(ws.path());
        assert_eq!(team.len(), 1);
        let cfg = team.get("team-db").unwrap();
        assert_eq!(cfg.server_type, "local");
        assert_eq!(cfg.command, vec!["npx", "-y", "team-db-mcp"]);
    }

    #[test]
    fn merge_workspace_overrides_team_on_name_collision() {
        let mut team = HashMap::new();
        team.insert("supabase".to_owned(), local_cfg(&["npx", "team-supabase"]));

        let mut persisted = HashMap::new();
        persisted.insert(
            "supabase".to_owned(),
            local_cfg(&["npx", "local-supabase"]),
        );

        let merged = merge_mcp_layers(&team, &persisted);
        let cfg = merged.get("supabase").unwrap();
        assert_eq!(cfg.command, vec!["npx", "local-supabase"]);
        assert_eq!(cfg.source.as_deref(), Some("workspace"));
    }

    #[test]
    fn merge_team_only_entry_has_team_source() {
        let mut team = HashMap::new();
        team.insert("team-only".to_owned(), local_cfg(&["npx", "team-only"]));

        let merged = merge_mcp_layers(&team, &HashMap::new());
        assert_eq!(merged.get("team-only").unwrap().source.as_deref(), Some("team"));
    }

    #[test]
    fn filter_put_body_strips_team_entries() {
        let ws = tempfile::tempdir().unwrap();
        let mcp_dir = ws.path().join(TEAM_LINK_NAME).join(".mcp");
        std::fs::create_dir_all(&mcp_dir).unwrap();
        std::fs::write(
            mcp_dir.join("shared.json"),
            r#"{"mcpServers":{"team-srv":{"command":"npx","args":["team"]}}}"#,
        )
        .unwrap();

        let mut body = HashMap::new();
        body.insert(
            "team-srv".to_owned(),
            with_source(local_cfg(&["npx", "team"]), McpSource::Team),
        );
        body.insert(
            "custom".to_owned(),
            with_source(local_cfg(&["npx", "custom"]), McpSource::Workspace),
        );

        let filtered = filter_put_body(ws.path(), body);
        assert!(!filtered.contains_key("team-srv"));
        assert!(filtered.contains_key("custom"));
    }

    #[test]
    fn materialize_adds_team_only_entries_without_overwriting_workspace() {
        let ws = tempfile::tempdir().unwrap();
        let mcp_dir = ws.path().join(TEAM_LINK_NAME).join(".mcp");
        std::fs::create_dir_all(&mcp_dir).unwrap();
        std::fs::write(
            mcp_dir.join("shared.json"),
            r#"{"mcpServers":{"team-a":{"command":"npx","args":["a"]},"shared":{"command":"npx","args":["team"]}}}"#,
        )
        .unwrap();
        std::fs::write(
            ws.path().join("opencode.json"),
            r#"{"mcp":{"shared":{"type":"local","enabled":true,"command":["npx","local"]}}}"#,
        )
        .unwrap();

        assert!(materialize_team_mcp_for_runtime(ws.path()).unwrap());

        let persisted = read_persisted_mcp(ws.path()).unwrap();
        assert_eq!(
            persisted.get("shared").unwrap().command,
            vec!["npx", "local"]
        );
        assert_eq!(
            persisted.get("team-a").unwrap().command,
            vec!["npx", "a"]
        );
    }
}

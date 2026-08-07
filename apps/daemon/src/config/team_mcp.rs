//! Team-shared MCP definitions, mirrored from the Cloud API into
//! `~/.amuxd/teams/<id>/cloud/.mcp/` by `runtime::team_cloud_config`.
//!
//! The file format is unchanged (Cursor `mcpServers`) because the server hands
//! back exactly that shape — see `docs/architecture/team-mcp-and-env-cloud.md`.
//! The synced `teamclaw-team/.mcp/` directory is no longer synced, but is still
//! read for machines that already have it; the cloud copy always wins.
//!
//! Merged at read time with workspace `opencode.json` entries. On name
//! collision the workspace layer wins (user local override).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::global_team_store::{resolve_team_dir, TEAM_LINK_NAME};
use super::workspace_control::{McpServerConfig, WorkspaceControlError};
use teamclaw_runtime_env::opencode_config::OpencodeConfigError;

pub const INHERENT_MCP_NAMES: &[&str] = &[
    "playwright",
    "chrome-control",
    "autoui",
    "teamclaw-introspect",
];

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

/// Directories holding team MCP definitions, **least** preferred first.
///
/// The cloud cache is last so it wins on a name collision. The legacy synced
/// `teamclaw-team/.mcp/` is still read rather than dropped: `.mcp/` is no longer
/// synced, so those files can only exist on a machine that already had them —
/// reading them keeps a pre-migration checkout working, and the ordering means
/// they can never shadow what the member actually installed.
fn team_mcp_dirs(workspace: &Path) -> Vec<PathBuf> {
    let team_id = onboarded_team_id();
    let legacy = match &team_id {
        Some(id) => resolve_team_dir(workspace, id).join(".mcp"),
        None => workspace.join(TEAM_LINK_NAME).join(".mcp"),
    };
    match &team_id {
        Some(id) => vec![
            legacy,
            crate::runtime::team_cloud_config::team_cloud_mcp_dir(id),
        ],
        // Without an onboarded team there is no cloud cache to read.
        None => vec![legacy],
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

/// Scan every team MCP source for `*.json` in Cursor `mcpServers` format.
///
/// Later directories override earlier ones on a name collision — see
/// [`team_mcp_dirs`] for the ordering and why.
pub fn scan_team_mcp(workspace: &Path) -> HashMap<String, McpServerConfig> {
    let mut team_servers = HashMap::new();
    for mcp_dir in team_mcp_dirs(workspace) {
        scan_team_mcp_dir_into(&mcp_dir, &mut team_servers);
    }
    team_servers
}

fn scan_team_mcp_dir_into(mcp_dir: &Path, out: &mut HashMap<String, McpServerConfig>) {
    if !mcp_dir.is_dir() {
        return;
    }

    let entries = match std::fs::read_dir(mcp_dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

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
            out.insert(name, convert_cursor_server(&server));
        }
    }
}

pub fn read_persisted_mcp(
    workspace: &Path,
) -> Result<HashMap<String, McpServerConfig>, WorkspaceControlError> {
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

pub fn load_merged_mcp(
    workspace: &Path,
) -> Result<HashMap<String, McpServerConfig>, WorkspaceControlError> {
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
        .filter(|(name, cfg)| match cfg.source.as_deref() {
            Some("team") => false,
            Some("workspace") | Some("inherent") => true,
            _ => is_inherent(name) || !team_names.contains(name),
        })
        .map(|(name, mut cfg)| {
            cfg.source = None;
            (name, cfg)
        })
        .collect()
}

/// Result of materializing team MCP entries into `opencode.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MaterializeTeamMcpOutcome {
    /// Whether `opencode.json` was rewritten.
    pub changed: bool,
    /// Team MCP servers newly inserted (existing workspace/inherent entries are untouched).
    pub added_count: usize,
}

/// Add team-only MCP entries into `opencode.json` for agent runtimes (workspace wins).
pub fn materialize_team_mcp_for_runtime(
    workspace: &Path,
) -> Result<MaterializeTeamMcpOutcome, WorkspaceControlError> {
    materialize_team_mcp_entries(workspace, &scan_team_mcp(workspace))
}

/// The applying half, taking the team map explicitly.
///
/// Split from [`materialize_team_mcp_for_runtime`] so it can be tested without a
/// daemon config dir: resolving *where* team MCP comes from now goes through the
/// cloud cache under `~/.amuxd`, which a unit test has no business creating.
pub fn materialize_team_mcp_entries(
    workspace: &Path,
    team: &HashMap<String, McpServerConfig>,
) -> Result<MaterializeTeamMcpOutcome, WorkspaceControlError> {
    if team.is_empty() {
        return Ok(MaterializeTeamMcpOutcome {
            changed: false,
            added_count: 0,
        });
    }

    let mut added_count = 0usize;
    let changed =
        teamclaw_runtime_env::opencode_config::OpencodeConfigStore::apply(workspace, |json| {
            let obj = json.as_object_mut().ok_or_else(|| {
                OpencodeConfigError::Parse("opencode.json root is not an object".into())
            })?;
            if obj.get("$schema").is_none() && obj.is_empty() {
                obj.insert(
                    "$schema".to_string(),
                    serde_json::json!("https://opencode.ai/config.json"),
                );
            }
            let mcp = obj.entry("mcp").or_insert_with(|| serde_json::json!({}));
            let mcp_obj = mcp
                .as_object_mut()
                .ok_or_else(|| OpencodeConfigError::Parse("mcp is not an object".into()))?;

            for (name, cfg) in team {
                if !mcp_obj.contains_key(name) {
                    let value = serde_json::to_value(cfg)
                        .map_err(|e| OpencodeConfigError::Parse(e.to_string()))?;
                    mcp_obj.insert(name.clone(), value);
                    added_count += 1;
                }
            }
            Ok(added_count > 0)
        })
        .map_err(|e| WorkspaceControlError::Io(e.to_string()))?;

    Ok(MaterializeTeamMcpOutcome {
        changed,
        added_count,
    })
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

    /// The dual-source merge, exercised on the directory scanner directly.
    ///
    /// `scan_team_mcp` itself resolves the cloud cache through the daemon's real
    /// config dir (via the onboarded team id), which a unit test has no business
    /// reaching into. `scan_team_mcp_dir_into` is the part that actually decides
    /// precedence, and it takes explicit paths.
    #[test]
    fn later_dirs_override_earlier_ones_on_name_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("legacy");
        let cloud = tmp.path().join("cloud");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&cloud).unwrap();
        std::fs::write(
            legacy.join("a.json"),
            r#"{"mcpServers":{"shared":{"command":"stale"},"legacy-only":{"command":"keep"}}}"#,
        )
        .unwrap();
        std::fs::write(
            cloud.join("team.json"),
            r#"{"mcpServers":{"shared":{"command":"fresh"}}}"#,
        )
        .unwrap();

        let mut merged = HashMap::new();
        scan_team_mcp_dir_into(&legacy, &mut merged);
        scan_team_mcp_dir_into(&cloud, &mut merged);

        // Cloud reflects what this member actually installed; the synced dir is
        // whatever the team repo still happens to carry.
        assert_eq!(merged.get("shared").unwrap().command, vec!["fresh"]);
        // ...but it does not erase entries the cloud never mentioned.
        assert_eq!(merged.get("legacy-only").unwrap().command, vec!["keep"]);
    }

    #[test]
    fn a_missing_dir_contributes_nothing_and_does_not_clear_the_map() {
        let tmp = tempfile::tempdir().unwrap();
        let present = tmp.path().join("present");
        std::fs::create_dir_all(&present).unwrap();
        std::fs::write(
            present.join("a.json"),
            r#"{"mcpServers":{"team-db":{"command":"npx"}}}"#,
        )
        .unwrap();

        let mut merged = HashMap::new();
        scan_team_mcp_dir_into(&present, &mut merged);
        // The offline case: no cloud cache yet. It must be a no-op, not a wipe —
        // an empty team map would reclassify materialized servers as workspace-owned.
        scan_team_mcp_dir_into(&tmp.path().join("absent"), &mut merged);

        assert_eq!(merged.len(), 1);
        assert!(merged.contains_key("team-db"));
    }

    /// Parses the Cursor `mcpServers` shape the Cloud API hands back verbatim.
    ///
    /// Exercises the directory scanner directly rather than `scan_team_mcp`:
    /// that one resolves the cloud cache through the daemon's real config dir,
    /// which a unit test has no business reaching into.
    #[test]
    fn scan_team_mcp_parses_cursor_json_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("team.json"),
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

        let mut team = HashMap::new();
        scan_team_mcp_dir_into(dir.path(), &mut team);
        assert_eq!(team.len(), 1);
        let cfg = team.get("team-db").unwrap();
        assert_eq!(cfg.server_type, "local");
        assert_eq!(cfg.command, vec!["npx", "-y", "team-db-mcp"]);
    }

    /// The legacy directory is still read, but never last — so a stale copy in a
    /// synced team repo cannot shadow what the member actually installed.
    #[test]
    fn legacy_team_mcp_directory_is_read_but_never_wins() {
        let ws = tempfile::tempdir().unwrap();
        let dirs = team_mcp_dirs(ws.path());
        assert!(!dirs.is_empty());
        assert!(dirs[0].starts_with(ws.path()), "legacy dir comes first");
    }

    #[test]
    fn merge_workspace_overrides_team_on_name_collision() {
        let mut team = HashMap::new();
        team.insert("supabase".to_owned(), local_cfg(&["npx", "team-supabase"]));

        let mut persisted = HashMap::new();
        persisted.insert("supabase".to_owned(), local_cfg(&["npx", "local-supabase"]));

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
        assert_eq!(
            merged.get("team-only").unwrap().source.as_deref(),
            Some("team")
        );
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
        std::fs::write(
            ws.path().join("opencode.json"),
            r#"{"mcp":{"shared":{"type":"local","enabled":true,"command":["npx","local"]}}}"#,
        )
        .unwrap();

        let mut team = HashMap::new();
        team.insert("team-a".to_owned(), local_cfg(&["npx", "a"]));
        team.insert("shared".to_owned(), local_cfg(&["npx", "team"]));

        let outcome = materialize_team_mcp_entries(ws.path(), &team).unwrap();
        assert!(outcome.changed);
        assert_eq!(outcome.added_count, 1);

        let persisted = read_persisted_mcp(ws.path()).unwrap();
        assert_eq!(
            persisted.get("shared").unwrap().command,
            vec!["npx", "local"]
        );
        assert_eq!(persisted.get("team-a").unwrap().command, vec!["npx", "a"]);
    }
}

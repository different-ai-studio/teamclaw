//! Workspace configuration control — provider, permission, allowlist, runtime APIs.
//!
//! `WorkspaceControlStore` is the daemon-internal abstraction that owns
//! all reads and writes to workspace-scoped settings. HTTP handlers call
//! into this trait; they never touch `opencode.json` or the allowlist file
//! directly. The single production implementation is `OpenCodeCompatStore`,
//! which maps TeamClaw-native types to/from the on-disk formats OpenCode
//! already uses. This keeps the compatibility surface below the daemon
//! boundary so future replacements only require a new `WorkspaceControlStore`
//! implementation.

pub use super::roles_skills::{
    delete_role, delete_skill, scan_roles_skills_state, upsert_role, upsert_skill, ManagedSkillDto,
    RoleRecordDto, RolesSkillsStateDto, UpsertRoleRequest, UpsertSkillRequest,
};

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

// ── Error ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum WorkspaceControlError {
    WorkspaceNotFound(String),
    NotFound(String),
    Io(String),
    Parse(String),
    /// Caller supplied an unsafe or out-of-bounds path/segment. Maps to 400.
    InvalidInput(String),
}

impl std::fmt::Display for WorkspaceControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WorkspaceNotFound(id) => write!(f, "workspace not found: {id}"),
            Self::NotFound(msg) => write!(f, "not found: {msg}"),
            Self::Io(e) => write!(f, "io error: {e}"),
            Self::Parse(e) => write!(f, "parse error: {e}"),
            Self::InvalidInput(msg) => write!(f, "invalid input: {msg}"),
        }
    }
}

impl std::error::Error for WorkspaceControlError {}

// ── Apply outcome ─────────────────────────────────────────────────────────────

/// What happened after a workspace config mutation. Clients use this to
/// decide whether to surface a "restart required" banner.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyOutcome {
    /// Change took effect immediately (no agent restart needed).
    AppliedLive,
    /// OpenCode will pick up the change on next workspace reload.
    ReloadRequired,
    /// The running agent must be restarted for the change to take effect.
    RestartRequired,
}

// ── Provider types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    pub display_name: String,
    /// True when an api_key (or ${ref}) is stored for this provider.
    pub authenticated: bool,
    pub base_url: Option<String>,
    /// Model IDs advertised by this provider in opencode.json.
    pub models: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ProviderAuthRequest {
    pub api_key: String,
    pub base_url: Option<String>,
    pub display_name: Option<String>,
    #[serde(default)]
    pub models: Vec<ProviderModelConfig>,
}

#[derive(Debug, Deserialize)]
pub struct ProviderModelConfig {
    pub model_id: String,
    pub model_name: Option<String>,
}

// ── Permission types ──────────────────────────────────────────────────────────

/// Maps skill name / glob pattern to an allow/deny/ask action.
/// Corresponds to `permission.skill` in opencode.json.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionAction {
    Allow,
    Deny,
    Ask,
}

/// Skill permission configuration for a workspace. The `skills` map uses
/// the same key format opencode.json uses: exact skill name or glob like
/// `"myns/*"`. The special key `"*"` sets the default.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PermissionConfig {
    #[serde(default)]
    pub skills: HashMap<String, PermissionAction>,
    /// Non-skill permission defaults (e.g. `"bash"`, `"read"`) stored at the
    /// root of `permission` in opencode.json, outside the `skill` sub-object.
    #[serde(default)]
    pub tools: HashMap<String, PermissionAction>,
}

// ── Allowlist types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AllowlistDecision {
    Allow,
    Deny,
}

/// A permanently-remembered tool-call decision for a workspace project.
/// Stored in `<workspace>/.teamclaw/allowlist.json` (daemon-owned).
/// Fields intentionally mirror the component's `PermissionRule` shape so
/// the frontend can use them directly without transformation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowlistRule {
    pub project_id: String,
    /// Tool / skill name (e.g. `"bash"`, `"read_file"`).
    pub permission: String,
    /// Argument or file-path pattern being allowlisted.
    pub pattern: String,
    pub decision: AllowlistDecision,
}

// ── MCP types ─────────────────────────────────────────────────────────────────

/// One MCP server entry from the `mcp` section of opencode.json.
/// Field names intentionally match the frontend `MCPServerConfig` and the
/// existing `mcp.rs` Tauri command type so JSON round-trips are lossless.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// Server kind: `"local"` (stdio) or `"remote"` (HTTP). Defaults to `""` when
    /// not present in the JSON so we can safely round-trip entries written by
    /// other tools that omit the field.
    #[serde(rename = "type", default, skip_serializing_if = "String::is_empty")]
    pub server_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Command + args for `type = "local"` stdio servers.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub environment: HashMap<String, String>,
    /// Base URL for `type = "remote"` HTTP servers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub headers: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
    /// Provenance for merged MCP views (`workspace` | `team` | `inherent`). Omitted on disk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Unknown fields are preserved so the daemon never silently drops
    /// opencode.json keys it does not yet understand.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

// ── Runtime status ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct RuntimeRefreshDto {
    pub status: String,
    pub change_kinds: Vec<String>,
    pub recommended_action: String,
    pub auto_apply_blocked_by_active_runtime: bool,
    pub last_detected_at: Option<String>,
    pub last_error: Option<String>,
}

impl RuntimeRefreshDto {
    pub fn clean() -> Self {
        Self {
            status: "clean".to_owned(),
            change_kinds: Vec::new(),
            recommended_action: "none".to_owned(),
            auto_apply_blocked_by_active_runtime: false,
            last_detected_at: None,
            last_error: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RuntimeStatus {
    pub workspace_id: String,
    /// Whether an agent runtime is currently running for this workspace.
    pub ready: bool,
    pub backend: String,
    pub current_model: Option<String>,
    pub refresh: RuntimeRefreshDto,
}

// ── WorkspaceControlStore trait ───────────────────────────────────────────────

pub trait WorkspaceControlStore: Send + Sync {
    fn get_providers(&self, workspace_id: &str)
        -> Result<Vec<ProviderInfo>, WorkspaceControlError>;

    fn put_provider_auth(
        &self,
        workspace_id: &str,
        provider_id: &str,
        req: ProviderAuthRequest,
    ) -> Result<ApplyOutcome, WorkspaceControlError>;

    fn delete_provider_auth(
        &self,
        workspace_id: &str,
        provider_id: &str,
    ) -> Result<ApplyOutcome, WorkspaceControlError>;

    fn get_permissions(
        &self,
        workspace_id: &str,
    ) -> Result<PermissionConfig, WorkspaceControlError>;

    fn put_permissions(
        &self,
        workspace_id: &str,
        config: PermissionConfig,
    ) -> Result<ApplyOutcome, WorkspaceControlError>;

    fn get_allowlist(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<AllowlistRule>, WorkspaceControlError>;

    fn put_allowlist(
        &self,
        workspace_id: &str,
        rules: Vec<AllowlistRule>,
    ) -> Result<ApplyOutcome, WorkspaceControlError>;

    fn get_mcp(
        &self,
        workspace_id: &str,
    ) -> Result<HashMap<String, McpServerConfig>, WorkspaceControlError>;

    fn put_mcp(
        &self,
        workspace_id: &str,
        servers: HashMap<String, McpServerConfig>,
    ) -> Result<ApplyOutcome, WorkspaceControlError>;

    fn get_roles_skills_state(
        &self,
        workspace_id: &str,
    ) -> Result<RolesSkillsStateDto, WorkspaceControlError>;

    fn get_skills(&self, workspace_id: &str)
        -> Result<Vec<ManagedSkillDto>, WorkspaceControlError>;

    fn get_roles(&self, workspace_id: &str) -> Result<Vec<RoleRecordDto>, WorkspaceControlError>;

    fn put_skill(
        &self,
        workspace_id: &str,
        slug: &str,
        req: UpsertSkillRequest,
    ) -> Result<ManagedSkillDto, WorkspaceControlError>;

    fn delete_skill(
        &self,
        workspace_id: &str,
        slug: &str,
        dir_path: Option<&str>,
    ) -> Result<ApplyOutcome, WorkspaceControlError>;

    fn put_role(
        &self,
        workspace_id: &str,
        slug: &str,
        req: UpsertRoleRequest,
    ) -> Result<RoleRecordDto, WorkspaceControlError>;

    fn delete_role(
        &self,
        workspace_id: &str,
        slug: &str,
        file_path: Option<&str>,
    ) -> Result<ApplyOutcome, WorkspaceControlError>;

    fn get_runtime_status(
        &self,
        workspace_id: &str,
    ) -> Result<RuntimeStatus, WorkspaceControlError>;

    fn reload_runtime(&self, workspace_id: &str) -> Result<ApplyOutcome, WorkspaceControlError>;
}

// ── opencode.json internal schema ────────────────────────────────────────────

/// The subset of opencode.json that WorkspaceControlStore reads and writes.
/// Unknown fields are preserved via `extra` so round-trips don't lose data.
#[derive(Debug, Deserialize, Serialize, Default)]
struct OpencodeJson {
    #[serde(default)]
    provider: HashMap<String, OcProviderEntry>,
    #[serde(default)]
    permission: OcPermissionSection,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    mcp: HashMap<String, McpServerConfig>,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
struct OcProviderEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    /// npm package name (e.g. `@ai-sdk/openai-compatible`)
    #[serde(skip_serializing_if = "Option::is_none")]
    npm: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    options: HashMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    models: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
struct OcPermissionSection {
    /// skill name / glob → "allow" | "deny" | "ask"
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    skill: HashMap<String, String>,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

// ── OpenCodeCompatStore ───────────────────────────────────────────────────────

/// Production implementation of `WorkspaceControlStore` that persists to the
/// on-disk formats OpenCode already uses. The daemon owns reads/writes to:
/// - `<workspace_path>/opencode.json` — providers, skill permissions
/// - `<workspace_path>/.teamclaw/allowlist.json` — permanently-remembered
///   tool-call decisions (daemon-owned sidecar; separate from OpenCode's
///   SQLite allowlist DB)
/// Stateless workspace-control store. The workspace identity is the
/// **base64url-encoded absolute filesystem path** — no registration step
/// required. Clients (frontend, desktop Tauri bridge) call
/// `base64url(workspacePath)` and pass the result as the `:id` URL segment.
pub struct OpenCodeCompatStore {
    /// Coarse write mutex: one workspace write at a time per process.
    write_lock: Mutex<()>,
}

/// Decode a base64url workspace-ID to an absolute filesystem path.
pub fn decode_workspace_path(workspace_id: &str) -> Result<PathBuf, WorkspaceControlError> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let bytes = URL_SAFE_NO_PAD
        .decode(workspace_id)
        .map_err(|_| WorkspaceControlError::WorkspaceNotFound(workspace_id.to_owned()))?;
    let path_str = String::from_utf8(bytes)
        .map_err(|_| WorkspaceControlError::WorkspaceNotFound(workspace_id.to_owned()))?;
    let path = PathBuf::from(&path_str);
    if path.is_dir() {
        Ok(path)
    } else {
        Err(WorkspaceControlError::WorkspaceNotFound(path_str))
    }
}

impl OpenCodeCompatStore {
    pub fn new() -> Self {
        Self {
            write_lock: Mutex::new(()),
        }
    }

    fn workspace_path(&self, workspace_id: &str) -> Result<PathBuf, WorkspaceControlError> {
        decode_workspace_path(workspace_id)
    }

    fn opencode_json_path(workspace_path: &std::path::Path) -> PathBuf {
        workspace_path.join("opencode.json")
    }

    fn teamclaw_json_path(workspace_path: &std::path::Path) -> PathBuf {
        workspace_path.join("teamclaw.json")
    }

    fn allowlist_path(workspace_path: &std::path::Path) -> PathBuf {
        workspace_path.join(".teamclaw").join("allowlist.json")
    }

    /// True when `options.apiKey` is a non-empty literal or `${env_ref}` placeholder.
    fn provider_entry_authenticated(entry: &OcProviderEntry) -> bool {
        entry
            .options
            .get("apiKey")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.trim().is_empty())
    }

    fn read_opencode_json(
        workspace_path: &std::path::Path,
    ) -> Result<OpencodeJson, WorkspaceControlError> {
        let path = Self::opencode_json_path(workspace_path);
        if !path.exists() {
            return Ok(OpencodeJson::default());
        }
        let content =
            std::fs::read_to_string(&path).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
        serde_json::from_str(&content).map_err(|e| WorkspaceControlError::Parse(e.to_string()))
    }

    /// Legacy workspace-root `teamclaw.json` may still define custom providers.
    fn read_teamclaw_json(
        workspace_path: &std::path::Path,
    ) -> Result<OpencodeJson, WorkspaceControlError> {
        let path = Self::teamclaw_json_path(workspace_path);
        if !path.exists() {
            return Ok(OpencodeJson::default());
        }
        let content =
            std::fs::read_to_string(&path).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
        serde_json::from_str(&content).map_err(|e| WorkspaceControlError::Parse(e.to_string()))
    }

    fn merged_provider_entries(
        workspace_path: &std::path::Path,
    ) -> Result<HashMap<String, OcProviderEntry>, WorkspaceControlError> {
        let mut merged = Self::read_teamclaw_json(workspace_path)?.provider;
        merged.extend(Self::read_opencode_json(workspace_path)?.provider);
        Ok(merged)
    }

    fn write_opencode_json(
        workspace_path: &std::path::Path,
        cfg: &OpencodeJson,
    ) -> Result<(), WorkspaceControlError> {
        let path = Self::opencode_json_path(workspace_path);
        let content = serde_json::to_string_pretty(cfg)
            .map_err(|e| WorkspaceControlError::Parse(e.to_string()))?;
        std::fs::write(&path, content).map_err(|e| WorkspaceControlError::Io(e.to_string()))
    }

    fn read_allowlist(
        workspace_path: &std::path::Path,
    ) -> Result<Vec<AllowlistRule>, WorkspaceControlError> {
        let path = Self::allowlist_path(workspace_path);
        if !path.exists() {
            return Ok(vec![]);
        }
        let content =
            std::fs::read_to_string(&path).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
        serde_json::from_str(&content).map_err(|e| WorkspaceControlError::Parse(e.to_string()))
    }

    fn write_allowlist(
        workspace_path: &std::path::Path,
        rules: &[AllowlistRule],
    ) -> Result<(), WorkspaceControlError> {
        let path = Self::allowlist_path(workspace_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
        }
        let content = serde_json::to_string_pretty(rules)
            .map_err(|e| WorkspaceControlError::Parse(e.to_string()))?;
        std::fs::write(&path, content).map_err(|e| WorkspaceControlError::Io(e.to_string()))
    }

    fn parse_permission_action(value: &str) -> Option<PermissionAction> {
        match value {
            "allow" => Some(PermissionAction::Allow),
            "deny" => Some(PermissionAction::Deny),
            "ask" => Some(PermissionAction::Ask),
            _ => None,
        }
    }

    fn permission_action_label(action: PermissionAction) -> &'static str {
        match action {
            PermissionAction::Allow => "allow",
            PermissionAction::Deny => "deny",
            PermissionAction::Ask => "ask",
        }
    }
}

impl Default for OpenCodeCompatStore {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceControlStore for OpenCodeCompatStore {
    fn get_providers(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ProviderInfo>, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let merged = Self::merged_provider_entries(&wpath)?;

        let providers = merged
            .iter()
            .map(|(id, entry)| {
                let base_url = entry
                    .options
                    .get("baseURL")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                let authenticated = Self::provider_entry_authenticated(entry);
                let models = entry.models.keys().cloned().collect();
                ProviderInfo {
                    id: id.clone(),
                    display_name: entry.name.clone().unwrap_or_else(|| id.clone()),
                    authenticated,
                    base_url,
                    models,
                }
            })
            .collect();

        Ok(providers)
    }

    fn put_provider_auth(
        &self,
        workspace_id: &str,
        provider_id: &str,
        req: ProviderAuthRequest,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        let mut cfg = Self::read_opencode_json(&wpath)?;
        let merged = Self::merged_provider_entries(&wpath)?;

        let mut entry = merged
            .get(provider_id)
            .cloned()
            .or_else(|| cfg.provider.get(provider_id).cloned())
            .unwrap_or_default();

        let api_key = if req.api_key.trim().is_empty() {
            entry
                .options
                .get("apiKey")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned()
        } else {
            req.api_key
        };
        if api_key.trim().is_empty() {
            return Err(WorkspaceControlError::InvalidInput(
                "api_key must not be empty".to_owned(),
            ));
        }

        if let Some(name) = req.display_name.as_ref() {
            entry.name = Some(name.clone());
        }
        if entry.npm.is_none() && (req.display_name.is_some() || req.base_url.is_some()) {
            entry.npm = Some("@ai-sdk/openai-compatible".to_owned());
        }
        entry
            .options
            .insert("apiKey".to_owned(), serde_json::Value::String(api_key));
        if let Some(base_url) = req.base_url {
            entry
                .options
                .insert("baseURL".to_owned(), serde_json::Value::String(base_url));
        }
        for model in req.models {
            let model_val = serde_json::json!({
                "name": model.model_name.unwrap_or_else(|| model.model_id.clone()),
            });
            entry.models.insert(model.model_id, model_val);
        }

        cfg.provider.insert(provider_id.to_owned(), entry);
        Self::write_opencode_json(&wpath, &cfg)?;
        Ok(ApplyOutcome::RestartRequired)
    }

    fn delete_provider_auth(
        &self,
        workspace_id: &str,
        provider_id: &str,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        let mut cfg = Self::read_opencode_json(&wpath)?;

        cfg.provider.remove(provider_id);
        Self::write_opencode_json(&wpath, &cfg)?;
        Ok(ApplyOutcome::RestartRequired)
    }

    fn get_permissions(
        &self,
        workspace_id: &str,
    ) -> Result<PermissionConfig, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let cfg = Self::read_opencode_json(&wpath)?;

        let skills = cfg
            .permission
            .skill
            .iter()
            .filter_map(|(k, v)| Self::parse_permission_action(v).map(|action| (k.clone(), action)))
            .collect();

        let tools = cfg
            .permission
            .extra
            .iter()
            .filter_map(|(k, v)| {
                let s = v.as_str()?;
                Self::parse_permission_action(s).map(|action| (k.clone(), action))
            })
            .collect();

        Ok(PermissionConfig { skills, tools })
    }

    fn put_permissions(
        &self,
        workspace_id: &str,
        config: PermissionConfig,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        let mut cfg = Self::read_opencode_json(&wpath)?;

        if !config.skills.is_empty() {
            cfg.permission.skill = config
                .skills
                .into_iter()
                .map(|(k, v)| (k, Self::permission_action_label(v).to_owned()))
                .collect();
        }

        if !config.tools.is_empty() {
            for (k, v) in config.tools {
                cfg.permission.extra.insert(
                    k,
                    serde_json::Value::String(Self::permission_action_label(v).to_owned()),
                );
            }
        }

        Self::write_opencode_json(&wpath, &cfg)?;
        Ok(ApplyOutcome::RestartRequired)
    }

    fn get_allowlist(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<AllowlistRule>, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        Self::read_allowlist(&wpath)
    }

    fn put_allowlist(
        &self,
        workspace_id: &str,
        rules: Vec<AllowlistRule>,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        Self::write_allowlist(&wpath, &rules)?;
        Ok(ApplyOutcome::AppliedLive)
    }

    fn get_runtime_status(
        &self,
        workspace_id: &str,
    ) -> Result<RuntimeStatus, WorkspaceControlError> {
        let _wpath = self.workspace_path(workspace_id)?;
        Ok(RuntimeStatus {
            workspace_id: workspace_id.to_owned(),
            // Runtime readiness is owned by RuntimeManager; the compat store
            // reports a static view. Phase D wires in the real status.
            ready: false,
            backend: "opencode".to_owned(),
            current_model: None,
            refresh: RuntimeRefreshDto::clean(),
        })
    }

    fn reload_runtime(&self, workspace_id: &str) -> Result<ApplyOutcome, WorkspaceControlError> {
        let _wpath = self.workspace_path(workspace_id)?;
        // Reload is driven by RuntimeManager; this stub records intent.
        // Phase D wires in the real reload signal.
        Ok(ApplyOutcome::ReloadRequired)
    }

    fn get_mcp(
        &self,
        workspace_id: &str,
    ) -> Result<HashMap<String, McpServerConfig>, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        super::team_mcp::load_merged_mcp(&wpath)
    }

    fn put_mcp(
        &self,
        workspace_id: &str,
        servers: HashMap<String, McpServerConfig>,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        let workspace_only = super::team_mcp::filter_put_body(&wpath, servers);
        let mut cfg = Self::read_opencode_json(&wpath)?;
        cfg.mcp = workspace_only;
        Self::write_opencode_json(&wpath, &cfg)?;
        super::team_mcp::materialize_team_mcp_for_runtime(&wpath)?;
        // OpenCode re-reads mcp on next session start; a running session
        // needs a restart to pick up server changes.
        Ok(ApplyOutcome::RestartRequired)
    }

    fn get_roles_skills_state(
        &self,
        workspace_id: &str,
    ) -> Result<RolesSkillsStateDto, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        scan_roles_skills_state(&wpath)
    }

    fn get_skills(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ManagedSkillDto>, WorkspaceControlError> {
        Ok(self.get_roles_skills_state(workspace_id)?.skills)
    }

    fn get_roles(&self, workspace_id: &str) -> Result<Vec<RoleRecordDto>, WorkspaceControlError> {
        Ok(self.get_roles_skills_state(workspace_id)?.roles)
    }

    fn put_skill(
        &self,
        workspace_id: &str,
        slug: &str,
        req: UpsertSkillRequest,
    ) -> Result<ManagedSkillDto, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        upsert_skill(&wpath, slug, &req)
    }

    fn delete_skill(
        &self,
        workspace_id: &str,
        slug: &str,
        dir_path: Option<&str>,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        delete_skill(&wpath, slug, dir_path)?;
        Ok(ApplyOutcome::ReloadRequired)
    }

    fn put_role(
        &self,
        workspace_id: &str,
        slug: &str,
        req: UpsertRoleRequest,
    ) -> Result<RoleRecordDto, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        upsert_role(&wpath, slug, &req)
    }

    fn delete_role(
        &self,
        workspace_id: &str,
        slug: &str,
        file_path: Option<&str>,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        delete_role(&wpath, slug, file_path)?;
        Ok(ApplyOutcome::ReloadRequired)
    }
}

// ── NullWorkspaceControlStore ─────────────────────────────────────────────────

/// Default no-op store used when no workspace control is configured (e.g.
/// in tests that don't exercise workspace routes). Every method returns
/// `WorkspaceNotFound` so workspace routes respond 404 gracefully.
pub struct NullWorkspaceControlStore;

impl WorkspaceControlStore for NullWorkspaceControlStore {
    fn get_providers(&self, id: &str) -> Result<Vec<ProviderInfo>, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn put_provider_auth(
        &self,
        id: &str,
        _: &str,
        _: ProviderAuthRequest,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn delete_provider_auth(
        &self,
        id: &str,
        _: &str,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn get_permissions(&self, id: &str) -> Result<PermissionConfig, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn put_permissions(
        &self,
        id: &str,
        _: PermissionConfig,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn get_allowlist(&self, id: &str) -> Result<Vec<AllowlistRule>, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn put_allowlist(
        &self,
        id: &str,
        _: Vec<AllowlistRule>,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn get_mcp(&self, id: &str) -> Result<HashMap<String, McpServerConfig>, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn put_mcp(
        &self,
        id: &str,
        _: HashMap<String, McpServerConfig>,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn get_roles_skills_state(
        &self,
        id: &str,
    ) -> Result<RolesSkillsStateDto, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn get_skills(&self, id: &str) -> Result<Vec<ManagedSkillDto>, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn get_roles(&self, id: &str) -> Result<Vec<RoleRecordDto>, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn put_skill(
        &self,
        id: &str,
        _: &str,
        _: UpsertSkillRequest,
    ) -> Result<ManagedSkillDto, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn delete_skill(
        &self,
        id: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn put_role(
        &self,
        id: &str,
        _: &str,
        _: UpsertRoleRequest,
    ) -> Result<RoleRecordDto, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn delete_role(
        &self,
        id: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn get_runtime_status(&self, id: &str) -> Result<RuntimeStatus, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn reload_runtime(&self, id: &str) -> Result<ApplyOutcome, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn make_store() -> OpenCodeCompatStore {
        OpenCodeCompatStore::new()
    }

    /// Encode an absolute path as a base64url workspace ID (mirrors the
    /// frontend `encodeWorkspaceId` helper in daemon-local-client.ts).
    fn ws_id(path: &std::path::Path) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        URL_SAFE_NO_PAD.encode(path.to_str().unwrap())
    }

    #[test]
    fn get_providers_empty_workspace_returns_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let providers = store.get_providers(&ws_id(dir.path())).unwrap();
        assert!(providers.is_empty());
    }

    #[test]
    fn get_providers_merges_teamclaw_json_with_opencode() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("teamclaw.json"),
            r#"{
  "provider": {
    "scnet": {
      "name": "scnet",
      "options": { "baseURL": "https://api.example.com/v1", "apiKey": "${scnet_api_key}" },
      "models": { "MiniMax-M2.5": { "name": "MiniMax-M2.5" } }
    }
  }
}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("opencode.json"),
            r#"{
  "provider": {
    "team": {
      "name": "Team",
      "options": { "baseURL": "https://team.example/v1", "apiKey": "sk-team" },
      "models": { "gpt-5.2": { "name": "gpt-5.2" } }
    }
  }
}"#,
        )
        .unwrap();

        let store = make_store();
        let providers = store.get_providers(&ws_id(root)).unwrap();
        assert_eq!(providers.len(), 2);
        let scnet = providers.iter().find(|p| p.id == "scnet").unwrap();
        assert!(scnet.authenticated);
        assert!(scnet.models.contains(&"MiniMax-M2.5".to_owned()));
        let team = providers.iter().find(|p| p.id == "team").unwrap();
        assert!(team.authenticated);
    }

    #[test]
    fn put_provider_auth_creates_entry_and_get_returns_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let wid = ws_id(dir.path());

        let outcome = store
            .put_provider_auth(
                &wid,
                "my-llm",
                ProviderAuthRequest {
                    api_key: "sk-test".to_owned(),
                    base_url: Some("https://api.example.com/v1".to_owned()),
                    display_name: Some("My LLM".to_owned()),
                    models: vec![ProviderModelConfig {
                        model_id: "my-llm/gpt-4".to_owned(),
                        model_name: Some("GPT-4".to_owned()),
                    }],
                },
            )
            .unwrap();

        assert!(matches!(outcome, ApplyOutcome::RestartRequired));

        let providers = store.get_providers(&wid).unwrap();
        assert_eq!(providers.len(), 1);
        let p = &providers[0];
        assert_eq!(p.id, "my-llm");
        assert_eq!(p.display_name, "My LLM");
        assert!(p.authenticated);
        assert_eq!(p.base_url.as_deref(), Some("https://api.example.com/v1"));
        assert!(p.models.contains(&"my-llm/gpt-4".to_owned()));
    }

    #[test]
    fn put_provider_auth_merges_existing_teamclaw_provider_when_connecting_api_key() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("teamclaw.json"),
            r#"{
  "provider": {
    "scnet": {
      "name": "scnet",
      "options": { "baseURL": "https://api.example.com/v1" },
      "models": { "MiniMax-M2.5": { "name": "MiniMax-M2.5" } }
    }
  }
}"#,
        )
        .unwrap();

        let store = make_store();
        let wid = ws_id(root);

        store
            .put_provider_auth(
                &wid,
                "scnet",
                ProviderAuthRequest {
                    api_key: "sk-live".to_owned(),
                    base_url: None,
                    display_name: None,
                    models: vec![],
                },
            )
            .unwrap();

        let providers = store.get_providers(&wid).unwrap();
        let scnet = providers.iter().find(|p| p.id == "scnet").unwrap();
        assert!(scnet.authenticated);
        assert_eq!(
            scnet.base_url.as_deref(),
            Some("https://api.example.com/v1")
        );
        assert!(scnet.models.contains(&"MiniMax-M2.5".to_owned()));

        let opencode = std::fs::read_to_string(root.join("opencode.json")).unwrap();
        assert!(opencode.contains("sk-live"));
        assert!(!opencode.contains("@ai-sdk/openai-compatible"));
    }

    #[test]
    fn put_provider_auth_preserves_existing_api_key_when_update_omits_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let wid = ws_id(dir.path());

        store
            .put_provider_auth(
                &wid,
                "my-llm",
                ProviderAuthRequest {
                    api_key: "sk-test".to_owned(),
                    base_url: Some("https://api.example.com/v1".to_owned()),
                    display_name: Some("My LLM".to_owned()),
                    models: vec![ProviderModelConfig {
                        model_id: "gpt-4".to_owned(),
                        model_name: Some("GPT-4".to_owned()),
                    }],
                },
            )
            .unwrap();

        store
            .put_provider_auth(
                &wid,
                "my-llm",
                ProviderAuthRequest {
                    api_key: String::new(),
                    base_url: Some("https://api.example.com/v2".to_owned()),
                    display_name: Some("My LLM v2".to_owned()),
                    models: vec![ProviderModelConfig {
                        model_id: "gpt-4o".to_owned(),
                        model_name: Some("GPT-4o".to_owned()),
                    }],
                },
            )
            .unwrap();

        let providers = store.get_providers(&wid).unwrap();
        let provider = providers.iter().find(|p| p.id == "my-llm").unwrap();
        assert_eq!(provider.display_name, "My LLM v2");
        assert_eq!(
            provider.base_url.as_deref(),
            Some("https://api.example.com/v2")
        );
        assert!(provider.authenticated);
        assert!(provider.models.contains(&"gpt-4o".to_owned()));
    }

    #[test]
    fn delete_provider_auth_removes_entry() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let wid = ws_id(dir.path());

        store
            .put_provider_auth(
                &wid,
                "to-remove",
                ProviderAuthRequest {
                    api_key: "sk-x".to_owned(),
                    base_url: None,
                    display_name: None,
                    models: vec![],
                },
            )
            .unwrap();

        store.delete_provider_auth(&wid, "to-remove").unwrap();
        let providers = store.get_providers(&wid).unwrap();
        assert!(providers.is_empty());
    }

    #[test]
    fn put_and_get_permissions_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let wid = ws_id(dir.path());

        let config = PermissionConfig {
            skills: HashMap::from([
                ("*".to_owned(), PermissionAction::Ask),
                ("bash".to_owned(), PermissionAction::Allow),
                ("network/*".to_owned(), PermissionAction::Deny),
            ]),
            ..Default::default()
        };

        store.put_permissions(&wid, config.clone()).unwrap();
        let got = store.get_permissions(&wid).unwrap();

        assert_eq!(got.skills.get("*"), Some(&PermissionAction::Ask));
        assert_eq!(got.skills.get("bash"), Some(&PermissionAction::Allow));
        assert_eq!(got.skills.get("network/*"), Some(&PermissionAction::Deny));
    }

    #[test]
    fn put_and_get_tool_permissions_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let wid = ws_id(dir.path());

        store
            .put_permissions(
                &wid,
                PermissionConfig {
                    tools: HashMap::from([
                        ("bash".to_owned(), PermissionAction::Allow),
                        ("read".to_owned(), PermissionAction::Ask),
                    ]),
                    ..Default::default()
                },
            )
            .unwrap();

        let got = store.get_permissions(&wid).unwrap();
        assert_eq!(got.tools.get("bash"), Some(&PermissionAction::Allow));
        assert_eq!(got.tools.get("read"), Some(&PermissionAction::Ask));
    }

    #[test]
    fn put_skills_only_does_not_clear_tool_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let wid = ws_id(dir.path());

        store
            .put_permissions(
                &wid,
                PermissionConfig {
                    tools: HashMap::from([("bash".to_owned(), PermissionAction::Allow)]),
                    ..Default::default()
                },
            )
            .unwrap();

        store
            .put_permissions(
                &wid,
                PermissionConfig {
                    skills: HashMap::from([("*".to_owned(), PermissionAction::Ask)]),
                    ..Default::default()
                },
            )
            .unwrap();

        let got = store.get_permissions(&wid).unwrap();
        assert_eq!(got.skills.get("*"), Some(&PermissionAction::Ask));
        assert_eq!(got.tools.get("bash"), Some(&PermissionAction::Allow));
    }

    #[test]
    fn put_and_get_allowlist_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let wid = ws_id(dir.path());

        let rules = vec![
            AllowlistRule {
                project_id: "proj-1".to_owned(),
                permission: "bash".to_owned(),
                pattern: "rm -rf *".to_owned(),
                decision: AllowlistDecision::Deny,
            },
            AllowlistRule {
                project_id: "proj-1".to_owned(),
                permission: "read_file".to_owned(),
                pattern: "*".to_owned(),
                decision: AllowlistDecision::Allow,
            },
        ];

        store.put_allowlist(&wid, rules.clone()).unwrap();
        let got = store.get_allowlist(&wid).unwrap();

        assert_eq!(got.len(), 2);
        assert_eq!(got[0].project_id, "proj-1");
        assert_eq!(got[0].permission, "bash");
        assert_eq!(got[0].pattern, "rm -rf *");
        assert_eq!(got[1].decision, AllowlistDecision::Allow);
    }

    #[test]
    fn opencode_json_round_trip_preserves_unknown_fields() {
        let dir = tempfile::tempdir().unwrap();
        let wid = ws_id(dir.path());

        let json = serde_json::json!({
            "provider": {},
            "someOtherKey": "preserved",
            "mcp": { "server1": {} }
        });
        std::fs::write(
            dir.path().join("opencode.json"),
            serde_json::to_string_pretty(&json).unwrap(),
        )
        .unwrap();

        let store = make_store();
        store
            .put_provider_auth(
                &wid,
                "p1",
                ProviderAuthRequest {
                    api_key: "sk".to_owned(),
                    base_url: None,
                    display_name: None,
                    models: vec![],
                },
            )
            .unwrap();

        let content = std::fs::read_to_string(dir.path().join("opencode.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["someOtherKey"], "preserved");
        assert_eq!(parsed["mcp"]["server1"], serde_json::json!({}));
    }

    #[test]
    fn get_mcp_empty_workspace_returns_empty_map() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let servers = store.get_mcp(&ws_id(dir.path())).unwrap();
        assert!(servers.is_empty());
    }

    #[test]
    fn put_and_get_mcp_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let wid = ws_id(dir.path());

        let mut servers = HashMap::new();
        servers.insert(
            "playwright".to_owned(),
            McpServerConfig {
                server_type: "local".to_owned(),
                enabled: Some(true),
                command: vec!["npx".to_owned(), "@playwright/mcp".to_owned()],
                environment: HashMap::new(),
                url: None,
                headers: HashMap::new(),
                timeout: None,
                source: None,
                extra: HashMap::new(),
            },
        );

        let outcome = store.put_mcp(&wid, servers.clone()).unwrap();
        assert!(matches!(outcome, ApplyOutcome::RestartRequired));

        let got = store.get_mcp(&wid).unwrap();
        assert_eq!(got.len(), 1);
        let s = got.get("playwright").unwrap();
        assert_eq!(s.server_type, "local");
        assert_eq!(s.command, vec!["npx", "@playwright/mcp"]);
        assert_eq!(s.enabled, Some(true));
    }

    #[test]
    fn put_mcp_preserves_other_opencode_json_sections() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let wid = ws_id(dir.path());

        // Seed a provider entry first.
        store
            .put_provider_auth(
                &wid,
                "openai",
                ProviderAuthRequest {
                    api_key: "sk-seed".to_owned(),
                    base_url: None,
                    display_name: None,
                    models: vec![],
                },
            )
            .unwrap();

        // Write MCP config.
        let mut servers = HashMap::new();
        servers.insert(
            "my-server".to_owned(),
            McpServerConfig {
                server_type: "remote".to_owned(),
                enabled: None,
                command: vec![],
                environment: HashMap::new(),
                url: Some("http://localhost:8080".to_owned()),
                headers: HashMap::new(),
                timeout: Some(30),
                source: None,
                extra: HashMap::new(),
            },
        );
        store.put_mcp(&wid, servers).unwrap();

        // Provider section must still be intact.
        let providers = store.get_providers(&wid).unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "openai");
    }

    #[test]
    fn null_store_returns_workspace_not_found() {
        let store: Arc<dyn WorkspaceControlStore> = Arc::new(NullWorkspaceControlStore);
        assert!(matches!(
            store.get_providers("any"),
            Err(WorkspaceControlError::WorkspaceNotFound(_))
        ));
    }

    #[test]
    fn invalid_base64_workspace_id_returns_not_found() {
        let store = make_store();
        assert!(matches!(
            store.get_providers("!!!not-base64!!!"),
            Err(WorkspaceControlError::WorkspaceNotFound(_))
        ));
    }

    #[test]
    fn nonexistent_directory_returns_not_found() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let store = make_store();
        let bogus_id = URL_SAFE_NO_PAD.encode("/tmp/definitely-does-not-exist-xyz123");
        assert!(matches!(
            store.get_providers(&bogus_id),
            Err(WorkspaceControlError::WorkspaceNotFound(_))
        ));
    }
}

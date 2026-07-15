//! Workspace runtime supervisor - bootstrap + RuntimeManager lifecycle.
//!
//! Replaces the desktop `start_opencode` sidecar path: workspace prep runs
//! here before agent spawn, and `/v1/workspaces/:id/runtime/*` handlers
//! delegate reload/status to the shared `RuntimeManager`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use tracing::{info, warn};

/// Matches `apps/desktop/src/commands/introspect_api.rs` — desktop Tauri hosts the API.
const INTROSPECT_API_PORT: u16 = 13144;
const TEAM_SKILLS_PATH: &str = "teamclaw-team/skills";
const INSTRUCTION_PLUGIN_TEMPLATE: &str = include_str!(
    "../../../../packages/app/src/lib/opencode/templates/teamclaw-instruction-plugin.mjs.txt"
);

use crate::config::workspace_control::{ApplyOutcome, RuntimeStatus, WorkspaceControlError};
use crate::proto::amux;
use crate::runtime::{
    acp_catalog_probe,
    refresh::{
        APPLY_REFRESH_SUPPRESS, INTERNAL_PREPARE_KINDS, INTERNAL_WRITE_SUPPRESS, RefreshChangeKind,
        RuntimeRefreshCoordinator, WorkspaceRefreshState,
    },
    AgentLaunchConfig, RuntimeManager,
};

struct InherentSkill {
    dirname: &'static str,
    content: &'static str,
}

fn inherent_desktop_control_skill() -> Option<InherentSkill> {
    #[cfg(target_os = "macos")]
    return Some(InherentSkill {
        dirname: "macos-control",
        content: include_str!("../../../../packages/app/src/lib/skills/macos-control/SKILL.md"),
    });

    #[cfg(target_os = "windows")]
    return Some(InherentSkill {
        dirname: "windows-control",
        content: include_str!("../../../../packages/app/src/lib/skills/windows-control/SKILL.md"),
    });

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    None
}

fn inherent_skills() -> Vec<InherentSkill> {
    let mut out = vec![InherentSkill {
        dirname: "create-role",
        content: include_str!("../../../../packages/app/src/lib/skills/create-role/SKILL.md"),
    }];
    if let Some(skill) = inherent_desktop_control_skill() {
        out.push(skill);
    }
    out
}

fn opencode_json_path(workspace_path: &Path) -> PathBuf {
    workspace_path.join("opencode.json")
}

fn read_json_object(path: &Path) -> Result<serde_json::Value, WorkspaceControlError> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content =
        std::fs::read_to_string(path).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    serde_json::from_str(&content).map_err(|e| WorkspaceControlError::Parse(e.to_string()))
}

fn write_json_pretty(path: &Path, value: &serde_json::Value) -> Result<(), WorkspaceControlError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    }
    let content = serde_json::to_string_pretty(value)
        .map_err(|e| WorkspaceControlError::Parse(e.to_string()))?;
    std::fs::write(path, content).map_err(|e| WorkspaceControlError::Io(e.to_string()))
}

/// Ensure tool-level permission defaults exist in `opencode.json`.
fn ensure_default_permissions(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    let config_path = opencode_json_path(workspace_path);
    let mut config = read_json_object(&config_path)?;
    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;

    if obj.contains_key("permission") {
        return Ok(());
    }

    obj.insert(
        "permission".to_string(),
        serde_json::json!({
            "bash": "ask",
            "edit": "ask",
            "write": "ask",
            "external_directory": "ask",
            "doom_loop": "ask"
        }),
    );

    write_json_pretty(&config_path, &config)
}

/// Seed inherent MCP entries that TeamClaw expects (non-destructive).
pub fn ensure_inherent_mcp(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    let config_path = opencode_json_path(workspace_path);
    let mut config = if config_path.exists() {
        read_json_object(&config_path)?
    } else {
        serde_json::json!({ "$schema": "https://opencode.ai/config.json" })
    };

    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;

    let mcp = obj.entry("mcp").or_insert_with(|| serde_json::json!({}));
    let mcp_obj = mcp
        .as_object_mut()
        .ok_or_else(|| WorkspaceControlError::Parse("mcp is not an object".into()))?;

    let mut changed = false;

    if !mcp_obj.contains_key("playwright") {
        mcp_obj.insert(
            "playwright".to_string(),
            serde_json::json!({
                "type": "local",
                "enabled": false,
                "command": ["npx", "-y", "@playwright/mcp@latest"]
            }),
        );
        changed = true;
    }

    if !mcp_obj.contains_key("chrome-control") {
        mcp_obj.insert(
            "chrome-control".to_string(),
            serde_json::json!({
                "type": "local",
                "enabled": true,
                "command": ["npx", "-y", "chrome-devtools-mcp@latest", "--autoConnect"]
            }),
        );
        changed = true;
    }

    ensure_extended_inherent_config(workspace_path, &mut config, &mut changed)?;

    if changed {
        write_json_pretty(&config_path, &config)?;
    }
    Ok(())
}

fn resolve_executable(path: PathBuf) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path);
    }
    #[cfg(windows)]
    {
        let with_exe = path.with_extension("exe");
        if with_exe.is_file() {
            return Some(with_exe);
        }
    }
    None
}

fn runtime_target_triple() -> &'static str {
    #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
    {
        return "aarch64-apple-darwin";
    }
    #[cfg(all(target_arch = "x86_64", target_os = "macos"))]
    {
        return "x86_64-apple-darwin";
    }
    #[cfg(all(target_arch = "aarch64", target_os = "linux"))]
    {
        return "aarch64-unknown-linux-gnu";
    }
    #[cfg(all(target_arch = "x86_64", target_os = "linux"))]
    {
        return "x86_64-unknown-linux-gnu";
    }
    #[cfg(all(target_arch = "x86_64", target_os = "windows"))]
    {
        return "x86_64-pc-windows-msvc";
    }
    #[allow(unreachable_code)]
    "unknown-unknown-unknown"
}

fn introspect_candidates_in_dir(dir: &Path) -> Option<PathBuf> {
    for candidate in [
        dir.join(format!("teamclaw-introspect-{}", runtime_target_triple())),
        dir.join("teamclaw-introspect"),
    ] {
        if let Some(resolved) = resolve_executable(candidate) {
            return Some(resolved);
        }
    }
    None
}

/// Production daemons run from `~/.amuxd/bin/amuxd`, but `teamclaw-introspect`
/// stays in the desktop app bundle (or dev `apps/desktop/binaries/`). Search
/// those locations after the current-exe directory.
fn find_introspect_in_installed_app_bundles() -> Option<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(target_os = "macos")]
    {
        roots.push(PathBuf::from("/Applications"));
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            roots.push(PathBuf::from(pf));
        }
        if let Some(pf86) = std::env::var_os("ProgramFiles(x86)") {
            roots.push(PathBuf::from(pf86));
        }
    }
    if let Some(home) = dirs::home_dir() {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            roots.push(home.join("Applications"));
        }
        #[cfg(target_os = "linux")]
        {
            roots.push(home.join(".local/share/applications"));
        }
    }

    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let bundle = entry.path();
            #[cfg(target_os = "macos")]
            {
                if bundle.extension().and_then(|e| e.to_str()) != Some("app") {
                    continue;
                }
                if let Some(found) = introspect_candidates_in_dir(&bundle.join("Contents/MacOS")) {
                    return Some(found);
                }
            }
            #[cfg(target_os = "windows")]
            {
                if !bundle.is_dir() {
                    continue;
                }
                if let Some(found) = introspect_candidates_in_dir(&bundle) {
                    return Some(found);
                }
            }
        }
    }
    None
}

fn resolve_introspect_binary() -> Option<String> {
    if std::process::Command::new("sh")
        .arg("-lc")
        .arg("command -v teamclaw-introspect")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some("teamclaw-introspect".to_string());
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(resolved) = introspect_candidates_in_dir(dir) {
                return Some(resolved.to_string_lossy().into_owned());
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        let amuxd_bin = home.join(".amuxd").join("bin");
        if let Some(resolved) = introspect_candidates_in_dir(&amuxd_bin) {
            return Some(resolved.to_string_lossy().into_owned());
        }
    }

    if let Some(resolved) = find_introspect_in_installed_app_bundles() {
        return Some(resolved.to_string_lossy().into_owned());
    }

    if let Ok(cwd) = std::env::current_dir() {
        for root in [
            cwd.clone(),
            cwd.join(".."),
            cwd.join("../.."),
            cwd.join("../../.."),
        ] {
            let candidate = root
                .join("apps/desktop/binaries")
                .join(format!("teamclaw-introspect-{}", runtime_target_triple()));
            if let Some(resolved) = resolve_executable(candidate) {
                return Some(resolved.to_string_lossy().into_owned());
            }
        }
    }

    None
}

fn introspect_command_stale(existing: &serde_json::Value) -> bool {
    existing
        .get("command")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .map(|p| !Path::new(p).exists())
        .unwrap_or(true)
}

/// Port of desktop `ensure_inherent_config` (teamclaw-introspect, autoui, skills.paths).
fn ensure_extended_inherent_config(
    workspace_path: &Path,
    config: &mut serde_json::Value,
    changed: &mut bool,
) -> Result<(), WorkspaceControlError> {
    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;

    let workspace_path_str = workspace_path.to_string_lossy();

    {
        let mcp = obj.entry("mcp").or_insert_with(|| serde_json::json!({}));
        let mcp_obj = mcp
            .as_object_mut()
            .ok_or_else(|| WorkspaceControlError::Parse("mcp is not an object".into()))?;

        let needs_introspect = match mcp_obj.get("teamclaw-introspect") {
            Some(existing) => introspect_command_stale(existing),
            None => true,
        };
        if needs_introspect {
            if let Some(introspect_bin) = resolve_introspect_binary() {
                mcp_obj.insert(
                    "teamclaw-introspect".to_string(),
                    serde_json::json!({
                        "type": "local",
                        "enabled": true,
                        "command": [
                            introspect_bin,
                            "--workspace", workspace_path_str.as_ref(),
                            "--api-port", INTROSPECT_API_PORT.to_string()
                        ]
                    }),
                );
                *changed = true;
            } else {
                warn!(
                    workspace = %workspace_path.display(),
                    "teamclaw-introspect binary not found; skipping MCP registration"
                );
            }
        }

        if !mcp_obj.contains_key("autoui") {
            mcp_obj.insert(
                "autoui".to_string(),
                serde_json::json!({
                    "type": "local",
                    "enabled": true,
                    "command": ["npx", "-y", "autoui-mcp@latest"],
                    "environment": {
                        "QWEN_API_KEY": "${QWEN_API_KEY}",
                        "QWEN_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                        "QWEN_MODEL": "qwen3-vl-flash"
                    }
                }),
            );
            *changed = true;
        } else if let Some(autoui) = mcp_obj.get_mut("autoui").and_then(|v| v.as_object_mut()) {
            let needs_restore = autoui
                .get("environment")
                .and_then(|v| v.as_object())
                .map(|env| env.is_empty())
                .unwrap_or(true);
            if needs_restore {
                autoui.insert(
                    "environment".to_string(),
                    serde_json::json!({
                        "QWEN_API_KEY": "${QWEN_API_KEY}",
                        "QWEN_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                        "QWEN_MODEL": "qwen3-vl-flash"
                    }),
                );
                *changed = true;
            }
        }
    }

    {
        let skills = obj.entry("skills").or_insert_with(|| serde_json::json!({}));
        let skills_obj = skills
            .as_object_mut()
            .ok_or_else(|| WorkspaceControlError::Parse("skills is not an object".into()))?;
        let paths_val = skills_obj
            .entry("paths")
            .or_insert_with(|| serde_json::json!([]));
        let paths = paths_val
            .as_array_mut()
            .ok_or_else(|| WorkspaceControlError::Parse("skills.paths is not an array".into()))?;
        if !paths.iter().any(|v| v.as_str() == Some(TEAM_SKILLS_PATH)) {
            paths.push(serde_json::json!(TEAM_SKILLS_PATH));
            *changed = true;
        }
    }

    Ok(())
}

fn remove_non_native_desktop_control_skills(skills_dir: &Path) {
    let remove_if_dir = |name: &str| {
        let path = skills_dir.join(name);
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        }
    };

    #[cfg(target_os = "macos")]
    remove_if_dir("windows-control");
    #[cfg(target_os = "windows")]
    remove_if_dir("macos-control");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        remove_if_dir("macos-control");
        remove_if_dir("windows-control");
    }
}

fn ensure_inherent_skills_in_dir(skills_dir: &Path) -> Result<(), WorkspaceControlError> {
    std::fs::create_dir_all(skills_dir).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    remove_non_native_desktop_control_skills(skills_dir);

    for skill in inherent_skills() {
        let skill_dir = skills_dir.join(skill.dirname);
        let skill_md = skill_dir.join("SKILL.md");
        if skill_md.exists() {
            continue;
        }
        std::fs::create_dir_all(&skill_dir)
            .map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
        std::fs::write(&skill_md, skill.content)
            .map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    }
    Ok(())
}

/// Install the TeamClaw instruction OpenCode plugin and register it in `opencode.json`.
pub fn ensure_instruction_plugin(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    use crate::runtime::workspace_runtime::{
        INSTRUCTION_PLUGIN_CONFIG_ENTRY, INSTRUCTION_PLUGIN_REL,
    };

    let plugin_path = workspace_path.join(INSTRUCTION_PLUGIN_REL);
    if let Some(parent) = plugin_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    }

    let should_write = match std::fs::read_to_string(&plugin_path) {
        Ok(existing) => existing != INSTRUCTION_PLUGIN_TEMPLATE,
        Err(_) => true,
    };
    if should_write {
        std::fs::write(&plugin_path, INSTRUCTION_PLUGIN_TEMPLATE)
            .map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    }

    let config_path = opencode_json_path(workspace_path);
    let mut config = if config_path.exists() {
        read_json_object(&config_path)?
    } else {
        serde_json::json!({ "$schema": "https://opencode.ai/config.json" })
    };

    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;

    if obj.get("$schema").is_none() {
        obj.insert(
            "$schema".to_string(),
            serde_json::json!("https://opencode.ai/config.json"),
        );
    }

    let plugins = obj
        .entry("plugin")
        .or_insert_with(|| serde_json::json!([]));
    let plugin_list = plugins.as_array_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json plugin field is not an array".into())
    })?;

    let already_registered = plugin_list.iter().any(|entry| {
        entry
            .as_str()
            .map(|value| value.contains("teamclaw-instruction"))
            .unwrap_or(false)
    });
    if !already_registered {
        plugin_list.push(serde_json::json!(INSTRUCTION_PLUGIN_CONFIG_ENTRY));
        write_json_pretty(&config_path, &config)?;
    }

    Ok(())
}

/// Prepare a workspace directory for OpenCode/ACP agent use.
pub fn prepare_workspace(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    if !workspace_path.is_dir() {
        return Err(WorkspaceControlError::WorkspaceNotFound(
            workspace_path.display().to_string(),
        ));
    }

    ensure_default_permissions(workspace_path)?;
    ensure_inherent_mcp(workspace_path)?;
    ensure_instruction_plugin(workspace_path)?;
    ensure_inherent_skills_in_dir(&workspace_path.join(".teamclaw/skills"))?;
    ensure_inherent_skills_in_dir(&workspace_path.join(".opencode/skills"))?;

    // The managed (shared) LLM is now resolved from the cloud API at spawn time
    // (see `DaemonServer::resolve_managed_llm`), which is where the team_id and a
    // cloud client are in scope. `prepare_workspace` has neither, so it passes
    // `Unknown` (a no-op) rather than reading a disk mirror — the authoritative
    // `provider.team` reconciliation happens in `assemble_runtime_env`.
    if let Err(e) = teamclaw_runtime_env::team_provider::ensure_team_provider(
        workspace_path,
        &teamclaw_runtime_env::ManagedLlmState::Unknown,
    ) {
        tracing::warn!(workspace = %workspace_path.display(), error = %e, "failed to ensure team provider");
    }
    if let Ok(Some(result)) =
        teamclaw_runtime_env::opencode_db::maybe_migrate_legacy_opencode_db(workspace_path)
    {
        if result.migrated {
            tracing::info!(workspace = %workspace_path.display(), "migrated legacy isolated OpenCode DB to global");
        }
    }

    info!(workspace = %workspace_path.display(), "workspace runtime prepared");
    Ok(())
}

fn binary_available(cfg: &AgentLaunchConfig) -> bool {
    let path = Path::new(&cfg.binary);
    if path.is_absolute() && path.exists() {
        return true;
    }
    std::process::Command::new("sh")
        .arg("-lc")
        .arg(format!("command -v {}", shell_escape(&cfg.binary)))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn shell_escape(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-:".contains(c))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn backend_label(agent_type: amux::AgentType) -> &'static str {
    match agent_type {
        amux::AgentType::Opencode => "opencode",
        amux::AgentType::ClaudeCode => "claude-code",
        amux::AgentType::Codex => "codex",
        _ => "unknown",
    }
}

pub struct RuntimeSupervisor {
    agents: Arc<AsyncMutex<RuntimeManager>>,
    refresh: Arc<RuntimeRefreshCoordinator>,
}

impl RuntimeSupervisor {
    pub fn new(agents: Arc<AsyncMutex<RuntimeManager>>) -> Arc<Self> {
        Arc::new(Self {
            agents,
            refresh: RuntimeRefreshCoordinator::new(),
        })
    }

    pub fn refresh_coordinator(&self) -> Arc<RuntimeRefreshCoordinator> {
        Arc::clone(&self.refresh)
    }

    pub fn start_refresh_auto_applier(self: Arc<Self>) -> JoinHandle<()> {
        self.start_refresh_auto_applier_with_interval(Duration::from_secs(1))
    }

    pub fn start_refresh_auto_applier_with_interval(
        self: Arc<Self>,
        interval: Duration,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                self.auto_apply_pending_refreshes().await;
            }
        })
    }

    /// Models OpenCode advertises via ACP for this workspace cwd (cron catalog).
    pub async fn probe_opencode_catalog_models(
        &self,
        workspace_path: &Path,
    ) -> Result<Vec<amux::ModelInfo>, String> {
        let launch = {
            let manager = self.agents.lock().await;
            manager.launch_config_for(amux::AgentType::Opencode)
        };
        if !binary_available(&launch) {
            return Err("opencode binary not available".into());
        }
        acp_catalog_probe::probe_opencode_models_at_cwd(
            &launch.binary,
            &launch.args,
            workspace_path.to_path_buf(),
            HashMap::new(),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn runtime_status(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> Result<RuntimeStatus, WorkspaceControlError> {
        // NOTE: status reads must be side-effect free. Workspace bootstrap
        // (writing opencode.json defaults, syncing skill dirs) happens at
        // runtime start (`runtime_adapter` spawn) and on explicit
        // `reload_workspace`, not here - otherwise polling this GET endpoint
        // would silently rewrite config and delete/recreate skill dirs.
        let manager = self.agents.lock().await;
        let agent_type = manager.default_agent_type();
        let backend = backend_label(agent_type).to_owned();
        let launch = manager.launch_config_for(agent_type);
        let backend_ready = binary_available(&launch);

        let workspace_path_str = workspace_path.to_string_lossy();
        let active: Vec<_> = manager
            .active_handles_for_workspace(&workspace_path_str, workspace_id)
            .collect();

        let current_model = active
            .iter()
            .find_map(|(agent_id, _)| manager.current_model(agent_id).cloned());

        Ok(RuntimeStatus {
            workspace_id: workspace_id.to_owned(),
            ready: backend_ready,
            backend,
            current_model,
            refresh: self.refresh.runtime_refresh_dto(workspace_id).await,
        })
    }

    pub async fn reload_workspace(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        evict_provider_hosts: bool,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        self.refresh.suppress_workspace_watch(
            workspace_id,
            &INTERNAL_PREPARE_KINDS,
            INTERNAL_WRITE_SUPPRESS,
        );
        prepare_workspace(workspace_path)?;

        let workspace_path_str = workspace_path.to_string_lossy();
        let stopped = {
            let mut manager = self.agents.lock().await;
            let stopped = manager
                .stop_runtimes_for_workspace(&workspace_path_str, workspace_id)
                .await;
            // Only nuke the pooled provider hosts when the change actually
            // affects provider auth/config. A Skills/MCP/permissions reload used
            // to evict here too, discarding the prewarmed opencode host and
            // re-cold-starting the next session — see
            // `RefreshChangeKind::requires_provider_host_evict`.
            if evict_provider_hosts {
                manager.evict_acp_hosts_after_provider_auth_change();
            }
            stopped
        };

        if stopped > 0 {
            info!(
                workspace = %workspace_path.display(),
                stopped,
                "stopped workspace runtimes for reload"
            );
            Ok(ApplyOutcome::RestartRequired)
        } else {
            Ok(ApplyOutcome::ReloadRequired)
        }
    }

    pub async fn apply_refresh(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        evict_provider_hosts: bool,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        self.refresh.suppress_workspace_watch(
            workspace_id,
            &INTERNAL_PREPARE_KINDS,
            APPLY_REFRESH_SUPPRESS,
        );
        let attempt = self
            .refresh
            .mark_applying(workspace_id, workspace_path)
            .await;
        match self
            .reload_workspace(workspace_id, workspace_path, evict_provider_hosts)
            .await
        {
            Ok(outcome) => {
                self.refresh.clear_applied(workspace_id, attempt).await;
                Ok(outcome)
            }
            Err(err) => {
                self.refresh
                    .mark_apply_failed(workspace_id, workspace_path, attempt, err.to_string())
                    .await;
                Err(err)
            }
        }
    }

    pub async fn auto_apply_pending_refreshes(&self) -> usize {
        let pending = self.refresh.pending_workspace_states().await;
        let mut applied = 0usize;
        for state in pending {
            if self.auto_apply_pending_refresh_state(state).await {
                applied += 1;
            }
        }
        applied
    }

    async fn auto_apply_pending_refresh_state(&self, state: WorkspaceRefreshState) -> bool {
        if !auto_applicable_refresh(&state) {
            self.refresh
                .set_auto_apply_blocked_by_active_runtime(&state.workspace_id, false)
                .await;
            return false;
        }

        let workspace_path = PathBuf::from(&state.workspace_path);
        let busy = {
            let manager = self.agents.lock().await;
            manager.workspace_has_active_turn(&state.workspace_path, &state.workspace_id)
        };
        if busy {
            self.refresh
                .set_auto_apply_blocked_by_active_runtime(&state.workspace_id, true)
                .await;
            info!(
                workspace_id = %state.workspace_id,
                workspace_path = %state.workspace_path,
                change_kinds = ?state.change_kinds,
                "deferred runtime refresh auto-apply because workspace has active turn"
            );
            return false;
        }

        self.refresh
            .set_auto_apply_blocked_by_active_runtime(&state.workspace_id, false)
            .await;
        let evict_provider_hosts = state
            .change_kinds
            .iter()
            .any(|kind| kind.requires_provider_host_evict());
        match self
            .apply_refresh(&state.workspace_id, &workspace_path, evict_provider_hosts)
            .await
        {
            Ok(outcome) => {
                info!(
                    workspace_id = %state.workspace_id,
                    workspace_path = %state.workspace_path,
                    change_kinds = ?state.change_kinds,
                    outcome = ?outcome,
                    "auto-applied pending runtime refresh"
                );
                true
            }
            Err(error) => {
                warn!(
                    workspace_id = %state.workspace_id,
                    workspace_path = %state.workspace_path,
                    change_kinds = ?state.change_kinds,
                    error = %error,
                    "failed to auto-apply pending runtime refresh"
                );
                false
            }
        }
    }
}

fn auto_applicable_refresh(state: &WorkspaceRefreshState) -> bool {
    !state.change_kinds.is_empty()
        && state.change_kinds.iter().all(|kind| {
            matches!(
                kind,
                RefreshChangeKind::Skills
                    | RefreshChangeKind::EnvVars
                    | RefreshChangeKind::ProviderAuth
                    | RefreshChangeKind::ProviderCatalog
                    | RefreshChangeKind::Permissions
                    | RefreshChangeKind::OpencodeJson
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::refresh::{self, refresh_watch};

    #[tokio::test]
    async fn apply_refresh_clears_pending_despite_internal_writes() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));

        supervisor
            .refresh_coordinator()
            .record_change(
                &workspace_id,
                dir.path(),
                refresh::RefreshChangeKind::OpencodeJson,
                refresh::RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        supervisor
            .apply_refresh(&workspace_id, dir.path(), true)
            .await
            .expect("apply_refresh");

        let dto = supervisor
            .refresh_coordinator()
            .runtime_refresh_dto(&workspace_id)
            .await;
        assert_eq!(dto.status, "clean", "pending should clear after apply");
    }

    #[tokio::test]
    async fn auto_apply_idle_skills_refresh_clears_pending_state() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));

        supervisor
            .refresh_coordinator()
            .record_change(
                &workspace_id,
                dir.path(),
                refresh::RefreshChangeKind::Skills,
                refresh::RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        let applied = supervisor.auto_apply_pending_refreshes().await;

        assert_eq!(applied, 1);
        let dto = supervisor
            .refresh_coordinator()
            .runtime_refresh_dto(&workspace_id)
            .await;
        assert_eq!(dto.status, "clean");
    }

    #[tokio::test]
    async fn auto_apply_busy_skills_refresh_stays_pending_and_marks_blocked() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));
        {
            let mut manager = supervisor.agents.lock().await;
            manager.add_test_workspace_runtime(
                "rt-busy",
                &dir.path().to_string_lossy(),
                &workspace_id,
                amux::AgentStatus::Active,
            );
        }

        supervisor
            .refresh_coordinator()
            .record_change(
                &workspace_id,
                dir.path(),
                refresh::RefreshChangeKind::Skills,
                refresh::RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        let applied = supervisor.auto_apply_pending_refreshes().await;

        assert_eq!(applied, 0);
        let dto = supervisor
            .refresh_coordinator()
            .runtime_refresh_dto(&workspace_id)
            .await;
        assert_eq!(dto.status, "pending");
        assert!(dto.auto_apply_blocked_by_active_runtime);
    }

    #[tokio::test]
    async fn auto_apply_busy_skills_refresh_applies_after_workspace_becomes_idle() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));
        {
            let mut manager = supervisor.agents.lock().await;
            manager.add_test_workspace_runtime(
                "rt-busy",
                &dir.path().to_string_lossy(),
                &workspace_id,
                amux::AgentStatus::Active,
            );
        }

        supervisor
            .refresh_coordinator()
            .record_change(
                &workspace_id,
                dir.path(),
                refresh::RefreshChangeKind::Skills,
                refresh::RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();
        assert_eq!(supervisor.auto_apply_pending_refreshes().await, 0);

        {
            let mut manager = supervisor.agents.lock().await;
            manager.set_test_runtime_status("rt-busy", amux::AgentStatus::Idle);
        }

        let applied = supervisor.auto_apply_pending_refreshes().await;

        assert_eq!(applied, 1);
        let dto = supervisor
            .refresh_coordinator()
            .runtime_refresh_dto(&workspace_id)
            .await;
        assert_eq!(dto.status, "clean");
    }

    #[tokio::test]
    async fn auto_applier_loop_applies_idle_pending_skills_refresh() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));
        let handle = supervisor
            .clone()
            .start_refresh_auto_applier_with_interval(std::time::Duration::from_millis(20));

        supervisor
            .refresh_coordinator()
            .record_change(
                &workspace_id,
                dir.path(),
                refresh::RefreshChangeKind::Skills,
                refresh::RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let dto = supervisor
                    .refresh_coordinator()
                    .runtime_refresh_dto(&workspace_id)
                    .await;
                if dto.status == "clean" {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("auto applier should clean pending refresh");

        handle.abort();
    }

    #[test]
    fn prepare_workspace_creates_defaults() {
        let dir = tempfile::tempdir().unwrap();
        prepare_workspace(dir.path()).unwrap();

        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("opencode.json")).unwrap(),
        )
        .unwrap();
        assert!(cfg.get("permission").is_some());

        assert!(dir
            .path()
            .join(".teamclaw/skills/create-role/SKILL.md")
            .is_file());
        assert!(!dir.path().join(".opencode/data").exists());
    }

    #[test]
    fn ensure_instruction_plugin_creates_file_and_registers() {
        let dir = tempfile::tempdir().unwrap();
        ensure_instruction_plugin(dir.path()).unwrap();

        let plugin_path = dir
            .path()
            .join(crate::runtime::workspace_runtime::INSTRUCTION_PLUGIN_REL);
        assert!(plugin_path.is_file());
        assert!(std::fs::read_to_string(plugin_path)
            .unwrap()
            .contains("experimental.chat.system.transform"));

        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("opencode.json")).unwrap(),
        )
        .unwrap();
        let plugins = cfg["plugin"].as_array().unwrap();
        assert!(plugins.iter().any(|entry| {
            entry
                .as_str()
                .map(|value| value.contains("teamclaw-instruction"))
                .unwrap_or(false)
        }));
        assert!(crate::runtime::instruction_plugin_installed(dir.path()));
    }
}

//! Workspace runtime supervisor - bootstrap + RuntimeManager lifecycle.
//!
//! Replaces the desktop `start_opencode` sidecar path: workspace prep runs
//! here before agent spawn, and `/v1/workspaces/:id/runtime/*` handlers
//! delegate reload/status to the shared `RuntimeManager`.

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
const REMOTE_TOOLS_MCP_SERVER_NAME: &str = "amuxd-remote-tools";
const INSTRUCTION_PLUGIN_TEMPLATE: &str = include_str!(
    "../../../../packages/app/src/lib/opencode/templates/teamclaw-instruction-plugin.mjs.txt"
);

use crate::config::workspace_control::{
    ApplyOutcome, EnvActivationBlocker, EnvActivationDiagnostics, RuntimeStatus,
    WorkspaceControlError,
};
use crate::proto::amux;
use crate::runtime::{
    refresh::{
        RefreshChangeKind, RuntimeRefreshCoordinator, WorkspaceRefreshState,
        APPLY_REFRESH_SUPPRESS, INTERNAL_PREPARE_KINDS, INTERNAL_WRITE_SUPPRESS,
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
    let workspace = path
        .parent()
        .ok_or_else(|| WorkspaceControlError::Io("opencode.json has no parent".into()))?;
    teamclaw_runtime_env::opencode_config::OpencodeConfigStore::load(workspace)
        .map_err(|e| WorkspaceControlError::Parse(e.to_string()))
}

fn write_json_pretty(path: &Path, value: &serde_json::Value) -> Result<(), WorkspaceControlError> {
    let workspace = path
        .parent()
        .ok_or_else(|| WorkspaceControlError::Io("opencode.json has no parent".into()))?;
    teamclaw_runtime_env::opencode_config::OpencodeConfigStore::write_value(workspace, value)
        .map_err(|e| WorkspaceControlError::Io(e.to_string()))
}

fn map_store_err(
    e: teamclaw_runtime_env::opencode_config::OpencodeConfigError,
) -> WorkspaceControlError {
    WorkspaceControlError::Io(e.to_string())
}

fn ws_to_store_err(
    e: WorkspaceControlError,
) -> teamclaw_runtime_env::opencode_config::OpencodeConfigError {
    match e {
        WorkspaceControlError::Io(s) => {
            teamclaw_runtime_env::opencode_config::OpencodeConfigError::Io(s)
        }
        WorkspaceControlError::Parse(s) => {
            teamclaw_runtime_env::opencode_config::OpencodeConfigError::Parse(s)
        }
        other => {
            teamclaw_runtime_env::opencode_config::OpencodeConfigError::Parse(other.to_string())
        }
    }
}

fn mutate_default_permissions(
    config: &mut serde_json::Value,
) -> Result<bool, WorkspaceControlError> {
    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;
    if obj.contains_key("permission") {
        return Ok(false);
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
    Ok(true)
}

fn mutate_inherent_mcp(
    workspace_path: &Path,
    config: &mut serde_json::Value,
) -> Result<bool, WorkspaceControlError> {
    if config.as_object().map(|o| o.is_empty()).unwrap_or(true) && config.get("$schema").is_none() {
        if let Some(obj) = config.as_object_mut() {
            obj.insert(
                "$schema".to_string(),
                serde_json::json!("https://opencode.ai/config.json"),
            );
        }
    }

    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;

    let mcp = obj.entry("mcp").or_insert_with(|| serde_json::json!({}));
    let mcp_obj = mcp
        .as_object_mut()
        .ok_or_else(|| WorkspaceControlError::Parse("mcp is not an object".into()))?;

    let mut changed = false;

    let remote_tools = remote_tools_mcp_config()?;
    let needs_remote_tools = mcp_obj
        .get(REMOTE_TOOLS_MCP_SERVER_NAME)
        .map(|existing| existing != &remote_tools)
        .unwrap_or(true);
    if needs_remote_tools {
        mcp_obj.insert(REMOTE_TOOLS_MCP_SERVER_NAME.to_string(), remote_tools);
        changed = true;
    }

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

    ensure_extended_inherent_config(workspace_path, config, &mut changed)?;
    Ok(changed)
}

fn mutate_instruction_plugin(
    config: &mut serde_json::Value,
) -> Result<bool, WorkspaceControlError> {
    use crate::runtime::workspace_runtime::INSTRUCTION_PLUGIN_CONFIG_ENTRY;

    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;

    if obj.get("$schema").is_none() {
        obj.insert(
            "$schema".to_string(),
            serde_json::json!("https://opencode.ai/config.json"),
        );
    }

    let plugins = obj.entry("plugin").or_insert_with(|| serde_json::json!([]));
    let plugin_list = plugins.as_array_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json plugin field is not an array".into())
    })?;

    let already_registered = plugin_list.iter().any(|entry| {
        entry
            .as_str()
            .map(|value| value.contains("teamclaw-instruction"))
            .unwrap_or(false)
    });
    if already_registered {
        return Ok(false);
    }
    plugin_list.push(serde_json::json!(INSTRUCTION_PLUGIN_CONFIG_ENTRY));
    Ok(true)
}

/// One read-modify-write for prepare/reload paths.
pub fn materialize_opencode_for_prepare(
    workspace_path: &Path,
) -> Result<(), WorkspaceControlError> {
    teamclaw_runtime_env::opencode_config::OpencodeConfigStore::apply(workspace_path, |config| {
        let mut changed = false;
        changed |= mutate_default_permissions(config).map_err(ws_to_store_err)?;
        changed |= mutate_inherent_mcp(workspace_path, config).map_err(ws_to_store_err)?;
        changed |= mutate_instruction_plugin(config).map_err(ws_to_store_err)?;
        Ok(changed)
    })
    .map_err(map_store_err)?;
    Ok(())
}

/// One read-modify-write for spawn: inherent MCP only.
///
/// Cloud `provider.team` materialization and secret resolution run in
/// [`teamclaw_runtime_env::assemble_runtime_env`] via
/// [`teamclaw_runtime_env::sync_team_provider_on_disk`].
pub fn materialize_inherent_mcp_for_spawn(
    workspace_path: &Path,
) -> Result<(), WorkspaceControlError> {
    teamclaw_runtime_env::opencode_config::OpencodeConfigStore::apply(workspace_path, |config| {
        mutate_inherent_mcp(workspace_path, config).map_err(ws_to_store_err)
    })
    .map_err(map_store_err)?;
    Ok(())
}

/// Ensure tool-level permission defaults exist in `opencode.json`.
fn ensure_default_permissions(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    teamclaw_runtime_env::opencode_config::OpencodeConfigStore::apply(workspace_path, |config| {
        mutate_default_permissions(config).map_err(ws_to_store_err)
    })
    .map_err(map_store_err)?;
    Ok(())
}

/// Seed inherent MCP entries that TeamClaw expects (non-destructive).
pub fn ensure_inherent_mcp(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    let config_path = opencode_json_path(workspace_path);
    let changed = teamclaw_runtime_env::opencode_config::OpencodeConfigStore::apply(
        workspace_path,
        |config| mutate_inherent_mcp(workspace_path, config).map_err(ws_to_store_err),
    )
    .map_err(map_store_err)?;
    if changed {
        info!(
            workspace = %workspace_path.display(),
            config_path = %config_path.display(),
            "ensure_inherent_mcp: opencode.json updated"
        );
    }
    Ok(())
}

fn remote_tools_mcp_config() -> Result<serde_json::Value, WorkspaceControlError> {
    let amuxd_bin =
        std::env::current_exe().map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    let sock = crate::config::DaemonConfig::sock_path();
    info!(
        amuxd_bin = %amuxd_bin.display(),
        sock = %sock.display(),
        "ensure_inherent_mcp: building remote-tools config"
    );
    Ok(serde_json::json!({
        "type": "local",
        "enabled": true,
        "command": [
            amuxd_bin.to_string_lossy(),
            "remote-tools-mcp",
            format!("--sock={}", sock.to_string_lossy())
        ]
    }))
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
    // Desktop-managed mode injects the bundled sidecar absolute path.
    if let Ok(path) = std::env::var("TEAMCLAW_INTROSPECT_BIN") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            let p = std::path::Path::new(trimmed);
            if p.is_file() {
                return Some(trimmed.to_string());
            }
            tracing::warn!(
                path = trimmed,
                "TEAMCLAW_INTROSPECT_BIN set but file missing; falling back"
            );
        }
    }

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

    let amuxd_bin = crate::config::DaemonConfig::config_dir().join("bin");
    if let Some(resolved) = introspect_candidates_in_dir(&amuxd_bin) {
        return Some(resolved.to_string_lossy().into_owned());
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
        if let Some(home) = dirs::home_dir() {
            let agents = home.join(".agents").join("skills");
            let agents_str = agents.to_string_lossy().to_string();
            let already = paths.iter().any(|v| {
                v.as_str()
                    .map(|s| s == agents_str || s == "~/.agents/skills")
                    .unwrap_or(false)
            });
            if !already {
                paths.push(serde_json::json!(agents_str));
                *changed = true;
            }
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

fn install_instruction_plugin_file(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    use crate::runtime::workspace_runtime::INSTRUCTION_PLUGIN_REL;

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
    Ok(())
}

/// Install the TeamClaw instruction OpenCode plugin and register it in `opencode.json`.
pub fn ensure_instruction_plugin(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    install_instruction_plugin_file(workspace_path)?;

    teamclaw_runtime_env::opencode_config::OpencodeConfigStore::apply(workspace_path, |config| {
        mutate_instruction_plugin(config).map_err(ws_to_store_err)
    })
    .map_err(map_store_err)?;
    Ok(())
}

/// Prepare a workspace directory for OpenCode/ACP agent use.
pub fn prepare_workspace(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    if !workspace_path.is_dir() {
        return Err(WorkspaceControlError::WorkspaceNotFound(
            workspace_path.display().to_string(),
        ));
    }

    install_instruction_plugin_file(workspace_path)?;
    materialize_opencode_for_prepare(workspace_path)?;
    ensure_inherent_skills_in_dir(&teamclaw_runtime_env::workspace_meta_write_path_from_env(
        workspace_path,
        "skills",
    ))?;
    ensure_inherent_skills_in_dir(&workspace_path.join(".opencode/skills"))?;
    crate::runtime::claude_skills::ensure_claude_team_skills(workspace_path)?;

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
        amux::AgentType::Pi => "pi",
        amux::AgentType::Cursor => "cursor",
        _ => "unknown",
    }
}

/// Whether the configured backend can actually be launched.
///
/// [`binary_available`] alone only answers this for backends whose
/// `AgentLaunchConfig.binary` really is an executable on PATH. It is wrong for
/// the other two:
///
/// - **pi** declares the literal `"pi"`, but `pi_rpc::resolve_binary` also
///   accepts `~/.pi/bin/pi`, which `command -v pi` does not see.
/// - **cursor** declares `"cursor-bridge"`, which is not an executable at all —
///   the backend runs `node <daemon>/cursor-bridge/src/main.mjs`.
///
/// So both reported "not available" on machines where they run perfectly well,
/// which failed the model-catalog probe before it could reach the backend.
fn backend_launchable(agent_type: amux::AgentType, cfg: &AgentLaunchConfig) -> bool {
    match agent_type {
        amux::AgentType::Pi => {
            let resolved = crate::runtime::pi_rpc::process::resolve_binary(None);
            binary_available(&AgentLaunchConfig::new(resolved, Vec::new(), "pi"))
        }
        amux::AgentType::Cursor => {
            let cmd = crate::runtime::cursor_sdk::process::default_bridge_command();
            let node_ok = cmd
                .first()
                .map(|bin| {
                    binary_available(&AgentLaunchConfig::new(bin.clone(), Vec::new(), "cursor"))
                })
                .unwrap_or(false);
            node_ok && crate::runtime::cursor_sdk::process::default_bridge_main().exists()
        }
        _ => binary_available(cfg),
    }
}

pub struct RuntimeSupervisor {
    agents: Arc<AsyncMutex<RuntimeManager>>,
    refresh: Arc<RuntimeRefreshCoordinator>,
    /// When set, `reload_workspace` reports each provider-host evict as
    /// `(workspace_id, workspace_path)` so the daemon can re-prewarm the
    /// evicted hosts off the critical path. Without this, the first session
    /// after a provider/env change always paid the full cold start.
    prewarm_notify: parking_lot::Mutex<Option<tokio::sync::mpsc::Sender<(String, String)>>>,
}

impl RuntimeSupervisor {
    pub fn new(agents: Arc<AsyncMutex<RuntimeManager>>) -> Arc<Self> {
        Arc::new(Self {
            agents,
            refresh: RuntimeRefreshCoordinator::new(),
            prewarm_notify: parking_lot::Mutex::new(None),
        })
    }

    /// Install the channel that receives `(workspace_id, path)` whenever a
    /// reload evicted the pooled provider hosts (see `prewarm_notify`).
    pub fn set_prewarm_notifier(&self, tx: tokio::sync::mpsc::Sender<(String, String)>) {
        *self.prewarm_notify.lock() = Some(tx);
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

    /// Probe the configured local backend for its live model catalog.
    ///
    /// Dispatches through the backend trait, so opencode reaches `serve.ensure()`
    /// and `/config/providers`, pi reaches `get_available_models`, and cursor and
    /// claude-code reach `list_models` — each spawning a child if none is live.
    /// There is no static fallback — an unavailable binary is an error, not a
    /// phantom list.
    ///
    /// This used to claim claude-code "returns its static table". It never had
    /// one: the claude bridge answers `list_models` off a live query, and with
    /// no session it used to answer `[]`. Believing the comment is how switching
    /// the local agent to claude-code ended up with a permanently empty picker —
    /// the probe tier looked covered, so nothing else was. The bridge now starts
    /// a session to answer, which is what makes this dispatch meaningful.
    pub async fn probe_catalog_models(
        &self,
        workspace_path: &Path,
    ) -> Result<Vec<amux::ModelInfo>, String> {
        let mut manager = self.agents.lock().await;
        let agent_type = manager.default_agent_type();
        let launch = manager.launch_config_for(agent_type);
        if !backend_launchable(agent_type, &launch) {
            return Err(format!(
                "{} binary not available",
                backend_label(agent_type)
            ));
        }
        manager
            .probe_catalog_models(workspace_path)
            .await
            .map_err(|e| e.to_string())
    }

    /// This device's last-known catalog for `workspace_path` under the
    /// configured backend, as persisted by `config::model_catalog`.
    ///
    /// The MQTT path already falls back to this via `RuntimeManager::fill_catalog`;
    /// the HTTP catalog endpoint needs the same fallback so a slow or failed
    /// live probe serves the last-known list instead of nothing. pi and cursor
    /// have no provider-file fallback of their own, so for them this is the only
    /// thing standing between a cold probe and a permanently empty picker.
    pub async fn cached_catalog_models(&self, workspace_path: &Path) -> Vec<amux::ModelInfo> {
        self.agents
            .lock()
            .await
            .catalog_for_worktree(&workspace_path.to_string_lossy())
    }

    /// Backend id for the configured local agent (`"opencode"` / `"pi"` /
    /// `"cursor"` / `"claude"`).
    pub async fn local_backend_type(&self) -> &'static str {
        self.agents.lock().await.local_backend_type()
    }

    /// This device's most-recently-used model ids for the configured local
    /// backend, newest first (`config::model_mru`).
    ///
    /// Served alongside the HTTP catalog so a client can resolve "the model
    /// this device last used" before any runtime exists to publish a retain.
    pub async fn recent_catalog_models(&self) -> Vec<String> {
        self.agents.lock().await.recent_models(None)
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
        let backend_ready = backend_launchable(agent_type, &launch);

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

    /// Diagnostics for env-var activation: storage readable, daemon runtime state,
    /// and human-readable blockers. Contains no secret values.
    pub async fn env_activation_diagnostics(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        team_id: Option<&str>,
    ) -> EnvActivationDiagnostics {
        let store = teamclaw_runtime_env::diagnose_personal_env_store();
        let personal_env_result = teamclaw_runtime_env::personal_secrets::load_personal_env();
        let loaded_user_count = personal_env_result
            .as_ref()
            .map(teamclaw_runtime_env::count_user_personal_env_keys)
            .unwrap_or(0);
        let personal_blob_user_var_count = store.user_stored_var_count;
        let personal_env_var_count = if loaded_user_count > 0 {
            loaded_user_count
        } else if store.blob_readable {
            personal_blob_user_var_count
        } else {
            0
        };
        let personal_env = personal_env_result.as_ref().cloned().unwrap_or_default();
        let personal_load_error = personal_env_result.err().map(|e| e.to_string());

        let team_env =
            crate::team_shared_env::load_team_env_for_workspace_detailed(workspace_path, team_id);

        let workspace_path_str = workspace_path.to_string_lossy();
        let (
            active_runtime_count,
            workspace_has_active_turn,
            opencode_serve_running,
            cached_env_count,
            served_env_keys,
            active_env_fingerprint,
            installed_env_fingerprint,
            snapshot_conflict_workspace,
            active_snapshot,
        ) = {
            let manager = self.agents.lock().await;
            let active_runtime_count = manager
                .active_handles_for_workspace(&workspace_path_str, workspace_id)
                .count();
            let workspace_has_active_turn =
                manager.workspace_has_active_turn(&workspace_path_str, workspace_id);
            let active_snapshot = manager
                .workspace_env_snapshot(&workspace_path_str, workspace_id)
                .map(|(snapshot, _)| snapshot);
            let serve_stats = manager
                .opencode_serve_supervisor()
                .await
                .map(|serve| {
                    let canonical_workspace = std::fs::canonicalize(workspace_path)
                        .unwrap_or_else(|_| workspace_path.to_path_buf())
                        .to_string_lossy()
                        .into_owned();
                    // All per-workspace: with one serve process per distinct
                    // runtime env, a global "active fingerprint" would report
                    // some other workspace's environment.
                    (
                        serve.is_running(),
                        serve.installed_env_key_count(&canonical_workspace),
                        serve.installed_env_keys(&canonical_workspace),
                        serve.active_env_fingerprint_for_workspace(&canonical_workspace),
                        serve.requested_env_fingerprint(&canonical_workspace),
                        serve.snapshot_conflict_workspace(&canonical_workspace),
                    )
                })
                .unwrap_or((false, 0, Vec::new(), None, None, None));
            (
                active_runtime_count,
                workspace_has_active_turn,
                serve_stats.0,
                serve_stats.1,
                serve_stats.2,
                serve_stats.3,
                serve_stats.4,
                serve_stats.5,
                active_snapshot,
            )
        };
        let active_handle_env_fingerprint = active_snapshot
            .as_ref()
            .map(|snapshot| snapshot.fingerprint.clone());

        let system_ctx = active_snapshot
            .as_ref()
            .map(|snapshot| teamclaw_runtime_env::SystemEnvContext {
                actor_id: snapshot
                    .bindings
                    .get("actor_id")
                    .cloned()
                    .unwrap_or_default(),
                display_name: snapshot
                    .bindings
                    .get("display_name")
                    .cloned()
                    .unwrap_or_default(),
                cloud_token_file: snapshot.bindings.get("TC_ACCESS_TOKEN_FILE").cloned(),
            })
            .unwrap_or(teamclaw_runtime_env::SystemEnvContext {
                actor_id: String::new(),
                display_name: String::new(),
                cloud_token_file: None,
            });
        let resolved = teamclaw_runtime_env::resolve_runtime_env(
            personal_env.clone(),
            team_env.values.clone(),
            system_ctx,
        );
        let host_env_shadowed_keys =
            teamclaw_runtime_env::host_shadowed_env_keys(&resolved.bindings);
        let mut override_keys: Vec<String> = resolved
            .overrides
            .iter()
            .filter(|entry| entry.kind == teamclaw_runtime_env::EnvOverrideKind::Layer)
            .map(|entry| entry.key.clone())
            .chain(team_env.overridden_keys.iter().cloned())
            .collect();
        override_keys.sort();
        override_keys.dedup();
        let mut alias_collision_keys: Vec<String> = resolved
            .overrides
            .iter()
            .filter(|entry| entry.kind == teamclaw_runtime_env::EnvOverrideKind::AliasCollision)
            .map(|entry| entry.key.clone())
            .collect();
        alias_collision_keys.sort();
        alias_collision_keys.dedup();
        let mut unresolved_env_keys = team_env.unresolved_keys.clone();
        unresolved_env_keys.extend(resolved.unresolved.iter().map(|entry| entry.key.clone()));
        unresolved_env_keys.sort();
        unresolved_env_keys.dedup();
        let resolved_env_fingerprint = Some(resolved.fingerprint.clone());

        if let Some(snapshot) = active_snapshot.as_ref() {
            override_keys.extend(
                snapshot
                    .overrides
                    .iter()
                    .filter(|entry| entry.kind == teamclaw_runtime_env::EnvOverrideKind::Layer)
                    .map(|entry| entry.key.clone()),
            );
            alias_collision_keys.extend(
                snapshot
                    .overrides
                    .iter()
                    .filter(|entry| {
                        entry.kind == teamclaw_runtime_env::EnvOverrideKind::AliasCollision
                    })
                    .map(|entry| entry.key.clone()),
            );
            override_keys.sort();
            override_keys.dedup();
            alias_collision_keys.sort();
            alias_collision_keys.dedup();
        }
        let system_env_var_count = active_snapshot
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .provenance
                    .iter()
                    .filter(|entry| {
                        entry.scope == teamclaw_runtime_env::EnvScope::System
                            && entry.alias_of.is_none()
                    })
                    .count()
            })
            .unwrap_or(0);

        let refresh = self.refresh.runtime_refresh_dto(workspace_id).await;
        let mut blockers: Vec<EnvActivationBlocker> = Vec::new();

        if !store.blob_readable {
            blockers.push(EnvActivationBlocker {
                code: if store.blob_exists {
                    "personal_blob_undecryptable".to_string()
                } else if store.master_key_exists {
                    "personal_blob_missing".to_string()
                } else {
                    "personal_store_uninitialized".to_string()
                },
                detail: if store.blob_exists {
                    store.blob_error.clone()
                } else {
                    None
                },
            });
        }
        if refresh.status == "failed" {
            blockers.push(EnvActivationBlocker {
                code: "refresh_failed".to_string(),
                detail: refresh.last_error.clone(),
            });
        } else if refresh.status == "pending" || refresh.status == "applying" {
            if refresh.change_kinds.iter().any(|k| k == "env_vars") {
                blockers.push(EnvActivationBlocker {
                    code: "env_vars_pending".to_string(),
                    detail: None,
                });
            }
        }
        if refresh.auto_apply_blocked_by_active_runtime {
            blockers.push(EnvActivationBlocker {
                code: "refresh_deferred_active_turn".to_string(),
                detail: None,
            });
        }
        if active_runtime_count > 0 {
            blockers.push(EnvActivationBlocker {
                code: "active_runtimes".to_string(),
                detail: Some(active_runtime_count.to_string()),
            });
        }
        if workspace_has_active_turn {
            blockers.push(EnvActivationBlocker {
                code: "turn_in_progress".to_string(),
                detail: None,
            });
        }
        if opencode_serve_running
            && cached_env_count == 0
            && (personal_env_var_count > 0 || !team_env.values.is_empty())
        {
            blockers.push(EnvActivationBlocker {
                code: "opencode_serve_no_cached_env".to_string(),
                detail: None,
            });
        }
        if !host_env_shadowed_keys.is_empty() {
            blockers.push(EnvActivationBlocker {
                code: "host_env_shadowed".to_string(),
                detail: Some(host_env_shadowed_keys.join(", ")),
            });
        }
        if !unresolved_env_keys.is_empty() {
            blockers.push(EnvActivationBlocker {
                code: "unresolved_env_keys".to_string(),
                detail: Some(unresolved_env_keys.join(", ")),
            });
        }
        if !alias_collision_keys.is_empty() {
            blockers.push(EnvActivationBlocker {
                code: "alias_collision".to_string(),
                detail: Some(alias_collision_keys.join(", ")),
            });
        }
        if !override_keys.is_empty() {
            blockers.push(EnvActivationBlocker {
                code: "env_layer_override".to_string(),
                detail: Some(override_keys.join(", ")),
            });
        }
        let workspace_conflicted = snapshot_conflict_workspace
            .as_deref()
            .is_some_and(|conflict| {
                std::fs::canonicalize(workspace_path)
                    .unwrap_or_else(|_| workspace_path.to_path_buf())
                    .to_string_lossy()
                    == conflict
            });
        if workspace_conflicted {
            blockers.push(EnvActivationBlocker {
                code: "env_snapshot_conflict".to_string(),
                detail: snapshot_conflict_workspace.clone(),
            });
        }
        // Compare *installed* against active, not `resolved_env_fingerprint`.
        // The resolved one comes from `resolve_runtime_env`, which stops at the
        // personal/team/system layers; the env actually installed for a spawn
        // additionally carries `TEAMCLAW_TEAM_PROVIDER` (assembled in
        // `env_assembly`). Comparing across the two therefore never matched on
        // any workspace with a managed team LLM, pinning it to "pending" and
        // emitting a permanent `env_snapshot_pending` blocker. Installed vs
        // active asks the question the status actually means: is the snapshot
        // this workspace installed the one it is running on?
        let activation_status = if workspace_conflicted {
            "blocked"
        } else if installed_env_fingerprint.is_some()
            && installed_env_fingerprint.as_deref() == active_env_fingerprint.as_deref()
        {
            "active"
        } else {
            "pending"
        }
        .to_string();
        if activation_status == "pending" {
            blockers.push(EnvActivationBlocker {
                code: "env_snapshot_pending".to_string(),
                detail: None,
            });
        }

        let brand = teamclaw_runtime_env::brand_short_name_from_env();
        let team_secret_configured = teamclaw_runtime_env::env_catalog::resolve_team_env_secret(
            workspace_path,
            team_id,
            Some(brand.as_str()),
        )
        .is_some();
        let team_secret_files_present = !team_env.source_paths.is_empty()
            || !team_env.unresolved_keys.is_empty()
            || !team_env.values.is_empty();
        if team_secret_files_present && !team_secret_configured {
            blockers.push(EnvActivationBlocker {
                code: "team_secret_missing".to_string(),
                detail: None,
            });
        }

        let activation_status_for_analysis = activation_status.as_str();
        let active_snapshot_ref = active_snapshot.as_ref();
        let mut analysis = teamclaw_runtime_env::analyze_env_activation(
            &teamclaw_runtime_env::EnvActivationInput {
                personal_env: &personal_env,
                team_env: &team_env.values,
                resolved: &resolved,
                unresolved_keys: &unresolved_env_keys,
                override_keys: &override_keys,
                host_shadowed_keys: &host_env_shadowed_keys,
                activation_status: activation_status_for_analysis,
                active_runtime_count,
                active_snapshot: active_snapshot_ref,
                served_env_keys: &served_env_keys,
                opencode_serve_running,
            },
        );
        analysis.mcp_unresolved_placeholders =
            teamclaw_runtime_env::find_unresolved_config_placeholders(
                workspace_path,
                &resolved.bindings,
            );
        if !analysis.mcp_unresolved_placeholders.is_empty() {
            let keys: Vec<String> = analysis
                .mcp_unresolved_placeholders
                .iter()
                .map(|entry| entry.key.clone())
                .collect();
            blockers.push(EnvActivationBlocker {
                code: "mcp_placeholder_unresolved".to_string(),
                detail: Some(keys.join(", ")),
            });
        }
        if !analysis.missing_expected_keys.is_empty() {
            blockers.push(EnvActivationBlocker {
                code: "missing_expected_env_keys".to_string(),
                detail: Some(analysis.missing_expected_keys.join(", ")),
            });
        }
        if !analysis.missing_served_env_keys.is_empty() {
            blockers.push(EnvActivationBlocker {
                code: "env_not_served".to_string(),
                detail: Some(analysis.missing_served_env_keys.join(", ")),
            });
        }

        EnvActivationDiagnostics {
            personal_env_var_count,
            personal_blob_user_var_count,
            personal_blob_readable: store.blob_readable,
            personal_load_error,
            team_env_var_count: team_env.values.len(),
            system_env_var_count,
            opencode_serve_running,
            opencode_serve_cached_env_count: cached_env_count,
            active_runtime_count,
            workspace_has_active_turn,
            refresh,
            host_env_shadowed_keys,
            resolved_env_fingerprint,
            active_env_fingerprint,
            override_keys,
            alias_collision_keys,
            unresolved_env_keys,
            snapshot_conflict_workspace,
            activation_status,
            blockers,
            expected_env_keys: analysis.expected_env_keys,
            effective_env_keys: analysis.effective_env_keys,
            missing_expected_keys: analysis.missing_expected_keys,
            key_statuses: analysis.key_statuses,
            mcp_unresolved_placeholders: analysis.mcp_unresolved_placeholders,
            installed_env_fingerprint,
            active_handle_env_fingerprint,
            team_secret_configured,
            opencode_serve_cached_env_keys: analysis.served_env_keys,
            missing_served_env_keys: analysis.missing_served_env_keys,
            active_handle_env_keys: analysis.active_handle_env_keys,
        }
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
                manager.evict_acp_hosts_after_provider_auth_change().await;
            }
            stopped
        };

        // Re-prewarm the just-evicted hosts in the background so the next
        // session doesn't pay the full cold start. Best-effort: dropped when no
        // notifier is installed (tests) or the queue is full.
        if evict_provider_hosts {
            if let Some(tx) = self.prewarm_notify.lock().clone() {
                let _ = tx.try_send((
                    workspace_id.to_string(),
                    workspace_path.to_string_lossy().into_owned(),
                ));
            }
        }

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

    async fn env_snapshot_unchanged(&self, workspace_id: &str, workspace_path: &Path) -> bool {
        let workspace_path_str = workspace_path.to_string_lossy();
        let previous = {
            let manager = self.agents.lock().await;
            manager.workspace_env_snapshot(&workspace_path_str, workspace_id)
        };
        let Some((previous, team_id)) = previous else {
            return false;
        };
        let Ok(personal) = teamclaw_runtime_env::personal_secrets::load_personal_env() else {
            return false;
        };
        let team =
            crate::team_shared_env::load_team_env_for_workspace(workspace_path, team_id.as_deref());
        let current = teamclaw_runtime_env::resolve_runtime_env(
            personal,
            team,
            teamclaw_runtime_env::SystemEnvContext {
                actor_id: previous
                    .bindings
                    .get("actor_id")
                    .cloned()
                    .unwrap_or_default(),
                display_name: previous
                    .bindings
                    .get("display_name")
                    .cloned()
                    .unwrap_or_default(),
                cloud_token_file: previous.bindings.get("TC_ACCESS_TOKEN_FILE").cloned(),
            },
        );
        current.fingerprint == previous.fingerprint
    }

    async fn auto_apply_pending_refresh_state(&self, state: WorkspaceRefreshState) -> bool {
        if !auto_applicable_refresh(&state) {
            self.refresh
                .set_auto_apply_blocked_by_active_runtime(&state.workspace_id, false)
                .await;
            return false;
        }

        let workspace_path = PathBuf::from(&state.workspace_path);
        let env_only = state
            .change_kinds
            .iter()
            .all(|kind| matches!(kind, RefreshChangeKind::EnvVars));
        if env_only
            && self
                .env_snapshot_unchanged(&state.workspace_id, &workspace_path)
                .await
        {
            let attempt = self
                .refresh
                .mark_applying(&state.workspace_id, &workspace_path)
                .await;
            self.refresh
                .set_auto_apply_blocked_by_active_runtime(&state.workspace_id, false)
                .await;
            self.refresh
                .clear_applied(&state.workspace_id, attempt)
                .await;
            info!(
                workspace_id = %state.workspace_id,
                workspace_path = %state.workspace_path,
                "cleared env refresh because the resolved fingerprint is unchanged"
            );
            return true;
        }
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
    async fn unchanged_env_fingerprint_clears_refresh_without_stopping_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));
        let snapshot = teamclaw_runtime_env::resolve_runtime_env(
            teamclaw_runtime_env::personal_secrets::load_personal_env().unwrap_or_default(),
            std::collections::HashMap::new(),
            teamclaw_runtime_env::SystemEnvContext {
                actor_id: "actor-test".to_string(),
                display_name: "Agent Test".to_string(),
                cloud_token_file: None,
            },
        );
        {
            let mut manager = supervisor.agents.lock().await;
            manager.add_test_workspace_runtime(
                "rt-idle",
                &dir.path().to_string_lossy(),
                &workspace_id,
                amux::AgentStatus::Idle,
            );
            manager.set_test_runtime_env_snapshot("rt-idle", snapshot, None);
        }
        supervisor
            .refresh_coordinator()
            .record_change(
                &workspace_id,
                dir.path(),
                refresh::RefreshChangeKind::EnvVars,
                refresh::RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        assert_eq!(supervisor.auto_apply_pending_refreshes().await, 1);
        let manager = supervisor.agents.lock().await;
        assert_eq!(
            manager
                .active_handles_for_workspace(&dir.path().to_string_lossy(), &workspace_id)
                .count(),
            1,
            "unchanged env must not evict an idle runtime"
        );
        drop(manager);
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
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclaw");
        let dir = tempfile::tempdir().unwrap();
        prepare_workspace(dir.path()).unwrap();

        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("opencode.json")).unwrap(),
        )
        .unwrap();
        assert!(cfg.get("permission").is_some());
        assert_eq!(
            cfg["mcp"][REMOTE_TOOLS_MCP_SERVER_NAME]["enabled"],
            serde_json::json!(true)
        );
        assert_eq!(
            cfg["mcp"][REMOTE_TOOLS_MCP_SERVER_NAME]["command"][1],
            serde_json::json!("remote-tools-mcp")
        );

        assert!(dir
            .path()
            .join(".teamclaw/skills/create-role/SKILL.md")
            .is_file());
        assert!(!dir.path().join(".opencode/data").exists());
    }

    #[test]
    fn prepare_workspace_white_label_writes_brand_skills() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("copilot361");

        let dir = tempfile::tempdir().unwrap();
        prepare_workspace(dir.path()).unwrap();
        assert!(dir
            .path()
            .join(".copilot361/skills/create-role/SKILL.md")
            .is_file());
        assert!(!dir
            .path()
            .join(".teamclaw/skills/create-role/SKILL.md")
            .exists());
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

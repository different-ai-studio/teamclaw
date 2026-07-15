//! Git-based team operations: join, clone, gitignore, secrets.
//!
//! Extracted from `team.rs` — types, helpers, and Tauri commands that deal
//! exclusively with the `teamclaw-team/` git repo lifecycle.

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::process_util::CommandNoWindow;

// ─── Types ───────────────────────────────────────────────────────────────────

/// One untracked file surfaced by the sync precheck.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncPrecheckFile {
    pub path: String,
    pub size_bytes: u64,
}

/// Result of a git operation.
///
/// `needs_confirmation` is set by `team_sync_repo` when untracked files exceed
/// thresholds and the caller did not pass `force=true`. In that case `new_files`
/// and `total_bytes` describe what would have been staged, and the sync did NOT run.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamGitResult {
    pub success: bool,
    pub message: String,
    #[serde(default)]
    pub needs_confirmation: bool,
    #[serde(default)]
    pub new_files: Vec<SyncPrecheckFile>,
    #[serde(default)]
    pub total_bytes: u64,
}

/// Result of team git create.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamGitCreateResult {
    pub team_id: String,
    pub team_secret: String,
}

/// Team metadata stored in _meta/team.json (committed to Git).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMeta {
    pub team_id: String,
    pub team_name: String,
    /// HMAC-SHA256(team_secret, "teamclaw-verify") as hex — for join verification.
    pub secret_verify: String,
    pub created_at: String,
    pub owner_node_id: String,
    /// LiteLLM/FC endpoint URL. When set, joining members register their key
    /// via this endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fc_endpoint: Option<String>,
}

/// Result of workspace git check.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitCheckResult {
    pub has_git: bool,
}

/// Inputs to the team-join clone & member-registration work.
struct TeamGitJoinArgs {
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
    fc_endpoint: Option<String>,
    workspace_path: String,
    access_token: Option<String>,
}

// ─── Constants ───────────────────────────────────────────────────────────────

/// The whitelist .gitignore content
pub const GITIGNORE_CONTENT: &str = r#"# ============================================
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
!.leaderboard/
!.leaderboard/**

# 3. Allow workspace config
!.gitignore
!README.md

# 4. Explicitly ignore (never sync)
.trash/
.DS_Store
node_modules/
.git/
"#;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Run a git command in a given directory.
pub fn run_git(args: &[&str], cwd: &str) -> Result<(bool, String, String), String> {
    let output = Command::new("git")
        .no_window()
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

/// Run `git clone` with `--filter=blob:none` (partial clone) for speed.
/// Falls back to a plain full clone if the server rejects the filter.
///
/// `base_args` must be the regular clone arg list, starting with "clone"
/// and ending with the target dir.
pub fn run_clone_with_partial_fallback(
    base_args: &[&str],
    cwd: &str,
) -> Result<(bool, String, String), String> {
    // Build filter args: insert --filter=blob:none before the last element (target dir).
    let target_dir = base_args.last().ok_or("clone args must not be empty")?;
    let prefix = &base_args[..base_args.len() - 1];
    let mut partial_args: Vec<&str> = prefix.to_vec();
    partial_args.push("--filter=blob:none");
    partial_args.push(target_dir);

    let (ok, stdout, stderr) = run_git(&partial_args, cwd)?;
    if ok {
        return Ok((ok, stdout, stderr));
    }

    // Partial clone rejected — clean up and retry full.
    if stderr.contains("uploadpack.allowFilter") || stderr.contains("invalid filter-spec") {
        let target_path = Path::new(cwd).join(target_dir);
        if target_path.exists() {
            let _ = std::fs::remove_dir_all(&target_path);
        }
    }
    eprintln!("[team_git_clone] Server rejected --filter=blob:none, falling back to full clone");
    run_git(base_args, cwd)
}

/// Parse the NUL-delimited output of `git status --porcelain -z -uall`
/// and return only the paths of untracked entries (records starting with `?? `).
pub fn parse_untracked_paths(porcelain_bytes: &[u8]) -> Vec<String> {
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
fn embed_token_in_url(url: &str, token: &str) -> String {
    if token.is_empty() {
        return url.to_string();
    }
    if let Some(rest) = url.strip_prefix("https://") {
        if let Some(at_pos) = rest.find('@') {
            let user_part = &rest[..at_pos];
            let host_part = &rest[at_pos + 1..];
            if user_part.contains(':') {
                let user = user_part.split(':').next().unwrap_or("oauth2");
                format!("https://{}:{}@{}", user, token, host_part)
            } else {
                format!("https://{}:{}@{}", user_part, token, host_part)
            }
        } else {
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
        url.to_string()
    }
}

/// Check if a URL is an HTTPS URL.
fn is_https_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

pub fn get_team_repo_path(workspace_path: &str) -> String {
    let p = Path::new(workspace_path).join(super::TEAM_REPO_DIR);
    p.to_string_lossy().to_string()
}

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

    let dirs = [
        "skills",
        ".mcp",
        "knowledge",
        "_feedback",
        "_meta",
        "_secrets",
    ];
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
pub fn ensure_gitignore_rules(team_dir: &str) {
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

/// Compute HMAC-SHA256(secret_hex, "teamclaw-verify") and return hex string.
fn compute_secret_verify(team_secret: &str) -> Result<String, String> {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;

    let secret_bytes = hex::decode(team_secret).map_err(|e| format!("Invalid hex secret: {e}"))?;
    let mut mac =
        HmacSha256::new_from_slice(&secret_bytes).map_err(|e| format!("HMAC init failed: {e}"))?;
    mac.update(b"teamclaw-verify");
    Ok(hex::encode(mac.finalize().into_bytes()))
}

// ─── Join Implementation ─────────────────────────────────────────────────────

/// Shared body for both the synchronous (`team_git_join`) and background
/// (`team_git_join_background`) commands.
async fn team_git_join_impl(
    app: AppHandle,
    args: TeamGitJoinArgs,
) -> Result<TeamGitResult, String> {
    let TeamGitJoinArgs {
        git_url,
        git_token,
        git_branch,
        team_id,
        team_secret,
        member_name,
        llm_base_url,
        llm_model,
        llm_model_name,
        llm_models,
        fc_endpoint,
        workspace_path,
        access_token,
    } = args;
    let team_dir = get_team_repo_path(&workspace_path);

    if Path::new(&team_dir).exists() {
        return Err(format!(
            "{} already exists. Remove it first or disconnect the team repo to re-initialize.",
            super::TEAM_REPO_DIR
        ));
    }

    let remote_url = match &git_token {
        Some(token) if !token.is_empty() && is_https_url(&git_url) => {
            embed_token_in_url(&git_url, token)
        }
        _ => git_url.clone(),
    };

    let clone_args: Vec<&str> = if let Some(ref branch) = git_branch {
        if !branch.is_empty() {
            vec![
                "clone",
                "-b",
                branch.as_str(),
                &remote_url,
                super::TEAM_REPO_DIR,
            ]
        } else {
            vec!["clone", &remote_url, super::TEAM_REPO_DIR]
        }
    } else {
        vec!["clone", &remote_url, super::TEAM_REPO_DIR]
    };
    let (ok, _, stderr) = run_clone_with_partial_fallback(&clone_args, &workspace_path)?;
    if !ok {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err(format!(
            "git clone failed (check URL and authentication): {}",
            stderr.trim()
        ));
    }

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

    if team_meta.team_id != team_id {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err(format!(
            "Team ID mismatch: expected '{}' but repo has '{}'",
            team_id, team_meta.team_id
        ));
    }

    let fc_endpoint = fc_endpoint
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| team_meta.fc_endpoint.clone());

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

    let actor_id = crate::commands::daemon_http::read_daemon_actor_id();
    if actor_id.is_empty() {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err(
            "Daemon actor_id unavailable (daemon not onboarded); cannot add team member"
                .to_string(),
        );
    }
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(existing) = manifest.members.iter_mut().find(|m| m.node_id == actor_id) {
        existing.name = member_name.clone();
        existing.platform = std::env::consts::OS.to_string();
        existing.arch = std::env::consts::ARCH.to_string();
        existing.hostname = gethostname::gethostname().to_string_lossy().to_string();
    } else {
        use crate::commands::team_unified::{MemberRole, TeamMember};
        manifest.members.push(TeamMember {
            node_id: actor_id.clone(),
            name: member_name.clone(),
            role: MemberRole::Editor,
            shortcuts_role: Vec::new(),
            label: String::new(),
            platform: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            hostname: gethostname::gethostname().to_string_lossy().to_string(),
            added_at: now,
        });
    }

    let members_json = serde_json::to_string_pretty(&manifest).map_err(|e| {
        let _ = std::fs::remove_dir_all(&team_dir);
        format!("Failed to serialize members.json: {}", e)
    })?;
    if let Err(e) = std::fs::write(&members_path, members_json) {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err(format!("Failed to write members.json: {}", e));
    }

    let _ = run_git(&["config", "user.name", &member_name], &team_dir);
    let _ = run_git(
        &[
            "config",
            "user.email",
            &format!(
                "{}@teamclaw.local",
                actor_id.chars().take(8).collect::<String>()
            ),
        ],
        &team_dir,
    );

    let (ok, _, stderr) = run_git(&["add", "-A"], &team_dir)?;
    if !ok {
        println!("[Team Join] git add warning: {}", stderr.trim());
    }
    let (ok, _, stderr) = run_git(&["commit", "-m", "chore: member joined team"], &team_dir)?;
    if !ok {
        println!("[Team Join] git commit warning: {}", stderr.trim());
    }
    let branch = git_branch
        .as_deref()
        .filter(|b| !b.is_empty())
        .unwrap_or("main");
    let (ok, _, stderr) = run_git(&["push", "origin", branch], &team_dir)?;
    if !ok {
        let (ok2, head_out, _) = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], &team_dir)?;
        if ok2 {
            let head_branch = head_out.trim();
            if head_branch != branch {
                let (ok3, _, stderr3) = run_git(&["push", "origin", head_branch], &team_dir)?;
                if !ok3 {
                    println!("[Team Join] git push warning: {}", stderr3.trim());
                }
            } else {
                println!("[Team Join] git push warning: {}", stderr.trim());
            }
        }
    }

    let llm_config = crate::commands::team_litellm::build_llm_config(
        llm_base_url,
        llm_model,
        llm_model_name,
        llm_models,
    );
    crate::commands::team_litellm::write_llm_config(&workspace_path, llm_config.as_ref())?;
    println!(
        "[Team Join] Wrote LLM config to {}/{}",
        super::TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME
    );

    crate::commands::team_secret_store::save_team_secret(&workspace_path, &team_id, &team_secret)?;
    println!("[Team Join] Saved team_secret to local encrypted store");

    {
        let secrets_state = app.state::<crate::commands::shared_secrets::SharedSecretsState>();
        crate::commands::shared_secrets::init_shared_secrets(
            secrets_state.inner(),
            &team_secret,
            team_path,
        )?;
    }
    println!("[Team Join] Initialized shared secrets");

    match crate::commands::team::sync_team_mcp_configs_from_dir(&team_dir, &workspace_path) {
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

    match (
        fc_endpoint
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
        access_token
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    ) {
        (Some(endpoint), Some(token)) => {
            let url = format!(
                "{}/v1/teams/{}/litellm/member-key",
                endpoint.trim_end_matches('/'),
                team_id
            );
            let token = token.to_string();
            println!(
                "[Team Join] Scheduling LiteLLM member-key provisioning via FC: {}",
                url
            );
            tokio::spawn(async move {
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(30))
                    .build()
                    .unwrap_or_else(|_| reqwest::Client::new());
                match client
                    .post(&url)
                    .header("Authorization", format!("Bearer {}", token))
                    .send()
                    .await
                {
                    Ok(r) if r.status().is_success() => {
                        println!(
                            "[Team Join] LiteLLM member-key provisioned via FC: HTTP status={}",
                            r.status()
                        );
                    }
                    Ok(r) => {
                        let status = r.status();
                        let body = r.text().await.unwrap_or_default();
                        log::warn!(
                            "[Team Join] LiteLLM member-key provisioning via FC failed: HTTP status={} body={}",
                            status,
                            body
                        );
                    }
                    Err(e) => {
                        log::warn!(
                            "[Team Join] LiteLLM member-key provisioning via FC request failed: {e}"
                        );
                    }
                }
            });
        }
        (Some(_), None) => {
            log::warn!(
                "[Team Join] Skipping LiteLLM member-key provisioning: no access token available"
            );
        }
        (None, _) => {}
    }

    Ok(TeamGitResult {
        success: true,
        message: format!("Joined team '{}' successfully", team_meta.team_name),
        ..Default::default()
    })
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn team_check_workspace_has_git(
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<WorkspaceGitCheckResult, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    let git_dir = Path::new(&workspace_path).join(".git");
    Ok(WorkspaceGitCheckResult {
        has_git: git_dir.exists(),
    })
}

/// Join an existing team repo synchronously: clone, verify HMAC secret, add self as member.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn team_git_join(
    app: AppHandle,
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
    fc_endpoint: Option<String>,
    workspace_path: Option<String>,
    access_token: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<TeamGitResult, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    team_git_join_impl(
        app,
        TeamGitJoinArgs {
            git_url,
            git_token,
            git_branch,
            team_id,
            team_secret,
            member_name,
            llm_base_url,
            llm_model,
            llm_model_name,
            llm_models,
            fc_endpoint,
            workspace_path,
            access_token,
        },
    )
    .await
}

/// Join an existing team repo in the background.
///
/// Emits `team:git-join-clone-completed` on success and
/// `team:git-join-clone-failed` on failure.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn team_git_join_background(
    app: AppHandle,
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
    fc_endpoint: Option<String>,
    workspace_path: Option<String>,
    access_token: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    let app_for_spawn = app.clone();
    let args = TeamGitJoinArgs {
        git_url,
        git_token,
        git_branch,
        team_id: team_id.clone(),
        team_secret,
        member_name,
        llm_base_url,
        llm_model,
        llm_model_name,
        llm_models,
        fc_endpoint,
        workspace_path,
        access_token,
    };
    tokio::spawn(async move {
        match team_git_join_impl(app_for_spawn.clone(), args).await {
            Ok(result) => {
                println!("[Team Join Background] completed: {}", result.message);
                let _ = app_for_spawn.emit(
                    "team:git-join-clone-completed",
                    serde_json::json!({
                        "teamId": team_id,
                        "message": result.message,
                    }),
                );
            }
            Err(err) => {
                eprintln!("[Team Join Background] failed: {err}");
                let _ = app_for_spawn.emit(
                    "team:git-join-clone-failed",
                    serde_json::json!({
                        "teamId": team_id,
                        "error": err,
                    }),
                );
                use tauri_plugin_notification::NotificationExt;
                let _ = app_for_spawn
                    .notification()
                    .builder()
                    .title("Team sync failed")
                    .body(format!("Could not finish syncing team repo: {err}"))
                    .show();
            }
        }
    });
    Ok(())
}

/// Ensure .gitignore in team repo dir has all required rules.
#[tauri::command]
pub async fn team_generate_gitignore(
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<TeamGitResult, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    let team_dir = get_team_repo_path(&workspace_path);
    ensure_gitignore_rules(&team_dir);
    Ok(TeamGitResult {
        success: true,
        message: ".gitignore ensured".to_string(),
        ..Default::default()
    })
}

/// Initialize shared secrets for an already-configured Git team.
#[tauri::command]
pub async fn init_git_team_secrets(
    team_id: String,
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    secrets_state: State<'_, crate::commands::shared_secrets::SharedSecretsState>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    let team_dir = get_team_repo_path(&workspace_path);
    let team_path = Path::new(&team_dir);

    if !team_path.join("_meta").join("team.json").exists() {
        return Ok(());
    }

    let team_secret =
        crate::commands::team_secret_store::load_team_secret(&workspace_path, &team_id)
            .map_err(|e| format!("Failed to load team secret: {e}"))?;

    crate::commands::shared_secrets::init_shared_secrets(&secrets_state, &team_secret, team_path)?;

    Ok(())
}

/// Load the team secret from the local encrypted store for display in settings.
#[tauri::command]
pub async fn get_git_team_secret(
    team_id: String,
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<String, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    crate::commands::team_secret_store::load_team_secret(&workspace_path, &team_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_untracked_paths_basic() {
        let input = b"?? new.txt\x00 M modified.txt\x00?? subdir/other.bin\x00";
        let paths = parse_untracked_paths(input);
        assert_eq!(
            paths,
            vec!["new.txt".to_string(), "subdir/other.bin".to_string()]
        );
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

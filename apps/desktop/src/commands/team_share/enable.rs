//! Task 6 — `enable_oss` / `enable_managed_git` / `enable_custom_git`
//! / `set_team_secret` / `get_share_status` commands.
//!
//! These commands wire a team (already created via `team_share::create_team`)
//! into one of the three share modes. They:
//!   1. Generate (or accept) a 64-char hex team secret and persist it via
//!      `team_secret_store`.
//!   2. POST `/v1/teams/{teamId}/share-mode` on FC with the chosen mode +
//!      (for git modes) the `gitConfig` payload.
//!
//! The team shared directory is created and linked by the daemon (one global
//! copy per team under `~/.amuxd/teams/<team_id>/teamclaw-team`, exposed via a
//! `teamclaw-team` symlink in each workspace); these commands no longer create
//! a per-workspace real dir. Team identifiers (team_id / share_mode / git URL)
//! are NOT persisted to `teamclaw.json` — the single source of truth is the
//! Cloud API current-team store.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::commands::oss_sync::error::SyncError;
use crate::commands::oss_sync::fc_client::FcClient;
use crate::commands::oss_sync::get_fc_endpoint;
use crate::commands::team_share::custom_git;
use crate::commands::team_sync_proxy;
use crate::commands::{team_secret_store, TEAM_REPO_DIR};
use tracing::info;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnableShareResult {
    pub team_id: String,
    pub share_mode: String,
    /// Non-fatal warning surfaced when the share-mode POST succeeded but the
    /// subsequent secret-delivery / link to the daemon did not. The team is
    /// enabled server-side; the daemon may not yet have the secrets it needs to
    /// sync (e.g. it was momentarily unreachable). Frontend should surface this
    /// so the user can retry. Named `clone_warning` for frontend compatibility,
    /// but it now reflects daemon delivery/link rather than a local git clone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clone_warning: Option<String>,
}

/// Deliver team secret material to the daemon and trigger the link, treating
/// any daemon error as a non-fatal warning. The FC share-mode POST has already
/// committed server-side by the time this runs, so a momentarily-unreachable
/// daemon must not fail the whole enable/join — the daemon's sweep will catch
/// up once it can be reached and the user can retry.
///
/// Returns `Some(warning)` describing the first failure, or `None` on success.
async fn deliver_secrets_and_link(
    team_id: &str,
    workspace_path: &str,
    oss_team_secret: Option<&str>,
    git_credential: Option<&str>,
    git_branch: Option<&str>,
) -> Option<String> {
    if let Err(e) =
        team_sync_proxy::daemon_team_secrets(team_id, oss_team_secret, git_credential, git_branch)
            .await
    {
        return Some(format!("daemon secret delivery deferred: {e}"));
    }
    if let Err(e) = team_sync_proxy::daemon_team_link(workspace_path).await {
        return Some(format!("daemon link deferred: {e}"));
    }
    None
}

/// Resolve the SSH-key credential value to PEM **content**.
///
/// `GitEnableInput.credential` for `ssh_key` is documented as "SSH private key
/// PEM", but `custom_git::store_credential`'s contract treats the value as a
/// filesystem *path*. The daemon needs the PEM content. Be defensive: if the
/// value looks like a path to an existing file, read it; otherwise treat it as
/// already-PEM content and pass it through.
fn resolve_ssh_pem_content(credential: &str) -> Result<String, String> {
    let trimmed = credential.trim();
    let looks_like_pem = trimmed.starts_with("-----BEGIN");
    if !looks_like_pem {
        let p = std::path::Path::new(credential);
        if p.is_file() {
            return std::fs::read_to_string(p)
                .map_err(|e| format!("failed to read SSH key file {credential}: {e}"));
        }
    }
    Ok(credential.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitEnableInput {
    pub remote_url: String,
    /// "ssh_key" | "https_token"
    pub auth_kind: String,
    /// Raw credential material — SSH private key PEM or HTTPS token.
    pub credential: String,
    pub branch: Option<String>,
}

// ─── Helpers ─────────────────────────────────────────────────────────────

fn generate_team_secret_hex() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("getrandom failed: {e}"))?;
    Ok(hex::encode(bytes))
}

/// Use a caller-supplied 64-hex secret when provided; otherwise generate one.
fn resolve_team_secret_hex(team_secret_hex: Option<String>) -> Result<String, String> {
    match team_secret_hex {
        None => generate_team_secret_hex(),
        Some(raw) => {
            let normalized = raw.trim().to_ascii_lowercase();
            if normalized.is_empty() {
                return generate_team_secret_hex();
            }
            if normalized.len() != 64 || !normalized.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err("team secret must be exactly 64 hex characters".to_string());
            }
            Ok(normalized)
        }
    }
}

/// The team shared directory is now created and linked by the daemon
/// (one global copy per team under `~/.amuxd/teams/<team_id>/teamclaw-team`,
/// exposed via a `teamclaw-team` symlink in each workspace). Desktop no longer
/// eagerly creates a per-workspace real directory here; if a real dir is
/// created later (git clone / OSS engine first write), the daemon consolidates
/// it into the global copy and replaces it with a symlink. Kept as a no-op so
/// the enable_* call sites are unchanged and to document the ownership move.
fn ensure_team_repo_dir(_workspace_path: &str) -> Result<(), String> {
    Ok(())
}

async fn post_share_mode(
    workspace_path: &str,
    team_id: &str,
    body: &serde_json::Value,
    access_token: &str,
) -> Result<(), String> {
    let fc = FcClient::new(get_fc_endpoint(workspace_path), access_token.to_string());
    let path = format!("/v1/teams/{}/share-mode", team_id);
    // The /v1 share-mode endpoint returns 409 once a team's mode is locked.
    // FcClient::map_fc_response maps any 409 to SyncError::Conflict (its CAS
    // semantics for /sync/*), which would surface to the UI as the meaningless
    // "conflict: remote_version=None, remote_cipher_hash=None". Translate it to
    // a clear, user-facing message instead.
    fc.post_json(&path, body).await.map_err(|e| match e {
        SyncError::Conflict { .. } => {
            "团队共享已开通,无法重复开通或切换共享模式 (share mode already locked)".to_string()
        }
        other => other.to_string(),
    })?;
    Ok(())
}

// ─── enable_oss ──────────────────────────────────────────────────────────

pub async fn enable_oss_impl(
    team_id: String,
    workspace_path: String,
    access_token: String,
    team_secret_hex: Option<String>,
) -> Result<EnableShareResult, String> {
    // Lock the share mode on the server FIRST. If it is already locked (409),
    // post_share_mode returns a clear error and we bail out BEFORE mutating any
    // local state — otherwise we would overwrite the existing team secret and
    // break decryption of data already synced under the original secret.
    info!(team_id = %team_id, share_mode = "oss", "team_share_enable_oss: locking share-mode on FC");
    post_share_mode(
        &workspace_path,
        &team_id,
        &json!({ "mode": "oss" }),
        &access_token,
    )
    .await?;
    info!(team_id = %team_id, share_mode = "oss", "team_share_enable_oss: share-mode locked");

    let secret = resolve_team_secret_hex(team_secret_hex)?;
    team_secret_store::save_team_secret(&workspace_path, &team_id, &secret)?;

    ensure_team_repo_dir(&workspace_path)?;

    // Deliver the OSS team secret to the daemon and link this workspace. The
    // daemon owns the actual sync/materialization now — desktop no longer
    // clones or creates the team dir locally. Non-fatal on daemon error.
    let clone_warning =
        deliver_secrets_and_link(&team_id, &workspace_path, Some(&secret), None, None).await;

    Ok(EnableShareResult {
        team_id,
        share_mode: "oss".to_string(),
        clone_warning,
    })
}

#[tauri::command]
pub async fn team_share_enable_oss(
    team_id: String,
    workspace_path: String,
    access_token: String,
    team_secret_hex: Option<String>,
) -> Result<EnableShareResult, String> {
    enable_oss_impl(team_id, workspace_path, access_token, team_secret_hex).await
}

// ─── enable_managed_git ──────────────────────────────────────────────────

pub async fn enable_managed_git_impl(
    team_id: String,
    workspace_path: String,
    access_token: String,
    team_secret_hex: Option<String>,
) -> Result<EnableShareResult, String> {
    let secret = resolve_team_secret_hex(team_secret_hex)?;
    team_secret_store::save_team_secret(&workspace_path, &team_id, &secret)?;

    let fc = FcClient::new(get_fc_endpoint(&workspace_path), access_token.clone());

    // Provision the managed git repo via FC.
    let create_resp = fc
        .post_json("/managed-git/create-repo", &json!({ "teamId": team_id }))
        .await
        .map_err(|e| format!("/managed-git/create-repo failed: {e}"))?;
    // FC returns the bare CodeUp HTTPS clone URL plus the bot's git credential
    // (`pat`) and `botUsername`. CodeUp HTTPS auth expects `<username>:<token>`,
    // so we store the credential in that combined form; the daemon embeds it
    // verbatim into the remote URL (see `embed_token_in_url`).
    let repo_url = create_resp
        .get("repoHttpUrl")
        .or_else(|| create_resp.get("repo_url"))
        .or_else(|| create_resp.get("repoUrl"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "managed-git/create-repo: missing repoHttpUrl".to_string())?
        .to_string();
    let pat = create_resp
        .get("pat")
        .or_else(|| create_resp.get("push_token"))
        .or_else(|| create_resp.get("pushToken"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "managed-git/create-repo: missing pat".to_string())?
        .to_string();
    let bot_username = create_resp
        .get("botUsername")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    // Combined `user:token` userinfo when a bot username is present; otherwise
    // the bare token (daemon falls back to an `oauth2:<token>` embed).
    let git_credential = match bot_username {
        Some(user) => format!("{user}:{pat}"),
        None => pat,
    };

    let cred_ref = format!("managed_git:{}", team_id);
    custom_git::store_credential(&workspace_path, &cred_ref, "https_token", &git_credential)?;

    let body = json!({
        "mode": "managed_git",
        "gitConfig": {
            "remoteUrl": repo_url,
            "authKind": "https_token",
            "credentialRef": cred_ref,
        }
    });
    info!(team_id = %team_id, share_mode = "managed_git", remote_url = %repo_url, "team_share_enable_managed_git: locking share-mode on FC");
    post_share_mode(&workspace_path, &team_id, &body, &access_token).await?;
    info!(team_id = %team_id, share_mode = "managed_git", "team_share_enable_managed_git: share-mode locked");

    ensure_team_repo_dir(&workspace_path)?;

    // Deliver team secret + git credential; non-fatal on daemon error.
    let clone_warning = deliver_secrets_and_link(
        &team_id,
        &workspace_path,
        Some(&secret),
        Some(&git_credential),
        None,
    )
    .await;

    Ok(EnableShareResult {
        team_id,
        share_mode: "managed_git".to_string(),
        clone_warning,
    })
}

#[tauri::command]
pub async fn team_share_enable_managed_git(
    team_id: String,
    workspace_path: String,
    access_token: String,
    team_secret_hex: Option<String>,
) -> Result<EnableShareResult, String> {
    enable_managed_git_impl(team_id, workspace_path, access_token, team_secret_hex).await
}

// ─── enable_custom_git ──────────────────────────────────────────────────

pub async fn enable_custom_git_impl(
    team_id: String,
    workspace_path: String,
    input: GitEnableInput,
    access_token: String,
    team_secret_hex: Option<String>,
) -> Result<EnableShareResult, String> {
    if input.auth_kind != "ssh_key" && input.auth_kind != "https_token" {
        return Err(format!(
            "invalid auth_kind `{}`; expected `ssh_key` or `https_token`",
            input.auth_kind
        ));
    }

    // SSH with an empty credential = "use this machine's ~/.ssh / ssh-agent".
    // No private key is stored or delivered; the daemon falls back to the local
    // SSH setup (see `sync::git::ssh_env_local`), so the user never has to paste
    // a key or type a password. HTTPS always needs a token.
    let local_ssh = input.auth_kind == "ssh_key" && input.credential.trim().is_empty();

    let secret = resolve_team_secret_hex(team_secret_hex)?;
    team_secret_store::save_team_secret(&workspace_path, &team_id, &secret)?;

    // `credentialRef` is a device-local pointer; FC only checks it is non-empty.
    // We always send it so the server contract is satisfied, but only persist a
    // real credential entry when the user actually supplied key material.
    let cred_ref = format!("custom_git:{}", team_id);
    if !local_ssh {
        custom_git::store_credential(
            &workspace_path,
            &cred_ref,
            &input.auth_kind,
            &input.credential,
        )?;
    }

    let mut git_config = json!({
        "remoteUrl": input.remote_url,
        "authKind": input.auth_kind,
        "credentialRef": cred_ref,
    });
    if let Some(branch) = input.branch.as_deref() {
        if let Some(obj) = git_config.as_object_mut() {
            obj.insert(
                "branch".to_string(),
                serde_json::Value::String(branch.to_string()),
            );
        }
    }

    let body = json!({
        "mode": "custom_git",
        "gitConfig": git_config,
    });
    info!(
        team_id = %team_id,
        share_mode = "custom_git",
        remote_url = %input.remote_url,
        auth_kind = %input.auth_kind,
        local_ssh = local_ssh,
        "team_share_enable_custom_git: locking share-mode on FC"
    );
    post_share_mode(&workspace_path, &team_id, &body, &access_token).await?;
    info!(team_id = %team_id, share_mode = "custom_git", "team_share_enable_custom_git: share-mode locked");

    ensure_team_repo_dir(&workspace_path)?;

    // Deliver the git credential to the daemon. For `https_token` the
    // credential is the literal token; for `ssh_key` the daemon needs the PEM
    // *content* (resolve_ssh_pem_content reads the file if input.credential is
    // a path). For local-SSH there is no credential — the daemon reuses the
    // machine's ~/.ssh / ssh-agent. Pass the user's branch through; the daemon
    // owns the clone.
    let git_credential = if local_ssh {
        None
    } else if input.auth_kind == "ssh_key" {
        Some(resolve_ssh_pem_content(&input.credential)?)
    } else {
        Some(input.credential.clone())
    };
    let clone_warning = deliver_secrets_and_link(
        &team_id,
        &workspace_path,
        Some(&secret),
        git_credential.as_deref(),
        input.branch.as_deref(),
    )
    .await;

    Ok(EnableShareResult {
        team_id,
        share_mode: "custom_git".to_string(),
        clone_warning,
    })
}

#[tauri::command]
pub async fn team_share_enable_custom_git(
    team_id: String,
    workspace_path: String,
    input: GitEnableInput,
    access_token: String,
    team_secret_hex: Option<String>,
) -> Result<EnableShareResult, String> {
    enable_custom_git_impl(
        team_id,
        workspace_path,
        input,
        access_token,
        team_secret_hex,
    )
    .await
}

// ─── set_team_secret ────────────────────────────────────────────────────

/// Save the team secret and hand it to the daemon.
///
/// Returns `Some(warning)` when the local save succeeded but the daemon did
/// not take delivery. That stays non-fatal — the local copy is the
/// contractually-required outcome and the daemon's sweep catches up once
/// reachable — but it is returned rather than logged: the daemon's own copy is
/// the system of record for decrypting `_secrets/`, so until delivery lands
/// the team's shared env vars are dead and only the user can retry.
pub async fn set_team_secret_impl(
    team_id: String,
    secret_hex: String,
    workspace_path: String,
) -> Result<Option<String>, String> {
    let normalized = secret_hex.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("team secret must be exactly 64 hex characters".to_string());
    }
    team_secret_store::save_team_secret(&workspace_path, &team_id, &normalized)?;

    let warning =
        deliver_secrets_and_link(&team_id, &workspace_path, Some(&normalized), None, None).await;
    if let Some(w) = &warning {
        info!("team_share_set_team_secret: {w}");
    }
    Ok(warning)
}

#[tauri::command]
pub async fn team_share_set_team_secret(
    team_id: String,
    secret_hex: String,
    workspace_path: String,
) -> Result<Option<String>, String> {
    set_team_secret_impl(team_id, secret_hex, workspace_path).await
}

// ─── get_team_secret ─────────────────────────────────────────────────────

/// Read back the locally-stored team secret so the settings UI can show the
/// currently-configured value instead of a blank box on re-entry. Returns
/// `None` when no secret has been saved for this team/workspace yet (rather
/// than an error) so the frontend can distinguish "not configured" from a real
/// read failure.
#[tauri::command]
pub async fn team_share_get_team_secret(
    team_id: String,
    workspace_path: String,
) -> Result<Option<String>, String> {
    match team_secret_store::load_team_secret(&workspace_path, &team_id) {
        Ok(secret) => Ok(Some(secret)),
        // `load_team_secret` only errors with a "not found" message when the
        // key is absent; treat that as "not configured".
        Err(_) => Ok(None),
    }
}

// ─── get_share_status ────────────────────────────────────────────────────

/// What the workspace `teamclaw-team` entry currently is:
/// `"symlink"` (linked to the daemon's global copy — a Windows junction also
/// reports as a symlink to symlink_metadata), `"real_dir"` (legacy local dir,
/// awaiting daemon consolidation), or `"missing"` (not linked yet).
pub(crate) fn detect_link_status(workspace_path: &str) -> &'static str {
    let link = std::path::Path::new(workspace_path).join(TEAM_REPO_DIR);
    match std::fs::symlink_metadata(&link) {
        Ok(m) if m.file_type().is_symlink() => "symlink",
        Ok(m) if m.is_dir() => "real_dir",
        _ => "missing",
    }
}

/// `~/.amuxd/teams/<team_id>/teamclaw-team` — the daemon's global copy path,
/// shown in the UI so users can see where synced content actually lives.
pub(crate) fn global_team_dir_display(team_id: &str) -> Option<String> {
    dirs::home_dir().map(|h| {
        h.join(".amuxd")
            .join("teams")
            .join(team_id)
            .join(TEAM_REPO_DIR)
            .to_string_lossy()
            .into_owned()
    })
}

pub async fn get_share_status_impl(
    team_id: String,
    workspace_path: String,
    access_token: String,
) -> Result<serde_json::Value, String> {
    let fc = FcClient::new(get_fc_endpoint(&workspace_path), access_token);
    let path = format!("/v1/teams/{}/share-mode", team_id);
    let mut value = fc.get_json(&path).await.map_err(|e| e.to_string())?;
    // Augment the server share-mode payload with local link + global-path info
    // so the settings UI can show where synced content lives and whether this
    // workspace is linked. camelCase to match the existing payload shape.
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "linkStatus".to_string(),
            json!(detect_link_status(&workspace_path)),
        );
        if let Some(p) = global_team_dir_display(&team_id) {
            obj.insert("globalPath".to_string(), json!(p));
        }
    }
    Ok(value)
}

#[tauri::command]
pub async fn team_share_get_status(
    team_id: String,
    workspace_path: String,
    access_token: String,
) -> Result<serde_json::Value, String> {
    get_share_status_impl(team_id, workspace_path, access_token).await
}

// ─── team_sync_paths ───────────────────────────────────────────────────────
//
// Surfaces, for the settings UI, *where team content physically lives* and
// *every `teamclaw-team` symlink that points at it*. All three share modes
// (oss / managed_git / custom_git) converge on the same topology: one real
// directory per team at `~/.amuxd/teams/<team_id>/teamclaw-team` (the daemon's
// global copy; git modes clone into it), with a `teamclaw-team` symlink in each
// workspace that joined the team. The list of workspaces comes from the Cloud
// API (`GET /v1/workspaces?teamId=...`, the single source of truth for a
// team's workspaces), filtered to paths that exist on this machine.

/// One workspace's `teamclaw-team` entry, for the settings UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLinkInfo {
    pub workspace_path: String,
    pub display_name: String,
    /// `<workspace_path>/teamclaw-team` — the symlink (or legacy local dir).
    pub link_path: String,
    /// `"symlink"` | `"real_dir"` | `"missing"` (see `detect_link_status`).
    pub status: String,
    /// Whether this is the workspace currently open in the app.
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSyncPaths {
    /// `~/.amuxd/teams/<team_id>/teamclaw-team` — the single real copy.
    pub real_dir: Option<String>,
    /// Whether that real directory currently exists on disk.
    pub real_dir_exists: bool,
    /// The current workspace plus every workspace bound to this team in the
    /// daemon registry, each with its `teamclaw-team` link status.
    pub links: Vec<WorkspaceLinkInfo>,
}

/// One workspace as returned by the Cloud API — kept minimal (only the
/// fields the settings UI's symlink materialization actually needs).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct RegistryWorkspace {
    #[serde(default)]
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) team_id: Option<String>,
}

/// Raw item shape of `GET /v1/workspaces?teamId=...` — `name` is the display
/// name, `slug` carries the filesystem path (mirrors the daemon's
/// `WorkspaceRow` mapping in `apps/daemon/src/backend/cloud_api/mod.rs`).
#[derive(Debug, Default, Deserialize)]
struct CloudWorkspaceItem {
    #[serde(default)]
    name: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default, rename = "teamId")]
    team_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct CloudWorkspacePage {
    #[serde(default)]
    items: Vec<CloudWorkspaceItem>,
}

/// Keep only cloud workspaces whose path exists as a directory on *this*
/// machine. Pure (no network) so it's easy to unit-test in isolation — the
/// cloud `workspaces` table intentionally includes other devices' workspace
/// paths, which this daemon/desktop must never touch. Mirrors the daemon's
/// `cloud_rows_to_local_linkable_paths` filter (Task 8) for consistency.
fn filter_workspaces_present_on_disk(items: Vec<RegistryWorkspace>) -> Vec<RegistryWorkspace> {
    items
        .into_iter()
        .filter(|w| !w.path.is_empty() && std::path::Path::new(&w.path).is_dir())
        .collect()
}

/// Fetch `team_id`'s workspaces from the Cloud API and filter to paths that
/// exist locally. Best-effort: any network/parse/auth failure yields an empty
/// list rather than surfacing an error, matching the previous (toml-read)
/// behavior's fail-open semantics for this settings-UI-only surface.
pub(crate) async fn load_team_workspaces(
    team_id: &str,
    workspace_path: &str,
    access_token: &str,
) -> Vec<RegistryWorkspace> {
    if team_id.trim().is_empty() || access_token.trim().is_empty() {
        return vec![];
    }
    let fc = FcClient::new(get_fc_endpoint(workspace_path), access_token.to_string());
    let path = format!(
        "/v1/workspaces?teamId={}&limit=200",
        urlencoding::encode(team_id)
    );
    let items = match fc.get_json(&path).await {
        Ok(value) => serde_json::from_value::<CloudWorkspacePage>(value)
            .map(|p| p.items)
            .unwrap_or_default(),
        Err(_) => return vec![],
    };
    let workspaces: Vec<RegistryWorkspace> = items
        .into_iter()
        .filter_map(|item| {
            let path = item.path.or(item.slug)?;
            if path.trim().is_empty() {
                return None;
            }
            Some(RegistryWorkspace {
                path,
                display_name: item.name,
                team_id: item.team_id.or_else(|| Some(team_id.to_string())),
            })
        })
        .collect();
    filter_workspaces_present_on_disk(workspaces)
}

/// Best-effort canonicalization for stable path comparison; falls back to the
/// raw string when the path can't be canonicalized (e.g. it doesn't exist).
fn canon_path(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

fn basename_or(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn push_workspace_link(
    links: &mut Vec<WorkspaceLinkInfo>,
    seen: &mut std::collections::HashSet<String>,
    ws_path: &str,
    display_name: String,
    is_current: bool,
) {
    if ws_path.is_empty() || !seen.insert(canon_path(ws_path)) {
        return;
    }
    let link_path = std::path::Path::new(ws_path)
        .join(TEAM_REPO_DIR)
        .to_string_lossy()
        .into_owned();
    links.push(WorkspaceLinkInfo {
        workspace_path: ws_path.to_string(),
        display_name,
        link_path,
        status: detect_link_status(ws_path).to_string(),
        is_current,
    });
}

pub async fn team_sync_paths_impl(
    team_id: String,
    workspace_path: String,
    access_token: Option<String>,
) -> TeamSyncPaths {
    let real_dir = global_team_dir_display(&team_id);
    let real_dir_exists = real_dir
        .as_deref()
        .map(|p| std::path::Path::new(p).exists())
        .unwrap_or(false);

    let current_canon = canon_path(&workspace_path);
    let mut links: Vec<WorkspaceLinkInfo> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Current workspace first, even if it isn't team-bound in the registry yet
    // (e.g. just enabled, daemon hasn't recorded team_id). Dedup handles the
    // overlap when it *is* already in the registry.
    if !workspace_path.is_empty() {
        let name = basename_or(&workspace_path);
        push_workspace_link(&mut links, &mut seen, &workspace_path, name, true);
    }

    // Other team workspaces come from the Cloud API and require an auth
    // token; when the caller doesn't have one handy (best-effort settings-UI
    // surface), we still show the current workspace above and simply skip
    // the rest rather than failing the whole command.
    let token = access_token.unwrap_or_default();
    for w in load_team_workspaces(&team_id, &workspace_path, &token).await {
        let is_current = canon_path(&w.path) == current_canon;
        let name = if w.display_name.is_empty() {
            basename_or(&w.path)
        } else {
            w.display_name.clone()
        };
        push_workspace_link(&mut links, &mut seen, &w.path, name, is_current);
    }

    TeamSyncPaths {
        real_dir,
        real_dir_exists,
        links,
    }
}

#[tauri::command]
pub async fn team_sync_paths(
    team_id: String,
    workspace_path: String,
    access_token: Option<String>,
) -> Result<TeamSyncPaths, String> {
    Ok(team_sync_paths_impl(team_id, workspace_path, access_token).await)
}

#[cfg(test)]
mod link_status_tests {
    use super::*;

    #[test]
    fn reports_missing_when_absent() {
        let ws = tempfile::tempdir().unwrap();
        assert_eq!(detect_link_status(ws.path().to_str().unwrap()), "missing");
    }

    #[test]
    fn reports_real_dir_for_plain_directory() {
        let ws = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(ws.path().join(TEAM_REPO_DIR)).unwrap();
        assert_eq!(detect_link_status(ws.path().to_str().unwrap()), "real_dir");
    }

    #[cfg(unix)]
    #[test]
    fn reports_symlink_when_present() {
        let ws = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(target.path(), ws.path().join(TEAM_REPO_DIR)).unwrap();
        assert_eq!(detect_link_status(ws.path().to_str().unwrap()), "symlink");
    }

    #[test]
    fn global_path_contains_team_and_amuxd() {
        if let Some(p) = global_team_dir_display("team-xyz") {
            assert!(p.contains("team-xyz"));
            assert!(p.contains(".amuxd"));
            assert!(p.ends_with(TEAM_REPO_DIR));
        }
    }

    #[test]
    fn filter_workspaces_present_on_disk_keeps_only_existing_dirs() {
        let ws = tempfile::tempdir().unwrap();
        let existing = ws.path().to_str().unwrap().to_string();
        let missing = ws
            .path()
            .join("does-not-exist")
            .to_string_lossy()
            .into_owned();

        let items = vec![
            RegistryWorkspace {
                path: existing.clone(),
                display_name: "alpha".into(),
                team_id: Some("team-1".into()),
            },
            RegistryWorkspace {
                path: missing,
                display_name: "beta".into(),
                team_id: Some("team-1".into()),
            },
            RegistryWorkspace {
                path: String::new(),
                display_name: "gamma".into(),
                team_id: Some("team-1".into()),
            },
        ];

        let got = filter_workspaces_present_on_disk(items);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].path, existing);
    }

    #[tokio::test]
    async fn load_team_workspaces_short_circuits_without_team_or_token() {
        // No network involved: empty team_id / access_token both bail before
        // any HTTP call is attempted, so this is safe to run in CI.
        assert!(load_team_workspaces("", "/tmp", "token").await.is_empty());
        assert!(load_team_workspaces("team-1", "/tmp", "").await.is_empty());
    }

    #[tokio::test]
    async fn sync_paths_includes_current_workspace_with_link_status() {
        let ws = tempfile::tempdir().unwrap();
        let ws_path = ws.path().to_str().unwrap().to_string();
        // No access token → the cloud fetch is skipped entirely (best-effort),
        // so this stays a pure local-disk test like the pre-refactor version.
        let out = team_sync_paths_impl("team-xyz".into(), ws_path.clone(), None).await;

        // Current workspace is always present and flagged, even when it isn't
        // team-bound in the cloud list yet. With no teamclaw-team entry on
        // disk → "missing".
        let current: Vec<_> = out.links.iter().filter(|l| l.is_current).collect();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].status, "missing");
        assert!(current[0].link_path.ends_with(TEAM_REPO_DIR));
    }
}

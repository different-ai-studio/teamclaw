//! HTTP loopback endpoints for daemon-owned team sync (desktop triggers these).
//!
//! The desktop app drives team sync over the daemon's loopback HTTP API rather
//! than running git/OSS itself. `POST /v1/team/sync` kicks a sync for the
//! workspace's onboarded team; `GET /v1/team/sync/status` reads the cached last
//! status. The daemon is single-team, so the team_id is resolved from
//! `daemon.toml` (teamclaw.json carries no team_id) — same lookup as
//! `/v1/team/link`.
use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;
use crate::sync::versions::{self, ChangedFile, VersionEntry};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub workspace_path: String,
    #[serde(default)]
    pub force_wipe_non_git: bool,
}

#[derive(Debug, Serialize)]
pub struct SyncResponse {
    #[serde(flatten)]
    pub status: crate::sync::dispatch::SyncStatus,
}

/// `POST /v1/team/sync` — body `{ "workspacePath": "<abs path>" }`.
pub async fn sync_now(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<SyncRequest>,
) -> Result<Json<SyncResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let workspace_path = body.workspace_path.trim();
    if workspace_path.is_empty() {
        return Err(HttpError::validation("workspacePath must not be empty"));
    }
    let team_id = team_id_for_workspace(workspace_path)?;
    crate::team_link::ensure_team_link(&team_id, workspace_path);
    let status = state
        .sync_dispatcher
        .sync_team(
            &team_id,
            workspace_path,
            crate::sync::dispatch::SyncOptions {
                wipe_non_git: body.force_wipe_non_git,
            },
        )
        .await;
    if let Some(err) = status
        .last_error
        .as_deref()
        .filter(|e| !e.trim().is_empty())
    {
        if crate::sync::git::is_not_git_repo_error(err) {
            return Err(HttpError::team_shared_dir_not_git(format!(
                "shared directory exists but is not a git repository ({err})"
            )));
        }
        return Err(HttpError::internal(err.to_string()));
    }
    if status
        .mode
        .as_deref()
        .filter(|m| !m.trim().is_empty())
        .is_none()
    {
        return Err(HttpError::team_share_not_enabled_for_daemon(format!(
            "team share is not enabled for daemon team {team_id} (share_mode is unset). \
             If you switched teams in the app, re-bind the local daemon (amuxd init) to the current team, then enable Git share again."
        )));
    }
    Ok(Json(SyncResponse { status }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusQuery {
    pub team_id: String,
}

/// `GET /v1/team/sync/status?teamId=...`
pub async fn sync_status(
    principal: Principal,
    State(state): State<HttpState>,
    Query(q): Query<StatusQuery>,
) -> Result<Json<crate::sync::dispatch::SyncStatus>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    Ok(Json(state.sync_dispatcher.status(&q.team_id).await))
}

// ---------------------------------------------------------------------------
// Task 11: secrets delivery
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsRequest {
    pub team_id: String,
    #[serde(default)]
    pub oss_team_secret: Option<String>,
    #[serde(default)]
    pub user_jwt: Option<String>,
    #[serde(default)]
    pub git_credential: Option<String>,
    #[serde(default)]
    pub git_branch: Option<String>,
}

/// `POST /v1/team/secrets` — desktop delivers credentials for headless sync.
/// JWTs expire: while the app is closed and the stored JWT is expired, OSS timer
/// syncs fail until the desktop re-posts a fresh JWT. Git timer syncs are
/// unaffected (git_token does not expire).
pub async fn set_secrets(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<SecretsRequest>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    // Trim then validate, exactly as `amuxd team secrets set` does: a secret
    // pasted into the setup UI arrives with stray whitespace far more often than
    // one typed as a CLI flag, and a malformed secret stored here would not
    // surface until it failed to decrypt on the next sync tick.
    let oss_team_secret = body.oss_team_secret.map(|s| s.trim().to_string());
    if let Some(secret) = oss_team_secret.as_deref() {
        crate::sync::secret_store::validate_team_secret(secret).map_err(HttpError::validation)?;
    }
    let incoming = crate::sync::secret_store::TeamSecrets {
        oss_team_secret,
        user_jwt: body.user_jwt,
        git_credential: body.git_credential,
        git_branch: body.git_branch,
    };
    state
        .sync_dispatcher
        .secrets()
        .merge(&body.team_id, &incoming)
        .map_err(|e| HttpError::internal(format!("store secrets: {e}")))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub set: bool,
    /// Masked fingerprint (`(set, ab12…ef90)`), never the value. See
    /// [`crate::sync::secret_store::mask_secret`].
    pub display: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsStatusResponse {
    pub team_id: String,
    pub oss_team_secret: SecretStatus,
    pub git_credential: SecretStatus,
    pub user_jwt: SecretStatus,
    /// Not a credential — the branch name is plain config, so it is returned
    /// as-is. The UI needs it to prefill the field.
    pub git_branch: Option<String>,
}

/// `GET /v1/team/secrets?teamId=...` — which sync credentials are stored.
///
/// The read counterpart of `POST /v1/team/secrets`, which had no way to answer
/// "is this already configured?" over HTTP — only `amuxd team secrets show`
/// could. Values are never returned, so this is `workspace:read` rather than
/// `workspace:write`: it reveals set/unset plus a fingerprint, the same
/// information the CLI prints.
pub async fn get_secrets(
    principal: Principal,
    State(state): State<HttpState>,
    Query(q): Query<StatusQuery>,
) -> Result<Json<SecretsStatusResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;

    let secrets = state
        .sync_dispatcher
        .secrets()
        .load(&q.team_id)
        .map_err(|e| HttpError::internal(format!("read secrets: {e}")))?;

    let status = |v: Option<&str>| SecretStatus {
        set: v.is_some(),
        display: crate::sync::secret_store::mask_secret(v),
    };

    Ok(Json(SecretsStatusResponse {
        team_id: q.team_id.clone(),
        oss_team_secret: status(secrets.oss_team_secret.as_deref()),
        git_credential: status(secrets.git_credential.as_deref()),
        user_jwt: status(secrets.user_jwt.as_deref()),
        git_branch: secrets.git_branch,
    }))
}

// ---------------------------------------------------------------------------
// Task 12: conflict + version endpoints
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEntry {
    pub path: String,
    pub kind: String,
}

/// `GET /v1/team/conflicts?teamId=...` — list both OSS sidecar conflicts (on
/// disk under the global team dir) and a synthetic git-backup marker when the
/// last git sync moved diverged files into `.trash`.
pub async fn list_conflicts(
    principal: Principal,
    State(state): State<HttpState>,
    Query(q): Query<StatusQuery>,
) -> Result<Json<Vec<ConflictEntry>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let root = crate::config::global_team_store::global_team_dir(&q.team_id);
    let mut out = Vec::new();
    for p in crate::sync::oss::scanner::scan_conflict_files(&root.to_string_lossy()) {
        out.push(ConflictEntry {
            path: p,
            kind: "oss-sidecar".into(),
        });
    }
    let st = state.sync_dispatcher.status(&q.team_id).await;
    if st.conflicts > 0 {
        out.push(ConflictEntry {
            path: ".trash".into(),
            kind: "git-backup".into(),
        });
    }
    Ok(Json(out))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRequest {
    pub team_id: String,
    pub path: String,
    pub choice: crate::sync::oss::ConflictChoice,
}

/// `POST /v1/team/conflicts/resolve` — resolve an OSS sidecar conflict by
/// recording the user's KeepRemote/KeepLocal choice in the per-team sync state.
/// Ported from desktop `oss_sync_resolve_conflict`, operating on the global
/// per-team `LocalSyncState` rather than a workspace path.
pub async fn resolve_conflict(
    principal: Principal,
    State(_state): State<HttpState>,
    Json(body): Json<ResolveRequest>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    // Validate the wire path for consistency (used only to index state here).
    crate::sync::oss::path_validator::validate(&body.path)
        .map_err(|e| HttpError::validation(format!("invalid path: {e}")))?;
    let mut st = crate::sync::oss::state::LocalSyncState::load_at(&body.team_id)
        .map_err(|e| HttpError::internal(format!("load sync state: {e}")))?;
    match body.choice {
        crate::sync::oss::ConflictChoice::KeepRemote => {
            // Mark local as matching synced (non-dirty); next tick won't re-upload.
            if let Some(fs) = st.files.get_mut(&body.path) {
                fs.local_plain_hash = fs.synced_plain_hash.clone();
                fs.dirty = false;
            }
        }
        crate::sync::oss::ConflictChoice::KeepLocal => {
            // Mark dirty=true so the next push uploads the local version.
            if let Some(fs) = st.files.get_mut(&body.path) {
                fs.dirty = true;
            }
        }
    }
    st.save_at(&body.team_id)
        .map_err(|e| HttpError::internal(format!("save sync state: {e}")))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionsQuery {
    pub team_id: String,
    pub path: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub fc_endpoint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListVersionsResponse {
    pub versions: Vec<VersionEntry>,
    pub next_cursor: Option<String>,
}

/// Build an `FcClient` from the per-team secret store. The daemon is single-team
/// and the team_secret is delivered via `/v1/team/secrets`. The FC bearer is the
/// daemon's own auto-refreshing cloud token (`oss_jwt`), not a desktop-delivered
/// JWT, so headless version browsing survives a stale delivered JWT. Returns
/// `(FcClient, team_secret)`.
async fn fc_client_from_store(
    state: &HttpState,
    team_id: &str,
    fc_endpoint: Option<String>,
) -> Result<(crate::sync::oss::fc_client::FcClient, String), HttpError> {
    let team_secret = state
        .sync_dispatcher
        .secrets()
        .resolve_team_secret(team_id, None)
        .map_err(|e| HttpError::validation(format!("no OSS team secret: {e}")))?;
    let jwt = state
        .sync_dispatcher
        .oss_jwt()
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let base = fc_endpoint
        .filter(|s| !s.trim().is_empty())
        .or_else(|| state.sync_dispatcher.fc_endpoint().ok())
        .ok_or_else(|| {
            HttpError::internal(
                "FC endpoint not configured: no cloud backend URL available".to_string(),
            )
        })?;
    Ok((
        crate::sync::oss::fc_client::FcClient::new(base, jwt),
        team_secret,
    ))
}

/// `GET /v1/team/versions?teamId=&path=&cursor=&fcEndpoint=` — one page of a
/// file's version history. Ported from desktop `oss_sync_list_versions`.
pub async fn list_versions(
    principal: Principal,
    State(state): State<HttpState>,
    Query(q): Query<VersionsQuery>,
) -> Result<Json<ListVersionsResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let team_dir = crate::config::global_team_store::global_team_dir(&q.team_id);

    if versions::is_git_team(&team_dir) {
        let entries = versions::git_list_versions(&team_dir, &q.path);
        return Ok(Json(ListVersionsResponse {
            versions: entries,
            next_cursor: None,
        }));
    }

    let (fc, _secret) = fc_client_from_store(&state, &q.team_id, q.fc_endpoint).await?;
    let (infos, next_cursor) = fc
        .list_versions(&q.team_id, &q.path, q.cursor)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let entries = infos
        .into_iter()
        .map(|v| VersionEntry {
            reference: v
                .content_hash
                .clone()
                .unwrap_or_else(|| v.version.to_string()),
            author: v.created_by,
            timestamp: v.created_at,
            deleted: v.deleted,
            message: v.message,
        })
        .collect();
    Ok(Json(ListVersionsResponse {
        versions: entries,
        next_cursor,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRequest {
    pub team_id: String,
    pub path: String,
    pub content_hash: String,
    #[serde(default)]
    pub fc_endpoint: Option<String>,
}

/// `POST /v1/team/versions/restore` — restore a file to a specific version by
/// downloading + decrypting its blob into the GLOBAL content root, then updating
/// the per-team sync state. Ported from desktop `oss_sync_restore_version`,
/// writing to `<global_team_dir>/<path>` instead of the in-workspace team dir.
pub async fn restore_version(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<RestoreRequest>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    // body.path is untrusted (off the wire); reject traversal/absolute paths
    // before joining it onto the global team dir.
    crate::sync::oss::path_validator::validate(&body.path)
        .map_err(|e| HttpError::validation(format!("invalid path: {e}")))?;
    let (fc, team_secret) = fc_client_from_store(&state, &body.team_id, body.fc_endpoint).await?;
    let key = crate::team_shared_env::derive_key(&team_secret)
        .map_err(|e| HttpError::internal(format!("derive key: {e}")))?;

    let mut st = crate::sync::oss::state::LocalSyncState::load_at(&body.team_id)
        .map_err(|e| HttpError::internal(format!("load sync state: {e}")))?;

    let dl = fc
        .download(&body.team_id, &body.content_hash)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let blob = fc
        .get_blob(&dl.download_url, &body.content_hash)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let plaintext = crate::sync::oss::crypto::decrypt_blob(&blob, &key)
        .map_err(|e| HttpError::internal(format!("decrypt: {e}")))?;
    let plain_hash = crate::sync::oss::crypto::sha256_hex(&plaintext);

    // Write into the GLOBAL content root, not a workspace path.
    let abs_path =
        crate::config::global_team_store::global_team_dir(&body.team_id).join(&body.path);
    // Defense-in-depth: ensure the resolved path does not escape the team dir
    // via an existing symlink before writing.
    crate::sync::oss::path_validator::validate_no_symlink_escape(
        &crate::config::global_team_store::global_team_dir(&body.team_id),
        &abs_path,
    )
    .map_err(|e| HttpError::validation(format!("path escapes team dir: {e}")))?;
    if let Some(parent) = abs_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| HttpError::internal(format!("mkdir: {e}")))?;
    }
    std::fs::write(&abs_path, &plaintext)
        .map_err(|e| HttpError::internal(format!("write file: {e}")))?;

    let meta =
        std::fs::metadata(&abs_path).map_err(|e| HttpError::internal(format!("stat file: {e}")))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.len();

    let synced_version = st
        .files
        .get(&body.path)
        .map(|f| f.synced_version)
        .unwrap_or(0);

    st.upsert(
        &body.path,
        synced_version,
        body.content_hash.clone(),
        plain_hash.clone(),
        plain_hash,
        mtime,
        size,
    );
    st.save_at(&body.team_id)
        .map_err(|e| HttpError::internal(format!("save sync state: {e}")))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileQuery {
    pub team_id: String,
    pub path: String,
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub fc_endpoint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentResponse {
    pub content: Option<String>,
}

/// `GET /v1/team/file?teamId=&path=&ref=&fcEndpoint=` — resolve one file's
/// content at a given version. git mode: `git show <ref>:<path>`. oss mode:
/// `ref` is either a content hash or the reserved "baseline" token (resolves to
/// the last-synced cipher hash from local sync state); the blob is downloaded +
/// decrypted. Missing file/version yields `{ content: null }`.
pub async fn get_file(
    principal: Principal,
    State(state): State<HttpState>,
    Query(q): Query<FileQuery>,
) -> Result<Json<FileContentResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let team_dir = crate::config::global_team_store::global_team_dir(&q.team_id);

    if versions::is_git_team(&team_dir) {
        let content = versions::git_show(&team_dir, &q.reference, &q.path);
        return Ok(Json(FileContentResponse { content }));
    }

    let cipher_hash = if q.reference == "baseline" {
        crate::sync::oss::state::LocalSyncState::load_at(&q.team_id)
            .ok()
            .and_then(|st| st.files.get(&q.path).map(|f| f.synced_cipher_hash.clone()))
            .filter(|h| !h.is_empty())
    } else {
        Some(q.reference.clone())
    };
    let Some(cipher_hash) = cipher_hash else {
        return Ok(Json(FileContentResponse { content: None }));
    };

    let (fc, secret) = fc_client_from_store(&state, &q.team_id, q.fc_endpoint).await?;
    let key = crate::team_shared_env::derive_key(&secret)
        .map_err(|e| HttpError::internal(format!("derive key: {e}")))?;
    let dl = fc
        .download(&q.team_id, &cipher_hash)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let blob = fc
        .get_blob(&dl.download_url, &cipher_hash)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let plaintext = crate::sync::oss::crypto::decrypt_blob(&blob, &key)
        .map_err(|e| HttpError::internal(format!("decrypt: {e}")))?;
    let content =
        String::from_utf8(plaintext).map_err(|e| HttpError::internal(format!("utf8: {e}")))?;
    Ok(Json(FileContentResponse {
        content: Some(content),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedQuery {
    pub team_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedResponse {
    pub files: Vec<ChangedFile>,
}

/// `GET /v1/team/changed?teamId=` — list files with local changes. git mode:
/// `git status --porcelain`. oss mode: dirty entries from the per-team
/// `LocalSyncState`.
pub async fn list_changed(
    principal: Principal,
    State(_state): State<HttpState>,
    Query(q): Query<ChangedQuery>,
) -> Result<Json<ChangedResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let team_dir = crate::config::global_team_store::global_team_dir(&q.team_id);

    if versions::is_git_team(&team_dir) {
        return Ok(Json(ChangedResponse {
            files: versions::git_changed(&team_dir),
        }));
    }

    let files = crate::sync::oss::state::LocalSyncState::load_at(&q.team_id)
        .map(|st| {
            st.files
                .into_iter()
                .filter(|(_, f)| f.dirty)
                .map(|(path, f)| ChangedFile {
                    path,
                    status: if f.deleted_local {
                        "deleted"
                    } else {
                        "modified"
                    }
                    .to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(ChangedResponse { files }))
}

/// Resolve the team_id for a workspace from the daemon's onboarded team
/// (teamclaw.json carries no team_id; daemon.toml does — same as /v1/team/link).
fn team_id_for_workspace(_workspace_path: &str) -> Result<String, HttpError> {
    let config = crate::config::DaemonConfig::load(&crate::config::DaemonConfig::default_path())
        .map_err(|e| HttpError::internal(format!("load daemon config: {e}")))?;
    config
        .team_id
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .ok_or_else(|| HttpError::validation("daemon is not onboarded to a team"))
}

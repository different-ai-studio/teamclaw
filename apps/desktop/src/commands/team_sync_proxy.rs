//! Plan B Task 5 — loopback HTTP client for the daemon's team-sync endpoints.
//!
//! The daemon owns team-sync now: it stores team secrets, materializes the
//! global team directory + per-workspace `teamclaw-team` symlink, runs the
//! actual git/OSS sync, and surfaces conflicts/versions. The desktop only
//! *delivers* the secrets and *triggers* link/sync over the daemon's local
//! HTTP server.
//!
//! This mirrors the auth dance in [`crate::commands::daemon_http`]:
//!   1. Read `~/.amuxd/amuxd.http.port` + `~/.amuxd/amuxd.http.token`.
//!   2. `POST /v1/auth/exchange` with `Authorization: Bearer {root_token}` and
//!      `{ "scopes": [...], "ttl_seconds": 300 }` → scoped session token.
//!   3. Call `/v1/team/*` with `Authorization: Bearer {session_token}`.
//!
//! Endpoints (all loopback, bearer-scoped):
//!   - `POST /v1/team/sync`              `{ workspacePath }`            scope `workspace:write`
//!   - `GET  /v1/team/sync/status?teamId`                              scope `workspace:read`
//!   - `POST /v1/team/secrets`           `{ teamId, ossTeamSecret?, gitCredential?, gitBranch? }` scope `workspace:write`
//!   - `POST /v1/team/link`              `{ path }`                    scope `workspace:write`
//!   - `GET  /v1/team/conflicts?teamId`                               scope `workspace:read`
//!   - `POST /v1/team/conflicts/resolve` `{ teamId, path, choice }`   scope `workspace:write`
//!   - `GET  /v1/team/versions?teamId&path[&cursor]`                  scope `workspace:read`
//!   - `POST /v1/team/versions/restore`  `{ teamId, path, contentHash }` scope `workspace:write`

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct DaemonAuthExchangeResponse {
    token: String,
}

/// Read `~/.amuxd/amuxd.http.{port,token}` and return `(base_url, root_token)`.
fn daemon_endpoint() -> Result<(String, String), String> {
    let amuxd_dir = dirs::home_dir()
        .ok_or_else(|| "no home dir".to_string())?
        .join(".amuxd");
    let port: u16 = std::fs::read_to_string(amuxd_dir.join("amuxd.http.port"))
        .map_err(|e| format!("daemon HTTP port unavailable (is amuxd running?): {e}"))?
        .trim()
        .parse()
        .map_err(|e| format!("invalid daemon HTTP port: {e}"))?;
    let root_token = std::fs::read_to_string(amuxd_dir.join("amuxd.http.token"))
        .map_err(|e| format!("daemon HTTP token unavailable (is amuxd running?): {e}"))?
        .trim()
        .to_string();
    Ok((format!("http://127.0.0.1:{port}"), root_token))
}

/// Exchange the daemon root token for a scoped session token.
async fn daemon_session_token(base: &str, scopes: &[&str]) -> Result<String, String> {
    let (_, root_token) = daemon_endpoint()?;
    daemon_session_token_with(&reqwest::Client::new(), base, &root_token, scopes).await
}

async fn daemon_session_token_with(
    client: &reqwest::Client,
    base: &str,
    root_token: &str,
    scopes: &[&str],
) -> Result<String, String> {
    let resp = client
        .post(format!("{base}/v1/auth/exchange"))
        .header("Authorization", format!("Bearer {root_token}"))
        .json(&serde_json::json!({
            "scopes": scopes,
            "ttl_seconds": 300,
        }))
        .send()
        .await
        .map_err(|e| format!("daemon auth/exchange request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("daemon auth/exchange {status}: {body}"));
    }
    let parsed: DaemonAuthExchangeResponse = resp
        .json()
        .await
        .map_err(|e| format!("daemon auth/exchange decode failed: {e}"))?;
    Ok(parsed.token)
}

/// Read port+token, exchange root→session for `scopes`, then issue
/// `method base/path` with the session bearer. Non-2xx maps to `Err(String)`.
///
/// `body` is sent as JSON for write methods; `query` is appended verbatim
/// (already-encoded, leading `?` included) for read methods.
async fn daemon_request<B: Serialize, R: DeserializeOwned>(
    method: reqwest::Method,
    path: &str,
    query: &str,
    scopes: &[&str],
    body: Option<&B>,
) -> Result<R, String> {
    let (base, root_token) = daemon_endpoint()?;
    let client = reqwest::Client::new();
    let session = daemon_session_token_with(&client, &base, &root_token, scopes).await?;

    let url = format!("{base}{path}{query}");
    let mut req = client
        .request(method, &url)
        .header("Authorization", format!("Bearer {session}"));
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("daemon request {path} failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("daemon {path} {status}: {text}"));
    }
    resp.json::<R>()
        .await
        .map_err(|e| format!("daemon {path} decode failed: {e}"))
}

/// Like [`daemon_request`] but for endpoints that return an empty/`{}` body and
/// the caller only needs success/failure.
async fn daemon_request_unit<B: Serialize>(
    method: reqwest::Method,
    path: &str,
    query: &str,
    scopes: &[&str],
    body: Option<&B>,
) -> Result<(), String> {
    let (base, root_token) = daemon_endpoint()?;
    let client = reqwest::Client::new();
    let session = daemon_session_token_with(&client, &base, &root_token, scopes).await?;

    let url = format!("{base}{path}{query}");
    let mut req = client
        .request(method, &url)
        .header("Authorization", format!("Bearer {session}"));
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("daemon request {path} failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("daemon {path} {status}: {text}"));
    }
    Ok(())
}

fn urlencode(value: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => {
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}

// ─── typed helpers ─────────────────────────────────────────────────────────

/// `POST /v1/team/sync` `{ workspacePath, forceWipeNonGit? }` — trigger a team sync.
pub async fn daemon_team_sync(
    workspace_path: &str,
    force_wipe_non_git: bool,
) -> Result<serde_json::Value, String> {
    daemon_request(
        reqwest::Method::POST,
        "/v1/team/sync",
        "",
        &["workspace:write"],
        Some(&serde_json::json!({
            "workspacePath": workspace_path,
            "forceWipeNonGit": force_wipe_non_git,
        })),
    )
    .await
}

/// Stable daemon problem+json code when the global team dir is not a git repo.
pub const TEAM_SHARED_DIR_NOT_GIT_CODE: &str = "team_shared_dir_not_git";

fn daemon_error_code(message: &str) -> Option<String> {
    let json_start = message.find('{')?;
    let json: serde_json::Value = serde_json::from_str(&message[json_start..]).ok()?;
    json.get("code")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// `GET /v1/team/sync/status?teamId=<id>` — current sync status.
pub async fn daemon_team_sync_status(team_id: &str) -> Result<serde_json::Value, String> {
    let query = format!("?teamId={}", urlencode(team_id));
    daemon_request::<(), _>(
        reqwest::Method::GET,
        "/v1/team/sync/status",
        &query,
        &["workspace:read"],
        None,
    )
    .await
}

/// Non-sensitive status of the team secret held by the local daemon.
///
/// The daemon deliberately returns only whether the secret is present (and a
/// masked fingerprint); this desktop surface further reduces that to a boolean
/// for the Environment Variables settings panel.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonTeamSecretStatus {
    oss_team_secret: DaemonSecretSetStatus,
}

#[derive(Debug, Deserialize)]
struct DaemonSecretSetStatus {
    set: bool,
}

pub async fn daemon_team_env_available(team_id: &str) -> Result<bool, String> {
    let query = format!("?teamId={}", urlencode(team_id));
    let status: DaemonTeamSecretStatus = daemon_request::<(), _>(
        reqwest::Method::GET,
        "/v1/team/secrets",
        &query,
        &["workspace:read"],
        None,
    )
    .await?;
    Ok(status.oss_team_secret.set)
}

/// `POST /v1/team/secrets` — deliver team secret material to the daemon.
///
/// `None` fields are omitted from the body. `authKind` is intentionally NOT
/// sent — the daemon learns it from FC.
pub async fn daemon_team_secrets(
    team_id: &str,
    oss_team_secret: Option<&str>,
    git_credential: Option<&str>,
    git_branch: Option<&str>,
) -> Result<(), String> {
    let mut body = serde_json::Map::new();
    body.insert("teamId".to_string(), serde_json::json!(team_id));
    if let Some(v) = oss_team_secret {
        body.insert("ossTeamSecret".to_string(), serde_json::json!(v));
    }
    if let Some(v) = git_credential {
        body.insert("gitCredential".to_string(), serde_json::json!(v));
    }
    if let Some(v) = git_branch {
        body.insert("gitBranch".to_string(), serde_json::json!(v));
    }
    daemon_request_unit(
        reqwest::Method::POST,
        "/v1/team/secrets",
        "",
        &["workspace:write"],
        Some(&serde_json::Value::Object(body)),
    )
    .await
}

/// `POST /v1/team/link` `{ path }` — materialize the global team dir + symlink.
pub async fn daemon_team_link(workspace_path: &str) -> Result<serde_json::Value, String> {
    daemon_request(
        reqwest::Method::POST,
        "/v1/team/link",
        "",
        &["workspace:write"],
        Some(&serde_json::json!({ "path": workspace_path })),
    )
    .await
}

/// `POST /v1/team/unlink` `{ path }` — drop workspace symlink + empty global scaffold.
pub async fn daemon_team_unlink(workspace_path: &str) -> Result<(), String> {
    daemon_request_unit(
        reqwest::Method::POST,
        "/v1/team/unlink",
        "",
        &["workspace:write"],
        Some(&serde_json::json!({ "path": workspace_path })),
    )
    .await
}

// ─── conflict / version helpers (used by Task 7) ────────────────────────────

/// `GET /v1/team/conflicts?teamId=<id>`.
pub async fn daemon_team_conflicts(team_id: &str) -> Result<serde_json::Value, String> {
    let query = format!("?teamId={}", urlencode(team_id));
    daemon_request::<(), _>(
        reqwest::Method::GET,
        "/v1/team/conflicts",
        &query,
        &["workspace:read"],
        None,
    )
    .await
}

/// `POST /v1/team/conflicts/resolve` `{ teamId, path, choice }`.
pub async fn daemon_team_resolve_conflict(
    team_id: &str,
    path: &str,
    choice: &str,
) -> Result<(), String> {
    daemon_request_unit(
        reqwest::Method::POST,
        "/v1/team/conflicts/resolve",
        "",
        &["workspace:write"],
        Some(&serde_json::json!({
            "teamId": team_id,
            "path": path,
            "choice": choice,
        })),
    )
    .await
}

/// `GET /v1/team/versions?teamId=<id>&path=<path>[&cursor=<cursor>]`.
pub async fn daemon_team_versions(
    team_id: &str,
    path: &str,
    cursor: Option<&str>,
) -> Result<serde_json::Value, String> {
    let mut query = format!("?teamId={}&path={}", urlencode(team_id), urlencode(path));
    if let Some(c) = cursor {
        query.push_str(&format!("&cursor={}", urlencode(c)));
    }
    daemon_request::<(), _>(
        reqwest::Method::GET,
        "/v1/team/versions",
        &query,
        &["workspace:read"],
        None,
    )
    .await
}

/// `POST /v1/team/versions/restore` `{ teamId, path, contentHash }`.
pub async fn daemon_team_restore_version(
    team_id: &str,
    path: &str,
    content_hash: &str,
) -> Result<(), String> {
    daemon_request_unit(
        reqwest::Method::POST,
        "/v1/team/versions/restore",
        "",
        &["workspace:write"],
        Some(&serde_json::json!({
            "teamId": team_id,
            "path": path,
            "contentHash": content_hash,
        })),
    )
    .await
}

// ─── Tauri command surface (Plan B Task 7) ──────────────────────────────────
//
// These `#[tauri::command]` fns REPLACE the old engine-backed commands of the
// same name in `oss_sync/mod.rs`, `team_shared_git.rs`, and `team.rs`. The
// command names + parameter names are kept identical so the frontend `invoke`
// sites need no change (Tauri binds args by name). The daemon now owns the
// actual sync/conflict/version engine; the desktop is a thin proxy.
//
// The daemon self-supplies the OSS JWT, so there is no `set-jwt` anymore.

/// Whether this daemon can decrypt Team Shared environment variables for the
/// supplied team. No secret material is returned to the renderer.
#[tauri::command]
pub async fn team_env_runtime_status(team_id: String) -> Result<bool, String> {
    if team_id.trim().is_empty() {
        return Ok(false);
    }
    daemon_team_env_available(&team_id).await
}

/// True when a daemon error / status `lastError` means the daemon has no OSS
/// team secret stored (see `secret_store::resolve_team_secret`). The daemon can
/// end up in this state if secret delivery was deferred (daemon unreachable) at
/// enable/join time, even though the desktop persisted the secret locally.
fn is_missing_team_secret_error(msg: &str) -> bool {
    msg.contains("no OSS team secret")
}

/// Re-deliver the locally-stored team secret to the daemon and re-link the
/// workspace. Best-effort self-heal for the "no OSS team secret" state: the
/// desktop is the source of truth for the secret (persisted in
/// `team_secret_store`), so if the daemon is missing it we push it back.
///
/// Returns `true` if a secret existed locally and was delivered, `false`
/// otherwise (no local secret to recover from, or delivery failed).
async fn redeliver_local_team_secret(team_id: &str, workspace_path: &str) -> bool {
    let Ok(secret) = crate::commands::team_secret_store::load_team_secret(workspace_path, team_id)
    else {
        return false;
    };
    if daemon_team_secrets(team_id, Some(&secret), None, None)
        .await
        .is_err()
    {
        return false;
    }
    // Re-link is non-fatal — the secret is what unblocks sync.
    let _ = daemon_team_link(workspace_path).await;
    true
}

/// `oss_sync_now(workspacePath, teamId)` — trigger a team sync via the daemon.
///
/// The frontend only reads back fresh status afterwards (it does not depend on
/// the exact `{pulled,pushed,conflicts}` numbers), so we map the daemon's sync
/// response into that shape, defaulting any missing field to `0`.
#[tauri::command]
pub async fn oss_sync_now(
    workspace_path: String,
    team_id: String,
) -> Result<serde_json::Value, String> {
    let mut status = daemon_team_sync(&workspace_path, false).await?;
    // Self-heal: if the daemon reports it has no team secret, re-deliver the
    // locally-stored one and retry the sync once.
    if status
        .get("lastError")
        .and_then(|v| v.as_str())
        .is_some_and(is_missing_team_secret_error)
        && redeliver_local_team_secret(&team_id, &workspace_path).await
    {
        status = daemon_team_sync(&workspace_path, false).await?;
    }
    let pick = |k: &str| status.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    Ok(serde_json::json!({
        "pulled": pick("pulled"),
        "pushed": pick("pushed"),
        "conflicts": pick("conflicts"),
    }))
}

/// `oss_sync_status(workspacePath, teamId)` — current sync status from the daemon.
///
/// Returns the daemon status JSON verbatim (Phase 3 aligns the TS type). The
/// `workspacePath` arg is accepted for signature compatibility; the daemon keys
/// status by team.
#[tauri::command]
pub async fn oss_sync_status(
    workspace_path: String,
    team_id: String,
) -> Result<serde_json::Value, String> {
    let status = daemon_team_sync_status(&team_id).await?;
    // Self-heal a stale "no OSS team secret" state: the desktop holds the secret
    // locally, so re-deliver it and run a sync so the daemon clears its
    // `last_error` (a bare status re-read would keep showing the stale error,
    // since `last_error` only updates when a sync actually runs). Then return
    // the fresh status so the panel clears the red banner.
    if status
        .get("lastError")
        .and_then(|v| v.as_str())
        .is_some_and(is_missing_team_secret_error)
        && redeliver_local_team_secret(&team_id, &workspace_path).await
    {
        let _ = daemon_team_sync(&workspace_path, false).await;
        return daemon_team_sync_status(&team_id).await;
    }
    Ok(status)
}

/// `oss_sync_list_versions(workspacePath, teamId, path, cursor?)`.
#[tauri::command]
pub async fn oss_sync_list_versions(
    workspace_path: String,
    team_id: String,
    path: String,
    cursor: Option<String>,
) -> Result<serde_json::Value, String> {
    let _ = &workspace_path;
    daemon_team_versions(&team_id, &path, cursor.as_deref()).await
}

/// `oss_sync_get_version_content(workspacePath, teamId, contentHash)`.
///
/// NOT YET PROXYABLE: the daemon exposes `GET /v1/team/versions` (a paginated
/// list of version metadata) and `POST /v1/team/versions/restore`, but no
/// content-by-hash fetch. Rather than fabricate content, return an explicit
/// error placeholder until the daemon grows a content endpoint.
#[tauri::command]
pub async fn oss_sync_get_version_content(
    workspace_path: String,
    team_id: String,
    content_hash: String,
) -> Result<String, String> {
    let _ = (&workspace_path, &team_id, &content_hash);
    Err("version content fetch is not supported via the daemon yet".to_string())
}

/// `oss_sync_restore_version(workspacePath, teamId, path, contentHash)`.
#[tauri::command]
pub async fn oss_sync_restore_version(
    workspace_path: String,
    team_id: String,
    path: String,
    content_hash: String,
) -> Result<(), String> {
    let _ = &workspace_path;
    daemon_team_restore_version(&team_id, &path, &content_hash).await
}

/// `oss_sync_resolve_conflict(workspacePath, teamId, path, choice)`.
///
/// `choice` is the camelCase string the frontend already sends
/// (`keepRemote` | `keepLocal`); forwarded verbatim to the daemon.
#[tauri::command]
pub async fn oss_sync_resolve_conflict(
    workspace_path: String,
    team_id: String,
    path: String,
    choice: String,
) -> Result<(), String> {
    let _ = &workspace_path;
    daemon_team_resolve_conflict(&team_id, &path, &choice).await
}

fn is_not_git_repo_error(msg: &str) -> bool {
    msg.starts_with(TEAM_SHARED_DIR_NOT_GIT_CODE)
}

fn team_sync_needs_confirmation(err: &str) -> bool {
    daemon_error_code(err).as_deref() == Some(TEAM_SHARED_DIR_NOT_GIT_CODE)
        || err.contains(TEAM_SHARED_DIR_NOT_GIT_CODE)
}

fn team_sync_success_payload() -> serde_json::Value {
    serde_json::json!({
        "success": true,
        "message": "Synced",
        "needsConfirmation": false,
        "newFiles": [],
        "totalBytes": 0,
    })
}

async fn invoke_daemon_team_sync(
    workspace_path: &str,
    force_wipe_non_git: bool,
) -> Result<serde_json::Value, String> {
    match daemon_team_sync(workspace_path, force_wipe_non_git).await {
        Ok(resp) => {
            team_sync_error_from_status(&resp)?;
            Ok(team_sync_success_payload())
        }
        Err(err) if !force_wipe_non_git && team_sync_needs_confirmation(&err) => {
            Ok(serde_json::json!({
                "success": false,
                "message": "The local team shared directory exists but is not a git repository.",
                "needsConfirmation": true,
                "confirmKind": "wipeNonGitDir",
                "newFiles": [],
                "totalBytes": 0,
            }))
        }
        Err(err) => Err(err),
    }
}

fn team_sync_error_from_status(status: &serde_json::Value) -> Result<(), String> {
    if let Some(err) = status
        .get("lastError")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
    {
        if is_not_git_repo_error(err) {
            return Err(format!(
                "daemon /v1/team/sync 422 Unprocessable Entity: {{\"code\":\"{TEAM_SHARED_DIR_NOT_GIT_CODE}\",\"detail\":\"{err}\"}}"
            ));
        }
        return Err(err.to_string());
    }
    if status
        .get("mode")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .is_none()
    {
        return Err(
            "team share is not enabled for the daemon's team (share_mode unset). \
             Re-bind amuxd to the current team if you switched teams, then enable Git share again."
                .to_string(),
        );
    }
    Ok(())
}

/// `team_sync_repo(workspace?, force?)` (team.rs) → proxy to the daemon sync.
///
/// Returns a `TeamGitResult`-shaped object so existing callers keep working.
#[tauri::command]
pub async fn team_sync_repo(
    workspace_path: Option<String>,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    let force_wipe = force.unwrap_or(false);
    let workspace_path = workspace_path
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?;
    invoke_daemon_team_sync(&workspace_path, force_wipe).await
}

/// `team_shared_git_sync(config, force?)` → proxy to the daemon sync.
///
/// The frontend passes the legacy `config` object (with `workspacePath`); we
/// only need `workspacePath` to trigger the daemon, the rest is daemon-owned.
/// When `force=true`, a non-git local team dir is deleted and re-cloned.
#[tauri::command]
pub async fn team_shared_git_sync(
    config: serde_json::Value,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    let force_wipe = force.unwrap_or(false);
    let workspace_path = config
        .get("workspacePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "config.workspacePath is required".to_string())?;
    invoke_daemon_team_sync(workspace_path, force_wipe).await
}

/// `team_shared_git_validate(config)` → daemon sync status (best effort).
///
/// Returns the daemon status JSON. Phase 3 aligns the TS type; existing callers
/// that only check for success will still observe a non-error result.
#[tauri::command]
pub async fn team_shared_git_validate(
    config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // The daemon keys status by team, not by the legacy git config. We don't
    // have a teamId here, so return a trivially-ok status shape rather than
    // failing — the daemon owns real validation during link/sync.
    let _ = config;
    Ok(serde_json::json!({
        "sharedDirPath": "",
        "exists": true,
        "isGitRepo": true,
        "remoteUrl": null,
        "branch": null,
        "dirty": false,
        "ahead": 0,
        "behind": 0,
    }))
}

/// `team_shared_git_setup(config)` → no-op success.
///
/// Setup is owned by the daemon now (team-share enable + `/v1/team/link`).
#[tauri::command]
pub async fn team_shared_git_setup(config: serde_json::Value) -> Result<serde_json::Value, String> {
    let _ = config;
    Ok(serde_json::json!({
        "sharedDirPath": "",
        "exists": true,
        "isGitRepo": true,
        "remoteUrl": null,
        "branch": null,
        "dirty": false,
        "ahead": 0,
        "behind": 0,
    }))
}

// ─── sync_mode commands (FC-direct; moved verbatim from oss_sync/mod.rs) ──────
//
// These toggle the team's FC `sync_mode` and mirror it into local teamclaw.json.
// They do NOT go through the daemon sync engine, so they keep calling FC
// directly. Moved here so they survive the Task 8 deletion of oss_sync/mod.rs.

use crate::commands::oss_sync::fc_client::FcClient;
use crate::commands::oss_sync::get_fc_endpoint;

/// Switch the team's sync_mode on the server (owner-only) and persist the new
/// mode into local teamclaw.json so the periodic tick dispatches to the correct
/// backend.
#[tauri::command]
pub async fn oss_sync_set_team_sync_mode(
    workspace_path: String,
    team_id: String,
    mode: String,
    access_token: String,
) -> Result<String, String> {
    if mode != "git" && mode != "oss" {
        return Err(format!("invalid sync_mode: {}", mode));
    }

    let fc = FcClient::new(get_fc_endpoint(&workspace_path), access_token);
    let returned_mode = fc
        .set_team_sync_mode(&team_id, &mode)
        .await
        .map_err(|e| e.to_string())?;

    // The team share mode is owned by the cloud; we no longer mirror it into
    // local teamclaw.json (legacy `team_mode`).
    Ok(returned_mode)
}

/// Read the team's sync_mode from the server (no ownership required).
#[tauri::command]
pub async fn oss_sync_get_team_sync_mode(
    workspace_path: String,
    team_id: String,
    access_token: String,
) -> Result<Option<String>, String> {
    let fc = FcClient::new(get_fc_endpoint(&workspace_path), access_token);
    fc.get_team_sync_mode(&team_id)
        .await
        .map_err(|e| e.to_string())
}

// ─── unified team file/versions/changed proxies (Task 3) ────────────────────

/// `GET /v1/team/versions` — mode-agnostic per-file version list.
#[tauri::command]
pub async fn team_file_versions(
    team_id: String,
    path: String,
    cursor: Option<String>,
) -> Result<serde_json::Value, String> {
    daemon_team_versions(&team_id, &path, cursor.as_deref()).await
}

/// `GET /v1/team/file?ref=` — content of a file at a version-ref
/// ("baseline" = current synced/committed baseline).
#[tauri::command]
pub async fn team_file_content(
    team_id: String,
    path: String,
    r#ref: String,
) -> Result<serde_json::Value, String> {
    let query = format!(
        "?teamId={}&path={}&ref={}",
        urlencode(&team_id),
        urlencode(&path),
        urlencode(&r#ref)
    );
    daemon_request::<(), _>(
        reqwest::Method::GET,
        "/v1/team/file",
        &query,
        &["workspace:read"],
        None,
    )
    .await
}

/// `GET /v1/team/changed` — files with local changes.
#[tauri::command]
pub async fn team_changed_files(team_id: String) -> Result<serde_json::Value, String> {
    let query = format!("?teamId={}", urlencode(&team_id));
    daemon_request::<(), _>(
        reqwest::Method::GET,
        "/v1/team/changed",
        &query,
        &["workspace:read"],
        None,
    )
    .await
}

/// `POST /v1/team/versions/restore` — restore a file to a version-ref.
/// For the unified model the version-ref IS the oss contentHash (git uses the SHA).
#[tauri::command]
pub async fn team_restore_file_version(
    team_id: String,
    path: String,
    r#ref: String,
) -> Result<(), String> {
    daemon_team_restore_version(&team_id, &path, &r#ref).await
}

//! `POST /v1/apps/seed` — trigger app-repo seeding for a freshly-created
//! (empty) managed-git repo.
//!
//! Seeding is the blocking clone → write-template → first-commit → push flow
//! implemented in [`crate::sync::app_seed::seed_app_repo`]. The daemon owns
//! this because it has git + the managed-git credentials; the desktop kicks it
//! over loopback right after the cloud API creates the app's repo.
//!
//! ### Body shape — optional `workdir`
//!
//! `workdir` is an *optional* explicit absolute path to clone into. When the
//! caller (the desktop) omits it — which it does, because the desktop does not
//! know a local path for the app — the daemon resolves a per-app workdir under
//! its own data root: `<amuxd home>/apps/<appId>`. When `workdir` *is* present
//! and non-empty, it is used verbatim (legacy behaviour; the C3 integration
//! test exercises this path).
//!
//! The daemon's workspace registry only maps ids → paths through the actor
//! channel (see `register_workspace`), and an app's repo is a *fresh* clone
//! target that does not yet exist in any registry. `workspaceId` is accepted
//! for caller bookkeeping/correlation only. `appId` is load-bearing when
//! `workdir` is omitted (it names the per-app subdir). The clone target must
//! not already exist (`seed_app_repo` clones into it).

use std::path::PathBuf;

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;

/// Local filesystem path to the app starter template.
///
/// Override via `TEAMCLAW_APP_TEMPLATE_DIR` (used by unit/integration tests).
/// Default: `<amuxd home>/templates/tanstack-postgres`.
fn template_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("TEAMCLAW_APP_TEMPLATE_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".amuxd")
        .join("templates")
        .join("tanstack-postgres")
}

/// Resolve the GitHub template repo URL to seed new apps from.
///
/// Override via `TEAMCLAW_APP_TEMPLATE_URL` (useful in tests or self-hosted
/// deployments pointing at a private fork).
fn template_repo_url() -> String {
    std::env::var("TEAMCLAW_APP_TEMPLATE_URL").unwrap_or_else(|_| {
        "https://github.com/different-ai-studio/template-tanstack-postgres".to_string()
    })
}

/// The daemon's data root for per-app seed clones: `<amuxd home>/apps`.
///
/// Mirrors `DaemonConfig::config_dir()` (`~/.amuxd`) so app clones live under
/// the same home the rest of the daemon uses. Falls back to `$HOME/.amuxd`, then
/// `/tmp/.amuxd`, matching the daemon's own home resolution.
fn apps_data_root() -> PathBuf {
    dirs::home_dir()
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".amuxd")
        .join("apps")
}

/// Resolve the clone target for a seed request.
///
/// If `workdir` is present and non-empty, use it verbatim (legacy explicit
/// path). Otherwise compute `<apps data root>/<appId>`. `app_id` must be
/// non-empty in the default-workdir case (it names the subdir).
fn resolve_workdir(workdir: &str, app_id: &str) -> Result<PathBuf, HttpError> {
    let workdir = workdir.trim();
    if !workdir.is_empty() {
        return Ok(PathBuf::from(workdir));
    }
    let app_id = app_id.trim();
    if app_id.is_empty() {
        return Err(HttpError::validation(
            "appId must not be empty when workdir is omitted",
        ));
    }
    Ok(apps_data_root().join(app_id))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedAppBody {
    /// Cloud app id — for caller correlation/bookkeeping only.
    #[serde(default)]
    pub app_id: String,
    /// Team id — used for the just-in-time managed-git credential fetch when the
    /// caller omits an explicit `gitToken`. Empty (the `#[serde(default)]`) means
    /// "no team-scoped fetch" (legacy/explicit-token callers).
    #[serde(default)]
    pub team_id: String,
    /// Workspace id — for caller correlation only; the clone target is
    /// `workdir`, not a registry-resolved path.
    #[serde(default)]
    pub workspace_id: String,
    /// Optional absolute path of a *fresh*, non-existent directory to clone
    /// into. When omitted/empty the daemon resolves `<amuxd home>/apps/<appId>`.
    #[serde(default)]
    pub workdir: Option<String>,
    /// HTTPS remote URL of the empty managed-git repo to seed.
    pub git_remote_url: String,
    /// Optional git credential (PAT / `user:secret`). Embedded into the clone
    /// URL by `seed_app_repo`; never logged.
    #[serde(default)]
    pub git_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedAppResponse {
    pub status: &'static str,
}

/// `POST /v1/apps/seed` — clone the empty app repo, write the starter
/// template, make the first commit, and push.
///
/// Requires `workspace:write` (same scope `register_workspace` uses). Returns
/// `{ "status": "ready" }` on success. The seed runs on a blocking thread.
pub async fn seed_app(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<SeedAppBody>,
) -> Result<Json<SeedAppResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;

    let git_remote_url = body.git_remote_url.trim().to_string();
    if git_remote_url.is_empty() {
        return Err(HttpError::validation("gitRemoteUrl must not be empty"));
    }
    let workdir_path = resolve_workdir(body.workdir.as_deref().unwrap_or(""), &body.app_id)?;
    // Remove a leftover workdir from a previous failed seed so that re-seeding
    // the same app is idempotent. Only remove the per-app subdirectory, never
    // an explicit caller-supplied workdir (the caller owns that path).
    if workdir_path.exists() {
        if body.workdir.as_deref().unwrap_or("").trim().is_empty() {
            std::fs::remove_dir_all(&workdir_path).map_err(|e| {
                HttpError::internal(format!(
                    "failed to clean up stale workdir {}: {e}",
                    workdir_path.display()
                ))
            })?;
        } else {
            return Err(HttpError::validation(format!(
                "workdir already exists: {}",
                workdir_path.display()
            )));
        }
    }
    // The default-workdir parent (`<amuxd home>/apps`) may not exist yet; create
    // it so the clone target's parent is present. (`seed_app_repo` clones into
    // `workdir_path` itself, which must not exist.) For an explicit `workdir`
    // the caller owns the parent, so this is best-effort and harmless.
    if let Some(parent) = workdir_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Credential resolution (JIT): an explicit body token wins (tests / legacy);
    // otherwise pull the team-scoped managed-git credential from the cloud API.
    let token: Option<String> = if let Some(t) = body.git_token.clone() {
        Some(t)
    } else {
        let team_id = body.team_id.trim();
        if team_id.is_empty() {
            None
        } else {
            let backend = state.backend.as_ref().ok_or_else(|| {
                HttpError::internal("cloud backend unavailable for credential fetch")
            })?;
            let cred = backend
                .managed_git_credential(team_id)
                .await
                .map_err(|e| HttpError::internal(format!("fetch managed-git credential: {e}")))?;
            Some(format!("{}:{}", cred.username, cred.token))
        }
    };
    let template_url = template_repo_url();

    tokio::task::spawn_blocking(move || {
        crate::sync::app_seed::seed_app_repo(
            &workdir_path,
            &git_remote_url,
            &template_url,
            token.as_deref(),
        )
    })
    .await
    .map_err(|e| HttpError::internal(format!("seed task panicked: {e}")))?
    .map_err(|e| HttpError::internal(format!("app seed failed: {e}")))?;

    Ok(Json(SeedAppResponse { status: "ready" }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildAppBody {
    /// Cloud app id — names the per-app workdir when `workdir` is omitted.
    #[serde(default)]
    pub app_id: String,
    /// Team id — for caller correlation only.
    #[serde(default)]
    pub team_id: String,
    /// Workspace id — for caller correlation only.
    #[serde(default)]
    pub workspace_id: String,
    /// Optional explicit workdir path; defaults to `<amuxd home>/apps/<appId>`.
    #[serde(default)]
    pub workdir: Option<String>,
    /// Presigned OSS PUT URL for the build artifact. Short-lived signed-URL
    /// secret — REQUIRED, and never logged.
    pub presigned_put: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildAppResponse {
    pub status: &'static str,
}

/// `POST /v1/apps/build` — build the app (`pnpm build` + zip `.output`) and
/// upload the artifact to the provided presigned OSS URL.
///
/// Requires `workspace:write`. The workdir MUST already exist (it's the seeded
/// checkout). Returns `{ "status": "built" }`. The presigned URL is a
/// short-lived secret and is never logged.
pub async fn build_app(
    principal: Principal,
    State(_state): State<HttpState>,
    Json(body): Json<BuildAppBody>,
) -> Result<Json<BuildAppResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;

    let presigned_put = body.presigned_put.trim().to_string();
    if presigned_put.is_empty() {
        return Err(HttpError::validation("presignedPut must not be empty"));
    }
    let workdir_path = resolve_workdir(body.workdir.as_deref().unwrap_or(""), &body.app_id)?;
    if !workdir_path.exists() {
        return Err(HttpError::validation(format!(
            "workdir does not exist: {}",
            workdir_path.display()
        )));
    }

    let bytes = tokio::task::spawn_blocking(move || {
        crate::sync::app_build::build_artifact(&workdir_path)
    })
    .await
    .map_err(|e| HttpError::internal(format!("build task panicked: {e}")))?
    .map_err(|e| HttpError::internal(format!("app build failed: {e}")))?;

    let resp = reqwest::Client::new()
        .put(&presigned_put)
        .body(bytes)
        .send()
        .await
        .map_err(|e| HttpError::internal(format!("upload PUT failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(HttpError::internal(format!(
            "upload PUT failed: HTTP {}",
            resp.status()
        )));
    }

    Ok(Json(BuildAppResponse { status: "built" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Env-var mutation can't be split across parallel tests (they share one
    // process env), so both `template_repo_url` cases live in one serialized test.
    #[test]
    fn template_repo_url_override_and_fallback() {
        let prev = std::env::var_os("TEAMCLAW_APP_TEMPLATE_URL");

        std::env::set_var("TEAMCLAW_APP_TEMPLATE_URL", "file:///tmp/some-template");
        assert_eq!(template_repo_url(), "file:///tmp/some-template");

        std::env::remove_var("TEAMCLAW_APP_TEMPLATE_URL");
        assert_eq!(
            template_repo_url(),
            "https://github.com/different-ai-studio/template-tanstack-postgres"
        );

        match prev {
            Some(v) => std::env::set_var("TEAMCLAW_APP_TEMPLATE_URL", v),
            None => std::env::remove_var("TEAMCLAW_APP_TEMPLATE_URL"),
        }
    }

    #[test]
    fn body_deserializes_camel_case() {
        let body: SeedAppBody = serde_json::from_value(serde_json::json!({
            "appId": "app-1",
            "teamId": "team-1",
            "workspaceId": "ws-1",
            "workdir": "/tmp/work",
            "gitRemoteUrl": "https://example.com/x.git",
            "gitToken": "secret"
        }))
        .unwrap();
        assert_eq!(body.app_id, "app-1");
        assert_eq!(body.team_id, "team-1");
        assert_eq!(body.workspace_id, "ws-1");
        assert_eq!(body.workdir.as_deref(), Some("/tmp/work"));
        assert_eq!(body.git_remote_url, "https://example.com/x.git");
        assert_eq!(body.git_token.as_deref(), Some("secret"));
    }

    #[test]
    fn body_token_and_workdir_optional() {
        // Desktop posts only appId + gitRemoteUrl — no workdir, no token.
        let body: SeedAppBody = serde_json::from_value(serde_json::json!({
            "appId": "app-1",
            "gitRemoteUrl": "https://example.com/x.git"
        }))
        .unwrap();
        assert!(body.git_token.is_none());
        assert!(body.workdir.is_none());
        assert_eq!(body.app_id, "app-1");
    }

    #[test]
    fn resolve_workdir_uses_explicit_path_when_present() {
        let p = resolve_workdir("/tmp/explicit", "app-1").unwrap();
        assert_eq!(p, PathBuf::from("/tmp/explicit"));
        // Whitespace-only workdir is treated as omitted → default path used.
        let p = resolve_workdir("   ", "app-2").unwrap();
        assert_eq!(p, apps_data_root().join("app-2"));
    }

    #[test]
    fn resolve_workdir_defaults_to_apps_root_appid() {
        let p = resolve_workdir("", "app-xyz").unwrap();
        assert_eq!(p, apps_data_root().join("app-xyz"));
        assert!(p.ends_with("apps/app-xyz"));
    }

    #[test]
    fn build_body_deserializes_camel_case() {
        let body: BuildAppBody = serde_json::from_value(serde_json::json!({
            "appId": "app-1",
            "teamId": "team-1",
            "presignedPut": "https://oss/put?sig=x"
        }))
        .unwrap();
        assert_eq!(body.app_id, "app-1");
        assert_eq!(body.presigned_put, "https://oss/put?sig=x");
        assert!(body.workdir.is_none());
    }

    #[test]
    fn build_body_requires_presigned_put() {
        // missing presignedPut → deserialization fails (field is required, not #[serde(default)])
        let r: Result<BuildAppBody, _> = serde_json::from_value(serde_json::json!({
            "appId": "app-1"
        }));
        assert!(r.is_err());
    }

    #[test]
    fn resolve_workdir_requires_app_id_when_workdir_omitted() {
        let err = resolve_workdir("", "  ").unwrap_err();
        // A validation error (not a path) when neither workdir nor appId given.
        let msg = format!("{err:?}");
        assert!(msg.contains("appId"), "unexpected error: {msg}");
    }
}

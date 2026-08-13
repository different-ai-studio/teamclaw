//! `POST /v1/apps/seed` — write an app's starter template into its checkout.
//!
//! Seeding is the blocking write-template → `git init` → first-commit flow in
//! [`crate::sync::app_seed::seed_app_repo`]. There is no remote and no network:
//! the templates are compiled into this binary
//! ([`crate::sync::app_templates`]). The daemon owns it because it is the one
//! with the filesystem; the desktop kicks it over loopback right after the
//! cloud API creates the app row.
//!
//! ### Body shape — optional `workdir`
//!
//! `workdir` is an *optional* explicit absolute path to seed into. When the
//! caller (the desktop) omits it — which it does, because the desktop does not
//! know a local path for the app — the daemon resolves a per-app workdir under
//! its own data root: `<amuxd home>/apps/<appId>`. When `workdir` *is* present
//! and non-empty, it is used verbatim.
//!
//! The daemon's workspace registry only maps ids → paths through the actor
//! channel (see `register_workspace`), and an app's checkout does not yet exist
//! in any registry. `workspaceId` is accepted for caller bookkeeping only.
//! `appId` is load-bearing when `workdir` is omitted (it names the subdir).
//! The target may already exist — seeding writes over it and commits the
//! difference.

use std::path::PathBuf;

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;

/// The daemon's data root for per-app checkouts: `<amuxd home>/apps`.
///
/// It used to say it mirrored `DaemonConfig::config_dir()` while actually
/// re-deriving `$HOME/.amuxd` by hand — so it honoured neither `$AMUXD_HOME`
/// nor the brand, and a white-label daemon cloned apps into the official
/// build's home. Call the real thing.
///
/// Still at the home root; `teams/<id>/state/apps/` is PR ④.
pub fn apps_data_root() -> PathBuf {
    crate::config::layout::active_state_dir().join("apps")
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
    /// Cloud app id — names the per-app workdir when `workdir` is omitted, and
    /// is substituted into the template's `AGENTS.md`.
    #[serde(default)]
    pub app_id: String,
    /// App name, shown to the agent in `AGENTS.md`. Falls back to the app id.
    #[serde(default)]
    pub app_name: String,
    /// App type (`static_web` / `slides` / `data_app`) — selects the template.
    /// Unknown or empty resolves to `data_app`, which is what every app created
    /// before types existed actually is.
    #[serde(default)]
    pub app_type: String,
    /// Team id — for caller correlation only.
    #[serde(default)]
    pub team_id: String,
    /// Workspace id — for caller correlation only; the target is `workdir`,
    /// not a registry-resolved path.
    #[serde(default)]
    pub workspace_id: String,
    /// Optional absolute path to seed into. When omitted/empty the daemon
    /// resolves `<amuxd home>/apps/<appId>`.
    #[serde(default)]
    pub workdir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedAppResponse {
    pub status: &'static str,
}

/// `POST /v1/apps/seed` — write the starter template into the app's checkout
/// and commit it.
///
/// Requires `workspace:write` (same scope `register_workspace` uses). Returns
/// `{ "status": "ready" }` on success. The seed runs on a blocking thread.
///
/// Re-seeding an existing checkout is safe: the template is written over the
/// top and the difference is committed, so a wrecked app can be repaired
/// without losing its history.
pub async fn seed_app(
    principal: Principal,
    State(_state): State<HttpState>,
    Json(body): Json<SeedAppBody>,
) -> Result<Json<SeedAppResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;

    let workdir_path = resolve_workdir(body.workdir.as_deref().unwrap_or(""), &body.app_id)?;
    if let Some(parent) = workdir_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let app_id = body.app_id.trim().to_string();
    let app_name = if body.app_name.trim().is_empty() {
        app_id.clone()
    } else {
        body.app_name.trim().to_string()
    };
    let app_type = crate::sync::app_templates::AppType::parse(&body.app_type);

    tokio::task::spawn_blocking(move || {
        crate::sync::app_seed::seed_app_repo(
            &workdir_path,
            &crate::sync::app_templates::TemplateVars {
                app_id: &app_id,
                app_name: &app_name,
                app_type,
            },
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

    let bytes =
        tokio::task::spawn_blocking(move || crate::sync::app_build::build_artifact(&workdir_path))
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

    #[test]
    fn body_deserializes_camel_case() {
        let body: SeedAppBody = serde_json::from_value(serde_json::json!({
            "appId": "app-1",
            "appName": "My App",
            "appType": "slides",
            "teamId": "team-1",
            "workspaceId": "ws-1",
            "workdir": "/tmp/work"
        }))
        .unwrap();
        assert_eq!(body.app_id, "app-1");
        assert_eq!(body.app_name, "My App");
        assert_eq!(body.app_type, "slides");
        assert_eq!(body.team_id, "team-1");
        assert_eq!(body.workspace_id, "ws-1");
        assert_eq!(body.workdir.as_deref(), Some("/tmp/work"));
    }

    #[test]
    fn body_needs_only_the_app_id() {
        // The desktop posts appId + appName + appType; everything else is
        // optional, and an older client that omits the type still seeds.
        let body: SeedAppBody = serde_json::from_value(serde_json::json!({
            "appId": "app-1"
        }))
        .unwrap();
        assert_eq!(body.app_id, "app-1");
        assert!(body.workdir.is_none());
        assert_eq!(body.app_type, "");
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

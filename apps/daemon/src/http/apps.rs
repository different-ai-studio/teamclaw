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

/// The daemon's data root for per-app checkouts: `teams/<active>/apps`.
///
/// It used to say it mirrored `DaemonConfig::config_dir()` while actually
/// re-deriving `$HOME/.amuxd` by hand — so it honoured neither `$AMUXD_HOME`
/// nor the brand, and a white-label daemon cloned apps into the official
/// build's home. Call the real thing.
///
/// It then lived under `state/`, which is daemon bookkeeping; an app checkout
/// is the user's own project. Existing checkouts are moved by
/// [`migrate_legacy_apps_root`], which the daemon calls once at startup.
///
/// This function only computes a path. It briefly did the migration too, and a
/// plain `cargo test` — which runs against the real `$HOME` — then renamed a
/// developer's actual app directory as a side effect of asking where apps live.
pub fn apps_data_root() -> PathBuf {
    crate::config::layout::active_apps_dir()
}

/// Move `state/apps` to its new home beside it, once. Called at startup.
///
/// A rename, so every checkout keeps its identity, its git history and its
/// `node_modules`. Skipped when the destination already exists: merging two
/// app roots is not a decision this function can make, and the legacy one is
/// left untouched for recovery rather than deleted.
///
/// Deliberately NOT called from `apps_data_root()`: a path accessor that moves
/// directories rewrote a developer's home during an ordinary `cargo test`.
pub fn migrate_legacy_apps_root() {
    let legacy = crate::config::layout::active_state_dir().join("apps");
    migrate_legacy_apps_root_from(&legacy, &apps_data_root());
}

/// [`migrate_legacy_apps_root`] with both paths given, so the rule is testable
/// without pointing the whole daemon at a temp home.
fn migrate_legacy_apps_root_from(legacy: &std::path::Path, dest: &std::path::Path) {
    if dest.exists() {
        return;
    }
    if !legacy.is_dir() {
        return;
    }
    if let Some(parent) = dest.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::warn!(error = %e, "apps: could not create team dir for migration");
            return;
        }
    }
    match std::fs::rename(legacy, dest) {
        Ok(()) => {
            tracing::info!(from = %legacy.display(), to = %dest.display(), "apps: moved app root out of state/")
        }
        Err(e) => {
            tracing::warn!(error = %e, from = %legacy.display(), "apps: could not move app root; leaving it in place")
        }
    }
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
    /// Where the app actually lives. Returned so the caller never has to
    /// compute it: the desktop used to derive `~/.amuxd/apps/<id>` by hand,
    /// which stopped matching this daemon's answer the moment the layout moved
    /// — the agent then edited one directory while deploys built another, and
    /// the deployed site silently stayed the seed template.
    pub workdir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWorkdirResponse {
    pub workdir: String,
}

/// `GET /v1/apps/:appId/workdir` — where this daemon keeps that app.
///
/// The single source of truth for the path, for callers that did not just seed
/// (opening the app's session, revealing it in Finder). Answers for an app that
/// has never been seeded too: the path is derived, not looked up.
pub async fn app_workdir(
    principal: Principal,
    State(_state): State<HttpState>,
    axum::extract::Path(app_id): axum::extract::Path<String>,
) -> Result<Json<AppWorkdirResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let path = resolve_workdir("", &app_id)?;
    Ok(Json(AppWorkdirResponse {
        workdir: path.to_string_lossy().into_owned(),
    }))
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
    let seeded_at = workdir_path.to_string_lossy().into_owned();

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

    Ok(Json(SeedAppResponse {
        status: "ready",
        workdir: seeded_at,
    }))
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
    fn apps_live_beside_state_not_inside_it() {
        // An app checkout is the user's own project, not daemon bookkeeping —
        // and the desktop opens it as an agent session's working directory.
        let root = apps_data_root();
        assert!(root.ends_with("apps"), "got {}", root.display());
        assert!(
            !root.to_string_lossy().contains("/state/"),
            "app root must not sit under state/: {}",
            root.display()
        );
    }

    #[test]
    fn legacy_state_apps_root_is_moved_not_copied() {
        // The deploy pipeline builds whatever is at the new path. Leaving the
        // old checkouts behind would ship the seed template forever, with the
        // user's real work sitting in a directory nothing reads.
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("state").join("apps");
        std::fs::create_dir_all(legacy.join("app-1")).unwrap();
        std::fs::write(legacy.join("app-1").join("index.html"), b"real work").unwrap();

        let dest = tmp.path().join("apps");
        migrate_legacy_apps_root_from(&legacy, &dest);

        assert!(!legacy.exists(), "legacy root must be gone, not duplicated");
        assert_eq!(
            std::fs::read_to_string(dest.join("app-1").join("index.html")).unwrap(),
            "real work",
        );
    }

    #[test]
    fn migration_leaves_both_alone_when_the_new_root_already_exists() {
        // Merging two app roots is not a decision this function can make, so
        // the legacy one stays put and stays recoverable.
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("state").join("apps");
        std::fs::create_dir_all(legacy.join("app-1")).unwrap();
        let dest = tmp.path().join("apps");
        std::fs::create_dir_all(dest.join("app-2")).unwrap();

        migrate_legacy_apps_root_from(&legacy, &dest);

        assert!(
            legacy.join("app-1").is_dir(),
            "legacy must survive untouched"
        );
        assert!(dest.join("app-2").is_dir());
        assert!(!dest.join("app-1").exists(), "nothing may be merged in");
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

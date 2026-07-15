//! Task 12 — `team_share_join_existing` command.
//!
//! Called by the frontend `JoinTeamFlow` immediately after a user claims an
//! invite. Fetches the team's current workspace config from FC
//! (`GET /v1/teams/{team_id}/workspace-config`) and reports whether the owner
//! has already enabled a share mode.
//!
//! The team shared directory is created and linked by the daemon (a
//! `teamclaw-team` symlink to the team's single global copy); joining no longer
//! creates a per-workspace real dir, and team identifiers are not persisted to
//! `teamclaw.json` (single source of truth = the Cloud API current-team store).
//!
//! Per spec: the joiner enters their own team secret manually afterwards via
//! `team_share_set_team_secret`. For git modes the daemon owns the clone — the
//! joiner needs credentials separately (managed_git tokens are re-shared
//! out-of-band, custom_git creds are user-supplied later).

use serde::{Deserialize, Serialize};

use crate::commands::oss_sync::fc_client::FcClient;
use crate::commands::oss_sync::get_fc_endpoint;
use crate::commands::team_sync_proxy;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinExistingResult {
    pub initialized: bool,
    pub share_mode: Option<String>,
}

pub async fn team_share_join_existing_impl(
    team_id: String,
    workspace_path: String,
    access_token: String,
) -> Result<JoinExistingResult, String> {
    let fc = FcClient::new(get_fc_endpoint(&workspace_path), access_token);
    let cfg: serde_json::Value = fc
        .get_json(&format!("/v1/teams/{}/workspace-config", team_id))
        .await
        .map_err(|e| e.to_string())?;

    let share_mode = cfg
        .get("shareMode")
        .and_then(|v| v.as_str())
        .map(String::from);

    if share_mode.is_none() {
        // Owner hasn't opened share yet — nothing to wire locally.
        return Ok(JoinExistingResult {
            initialized: false,
            share_mode: None,
        });
    }

    // The team shared dir is created and linked by the daemon (one global copy
    // per team, exposed via a `teamclaw-team` symlink). Joining no longer
    // eagerly creates a per-workspace real directory; the daemon's sweep links
    // it (and consolidates any legacy real dir into the global copy). Trigger
    // the link now so the symlink appears immediately. The joiner's team secret
    // is delivered separately via `team_share_set_team_secret`. Non-fatal: a
    // momentarily-unreachable daemon must not fail the join — its sweep links
    // the workspace once reachable.
    if let Err(e) = team_sync_proxy::daemon_team_link(&workspace_path).await {
        eprintln!("team_share_join_existing: daemon link deferred: {e}");
    }

    // NOTE: team_id / share_mode / git_remote_url / litellm_team_id are NOT
    // written to teamclaw.json anymore. They duplicated the Cloud API (teams /
    // workspace-config) and drifted from the active team; the single source of
    // truth is the current-team store (OSS sync takes team_id from there).

    Ok(JoinExistingResult {
        initialized: true,
        share_mode,
    })
}

#[tauri::command]
pub async fn team_share_join_existing(
    team_id: String,
    workspace_path: String,
    access_token: String,
) -> Result<JoinExistingResult, String> {
    team_share_join_existing_impl(team_id, workspace_path, access_token).await
}

//! Team share / onboarding commands (refactor 2026-05-28).
//!
//! `team_share::create_team` is the slim replacement for the legacy
//! `oss_sync::oss_sync_create_team` Tauri command. It does ONLY the
//! `POST /v1/teams` call and returns `{ team_id, team_slug }`.
//!
//! Secret generation, OSS directory setup, and writes to
//! `.teamclu/teamclu.json` (e.g. `oss_team_id`, `share_mode`,
//! `ai_gateway_endpoint`) are intentionally NOT performed here. Those
//! responsibilities live in the `enable_oss` command (`team_share::enable`).

pub mod disconnect;
pub mod enable;
pub mod join;

#[allow(unused_imports)]
pub use disconnect::team_disconnect_repo;
#[allow(unused_imports)]
pub use enable::{
    enable_oss_impl, get_share_status_impl, set_team_secret_impl, team_share_enable_oss,
    team_share_get_status, team_share_set_team_secret, team_sync_paths, EnableShareResult,
};
#[allow(unused_imports)]
pub use join::{team_share_join_existing, team_share_join_existing_impl, JoinExistingResult};

use serde::{Deserialize, Serialize};

use crate::commands::oss_sync::fc_client::FcClient;
use crate::commands::oss_sync::resolve_runtime_fc_endpoint;

/// Result of the slim `team_share::create_team` Tauri command.
///
/// Intentionally omits `ai_gateway_endpoint` / `litellm_key` / `team_secret`
/// that the legacy `oss_sync_create_team` returned — those concerns are now
/// handled by `team_litellm.setup` and `team_share.enable_*` respectively.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTeamResult {
    pub team_id: String,
    pub team_slug: String,
}

/// Tauri command: create a new team server-side by hitting `POST /v1/teams`.
///
/// This does NOT generate a team secret, does NOT provision OSS / Git
/// remotes, and does NOT touch `.teamclu/teamclu.json`. Use one of the
/// `team_share::enable::*` commands to wire the team into a sharing mode
/// after creation.
#[tauri::command]
pub async fn team_share_create(
    name: String,
    workspace_path: String,
    access_token: String,
    cloud_api_url: String,
) -> Result<CreateTeamResult, String> {
    create_team(name, workspace_path, access_token, cloud_api_url).await
}

/// Library entry point (also called from integration tests).
///
/// `access_token` is the caller's own fresh user session JWT (Design 2); it is
/// passed straight to `FcClient` instead of reading a stale cached token.
pub async fn create_team(
    name: String,
    _workspace_path: String,
    access_token: String,
    cloud_api_url: String,
) -> Result<CreateTeamResult, String> {
    let fc = FcClient::new(resolve_runtime_fc_endpoint(&cloud_api_url)?, access_token);
    let row = fc
        .create_team(&name, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(CreateTeamResult {
        team_id: row.team_id,
        team_slug: row.team_slug,
    })
}

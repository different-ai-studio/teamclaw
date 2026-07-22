pub mod atomic_write;
pub mod env_catalog;
pub mod mcp_resolve;
pub mod merge;
pub mod opencode_db;
pub mod personal_secrets;
pub mod team_crypto;
pub mod team_provider;

#[cfg(test)]
pub mod test_util;

use std::collections::HashMap;
use std::path::Path;

pub use team_provider::{ManagedLlmModel, ManagedLlmProvider, ManagedLlmState};

pub const APP_SECRETS_DIR: &str = "teamclaw";
pub const DEFAULT_TEAM_REPO_DIR: &str = "teamclaw-team";

#[derive(Debug, Clone, Default)]
pub struct RuntimeEnvBundle {
    pub extra_env: HashMap<String, String>,
    pub opencode_json_original: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SystemEnvContext {
    pub actor_id: String,
    pub display_name: String,
    /// Absolute path to a file the daemon keeps refreshed with the current
    /// cloud access token (JWT). Injected as `TC_ACCESS_TOKEN_FILE` so a
    /// long-running agent can re-read a *fresh* token whenever it needs one —
    /// the token itself is never injected into the env, since env values are
    /// frozen at spawn and the JWT expires (~1h) well before a multi-day
    /// session ends. `None` when there is no cloud backend to source it from.
    pub cloud_token_file: Option<String>,
}

pub fn assemble_runtime_env(
    workspace: &Path,
    team_env: HashMap<String, String>,
    system: SystemEnvContext,
    managed_llm: &ManagedLlmState,
) -> anyhow::Result<RuntimeEnvBundle> {
    opencode_db::maybe_migrate_legacy_opencode_db(workspace)?;
    team_provider::ensure_team_provider(workspace, managed_llm)?;

    let personal = personal_secrets::load_personal_env()?;
    let merged = merge::merge_env_maps(personal, team_env, &system);
    let opencode_json_original =
        mcp_resolve::resolve_config_secret_refs(workspace, &merged)?;
    Ok(RuntimeEnvBundle {
        extra_env: merged,
        opencode_json_original,
    })
}

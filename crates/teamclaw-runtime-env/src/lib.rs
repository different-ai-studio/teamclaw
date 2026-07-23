pub mod atomic_write;
pub mod env_catalog;
pub mod mcp_resolve;
pub mod merge;
pub mod opencode_config;
pub mod opencode_db;
pub mod personal_secrets;
pub mod team_crypto;
pub mod team_provider;
pub mod team_provider_sync;

#[cfg(test)]
pub mod test_util;

use std::collections::HashMap;
use std::path::Path;

pub use merge::{secrets_for_team_provider, tc_api_key_for_actor};
pub use team_provider::{ManagedLlmModel, ManagedLlmProvider, ManagedLlmState};
pub use team_provider_sync::{
    sync_team_provider_on_disk, SecretResolveScope, TeamProviderSyncResult,
};

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

    let personal = personal_secrets::load_personal_env()?;
    let merged = merge::merge_env_maps(personal, team_env, &system);
    let sync = sync_team_provider_on_disk(
        workspace,
        managed_llm,
        &merged,
        SecretResolveScope::FullConfig,
    )?;
    Ok(RuntimeEnvBundle {
        extra_env: merged,
        opencode_json_original: sync.opencode_json_original,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team_provider::{ManagedLlmModel, ManagedLlmProvider};

    #[test]
    fn assemble_runtime_env_materializes_team_provider_on_spawn() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("opencode.json"), "{}").unwrap();

        let managed = ManagedLlmState::Enabled(ManagedLlmProvider {
            name: "Team".to_string(),
            base_url: "https://gateway.example/v1".to_string(),
            models: vec![ManagedLlmModel {
                id: "model-a".to_string(),
                name: "Model A".to_string(),
            }],
        });

        let bundle = assemble_runtime_env(
            dir.path(),
            HashMap::new(),
            SystemEnvContext {
                actor_id: "spawn-actor".to_string(),
                display_name: String::new(),
                cloud_token_file: None,
            },
            &managed,
        )
        .unwrap();

        assert_eq!(
            bundle.extra_env.get("tc_api_key").map(String::as_str),
            Some("sk-tc-spawn-actor")
        );

        let raw = std::fs::read_to_string(dir.path().join("opencode.json")).unwrap();
        assert!(raw.contains("sk-tc-spawn-actor"));
        assert!(raw.contains("model-a"));
        assert!(bundle.opencode_json_original.is_some());
    }
}

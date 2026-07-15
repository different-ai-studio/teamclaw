use std::path::Path;

use teamclaw_runtime_env::ManagedLlmState;

use crate::team_shared_env;

use super::SpawnRuntimeEnv;

/// Assemble personal + team + system env and resolve `${KEY}` placeholders in
/// `opencode.json` before attaching an ACP host.
///
/// `managed_llm` is the team's shared LLM as resolved from the cloud API (base
/// URL + model list). It is threaded straight into `opencode.json`'s
/// `provider.team`; the secret (`tc_api_key`) is never sourced from it — it is
/// derived locally from `actor_id` inside `assemble_runtime_env`.
pub fn assemble_spawn_runtime_env(
    workspace_root: &Path,
    team_id: Option<&str>,
    actor_id: &str,
    display_name: &str,
    cloud_token_file: Option<&str>,
    managed_llm: &ManagedLlmState,
) -> anyhow::Result<SpawnRuntimeEnv> {
    let team_env = team_shared_env::load_team_env_for_workspace(workspace_root, team_id);
    let bundle = teamclaw_runtime_env::assemble_runtime_env(
        workspace_root,
        team_env,
        teamclaw_runtime_env::SystemEnvContext {
            actor_id: actor_id.to_string(),
            display_name: display_name.to_string(),
            cloud_token_file: cloud_token_file.map(str::to_string),
        },
        managed_llm,
    )?;
    Ok(SpawnRuntimeEnv {
        extra_env: bundle.extra_env,
        force_env_override: true,
        opencode_json_original: bundle.opencode_json_original,
    })
}

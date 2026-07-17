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
        is_gateway: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use teamclaw_runtime_env::team_crypto::{self, SecretEntry};

    /// Covers the production boundary, rather than merely testing the secret
    /// reader: an encrypted team value must be present in the environment that
    /// is handed to the ACP host. Keep the key unique so any developer's local
    /// personal environment cannot mask a regression in this test.
    #[test]
    fn encrypted_team_secret_is_injected_into_spawn_environment() {
        let workspace = tempfile::tempdir().unwrap();
        let team_secret = "6a".repeat(32);
        let config_dir = workspace.path().join(".teamclaw");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("teamclaw.json"),
            serde_json::json!({ "team": { "envSecret": team_secret } }).to_string(),
        )
        .unwrap();

        let secrets_dir = workspace.path().join("teamclaw-team").join("_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        let entry = SecretEntry {
            key_id: "team_env_integration_test_token".to_string(),
            key: "expected-team-value".to_string(),
            ..Default::default()
        };
        let key = team_crypto::derive_key(&team_secret).unwrap();
        let envelope = team_crypto::encrypt_secret(&entry, &key).unwrap();
        std::fs::write(
            secrets_dir.join("team_env_integration_test_token.enc.json"),
            serde_json::to_vec(&envelope).unwrap(),
        )
        .unwrap();

        let spawn_env = assemble_spawn_runtime_env(
            workspace.path(),
            None,
            "actor-for-env-test",
            "Env Test Agent",
            None,
            &ManagedLlmState::Unknown,
        )
        .unwrap();

        assert_eq!(
            spawn_env
                .extra_env
                .get("team_env_integration_test_token")
                .map(String::as_str),
            Some("expected-team-value")
        );
        assert_eq!(
            spawn_env
                .extra_env
                .get("TEAM_ENV_INTEGRATION_TEST_TOKEN")
                .map(String::as_str),
            Some("expected-team-value"),
            "the uppercase alias is what many ACP agents consume"
        );
    }
}

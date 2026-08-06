use std::path::Path;

use teamclaw_runtime_env::ManagedLlmState;

use crate::team_shared_env;

use super::SpawnRuntimeEnv;

/// Assemble personal + team + system env, materialize `provider.team`, and resolve
/// `${KEY}` placeholders in `opencode.json` before attaching an ACP host.
///
/// `managed_llm` is the team's shared LLM as resolved from the cloud API (base
/// URL + model list). It is written to `opencode.json`'s `provider.team` inside
/// [`teamclaw_runtime_env::assemble_runtime_env`]; the secret (`tc_api_key`) is
/// derived locally from `actor_id`, never sourced from the cloud config.
pub fn assemble_spawn_runtime_env(
    workspace_root: &Path,
    team_id: Option<&str>,
    actor_id: &str,
    display_name: &str,
    cloud_token_file: Option<&str>,
    managed_llm: &ManagedLlmState,
) -> anyhow::Result<SpawnRuntimeEnv> {
    let team_env = team_shared_env::load_team_env_for_workspace_detailed(workspace_root, team_id);
    let mut bundle = teamclaw_runtime_env::assemble_runtime_env(
        workspace_root,
        team_env.values,
        teamclaw_runtime_env::SystemEnvContext {
            actor_id: actor_id.to_string(),
            display_name: display_name.to_string(),
            cloud_token_file: cloud_token_file.map(str::to_string),
        },
        managed_llm,
    )?;
    let personal_store = teamclaw_runtime_env::diagnose_personal_env_store();
    let personal_location = (!personal_store.secrets_dir.is_empty()).then(|| {
        std::path::Path::new(&personal_store.secrets_dir)
            .join("personal-secrets.json.enc")
            .display()
            .to_string()
    });
    bundle
        .resolved_env
        .annotate_sources(personal_location.as_deref(), &team_env.source_paths);
    bundle
        .resolved_env
        .unresolved
        .extend(team_env.unresolved_keys.into_iter().map(|key| {
            teamclaw_runtime_env::UnresolvedEnv {
                key,
                scope: teamclaw_runtime_env::EnvScope::Team,
                reason: teamclaw_runtime_env::UnresolvedReason::Unavailable,
            }
        }));
    let mut extra_env = bundle.extra_env;
    // Backend-neutral team-provider handoff. opencode consumes the team gateway
    // via `provider.team` in opencode.json (written by `ensure_team_provider`);
    // other local runtimes (pi, …) that can't read opencode.json instead read
    // this `TEAMCLAW_TEAM_PROVIDER` env and register the provider themselves.
    // The secret is NOT embedded — the payload references `${tc_api_key}`, the
    // same env-interpolated key opencode uses, which is already in `extra_env`.
    if let ManagedLlmState::Enabled(provider) = managed_llm {
        // Sorted by id, because this string is part of the spawn env and the
        // env's fingerprint decides which `opencode serve` process a workspace
        // rides. The cloud model list arrives in whatever order the API
        // returns; letting that order through would re-fingerprint the
        // workspace on every managed-LLM TTL refresh and churn serve processes
        // for a list that never actually changed.
        let mut sorted_models: Vec<&teamclaw_runtime_env::ManagedLlmModel> = provider
            .models
            .iter()
            .filter(|m| !m.id.is_empty())
            .collect();
        sorted_models.sort_by(|left, right| left.id.cmp(&right.id));
        sorted_models.dedup_by(|left, right| left.id == right.id);
        let models: Vec<serde_json::Value> = sorted_models
            .into_iter()
            .map(|m| {
                serde_json::json!({
                    "id": m.id,
                    "name": if m.name.is_empty() { &m.id } else { &m.name },
                })
            })
            .collect();
        let name = if provider.name.is_empty() {
            "Team"
        } else {
            &provider.name
        };
        let payload = serde_json::json!({
            "name": name,
            "baseUrl": provider.base_url,
            "apiKeyEnv": "tc_api_key",
            "models": models,
        });
        extra_env.insert("TEAMCLAW_TEAM_PROVIDER".to_string(), payload.to_string());
    }
    Ok(SpawnRuntimeEnv {
        extra_env,
        resolved_env: Some(bundle.resolved_env),
        env_team_id: team_id.map(str::to_string),
        force_env_override: true,
        opencode_json_original: bundle.opencode_json_original,
        is_gateway: false,
        permission: None,
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

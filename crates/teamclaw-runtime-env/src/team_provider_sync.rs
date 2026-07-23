//! Shared `provider.team` materialization + secret resolution for spawn and reconcile.
//!
//! Both paths must stay aligned: write the cloud-sourced team provider, then resolve
//! apiKey placeholders. Reconcile uses [`SecretResolveScope::ProviderApiKeysOnly`] so
//! frequent provider reads do not substitute MCP env vars into plaintext on disk.

use std::collections::HashMap;
use std::path::Path;

use crate::mcp_resolve;
use crate::team_provider::{self, ManagedLlmState};

/// How much of `opencode.json` secret resolution should run after `provider.team`
/// is materialized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretResolveScope {
    /// Spawn: substitute every `${KEY}` present in `secrets` (MCP env, provider
    /// apiKey, etc.) and install the runtime overlay.
    FullConfig,
    /// Reconcile: only resolve `provider.*.options.apiKey` — leave MCP placeholders.
    ProviderApiKeysOnly,
}

#[derive(Debug, Clone, Default)]
pub struct TeamProviderSyncResult {
    /// Canonical placeholder content before full runtime resolve — set only for
    /// [`SecretResolveScope::FullConfig`] when placeholders were substituted.
    pub opencode_json_original: Option<String>,
    pub provider_section_changed: bool,
}

/// Materialize `provider.team` from `managed_llm`, then resolve apiKey placeholders.
///
/// This is the single entry point both spawn (PR2) and reconcile should use so the
/// two paths cannot drift again.
pub fn sync_team_provider_on_disk(
    workspace: &Path,
    managed_llm: &ManagedLlmState,
    secrets: &HashMap<String, String>,
    scope: SecretResolveScope,
) -> anyhow::Result<TeamProviderSyncResult> {
    let provider_section_changed = team_provider::ensure_team_provider(workspace, managed_llm)?;

    let opencode_json_original = match scope {
        SecretResolveScope::FullConfig => mcp_resolve::resolve_config_secret_refs(workspace, secrets)?,
        SecretResolveScope::ProviderApiKeysOnly => {
            mcp_resolve::resolve_provider_api_keys_on_disk(workspace, secrets)?;
            None
        }
    };

    Ok(TeamProviderSyncResult {
        opencode_json_original,
        provider_section_changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merge::secrets_for_team_provider;
    use crate::team_provider::{ManagedLlmModel, ManagedLlmProvider};
    use std::fs;
    use tempfile::TempDir;

    fn sample_provider() -> ManagedLlmProvider {
        ManagedLlmProvider {
            name: "Team".to_string(),
            base_url: "https://gateway.example/v1".to_string(),
            models: vec![ManagedLlmModel {
                id: "model-a".to_string(),
                name: "Model A".to_string(),
            }],
        }
    }

    fn read_opencode(path: &Path) -> String {
        fs::read_to_string(path.join("opencode.json")).unwrap()
    }

    #[test]
    fn provider_only_scope_resolves_team_api_key_leaves_mcp_placeholder() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("opencode.json"),
            r#"{
  "provider": {
    "team": {
      "options": { "apiKey": "${tc_api_key}" },
      "models": { "model-a": { "name": "Model A" } }
    }
  },
  "mcp": {
    "github": {
      "environment": { "TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}"#,
        )
        .unwrap();

        let secrets = secrets_for_team_provider("actor-123");
        sync_team_provider_on_disk(
            dir.path(),
            &ManagedLlmState::Enabled(sample_provider()),
            &secrets,
            SecretResolveScope::ProviderApiKeysOnly,
        )
        .unwrap();

        let on_disk = read_opencode(dir.path());
        assert!(on_disk.contains("sk-tc-actor-123"));
        assert!(
            on_disk.contains("${GITHUB_TOKEN}"),
            "reconcile scope must not resolve MCP placeholders"
        );
        assert!(
            !dir.path().join(".teamclaw/opencode.runtime.json").exists(),
            "provider-only resolve must not install spawn overlay"
        );
    }

    #[test]
    fn sync_preserves_resolved_api_key_on_reconcile() {
        let dir = TempDir::new().unwrap();
        let resolved = "sk-tc-actor-xyz";
        fs::write(
            dir.path().join("opencode.json"),
            serde_json::json!({
                "provider": {
                    "team": {
                        "options": {
                            "baseURL": "https://gateway.example/v1",
                            "apiKey": resolved
                        },
                        "models": { "old": { "name": "Old" } }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        sync_team_provider_on_disk(
            dir.path(),
            &ManagedLlmState::Enabled(sample_provider()),
            &secrets_for_team_provider("actor-xyz"),
            SecretResolveScope::ProviderApiKeysOnly,
        )
        .unwrap();

        let parsed: serde_json::Value = serde_json::from_str(&read_opencode(dir.path())).unwrap();
        assert_eq!(
            parsed["provider"]["team"]["options"]["apiKey"].as_str(),
            Some(resolved)
        );
    }

    #[test]
    fn spawn_and_reconcile_scopes_agree_on_team_provider_api_key() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("opencode.json"), r#"{}"#).unwrap();

        let secrets = secrets_for_team_provider("shared-actor");
        let managed = ManagedLlmState::Enabled(sample_provider());

        sync_team_provider_on_disk(
            dir.path(),
            &managed,
            &secrets,
            SecretResolveScope::ProviderApiKeysOnly,
        )
        .unwrap();
        let reconcile_disk = read_opencode(dir.path());

        fs::write(dir.path().join("opencode.json"), r#"{}"#).unwrap();
        sync_team_provider_on_disk(
            dir.path(),
            &managed,
            &secrets,
            SecretResolveScope::FullConfig,
        )
        .unwrap();
        let spawn_disk = read_opencode(dir.path());

        let reconcile_json: serde_json::Value = serde_json::from_str(&reconcile_disk).unwrap();
        let spawn_json: serde_json::Value = serde_json::from_str(&spawn_disk).unwrap();
        assert_eq!(
            reconcile_json["provider"]["team"]["options"]["apiKey"],
            spawn_json["provider"]["team"]["options"]["apiKey"]
        );
        assert_eq!(
            reconcile_json["provider"]["team"]["models"],
            spawn_json["provider"]["team"]["models"]
        );
    }

    #[test]
    fn full_config_scope_materializes_team_provider_and_resolves_secrets() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("opencode.json"),
            r#"{
  "provider": {
    "team": { "options": { "apiKey": "${tc_api_key}" } }
  },
  "mcp": {
    "github": { "environment": { "TOKEN": "${API_TOKEN}" } }
  }
}"#,
        )
        .unwrap();

        let mut secrets = HashMap::new();
        secrets.insert("tc_api_key".to_string(), "sk-tc-spawn-actor".to_string());
        secrets.insert("API_TOKEN".to_string(), "ghp_spawn".to_string());

        sync_team_provider_on_disk(
            dir.path(),
            &ManagedLlmState::Enabled(sample_provider()),
            &secrets,
            SecretResolveScope::FullConfig,
        )
        .unwrap();

        let on_disk = read_opencode(dir.path());
        assert!(on_disk.contains("sk-tc-spawn-actor"));
        assert!(on_disk.contains("ghp_spawn"));
        assert!(!on_disk.contains("${tc_api_key}"));
        assert!(!on_disk.contains("${API_TOKEN}"));
        assert!(dir.path().join(".teamclaw/opencode.runtime.json").exists());
        let parsed: serde_json::Value = serde_json::from_str(&on_disk).unwrap();
        assert_eq!(
            parsed["provider"]["team"]["models"]["model-a"]["name"].as_str(),
            Some("Model A")
        );
    }
}

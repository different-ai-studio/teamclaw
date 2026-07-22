use std::path::Path;

use tracing::info;

use crate::opencode_config::OpencodeConfigStore;
use crate::DEFAULT_TEAM_REPO_DIR;

const TEAMCLAW_DIR: &str = ".teamclaw";
const CONFIG_FILE_NAME: &str = "teamclaw.json";

/// One model exposed by the team's managed LLM gateway.
#[derive(Debug, Clone)]
pub struct ManagedLlmModel {
    pub id: String,
    pub name: String,
}

/// The team's managed (shared) LLM provider, sourced from the cloud API rather
/// than a disk file. Materialized into `opencode.json`'s `provider.team` entry.
#[derive(Debug, Clone)]
pub struct ManagedLlmProvider {
    pub name: String,
    pub base_url: String,
    pub models: Vec<ManagedLlmModel>,
}

/// Tri-state result of resolving the team's managed LLM from the cloud.
#[derive(Debug, Clone, Default)]
pub enum ManagedLlmState {
    #[default]
    Unknown,
    Disabled,
    Enabled(ManagedLlmProvider),
}

fn teamclaw_config_path(workspace: &Path) -> std::path::PathBuf {
    workspace.join(TEAMCLAW_DIR).join(CONFIG_FILE_NAME)
}

/// Read `{workspace}/.teamclaw/teamclaw.json` → `team.sharedDirName`, or fall back to
/// [`DEFAULT_TEAM_REPO_DIR`].
pub fn resolve_shared_dir_name(workspace: &Path) -> String {
    let config_path = teamclaw_config_path(workspace);
    let content = match std::fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(_) => return DEFAULT_TEAM_REPO_DIR.to_string(),
    };
    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(json) => json,
        Err(_) => return DEFAULT_TEAM_REPO_DIR.to_string(),
    };
    json.get("team")
        .and_then(|team| team.get("sharedDirName"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_TEAM_REPO_DIR.to_string())
}

fn map_store_err(e: crate::opencode_config::OpencodeConfigError) -> anyhow::Error {
    anyhow::anyhow!("{e}")
}

fn map_mutate_err(e: anyhow::Error) -> crate::opencode_config::OpencodeConfigError {
    crate::opencode_config::OpencodeConfigError::Parse(e.to_string())
}

/// Apply `provider.team` reconciliation in-memory (no write). Returns whether the
/// config object changed.
pub fn mutate_team_provider(
    config: &mut serde_json::Value,
    state: &ManagedLlmState,
) -> anyhow::Result<bool> {
    if matches!(state, ManagedLlmState::Unknown) {
        return Ok(false);
    }

    let obj = config
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("opencode.json root is not an object"))?;

    if obj.get("$schema").is_none() && obj.is_empty() {
        obj.insert(
            "$schema".to_string(),
            serde_json::json!("https://opencode.ai/config.json"),
        );
    }

    let has_team_in_opencode = obj
        .get("provider")
        .and_then(|p| p.as_object())
        .map(|p| p.contains_key("team"))
        .unwrap_or(false);

    let mut changed = false;

    match state {
        ManagedLlmState::Enabled(provider) => {
            let mut models_out = serde_json::Map::new();
            for m in &provider.models {
                if m.id.is_empty() {
                    continue;
                }
                let mname = if m.name.is_empty() { &m.id } else { &m.name };
                models_out.insert(
                    m.id.clone(),
                    serde_json::json!({
                        "name": mname,
                        "limit": { "context": 256000, "output": 16000 }
                    }),
                );
            }

            let name = if provider.name.is_empty() {
                "Team"
            } else {
                &provider.name
            };
            let team_entry = serde_json::json!({
                "npm": "@ai-sdk/openai-compatible",
                "name": name,
                "options": { "baseURL": provider.base_url, "apiKey": "${tc_api_key}" },
                "models": models_out,
            });

            let providers = obj
                .entry("provider")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or_else(|| anyhow::anyhow!("provider is not an object"))?;
            if providers.get("team") != Some(&team_entry) {
                providers.insert("team".to_string(), team_entry);
                changed = true;
                info!(
                    base_url = %provider.base_url,
                    "Wrote provider.team to opencode.json (synced from cloud managed LLM)"
                );
            }
        }
        ManagedLlmState::Disabled => {
            if has_team_in_opencode {
                if let Some(providers) = obj.get_mut("provider").and_then(|p| p.as_object_mut()) {
                    providers.remove("team");
                    if providers.is_empty() {
                        obj.remove("provider");
                    }
                    changed = true;
                    info!("Removed stale provider.team from opencode.json (managed LLM disabled)");
                }
            }
        }
        ManagedLlmState::Unknown => {}
    }

    Ok(changed)
}

/// Reconcile `provider.team` in opencode.json against the cloud-sourced managed LLM.
pub fn ensure_team_provider(workspace: &Path, state: &ManagedLlmState) -> anyhow::Result<()> {
    if matches!(state, ManagedLlmState::Unknown) {
        return Ok(());
    }
    OpencodeConfigStore::apply(workspace, |config| {
        mutate_team_provider(config, state).map_err(map_mutate_err)
    })
    .map_err(map_store_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_teamclaw_json(dir: &Path, shared_dir_name: Option<&str>) {
        let config_dir = dir.join(TEAMCLAW_DIR);
        fs::create_dir_all(&config_dir).unwrap();
        let json = match shared_dir_name {
            Some(name) => serde_json::json!({ "team": { "sharedDirName": name } }),
            None => serde_json::json!({ "team": {} }),
        };
        fs::write(
            config_dir.join(CONFIG_FILE_NAME),
            serde_json::to_string(&json).unwrap(),
        )
        .unwrap();
    }

    fn sample_provider() -> ManagedLlmProvider {
        ManagedLlmProvider {
            name: "Team".to_string(),
            base_url: "https://gateway.example/v1".to_string(),
            models: vec![ManagedLlmModel {
                id: "gpt-4".to_string(),
                name: "GPT-4".to_string(),
            }],
        }
    }

    #[test]
    fn ensure_team_provider_adds_team_when_enabled() {
        let dir = TempDir::new().unwrap();
        ensure_team_provider(dir.path(), &ManagedLlmState::Enabled(sample_provider())).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("opencode.json")).unwrap())
                .unwrap();
        assert!(parsed["provider"]["team"].is_object());
    }

    #[test]
    fn ensure_team_provider_overwrites_existing_team_when_enabled() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("opencode.json"),
            serde_json::json!({
                "provider": {
                    "team": { "options": { "baseURL": "https://old.example" } }
                }
            })
            .to_string(),
        )
        .unwrap();
        ensure_team_provider(dir.path(), &ManagedLlmState::Enabled(sample_provider())).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("opencode.json")).unwrap())
                .unwrap();
        assert_eq!(
            parsed["provider"]["team"]["options"]["baseURL"],
            "https://gateway.example/v1"
        );
    }

    #[test]
    fn ensure_team_provider_removes_stale_team_when_disabled() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("opencode.json"),
            serde_json::json!({ "provider": { "team": {} } }).to_string(),
        )
        .unwrap();
        ensure_team_provider(dir.path(), &ManagedLlmState::Disabled).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("opencode.json")).unwrap())
                .unwrap();
        assert!(parsed.get("provider").is_none());
    }

    #[test]
    fn ensure_team_provider_unknown_leaves_config_untouched() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("opencode.json"),
            serde_json::json!({ "provider": { "team": { "keep": true } } }).to_string(),
        )
        .unwrap();
        ensure_team_provider(dir.path(), &ManagedLlmState::Unknown).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("opencode.json")).unwrap())
                .unwrap();
        assert_eq!(parsed["provider"]["team"]["keep"], true);
    }

    #[test]
    fn resolve_shared_dir_name_reads_teamclaw_json() {
        let dir = TempDir::new().unwrap();
        write_teamclaw_json(dir.path(), Some("custom-team"));
        assert_eq!(resolve_shared_dir_name(dir.path()), "custom-team");
    }
}

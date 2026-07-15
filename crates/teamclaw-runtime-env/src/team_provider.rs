use std::path::Path;

use tracing::info;

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
///
/// The extra `Unknown` state (vs. a bare `Option`) is deliberate: it lets a
/// caller with no fresh cloud answer (e.g. the sync `prepare_workspace` path, or
/// a transient fetch failure) leave `opencode.json` untouched instead of
/// wrongly stripping a working `provider.team`. Only an authoritative `Disabled`
/// removes the entry.
#[derive(Debug, Clone, Default)]
pub enum ManagedLlmState {
    /// No fresh cloud answer — leave `opencode.json` as-is.
    #[default]
    Unknown,
    /// Cloud confirms the team has no managed LLM — remove any stale entry.
    Disabled,
    /// Cloud-supplied managed LLM — write/overwrite `provider.team`.
    Enabled(ManagedLlmProvider),
}

fn opencode_config_path(workspace: &Path) -> std::path::PathBuf {
    workspace.join("opencode.json")
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

/// Reconcile `provider.team` in opencode.json against the cloud-sourced managed
/// LLM ([`ManagedLlmState`]).
///
/// The managed LLM used to be mirrored to `{sharedDir}/_meta/provider.json` and
/// read from disk, which raced the first-install git clone (the file wasn't there
/// yet, so the provider silently never appeared until a daemon restart). It is now
/// fetched directly from the cloud API and passed in here, so `opencode.json`
/// converges on first run without any disk dependency.
///
/// Behavior:
/// - `Enabled` → write/overwrite `provider.team` from the cloud provider. The
///   daemon is the sole owner of the entry now, so it always overwrites.
/// - `Disabled` → remove any stale `provider.team` (team turned managed LLM off).
/// - `Unknown` → no-op; leave `opencode.json` untouched (no fresh cloud answer, so
///   don't strip a working provider on a transient miss).
pub fn ensure_team_provider(workspace: &Path, state: &ManagedLlmState) -> anyhow::Result<()> {
    if matches!(state, ManagedLlmState::Unknown) {
        return Ok(());
    }

    let config_path = opencode_config_path(workspace);

    let mut config: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)?;
        serde_json::from_str(&content)?
    } else {
        serde_json::json!({ "$schema": "https://opencode.ai/config.json" })
    };
    let obj = config
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("opencode.json root is not an object"))?;

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
                // The secret is never written to disk; `${tc_api_key}` is resolved
                // at runtime from the env map (locally derived from actor_id).
                "options": { "baseURL": provider.base_url, "apiKey": "${tc_api_key}" },
                "models": models_out,
            });

            let providers = obj
                .entry("provider")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or_else(|| anyhow::anyhow!("provider is not an object"))?;
            let differs = providers.get("team") != Some(&team_entry);
            if differs {
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

    if changed {
        let mut new_content = serde_json::to_string_pretty(&config)?;
        if !new_content.ends_with('\n') {
            new_content.push('\n');
        }
        std::fs::write(&config_path, &new_content)?;
    }

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
            serde_json::to_string_pretty(&json).unwrap(),
        )
        .unwrap();
    }

    fn sample_provider() -> ManagedLlmProvider {
        ManagedLlmProvider {
            name: "Team Gateway".to_string(),
            base_url: "https://gateway.example/v1".to_string(),
            models: vec![
                ManagedLlmModel {
                    id: "gpt-4o".to_string(),
                    name: "GPT-4o".to_string(),
                },
                ManagedLlmModel {
                    id: "claude-sonnet".to_string(),
                    name: "Claude Sonnet".to_string(),
                },
            ],
        }
    }

    #[test]
    fn resolve_shared_dir_name_reads_json_and_falls_back() {
        let dir = TempDir::new().unwrap();

        assert_eq!(
            resolve_shared_dir_name(dir.path()),
            DEFAULT_TEAM_REPO_DIR.to_string()
        );

        write_teamclaw_json(dir.path(), None);
        assert_eq!(
            resolve_shared_dir_name(dir.path()),
            DEFAULT_TEAM_REPO_DIR.to_string()
        );

        write_teamclaw_json(dir.path(), Some("custom-team-dir"));
        assert_eq!(
            resolve_shared_dir_name(dir.path()),
            "custom-team-dir".to_string()
        );
    }

    #[test]
    fn ensure_team_provider_adds_team_when_enabled() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("opencode.json"),
            r#"{"$schema":"https://opencode.ai/config.json"}"#,
        )
        .unwrap();

        ensure_team_provider(dir.path(), &ManagedLlmState::Enabled(sample_provider())).unwrap();

        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("opencode.json")).unwrap())
                .unwrap();
        let team = config
            .get("provider")
            .and_then(|p| p.get("team"))
            .expect("provider.team should be added");
        assert_eq!(team.get("name").and_then(|v| v.as_str()), Some("Team Gateway"));
        assert_eq!(
            team.get("options")
                .and_then(|o| o.get("baseURL"))
                .and_then(|v| v.as_str()),
            Some("https://gateway.example/v1")
        );
        // The secret is never written to disk — only the placeholder.
        assert_eq!(
            team.get("options")
                .and_then(|o| o.get("apiKey"))
                .and_then(|v| v.as_str()),
            Some("${tc_api_key}")
        );
        assert!(team.get("models").and_then(|m| m.get("gpt-4o")).is_some());
    }

    #[test]
    fn ensure_team_provider_overwrites_existing_team_when_enabled() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("opencode.json"),
            r#"{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "team": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Old Name",
      "options": { "baseURL": "https://old.example/v1", "apiKey": "${tc_api_key}" },
      "models": {}
    }
  }
}"#,
        )
        .unwrap();

        ensure_team_provider(dir.path(), &ManagedLlmState::Enabled(sample_provider())).unwrap();

        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("opencode.json")).unwrap())
                .unwrap();
        let team = config.get("provider").and_then(|p| p.get("team")).unwrap();
        assert_eq!(team.get("name").and_then(|v| v.as_str()), Some("Team Gateway"));
        assert_eq!(
            team.get("options")
                .and_then(|o| o.get("baseURL"))
                .and_then(|v| v.as_str()),
            Some("https://gateway.example/v1")
        );
    }

    #[test]
    fn ensure_team_provider_removes_stale_team_when_disabled() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("opencode.json"),
            r#"{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "team": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Stale Team",
      "options": { "baseURL": "https://old.example/v1", "apiKey": "secret" },
      "models": {}
    }
  }
}"#,
        )
        .unwrap();

        ensure_team_provider(dir.path(), &ManagedLlmState::Disabled).unwrap();

        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("opencode.json")).unwrap())
                .unwrap();
        assert!(config.get("provider").is_none());
    }

    #[test]
    fn ensure_team_provider_unknown_leaves_config_untouched() {
        let dir = TempDir::new().unwrap();
        let original = r#"{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "team": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Existing",
      "options": { "baseURL": "https://keep.example/v1", "apiKey": "${tc_api_key}" },
      "models": {}
    }
  }
}"#;
        fs::write(dir.path().join("opencode.json"), original).unwrap();

        ensure_team_provider(dir.path(), &ManagedLlmState::Unknown).unwrap();

        // Unknown is a no-op: existing provider.team must survive.
        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("opencode.json")).unwrap())
                .unwrap();
        assert_eq!(
            config
                .get("provider")
                .and_then(|p| p.get("team"))
                .and_then(|t| t.get("name"))
                .and_then(|v| v.as_str()),
            Some("Existing")
        );
    }
}

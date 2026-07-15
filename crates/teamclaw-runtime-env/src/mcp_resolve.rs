use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn opencode_config_path(workspace: &Path) -> PathBuf {
    workspace.join("opencode.json")
}

/// Replace `${KEY}` and `$KEY` references in opencode.json with actual values.
///
/// Writes the resolved config to disk when substitutions occur.
///
/// Returns the original file content if any substitutions were made (caller
/// must restore it later), or `None` if nothing changed.
pub fn resolve_config_secret_refs(
    workspace: &Path,
    secrets: &HashMap<String, String>,
) -> anyhow::Result<Option<String>> {
    if secrets.is_empty() {
        return Ok(None);
    }

    let config_path = opencode_config_path(workspace);
    let original = match std::fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };

    // Simple string replacement on the raw JSON — avoids re-serialization
    // artefacts (key ordering, whitespace). Safe because secret values never
    // contain `${`.
    let mut resolved = original.clone();
    let mut changed = false;
    for (key, value) in secrets {
        let placeholder = format!("${{{}}}", key);
        if resolved.contains(&placeholder) {
            resolved = resolved.replace(&placeholder, value);
            changed = true;
        }
        let placeholder_bare = format!("${key}");
        if resolved.contains(&placeholder_bare) {
            resolved = resolved.replace(&placeholder_bare, value);
            changed = true;
        }
    }

    if changed {
        std::fs::write(&config_path, &resolved)?;
        Ok(Some(original))
    } else {
        Ok(None)
    }
}

/// Restore the original opencode.json content (with `${KEY}` placeholders),
/// but keep provider apiKey values resolved since opencode re-reads the
/// config at request time.
pub fn restore_config(
    workspace: &Path,
    original: &Option<String>,
    secrets: &HashMap<String, String>,
) -> anyhow::Result<()> {
    if let Some(content) = original {
        let restored = resolve_provider_api_keys(content, secrets);
        let config_path = opencode_config_path(workspace);
        std::fs::write(&config_path, &restored)?;
    }
    Ok(())
}

/// Resolve only `provider.*.options.apiKey` values in the JSON content.
///
/// Other `${KEY}` references (e.g. MCP env vars) are left as placeholders
/// so they don't linger as plaintext on disk.
fn resolve_provider_api_keys(content: &str, secrets: &HashMap<String, String>) -> String {
    let mut json: serde_json::Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(_) => return content.to_string(),
    };

    let mut changed = false;
    if let Some(providers) = json.get_mut("provider").and_then(|p| p.as_object_mut()) {
        for provider in providers.values_mut() {
            if let Some(api_key) = provider
                .get_mut("options")
                .and_then(|o| o.get_mut("apiKey"))
                .and_then(|v| v.as_str().map(|s| s.to_string()))
            {
                if let Some(start) = api_key.find("${") {
                    if let Some(end) = api_key[start..].find('}') {
                        let key_name = &api_key[start + 2..start + end];
                        if let Some(value) = secrets.get(key_name) {
                            let resolved = api_key.replace(&format!("${{{key_name}}}"), value);
                            provider["options"]["apiKey"] = serde_json::Value::String(resolved);
                            changed = true;
                        }
                    }
                }
            }
        }
    }

    if changed {
        serde_json::to_string_pretty(&json).unwrap_or_else(|_| content.to_string())
    } else {
        content.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_opencode_json(dir: &Path, content: &str) {
        fs::write(dir.join("opencode.json"), content).unwrap();
    }

    fn read_opencode_json(dir: &Path) -> String {
        fs::read_to_string(dir.join("opencode.json")).unwrap()
    }

    #[test]
    fn resolve_replaces_mcp_environment_placeholders() {
        let dir = TempDir::new().unwrap();
        write_opencode_json(
            dir.path(),
            r#"{
  "mcp": {
    "github": {
      "type": "stdio",
      "environment": {
        "GITHUB_TOKEN": "${API_KEY}"
      }
    }
  }
}"#,
        );

        let mut secrets = HashMap::new();
        secrets.insert("API_KEY".to_string(), "ghp_secret123".to_string());

        let original = resolve_config_secret_refs(dir.path(), &secrets).unwrap();
        assert!(original.is_some());

        let on_disk = read_opencode_json(dir.path());
        assert!(on_disk.contains("ghp_secret123"));
        assert!(!on_disk.contains("${API_KEY}"));
    }

    #[test]
    fn restore_puts_mcp_placeholders_back_keeps_resolved_provider_api_key() {
        let dir = TempDir::new().unwrap();
        let original_content = r#"{
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "${ANTHROPIC_KEY}"
      }
    }
  },
  "mcp": {
    "github": {
      "type": "stdio",
      "environment": {
        "GITHUB_TOKEN": "${API_KEY}"
      }
    }
  }
}"#;
        write_opencode_json(dir.path(), original_content);

        let mut secrets = HashMap::new();
        secrets.insert("API_KEY".to_string(), "ghp_secret123".to_string());
        secrets.insert("ANTHROPIC_KEY".to_string(), "sk-ant-resolved".to_string());

        let original = resolve_config_secret_refs(dir.path(), &secrets).unwrap();
        assert!(original.is_some());

        restore_config(dir.path(), &original, &secrets).unwrap();

        let restored = read_opencode_json(dir.path());
        assert!(restored.contains("${API_KEY}"), "MCP env should use placeholder");
        assert!(
            restored.contains("sk-ant-resolved"),
            "provider apiKey should stay resolved"
        );
        assert!(
            !restored.contains("${ANTHROPIC_KEY}"),
            "provider apiKey should not keep placeholder"
        );
    }

    #[test]
    fn resolve_returns_none_when_no_placeholders() {
        let dir = TempDir::new().unwrap();
        write_opencode_json(
            dir.path(),
            r#"{"mcp": {"github": {"environment": {"TOKEN": "literal"}}}}"#,
        );

        let mut secrets = HashMap::new();
        secrets.insert("API_KEY".to_string(), "unused".to_string());

        let original = resolve_config_secret_refs(dir.path(), &secrets).unwrap();
        assert!(original.is_none());
    }

    #[test]
    fn resolve_returns_none_when_secrets_empty() {
        let dir = TempDir::new().unwrap();
        write_opencode_json(dir.path(), r#"{"mcp": {"env": "${API_KEY}"}}"#);

        let secrets = HashMap::new();
        let original = resolve_config_secret_refs(dir.path(), &secrets).unwrap();
        assert!(original.is_none());
    }

    #[test]
    fn resolve_returns_none_when_config_missing() {
        let dir = TempDir::new().unwrap();
        let mut secrets = HashMap::new();
        secrets.insert("API_KEY".to_string(), "value".to_string());

        let original = resolve_config_secret_refs(dir.path(), &secrets).unwrap();
        assert!(original.is_none());
    }

    #[test]
    fn resolve_replaces_bare_dollar_key() {
        let dir = TempDir::new().unwrap();
        write_opencode_json(
            dir.path(),
            r#"{"mcp": {"server": {"environment": {"TOKEN": "$API_KEY"}}}}"#,
        );

        let mut secrets = HashMap::new();
        secrets.insert("API_KEY".to_string(), "bare-value".to_string());

        let original = resolve_config_secret_refs(dir.path(), &secrets).unwrap();
        assert!(original.is_some());

        let on_disk = read_opencode_json(dir.path());
        assert!(on_disk.contains("bare-value"));
        assert!(!on_disk.contains("$API_KEY"));
    }
}

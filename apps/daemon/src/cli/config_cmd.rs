use crate::cli::{ConfigAction, ConfigArgs};
use std::path::Path;
use toml::Value;

pub fn run(args: ConfigArgs, default_config_path: &Path) -> anyhow::Result<()> {
    let path = args.config.as_deref().unwrap_or(default_config_path);
    match args.action {
        ConfigAction::Path => {
            println!("{}", path.display());
        }
        ConfigAction::List => {
            for line in list_config_values(path)? {
                println!("{line}");
            }
        }
        ConfigAction::Get { key } => {
            println!("{}", get_config_value(path, &key)?);
        }
        ConfigAction::Set { key, value } => {
            set_config_value(path, &key, &value)?;
            println!("{key} = {}", get_config_value(path, &key)?);
        }
        ConfigAction::Unset { key } => {
            unset_config_value(path, &key)?;
            println!("unset {key}");
        }
    }
    Ok(())
}

fn get_config_value(path: &Path, key: &str) -> anyhow::Result<String> {
    let root = read_config(path)?;
    let value = value_at_key(&root, key).ok_or_else(|| anyhow::anyhow!("missing key: {key}"))?;
    Ok(format_inline_value(value))
}

fn list_config_values(path: &Path) -> anyhow::Result<Vec<String>> {
    let root = read_config(path)?;
    let mut lines = Vec::new();
    flatten_values(None, &root, &mut lines);
    lines.sort();
    Ok(lines)
}

fn set_config_value(path: &Path, key: &str, raw_value: &str) -> anyhow::Result<()> {
    let mut root = read_config(path)?;
    let value = parse_cli_value(raw_value);
    set_value_at_key(&mut root, key, value)?;
    write_config(path, &root)
}

fn unset_config_value(path: &Path, key: &str) -> anyhow::Result<()> {
    let mut root = read_config(path)?;
    remove_value_at_key(&mut root, key)?;
    write_config(path, &root)
}

fn read_config(path: &Path) -> anyhow::Result<Value> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("read {}: {e}", path.display()))?;
    text.parse::<Value>()
        .map_err(|e| anyhow::anyhow!("parse {}: {e}", path.display()))
}

fn write_config(path: &Path, root: &Value) -> anyhow::Result<()> {
    let content = toml::to_string_pretty(root)?;
    toml::from_str::<crate::config::DaemonConfig>(&content)
        .map_err(|e| anyhow::anyhow!("validate {}: {e}", path.display()))?;
    std::fs::write(path, content)?;
    Ok(())
}

fn parse_cli_value(raw: &str) -> Value {
    let wrapped = format!("value = {raw}");
    wrapped
        .parse::<Value>()
        .ok()
        .and_then(|value| value.get("value").cloned())
        .unwrap_or_else(|| Value::String(raw.to_string()))
}

fn key_parts(key: &str) -> anyhow::Result<Vec<&str>> {
    let parts: Vec<_> = key.split('.').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        anyhow::bail!("config key cannot be empty");
    }
    Ok(parts)
}

fn value_at_key<'a>(root: &'a Value, key: &str) -> Option<&'a Value> {
    let mut current = root;
    for part in key_parts(key).ok()? {
        current = current.get(part)?;
    }
    Some(current)
}

fn set_value_at_key(root: &mut Value, key: &str, value: Value) -> anyhow::Result<()> {
    let parts = key_parts(key)?;
    let mut current = root;
    for part in &parts[..parts.len() - 1] {
        let table = current
            .as_table_mut()
            .ok_or_else(|| anyhow::anyhow!("{} is not a table", part))?;
        current = table
            .entry((*part).to_string())
            .or_insert_with(|| Value::Table(Default::default()));
    }
    let table = current
        .as_table_mut()
        .ok_or_else(|| anyhow::anyhow!("parent for {key} is not a table"))?;
    table.insert(parts[parts.len() - 1].to_string(), value);
    Ok(())
}

fn remove_value_at_key(root: &mut Value, key: &str) -> anyhow::Result<()> {
    let parts = key_parts(key)?;
    let mut current = root;
    for part in &parts[..parts.len() - 1] {
        current = current
            .get_mut(*part)
            .ok_or_else(|| anyhow::anyhow!("missing key: {key}"))?;
    }
    let table = current
        .as_table_mut()
        .ok_or_else(|| anyhow::anyhow!("parent for {key} is not a table"))?;
    table
        .remove(parts[parts.len() - 1])
        .ok_or_else(|| anyhow::anyhow!("missing key: {key}"))?;
    Ok(())
}

fn flatten_values(prefix: Option<&str>, value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Table(table) => {
            for (key, child) in table {
                let dotted = match prefix {
                    Some(prefix) => format!("{prefix}.{key}"),
                    None => key.to_string(),
                };
                flatten_values(Some(&dotted), child, out);
            }
        }
        other => {
            if let Some(prefix) = prefix {
                out.push(format!("{prefix} = {}", format_inline_value(other)));
            }
        }
    }
}

fn format_inline_value(value: &Value) -> String {
    match value {
        Value::String(s) => format!("{s:?}"),
        Value::Integer(i) => i.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Boolean(b) => b.to_string(),
        Value::Datetime(dt) => dt.to_string(),
        Value::Array(items) => {
            let values = items
                .iter()
                .map(format_inline_value)
                .collect::<Vec<_>>()
                .join(", ");
            format!("[{values}]")
        }
        Value::Table(_) => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    #[test]
    fn set_get_and_unset_nested_config_values() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        std::fs::write(
            &path,
            r#"
team_id = "team-1"

[device]
id = "actor-1"
name = "Mac"

[mqtt]
broker_url = "mqtts://old.example"
"#,
        )
        .unwrap();

        super::set_config_value(&path, "agents.codex.binary", "codex").unwrap();
        super::set_config_value(&path, "agents.codex.default_flags", r#"["--foo", "bar"]"#)
            .unwrap();
        super::set_config_value(&path, "idle_runtime_timeout_secs", "1800").unwrap();

        assert_eq!(
            super::get_config_value(&path, "agents.codex.binary").unwrap(),
            "\"codex\""
        );
        assert_eq!(
            super::get_config_value(&path, "agents.codex.default_flags").unwrap(),
            "[\"--foo\", \"bar\"]"
        );
        assert_eq!(
            super::get_config_value(&path, "idle_runtime_timeout_secs").unwrap(),
            "1800"
        );

        let cfg = crate::config::DaemonConfig::load(&path).unwrap();
        assert_eq!(cfg.agents.codex.as_ref().unwrap().binary, "codex");
        assert_eq!(
            cfg.agents.codex.as_ref().unwrap().default_flags,
            vec!["--foo".to_string(), "bar".to_string()]
        );
        assert_eq!(cfg.idle_runtime_timeout_secs, Some(1800));

        super::unset_config_value(&path, "team_id").unwrap();
        assert!(super::get_config_value(&path, "team_id").is_err());
        assert_eq!(
            crate::config::DaemonConfig::load(&path).unwrap().team_id,
            None
        );
    }

    #[test]
    fn list_config_values_flattens_nested_tables() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        std::fs::write(
            &path,
            r#"
[device]
id = "actor-1"
name = "Mac"

[mqtt]
broker_url = "mqtts://broker.example"
"#,
        )
        .unwrap();

        assert_eq!(
            super::list_config_values(&path).unwrap(),
            vec![
                "device.id = \"actor-1\"".to_string(),
                "device.name = \"Mac\"".to_string(),
                "mqtt.broker_url = \"mqtts://broker.example\"".to_string(),
            ]
        );
    }

    #[test]
    fn invalid_edits_do_not_overwrite_existing_config() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        let original = r#"
[device]
id = "actor-1"
name = "Mac"

[mqtt]
broker_url = "mqtts://broker.example"
"#;
        std::fs::write(&path, original).unwrap();

        let err = super::unset_config_value(&path, "device.id").unwrap_err();

        assert!(err.to_string().contains("validate"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }
}

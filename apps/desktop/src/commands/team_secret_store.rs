fn team_secret_blob_key(team_id: &str) -> String {
    format!("_team_secret.{}", team_id)
}

pub fn save_team_secret(workspace_path: &str, team_id: &str, secret: &str) -> Result<(), String> {
    let mut blob = super::env_vars::read_env_blob(workspace_path)?;
    blob.insert(
        team_secret_blob_key(team_id),
        serde_json::Value::String(secret.to_string()),
    );
    super::env_vars::write_env_blob(&blob)
}

pub fn load_team_secret(workspace_path: &str, team_id: &str) -> Result<String, String> {
    let blob = super::env_vars::read_env_blob(workspace_path)?;
    let key = team_secret_blob_key(team_id);
    if let Some(value) = blob.get(&key).and_then(|v| v.as_str()) {
        return Ok(value.to_string());
    }
    Err(format!("Team secret not found for team {team_id}"))
}

pub fn delete_team_secret(workspace_path: &str, team_id: &str) -> Result<(), String> {
    let mut blob = super::env_vars::read_env_blob(workspace_path)?;
    blob.remove(&team_secret_blob_key(team_id));
    super::env_vars::write_env_blob(&blob)
}

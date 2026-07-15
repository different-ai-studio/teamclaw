//! LiteLLM-related commands and local config helpers.
//!
//! - `team_litellm_setup`: provisions LiteLLM for a team via FC.
//! - `build_llm_config` / `write_llm_config`: read/write the `"llm"` key in
//!   the workspace `teamclaw.json` (still used by the team-join flow when
//!   materializing local config). The Settings "团队共享模型" pane now stores
//!   the team LLM config in the cloud (`PUT /v1/teams/:id/llm-config`); the
//!   client materializes `_meta/provider.json` for the daemon directly.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;

// ─── Types ───────────────────────────────────────────────────────────────────

/// A single model entry in the team LLM configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmModelEntry {
    pub id: String,
    pub name: String,
}

/// LLM configuration stored in teamclaw.json under "llm" key.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub base_url: String,
    pub model: String,
    pub model_name: String,
    /// Multiple selectable models. When present, users can switch between these.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<LlmModelEntry>,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Build an LlmConfig from optional parameters.
/// Returns None when no base_url is provided (user chose not to host LLM).
pub fn build_llm_config(
    base_url: Option<String>,
    model: Option<String>,
    model_name: Option<String>,
    models_json: Option<String>,
) -> Option<LlmConfig> {
    let url = base_url.filter(|s| !s.is_empty())?;
    let models: Vec<LlmModelEntry> = models_json
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let default_model = models.first();
    Some(LlmConfig {
        base_url: url,
        model: model
            .filter(|s| !s.is_empty())
            .or_else(|| default_model.map(|m| m.id.clone()))
            .unwrap_or_else(|| "default".to_string()),
        model_name: model_name
            .filter(|s| !s.is_empty())
            .or_else(|| default_model.map(|m| m.name.clone()))
            .unwrap_or_else(|| "default".to_string()),
        models,
    })
}

/// Write LLM config to teamclaw.json under "llm" key, preserving other fields.
pub fn write_llm_config(workspace_path: &str, config: Option<&LlmConfig>) -> Result<(), String> {
    let teamclaw_dir = format!("{}/{}", workspace_path, crate::commands::TEAMCLAW_DIR);
    let _ = std::fs::create_dir_all(&teamclaw_dir);
    let config_path = format!("{}/{}", teamclaw_dir, crate::commands::CONFIG_FILE_NAME);

    let mut json: serde_json::Value = if Path::new(&config_path).exists() {
        let content = std::fs::read_to_string(&config_path).map_err(|e| {
            format!(
                "Failed to read {}: {}",
                crate::commands::CONFIG_FILE_NAME,
                e
            )
        })?;
        serde_json::from_str(&content).map_err(|e| {
            format!(
                "Failed to parse {}: {}",
                crate::commands::CONFIG_FILE_NAME,
                e
            )
        })?
    } else {
        serde_json::json!({
            "$schema": "https://opencode.ai/config.json"
        })
    };

    if let Some(llm_config) = config {
        let llm_val = serde_json::to_value(llm_config)
            .map_err(|e| format!("Failed to serialize llm config: {}", e))?;
        json.as_object_mut()
            .ok_or_else(|| format!("{} is not an object", crate::commands::CONFIG_FILE_NAME))?
            .insert("llm".to_string(), llm_val);
    } else {
        json.as_object_mut()
            .ok_or_else(|| format!("{} is not an object", crate::commands::CONFIG_FILE_NAME))?
            .remove("llm");
    }

    let content = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&config_path, content).map_err(|e| {
        format!(
            "Failed to write {}: {}",
            crate::commands::CONFIG_FILE_NAME,
            e
        )
    })
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

use crate::commands::env_vars;
use crate::commands::oss_sync::fc_client::FcClient;
use crate::commands::oss_sync::get_fc_endpoint;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteLlmSetupResult {
    pub ai_gateway_endpoint: String,
    pub litellm_key: String,
}

/// Library entry point (also called from integration tests).
pub async fn setup_impl(
    team_id: String,
    workspace_path: String,
    access_token: String,
) -> Result<LiteLlmSetupResult, String> {
    let fc = FcClient::new(get_fc_endpoint(&workspace_path), access_token);
    let path = format!("/v1/teams/{}/litellm/setup", team_id);
    let resp = fc
        .post_json(&path, &json!({}))
        .await
        .map_err(|e| e.to_string())?;

    let ai_gateway_endpoint = resp
        .get("aiGatewayEndpoint")
        .or_else(|| resp.get("ai_gateway_endpoint"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "litellm/setup: missing aiGatewayEndpoint".to_string())?
        .to_string();
    let litellm_key = resp
        .get("litellmKey")
        .or_else(|| resp.get("litellm_key"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "litellm/setup: missing litellmKey".to_string())?
        .to_string();

    let mut cfg = env_vars::read_teamclaw_json(&workspace_path)?;
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert(
            "ai_gateway_endpoint".to_string(),
            serde_json::Value::String(ai_gateway_endpoint.clone()),
        );
        obj.insert(
            "litellm_key".to_string(),
            serde_json::Value::String(litellm_key.clone()),
        );
    }
    env_vars::write_teamclaw_json(&workspace_path, &cfg)?;

    Ok(LiteLlmSetupResult {
        ai_gateway_endpoint,
        litellm_key,
    })
}

#[tauri::command]
pub async fn team_litellm_setup(
    team_id: String,
    workspace_path: String,
    access_token: String,
) -> Result<LiteLlmSetupResult, String> {
    setup_impl(team_id, workspace_path, access_token).await
}

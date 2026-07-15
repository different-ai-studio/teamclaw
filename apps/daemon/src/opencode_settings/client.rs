use std::collections::HashMap;
use std::path::Path;

use reqwest::StatusCode;
use serde_json::Value;

use super::{OAuthAuthorizeResult, OpenCodeSettingsError};

#[derive(Debug, Clone)]
pub struct LiveProviderSummary {
    pub id: String,
    pub display_name: String,
    pub model_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct LiveProviderCatalog {
    pub connected: Vec<String>,
    pub providers: HashMap<String, LiveProviderSummary>,
}

#[derive(Clone)]
pub struct OpenCodeSettingsClient {
    http: reqwest::Client,
    base_url: String,
    directory: String,
}

impl OpenCodeSettingsClient {
    pub fn new(base_url: String, workspace_path: &Path) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            directory: workspace_path.to_string_lossy().to_string(),
        }
    }

    pub async fn fetch_provider_auth_methods(
        &self,
    ) -> Result<
        HashMap<String, Vec<crate::config::provider_auth::ProviderAuthMethod>>,
        OpenCodeSettingsError,
    >
    {
        let value: Value = self.get_json("/provider/auth").await?;
        serde_json::from_value(value).map_err(|e| OpenCodeSettingsError::Http(e.to_string()))
    }

    pub async fn oauth_authorize(
        &self,
        provider_id: &str,
        method_index: u32,
        inputs: &HashMap<String, String>,
    ) -> Result<OAuthAuthorizeResult, OpenCodeSettingsError> {
        let path = format!("/provider/{}/oauth/authorize", provider_id);
        let body = serde_json::json!({
            "method": method_index,
            "inputs": inputs,
        });
        let value: Value = self.post_json(&path, body).await?;
        let url = value
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OpenCodeSettingsError::Http("authorize response missing url".into()))?
            .to_string();
        let method = value
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("code")
            .to_string();
        let instructions = value
            .get("instructions")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Ok(OAuthAuthorizeResult {
            url,
            method,
            instructions,
        })
    }

    pub async fn oauth_callback(
        &self,
        provider_id: &str,
        method_index: u32,
        code: Option<&str>,
    ) -> Result<(), OpenCodeSettingsError> {
        let path = format!("/provider/{}/oauth/callback", provider_id);
        let mut body = serde_json::json!({ "method": method_index });
        if let Some(code) = code {
            body["code"] = Value::String(code.to_string());
        }
        let _: Value = self.post_json(&path, body).await?;
        Ok(())
    }

    pub async fn remove_auth(&self, provider_id: &str) -> Result<(), OpenCodeSettingsError> {
        let path = format!("/auth/{}", provider_id);
        let url = self.url(&path);
        let resp = self
            .http
            .delete(&url)
            .send()
            .await
            .map_err(|e| OpenCodeSettingsError::Http(e.to_string()))?;
        if resp.status().is_success() {
            return Ok(());
        }
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        // Some OpenCode builds may not expose DELETE; treat 404 as already removed.
        if status == StatusCode::NOT_FOUND {
            return Ok(());
        }
        Err(OpenCodeSettingsError::Api {
            status: status.as_u16(),
            detail,
        })
    }

    pub async fn fetch_connected_provider_ids(&self) -> Result<Vec<String>, OpenCodeSettingsError> {
        Ok(self.fetch_provider_catalog().await?.connected)
    }

    /// Live OpenCode provider catalog (`GET /provider`) — models + connected ids.
    pub async fn fetch_provider_catalog(
        &self,
    ) -> Result<LiveProviderCatalog, OpenCodeSettingsError> {
        let value: Value = self.get_json("/provider").await?;
        let connected = value
            .get("connected")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();

        let mut providers = std::collections::HashMap::new();
        let all = value
            .get("all")
            .or_else(|| value.get("providers"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for entry in all {
            let Some(id) = entry.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let display_name = entry
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(id)
                .to_string();
            let model_ids = entry
                .get("models")
                .and_then(|models| models.as_object())
                .map(|models| models.keys().cloned().collect())
                .unwrap_or_default();
            providers.insert(
                id.to_string(),
                LiveProviderSummary {
                    id: id.to_string(),
                    display_name,
                    model_ids,
                },
            );
        }

        Ok(LiveProviderCatalog {
            connected,
            providers,
        })
    }

    async fn get_json(&self, path: &str) -> Result<Value, OpenCodeSettingsError> {
        let url = self.url(path);
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| OpenCodeSettingsError::Http(e.to_string()))?;
        self.json_response(resp).await
    }

    async fn post_json(&self, path: &str, body: Value) -> Result<Value, OpenCodeSettingsError> {
        let url = self.url(path);
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| OpenCodeSettingsError::Http(e.to_string()))?;
        self.json_response(resp).await
    }

    async fn json_response(&self, resp: reqwest::Response) -> Result<Value, OpenCodeSettingsError> {
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| OpenCodeSettingsError::Http(e.to_string()))?;
        if !status.is_success() {
            return Err(OpenCodeSettingsError::Api {
                status: status.as_u16(),
                detail: text,
            });
        }
        serde_json::from_str(&text).map_err(|e| OpenCodeSettingsError::Http(e.to_string()))
    }

    fn url(&self, path: &str) -> String {
        format!(
            "{}{}?directory={}",
            self.base_url,
            path,
            urlencoding::encode(&self.directory)
        )
    }
}


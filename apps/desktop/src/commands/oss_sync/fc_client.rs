//! FC Sync API client — reqwest-based HTTP client with JWT injection
//! and FC error code mapping.
//!
//! All endpoints use `Authorization: Bearer <supabase-jwt>`.
//! FC custom PostgreSQL error codes:
//!   P0409 → SyncError::Conflict
//!   P0403 → SyncError::Auth
//!   P0410 → SyncError::SessionExpired
//!
//! The blob-transfer and version-history methods (manifest, upload_prepare,
//! put_blob, upload_complete, download, get_blob, delete_file, list_versions)
//! were removed when the daemon took over team sync. What remains is the
//! team-provisioning / sync-mode / generic JSON surface that team-share
//! onboarding and LiteLLM provisioning still call.

use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;

use super::error::SyncError;

/// Per-request timeout for all FC calls. Without this, `reqwest::Client::new()`
/// has **no** request timeout: a Cloud API host that accepts the connection but
/// never responds (e.g. a misconfigured/diverged `cloudApiUrl`, a black-holed
/// LB, or a stalled TLS peer) makes `get_json`/`post` hang forever. That in turn
/// leaves callers — e.g. the Settings → Team Shared pane's `team_share_get_status`
/// — stuck on "Loading team share status…" indefinitely, because the awaiting
/// promise neither resolves nor rejects. A bounded timeout turns that stall into
/// a surfaced error the UI can catch and retry from.
const FC_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Cap on establishing the TCP/TLS connection, so an unreachable host fails fast
/// instead of waiting out the full request timeout.
const FC_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Result of POST /v1/teams.
///
/// The Cloud API response shape: `{ id, name, slug, createdAt, aiGatewayEndpoint, litellmKey }`.
/// `aiGatewayEndpoint` and `litellmKey` are nullable when LiteLLM provisioning
/// is skipped (e.g. local dev with LITELLM_MASTER_KEY unset).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTeamResult {
    #[serde(rename = "id")]
    pub team_id: String,
    #[serde(rename = "slug")]
    pub team_slug: String,
    #[serde(default)]
    pub ai_gateway_endpoint: Option<String>,
    #[serde(default)]
    pub litellm_key: Option<String>,
}

pub struct FcClient {
    pub client: Client,
    pub base_url: String,
    pub jwt: String,
}

impl FcClient {
    pub fn new(base_url: String, jwt: String) -> Self {
        // Force HTTP/1.1 and rustls — mirrors the daemon Cloud API client.
        // reqwest 0.12+ is required: 0.11 fails TLS to some SGW-fronted hosts
        // with "error trying to connect: bad protocol version". HTTP/1.1 also
        // avoids FC idle HTTP/2 stream reuse bugs after ~60 s. `build()` only
        // fails on a fatal TLS/runtime misconfig; fall back to the un-timed
        // default rather than panic.
        let client = Client::builder()
            .http1_only()
            .use_rustls_tls()
            .timeout(FC_REQUEST_TIMEOUT)
            .connect_timeout(FC_CONNECT_TIMEOUT)
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            base_url,
            jwt,
        }
    }

    /// POST /v1/teams — unified team creation. Provisions LiteLLM team + key
    /// server-side and seeds team_workspace_config in one call. The legacy
    /// `/sync/create-team` endpoint was removed in 2026-05.
    ///
    /// `node_id` is accepted for backward compatibility with the previous
    /// signature but is no longer forwarded — the /v1/teams handler derives
    /// the owning actor's node from the JWT-authenticated user.
    pub async fn create_team(
        &self,
        team_name: &str,
        _node_id: Option<&str>,
    ) -> Result<CreateTeamResult, SyncError> {
        let body = serde_json::json!({ "name": team_name });
        let resp = self.post("/v1/teams", &body).await?;
        Ok(resp)
    }

    /// POST /sync/set-mode — owner-only sync_mode switch (Tranche 5).
    pub async fn set_team_sync_mode(&self, team_id: &str, mode: &str) -> Result<String, SyncError> {
        let body = serde_json::json!({ "teamId": team_id, "mode": mode });
        #[derive(serde::Deserialize)]
        struct ModeResp {
            mode: String,
        }
        let resp: ModeResp = self.post("/sync/set-mode", &body).await?;
        Ok(resp.mode)
    }

    /// POST /sync/team-mode — read sync_mode (Tranche 5).
    pub async fn get_team_sync_mode(&self, team_id: &str) -> Result<Option<String>, SyncError> {
        let body = serde_json::json!({ "teamId": team_id });
        #[derive(serde::Deserialize)]
        struct ModeResp {
            mode: Option<String>,
        }
        let resp: ModeResp = self.post("/sync/team-mode", &body).await?;
        Ok(resp.mode)
    }

    /// Generic POST helper for ad-hoc endpoints (e.g. team_share enable flow).
    /// Returns the raw JSON value on 2xx; surfaces FC error envelope on non-2xx.
    pub async fn post_json(&self, path: &str, body: &Value) -> Result<Value, SyncError> {
        self.post(path, body).await
    }

    /// Generic DELETE helper. Returns raw JSON value on 2xx.
    pub async fn delete_json(&self, path: &str) -> Result<Value, SyncError> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .client
            .delete(&url)
            .header("Authorization", format!("Bearer {}", self.jwt))
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        map_fc_response(resp).await
    }

    /// Generic GET helper. Returns raw JSON value on 2xx.
    pub async fn get_json(&self, path: &str) -> Result<Value, SyncError> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.jwt))
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        map_fc_response(resp).await
    }

    /// Internal POST helper with JWT injection and error mapping.
    async fn post<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &Value,
    ) -> Result<T, SyncError> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.jwt))
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        map_fc_response(resp).await
    }
}

/// Extract a human-readable message from the Cloud API error envelope.
/// FC returns `{ error: { code, message, requestId, details? } }` (not a bare string).
fn fc_api_error_message(body: &Value) -> String {
    if let Some(obj) = body.get("error").and_then(|v| v.as_object()) {
        let msg = obj.get("message").and_then(|v| v.as_str()).unwrap_or("");
        let code = obj.get("code").and_then(|v| v.as_str()).unwrap_or("");
        let upstream = obj
            .get("details")
            .and_then(|d| d.get("upstreamCode"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mut parts = Vec::new();
        if !msg.is_empty() {
            parts.push(msg.to_string());
        }
        if !code.is_empty() {
            parts.push(format!("code={code}"));
        }
        if !upstream.is_empty() {
            parts.push(format!("upstream={upstream}"));
        }
        if !parts.is_empty() {
            return parts.join("; ");
        }
    }
    if let Some(s) = body.get("error").and_then(|v| v.as_str()) {
        return s.to_string();
    }
    if let Some(s) = body.as_str() {
        return s.to_string();
    }
    serde_json::to_string(body).unwrap_or_else(|_| "<unparseable error body>".to_string())
}

/// Map an HTTP response to `T` or `SyncError`, handling FC custom error codes.
async fn map_fc_response<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
) -> Result<T, SyncError> {
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;

    if status.is_success() {
        serde_json::from_slice(&bytes)
            .map_err(|e| SyncError::Internal(format!("response parse failed: {e}")))
    } else {
        // Legacy /sync/* envelope uses top-level `code`; /v1 uses nested `error.code`.
        let body: Value = serde_json::from_slice(&bytes).unwrap_or_default();
        let code = body["code"]
            .as_str()
            .or_else(|| body["error"]["code"].as_str())
            .unwrap_or("");
        let reason = body["reason"].as_str().unwrap_or("");

        // 409 CAS mismatch
        if status.as_u16() == 409 || code == "P0409" || reason == "cas-mismatch" {
            let remote_version = body["remoteVersion"].as_i64().map(|v| v as i32);
            let remote_cipher_hash = body["remoteHash"].as_str().map(|s| s.to_string());
            return Err(SyncError::Conflict {
                remote_version,
                remote_cipher_hash,
            });
        }

        // Auth errors
        if status.as_u16() == 403 || code == "P0403" {
            return Err(SyncError::Auth(fc_api_error_message(&body)));
        }

        // Session expired / gone
        if status.as_u16() == 410 || code == "P0410" {
            return Err(SyncError::SessionExpired(fc_api_error_message(&body)));
        }

        // Path validation
        if status.as_u16() == 422 {
            return Err(SyncError::InvalidPath(fc_api_error_message(&body)));
        }

        let detail = fc_api_error_message(&body);
        Err(SyncError::Internal(format!(
            "FC returned HTTP {}: {}",
            status,
            if detail.is_empty() {
                "<no error message>".to_string()
            } else {
                detail
            }
        )))
    }
}

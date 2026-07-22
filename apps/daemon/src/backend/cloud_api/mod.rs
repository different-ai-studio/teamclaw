mod client;
mod gateway;
mod messages;

use super::{
    AgentDefaults, AgentRuntimeRow, AgentRuntimeUpsert, Backend, BackendError, BackendResult,
    BackendSessionAndParticipants, BootstrapMqttOverride, ClaimResult, CloudAuthSnapshot,
    ManagedGitCredential, ManagedLlmConfig, ManagedLlmModelInfo, ShareModeConfig, StoredMessage,
    WorkspaceRow, WorkspaceUpsert,
};
use crate::provider_config::CloudApiConfig;
use async_trait::async_trait;
use client::{
    cloud_url, decode_response, network_error, refresh_failure_message, request_id, RefreshRequest,
    TokenResponse,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Shared cloud-auth health flag, cloned across every `CloudApiBackend` clone so
/// the HTTP layer observes the same state as the refresh path. Set when a token
/// refresh is rejected with a terminal status (the stored refresh token is dead
/// and re-onboarding is required); cleared on the next successful refresh.
#[derive(Debug, Default)]
struct CloudAuthHealth {
    terminal_failure: AtomicBool,
}

impl CloudAuthHealth {
    fn mark_terminal(&self) {
        self.terminal_failure.store(true, Ordering::Relaxed);
    }

    fn clear(&self) {
        self.terminal_failure.store(false, Ordering::Relaxed);
    }

    fn snapshot(&self) -> CloudAuthSnapshot {
        CloudAuthSnapshot {
            terminal_failure: self.terminal_failure.load(Ordering::Relaxed),
        }
    }
}

/// True when a `/v1/auth/refresh` HTTP status means the refresh token itself is
/// permanently rejected (so re-onboarding is the only recovery), as opposed to a
/// transient server/network hiccup. GoTrue/FC answer a dead or unknown refresh
/// token with 400/401 (`refresh_token_not_found`, `invalid_grant`); 5xx and 429
/// are transient and must NOT latch the terminal flag.
fn is_terminal_refresh_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::BAD_REQUEST
}

#[derive(Debug, Deserialize)]
struct BootstrapResponse {
    #[serde(default)]
    mqtt: Option<BootstrapMqttPayload>,
}

#[derive(Debug, Deserialize)]
struct BootstrapMqttPayload {
    url: String,
    /// Legacy raw-TCP broker address (`mqtt://host:port`). Clients now support
    /// MQTT-over-WebSocket directly, so the canonical public `url` wins.
    #[serde(default, rename = "tcpUrl")]
    tcp_url: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

impl BootstrapMqttPayload {
    /// `url` is the canonical public endpoint. It can be raw MQTT or
    /// MQTT-over-WebSocket; `tcpUrl` remains a backwards-compatible fallback.
    fn broker_url(self) -> String {
        if self.url.trim().is_empty() {
            self.tcp_url.unwrap_or_default()
        } else {
            self.url
        }
    }
}

/// Wire shape of `GET /v1/teams/:id/share-mode`. The FC handler returns
/// `{ mode, enabledAt, gitRemoteUrl, gitAuthKind }` (see
/// `services/fc/src/lib/pg-repo/teams.ts::getShareMode` and the Supabase repo
/// equivalent). `enabledAt` is ignored — the daemon only needs the sync config.
/// The endpoint does not return a git branch.
#[derive(Debug, Deserialize)]
struct ShareModeResponse {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default, rename = "gitRemoteUrl")]
    git_remote_url: Option<String>,
    #[serde(default, rename = "gitAuthKind")]
    git_auth_kind: Option<String>,
}

impl From<ShareModeResponse> for ShareModeConfig {
    fn from(r: ShareModeResponse) -> Self {
        // `mode: null` ⇒ team-share not enabled ⇒ no usable git config; collapse
        // to the all-`None` default regardless of any stray git fields.
        if r.mode.is_none() {
            return ShareModeConfig::default();
        }
        ShareModeConfig {
            mode: r.mode,
            git_remote_url: r.git_remote_url,
            // The share-mode endpoint does not surface a branch (see
            // `ShareModeConfig`); always `None` here.
            git_branch: None,
            git_auth_kind: r.git_auth_kind,
        }
    }
}

/// Access token must be refreshed this long before its `expires_at` so an
/// in-flight request never races the expiry boundary.
const ACCESS_TOKEN_LEEWAY: Duration = Duration::from_secs(60);

/// Mutable token state shared across all clones of a `CloudApiBackend`.
///
/// Held only for brief, synchronous critical sections — never across an
/// `.await`. The network refresh itself is serialized by `refresh_lock`.
struct TokenState {
    /// The live refresh token. Seeded from `backend.toml`, then updated in place
    /// every time Supabase rotates it.
    refresh_token: String,
    /// The most recently fetched access token, if any.
    access_token: Option<String>,
    /// JWT expiry as epoch seconds (wall clock). Must not use `Instant` — macOS
    /// suspends the monotonic clock during sleep while JWT expiry is wall-clock.
    expires_at_epoch: Option<i64>,
}

#[derive(Clone)]
pub struct CloudApiBackend {
    pub(super) cfg: CloudApiConfig,
    pub(super) http: reqwest::Client,
    /// Cached token + live refresh token. Shared across clones via `Arc`.
    token: Arc<Mutex<TokenState>>,
    /// Single-flight gate: ensures only one refresh hits the network at a time
    /// so concurrent requests can't submit the same (rotating) refresh token in
    /// parallel and trip Supabase's reuse detection.
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
    /// Where to persist a rotated refresh token (`~/.amuxd/backend.toml`).
    /// `None` in tests that don't exercise persistence.
    persist_path: Option<PathBuf>,
    /// Cloud-auth health, shared across clones. Latched when a refresh is
    /// rejected with a terminal status; surfaced via `cloud_auth_health()`.
    auth_health: Arc<CloudAuthHealth>,
}

impl CloudApiBackend {
    pub fn new(cfg: CloudApiConfig) -> Self {
        Self::with_optional_persist(cfg, None)
    }

    /// Construct a backend that persists rotated refresh tokens back to
    /// `persist_path` (the `backend.toml` it was loaded from).
    pub fn with_persist_path(cfg: CloudApiConfig, persist_path: PathBuf) -> Self {
        Self::with_optional_persist(cfg, Some(persist_path))
    }

    fn with_optional_persist(cfg: CloudApiConfig, persist_path: Option<PathBuf>) -> Self {
        let refresh_token = cfg.refresh_token.clone();
        // Force HTTP/1.1: Alibaba Cloud Function Compute (FC) closes idle
        // HTTP/2 streams after ~60 s, causing the next request on the same
        // connection to fail with "error sending request".  HTTP/1.1 keeps
        // each request on its own connection and avoids the silent reuse bug.
        let http = reqwest::Client::builder()
            .http1_only()
            // Bound every cloud call so one black-holed request can't wedge the
            // shared client (and, via `refresh_lock`, every daemon-wide call).
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self {
            cfg,
            http,
            token: Arc::new(Mutex::new(TokenState {
                refresh_token,
                access_token: None,
                expires_at_epoch: None,
            })),
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            persist_path,
            auth_health: Arc::new(CloudAuthHealth::default()),
        }
    }

    /// Return a valid access token, refreshing only when the cached one is
    /// missing or within `ACCESS_TOKEN_LEEWAY` of expiry.
    pub(super) async fn access_token(&self) -> BackendResult<String> {
        // Fast path: a cached token with comfortable headroom.
        if let Some(token) = self.cached_access_token() {
            return Ok(token);
        }

        // Slow path: serialize refreshes so concurrent callers don't each submit
        // the (about-to-rotate) refresh token in parallel.
        let _guard = self.refresh_lock.lock().await;

        // Re-check: another task may have refreshed while we waited on the gate.
        if let Some(token) = self.cached_access_token() {
            return Ok(token);
        }

        let refresh_token = {
            let state = self.token.lock().expect("token state poisoned");
            state.refresh_token.clone()
        };

        let url = format!("{}/v1/auth/refresh", self.cfg.url.trim_end_matches('/'));
        // Belt-and-suspenders: even if the client-level timeout is ever removed,
        // wrap the refresh network call so `refresh_lock` is guaranteed to be
        // released and one stalled refresh can't wedge every cloud call.
        let send_fut = self
            .http
            .post(url)
            .json(&RefreshRequest {
                refresh_token: &refresh_token,
            })
            .send();
        let resp = tokio::time::timeout(Duration::from_secs(30), send_fut)
            .await
            .map_err(|_| BackendError::Provider {
                provider: "cloud_api",
                code: None,
                message: "token refresh timed out".to_string(),
            })?
            .map_err(network_error)?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            // Latch a terminal-auth flag only when the refresh token itself is
            // rejected (400/401). The daemon keeps retrying, but the desktop can
            // now observe the dead session via `/v1/info` and auto re-onboard.
            if is_terminal_refresh_status(status) {
                self.auth_health.mark_terminal();
            }
            return Err(BackendError::Auth(refresh_failure_message(&text)));
        }

        let body: TokenResponse = resp.json().await.map_err(network_error)?;

        // Capture the rotated refresh token. Supabase revokes the prior token
        // after the reuse interval, so we must keep (and persist) the new one.
        let rotated = match body.refresh_token {
            Some(ref new_rt) if !new_rt.is_empty() && *new_rt != refresh_token => {
                Some(new_rt.clone())
            }
            _ => None,
        };

        {
            let mut state = self.token.lock().expect("token state poisoned");
            state.access_token = Some(body.access_token.clone());
            state.expires_at_epoch = body.expires_at;
            if let Some(ref new_rt) = rotated {
                state.refresh_token = new_rt.clone();
            }
        }

        if let Some(new_rt) = rotated {
            self.persist_refresh_token(&new_rt);
        }

        // A successful refresh clears any prior terminal-auth latch (e.g. after
        // the desktop re-onboards the daemon with fresh credentials).
        self.auth_health.clear();

        Ok(body.access_token)
    }

    /// The cached access token if it is still comfortably valid, else `None`.
    fn cached_access_token(&self) -> Option<String> {
        let state = self.token.lock().expect("token state poisoned");
        match (&state.access_token, state.expires_at_epoch) {
            (Some(token), Some(expires_at)) => {
                let now = super::epoch_secs_now();
                if (now + ACCESS_TOKEN_LEEWAY.as_secs() as i64) < expires_at {
                    Some(token.clone())
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    /// Best-effort write of a rotated refresh token back to `backend.toml`.
    /// Failure is logged but non-fatal — the in-memory token is still updated,
    /// so the running daemon keeps working; only a restart would lose it.
    fn persist_refresh_token(&self, refresh_token: &str) {
        let Some(path) = self.persist_path.as_ref() else {
            return;
        };
        // Never recreate a file removed by `amuxd clear`, and never let a
        // still-running stale process overwrite credentials written by a later
        // `amuxd init`. Only the process whose routing identity still matches
        // the current file is allowed to rotate that file's token.
        if !path.exists() {
            tracing::warn!(
                path = %path.display(),
                "skipping rotated refresh_token persistence because backend.toml was removed"
            );
            return;
        }
        let mut cfg = match crate::provider_config::ProviderConfig::load_from_path(path) {
            Ok(crate::provider_config::ProviderConfig::CloudApi(cfg)) => cfg,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    path = %path.display(),
                    "skipping rotated refresh_token persistence because backend.toml is unreadable"
                );
                return;
            }
        };
        if cfg.url != self.cfg.url
            || cfg.team_id != self.cfg.team_id
            || cfg.actor_id != self.cfg.actor_id
        {
            tracing::warn!(
                path = %path.display(),
                running_team_id = %self.cfg.team_id,
                running_actor_id = %self.cfg.actor_id,
                disk_team_id = %cfg.team_id,
                disk_actor_id = %cfg.actor_id,
                "skipping rotated refresh_token persistence because daemon identity was rebound"
            );
            return;
        }
        cfg.refresh_token = refresh_token.to_string();
        if let Err(e) = crate::provider_config::ProviderConfig::save_cloud_api(path, &cfg) {
            tracing::warn!(
                error = %e,
                path = %path.display(),
                "failed to persist rotated refresh_token; auth may break after restart"
            );
        }
    }

    /// Drop only the cached access token. The refresh token is unchanged.
    fn invalidate_access_token_cache(&self) {
        let mut state = self.token.lock().expect("token state poisoned");
        state.access_token = None;
        state.expires_at_epoch = None;
    }

    pub(super) async fn get<T>(&self, path: &str) -> BackendResult<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        for is_retry in [false, true] {
            let token = self.access_token().await?;
            let resp = self
                .http
                .get(self.cloud_url(path))
                .bearer_auth(token)
                .header("x-request-id", request_id())
                .send()
                .await
                .map_err(network_error)?;
            match decode_response(resp).await {
                Err(BackendError::Auth(_)) if !is_retry => {
                    tracing::debug!(
                        path,
                        "cloud_api: 401 unauthorized, invalidating cached access token and retrying once"
                    );
                    self.invalidate_access_token_cache();
                }
                result => return result,
            }
        }
        unreachable!("cloud_api get retry loop exhausted")
    }

    pub(super) async fn post<Req, Resp>(
        &self,
        path: &str,
        body: &Req,
        idempotency_key: Option<&str>,
    ) -> BackendResult<Resp>
    where
        Req: Serialize + ?Sized,
        Resp: for<'de> Deserialize<'de>,
    {
        for is_retry in [false, true] {
            let token = self.access_token().await?;
            let mut req = self
                .http
                .post(self.cloud_url(path))
                .bearer_auth(token)
                .header("x-request-id", request_id())
                .json(body);
            if let Some(key) = idempotency_key {
                req = req.header("idempotency-key", key);
            }
            let resp = req.send().await.map_err(network_error)?;
            match decode_response(resp).await {
                Err(BackendError::Auth(_)) if !is_retry => {
                    tracing::debug!(
                        path,
                        "cloud_api: 401 unauthorized, invalidating cached access token and retrying once"
                    );
                    self.invalidate_access_token_cache();
                }
                result => return result,
            }
        }
        unreachable!("cloud_api post retry loop exhausted")
    }

    pub(super) async fn patch_no_content<Req>(&self, path: &str, body: &Req) -> BackendResult<()>
    where
        Req: Serialize + ?Sized,
    {
        for is_retry in [false, true] {
            let token = self.access_token().await?;
            let resp = self
                .http
                .patch(self.cloud_url(path))
                .bearer_auth(token)
                .header("x-request-id", request_id())
                .json(body)
                .send()
                .await
                .map_err(network_error)?;
            if resp.status().is_success() {
                return Ok(());
            }
            let status = resp.status();
            let bytes = resp.bytes().await.map_err(network_error)?;
            let envelope = serde_json::from_slice::<client::CloudErrorEnvelope>(&bytes).ok();
            match client::decode_error(status, envelope) {
                BackendError::Auth(_) if !is_retry => {
                    tracing::debug!(
                        path,
                        "cloud_api: 401 unauthorized, invalidating cached access token and retrying once"
                    );
                    self.invalidate_access_token_cache();
                }
                err => return Err(err),
            }
        }
        unreachable!("cloud_api patch retry loop exhausted")
    }

    pub(super) fn cloud_url(&self, path: &str) -> String {
        cloud_url(&self.cfg, path)
    }
}

#[async_trait]
impl Backend for CloudApiBackend {
    fn team_id(&self) -> &str {
        &self.cfg.team_id
    }

    fn actor_id(&self) -> &str {
        &self.cfg.actor_id
    }

    async fn auth_token(&self) -> BackendResult<String> {
        self.access_token().await
    }

    fn cloud_auth_health(&self) -> Option<CloudAuthSnapshot> {
        Some(self.auth_health.snapshot())
    }

    async fn fetch_bootstrap_mqtt(&self) -> BackendResult<Option<BootstrapMqttOverride>> {
        let payload: BootstrapResponse = self.get("/v1/config/bootstrap").await?;
        Ok(payload.mqtt.map(|m| BootstrapMqttOverride {
            username: m.username.clone(),
            password: m.password.clone(),
            url: m.broker_url(),
        }))
    }

    async fn team_share_config(&self, team_id: &str) -> BackendResult<ShareModeConfig> {
        let path = format!("/v1/teams/{team_id}/share-mode");
        match self.get::<ShareModeResponse>(&path).await {
            Ok(resp) => Ok(resp.into()),
            // A team that has never enabled team-share (404) is not an error —
            // it simply has no sync config yet.
            Err(BackendError::NotFound(_)) => Ok(ShareModeConfig::default()),
            Err(e) => Err(e),
        }
    }

    async fn managed_git_credential(&self, team_id: &str) -> BackendResult<ManagedGitCredential> {
        self.get(&format!("/v1/teams/{team_id}/managed-git-credential"))
            .await
    }

    async fn managed_llm_config(&self, team_id: &str) -> BackendResult<ManagedLlmConfig> {
        #[derive(serde::Deserialize)]
        struct ModelEntry {
            id: Option<String>,
            name: Option<String>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Llm {
            #[serde(default)]
            enabled: bool,
            #[serde(default)]
            base_url: Option<String>,
            #[serde(default)]
            ai_gateway_endpoint: Option<String>,
            #[serde(default)]
            models: Vec<ModelEntry>,
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            llm: Option<Llm>,
        }
        let path = format!("/v1/teams/{team_id}/workspace-config");
        let resp: Resp = match self.get::<Resp>(&path).await {
            Ok(r) => r,
            // A team that never enabled team-share (404) simply has no managed LLM.
            Err(BackendError::NotFound(_)) => return Ok(ManagedLlmConfig::default()),
            Err(e) => return Err(e),
        };
        let Some(llm) = resp.llm else {
            return Ok(ManagedLlmConfig::default());
        };
        let base_url = llm
            .base_url
            .filter(|s| !s.trim().is_empty())
            .or_else(|| llm.ai_gateway_endpoint.filter(|s| !s.trim().is_empty()));
        let models = llm
            .models
            .into_iter()
            .filter_map(|m| {
                let id = m.id.filter(|s| !s.trim().is_empty())?;
                let name = m
                    .name
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| id.clone());
                Some(ManagedLlmModelInfo { id, name })
            })
            .collect();
        Ok(ManagedLlmConfig {
            enabled: llm.enabled,
            base_url,
            name: None,
            models,
        })
    }

    async fn ensure_llm_member_key(&self, team_id: &str) -> BackendResult<()> {
        #[derive(serde::Serialize)]
        struct Empty {}
        #[derive(serde::Deserialize)]
        struct Resp {
            #[allow(dead_code)]
            key: Option<String>,
        }
        let path = format!("/v1/teams/{team_id}/litellm/member-key");
        let _: Resp = self.post(&path, &Empty {}, None).await?;
        Ok(())
    }

    async fn get_effective_default_agent(&self, team_id: &str) -> BackendResult<Option<String>> {
        #[derive(serde::Deserialize)]
        struct Resp {
            #[serde(rename = "defaultAgentId")]
            default_agent_id: Option<String>,
        }
        let path = format!("/v1/teams/{team_id}/members/me/effective-default-agent");
        let resp: Resp = self.get::<Resp>(&path).await?;
        Ok(resp.default_agent_id)
    }

    fn cloud_base_url(&self) -> Option<String> {
        Some(self.cfg.url.trim_end_matches('/').to_string())
    }

    fn cached_credential_expiry_epoch(&self) -> Option<i64> {
        self.token
            .lock()
            .expect("token state poisoned")
            .expires_at_epoch
    }

    fn invalidate_cached_credential(&self) {
        self.invalidate_access_token_cache();
    }

    async fn claim_team_invite(&self, token: &str) -> BackendResult<ClaimResult> {
        #[derive(serde::Serialize)]
        struct ClaimInviteRequest<'a> {
            token: &'a str,
        }
        #[derive(serde::Deserialize)]
        struct CloudClaimResult {
            #[serde(rename = "actorId")]
            actor_id: String,
            #[serde(rename = "teamId")]
            team_id: String,
            #[serde(rename = "actorType")]
            actor_type: String,
            #[serde(rename = "displayName")]
            display_name: String,
            #[serde(rename = "refreshToken")]
            refresh_token: Option<String>,
        }
        let row: CloudClaimResult = self
            .post("/v1/invites/claim", &ClaimInviteRequest { token }, None)
            .await?;
        Ok(ClaimResult {
            actor_id: row.actor_id,
            team_id: row.team_id,
            actor_type: row.actor_type,
            display_name: row.display_name,
            refresh_token: row.refresh_token,
        })
    }

    async fn upsert_agent_runtime(
        &self,
        row: &AgentRuntimeUpsert<'_>,
    ) -> BackendResult<Option<String>> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "agentActorId")]
            agent_actor_id: &'a str,
            #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
            session_id: Option<&'a str>,
            #[serde(rename = "runtimeId", skip_serializing_if = "Option::is_none")]
            runtime_id: Option<&'a str>,
            #[serde(rename = "backendSessionId", skip_serializing_if = "Option::is_none")]
            backend_session_id: Option<&'a str>,
            #[serde(rename = "backendType")]
            backend_type: &'a str,
            #[serde(rename = "workspaceId", skip_serializing_if = "Option::is_none")]
            workspace_id: Option<&'a str>,
            status: &'a str,
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            id: Option<String>,
        }
        let r: Resp = self
            .post(
                "/v1/agents/runtimes",
                &Body {
                    agent_actor_id: row.agent_id,
                    session_id: row.session_id,
                    runtime_id: row.runtime_id,
                    backend_session_id: row.backend_session_id,
                    backend_type: row.backend_type,
                    workspace_id: row.workspace_id,
                    status: row.status,
                },
                None,
            )
            .await?;
        Ok(r.id)
    }

    async fn fetch_agent_runtime_for_session(
        &self,
        session_id: &str,
        runtime_id: &str,
        backend_session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>> {
        let path = format!(
            "/v1/agents/runtimes?sessionId={session_id}&runtimeId={runtime_id}&backendSessionId={backend_session_id}"
        );
        match self.get::<CloudAgentRuntime>(&path).await {
            Ok(r) => Ok(Some(r.into_row())),
            Err(BackendError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn fetch_latest_runtime_for_session(
        &self,
        agent_id: &str,
        session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>> {
        let path = format!("/v1/agents/runtimes/latest?agentId={agent_id}&sessionId={session_id}");
        match self.get::<CloudAgentRuntime>(&path).await {
            Ok(r) => Ok(Some(r.into_row())),
            Err(BackendError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn ensure_agent_types(
        &self,
        supported_types: &[String],
        default_agent_type: &str,
    ) -> BackendResult<()> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "supportedTypes")]
            supported_types: &'a [String],
            #[serde(rename = "defaultAgentType")]
            default_agent_type: &'a str,
        }
        let token = self.access_token().await?;
        let resp = self
            .http
            .post(self.cloud_url("/v1/agents/types/ensure"))
            .bearer_auth(token)
            .header("x-request-id", request_id())
            .json(&Body {
                supported_types,
                default_agent_type,
            })
            .send()
            .await
            .map_err(network_error)?;
        if resp.status().is_success() {
            Ok(())
        } else {
            let status = resp.status();
            let bytes = resp.bytes().await.map_err(network_error)?;
            let envelope = serde_json::from_slice::<client::CloudErrorEnvelope>(&bytes).ok();
            Err(client::decode_error(status, envelope))
        }
    }

    async fn check_agent_permission(
        &self,
        agent_id: &str,
        actor_id: &str,
    ) -> BackendResult<Option<String>> {
        #[derive(serde::Deserialize)]
        struct Resp {
            allowed: bool,
            role: Option<String>,
        }
        let r: Resp = self
            .get(&format!(
                "/v1/agents/{agent_id}/permission?actorId={actor_id}"
            ))
            .await?;
        Ok(if r.allowed { r.role } else { None })
    }

    async fn report_client_version(&self, device_id: &str) -> BackendResult<()> {
        #[derive(serde::Serialize)]
        struct ClientVersionReq<'a> {
            #[serde(rename = "clientType")]
            client_type: &'a str,
            version: &'a str,
            #[serde(rename = "deviceId")]
            device_id: &'a str,
        }
        #[derive(serde::Deserialize)]
        struct ClientVersionAck {
            #[allow(dead_code)]
            ok: Option<bool>,
        }
        let req = ClientVersionReq {
            client_type: "daemon",
            version: env!("CARGO_PKG_VERSION"),
            device_id,
        };
        let path = format!("/v1/teams/{}/client-version", self.cfg.team_id);
        let _: ClientVersionAck = self.post(&path, &req, None).await?;
        Ok(())
    }

    async fn heartbeat(&self) -> BackendResult<()> {
        let token = self.access_token().await?;
        let resp = self
            .http
            .post(self.cloud_url("/v1/heartbeat"))
            .bearer_auth(token)
            .header("x-request-id", request_id())
            .send()
            .await
            .map_err(network_error)?;
        if resp.status().is_success() {
            Ok(())
        } else {
            let status = resp.status();
            let bytes = resp.bytes().await.map_err(network_error)?;
            let envelope = serde_json::from_slice::<client::CloudErrorEnvelope>(&bytes).ok();
            Err(client::decode_error(status, envelope))
        }
    }

    async fn set_agent_default_workspace(&self, workspace_id: &str) -> BackendResult<()> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "defaultWorkspaceId")]
            default_workspace_id: &'a str,
        }
        self.patch_no_content(
            &format!("/v1/agents/{}/defaults", self.cfg.actor_id),
            &Body {
                default_workspace_id: workspace_id,
            },
        )
        .await
    }

    async fn upsert_workspace(&self, row: &WorkspaceUpsert<'_>) -> BackendResult<WorkspaceRow> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(skip_serializing_if = "Option::is_none")]
            id: Option<&'a str>,
            #[serde(rename = "teamId")]
            team_id: &'a str,
            #[serde(rename = "agentId")]
            agent_id: &'a str,
            name: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            path: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            slug: Option<&'a str>,
            archived: bool,
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            id: String,
            #[serde(default)]
            path: Option<String>,
            #[serde(default)]
            slug: Option<String>,
        }
        let body = Body {
            id: row.cloud_id,
            team_id: row.team_id,
            agent_id: row.agent_id,
            name: row.name,
            path: row.path,
            slug: row.path,
            archived: row.archived,
        };
        let r: Resp = self.post("/v1/workspaces", &body, None).await?;
        Ok(WorkspaceRow {
            id: r.id,
            team_id: row.team_id.to_string(),
            path: r.path.or(r.slug),
        })
    }

    async fn get_workspaces_by_team(&self, team_id: &str) -> BackendResult<Vec<WorkspaceRow>> {
        #[derive(serde::Deserialize)]
        struct Item {
            id: String,
            #[serde(rename = "teamId")]
            team_id: String,
            #[serde(default)]
            path: Option<String>,
            #[serde(default)]
            slug: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Page {
            items: Vec<Item>,
            #[serde(rename = "nextCursor", default)]
            next_cursor: Option<String>,
        }
        let mut rows = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut path = format!(
                "/v1/workspaces?teamId={}&limit=200",
                urlencoding::encode(team_id)
            );
            if let Some(c) = &cursor {
                path.push_str(&format!("&cursor={}", urlencoding::encode(c)));
            }
            let page: Page = self.get(&path).await?;
            let done = page.next_cursor.is_none();
            rows.extend(page.items.into_iter().map(|item| WorkspaceRow {
                id: item.id,
                team_id: item.team_id,
                path: item.path.or(item.slug),
            }));
            if done {
                break;
            }
            cursor = page.next_cursor;
        }
        Ok(rows)
    }

    async fn get_workspaces_by_ids(&self, ids: &[String]) -> BackendResult<Vec<WorkspaceRow>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "teamId")]
            team_id: &'a str,
            ids: &'a [String],
        }
        #[derive(serde::Deserialize)]
        struct Item {
            id: String,
            #[serde(default)]
            path: Option<String>,
            #[serde(default)]
            slug: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            items: Vec<Item>,
        }
        let body = Body {
            team_id: &self.cfg.team_id,
            ids,
        };
        let r: Resp = self.post("/v1/workspaces/by-ids", &body, None).await?;
        Ok(r.items
            .into_iter()
            .map(|item| WorkspaceRow {
                id: item.id,
                team_id: self.cfg.team_id.clone(),
                path: item.path.or(item.slug),
            })
            .collect())
    }

    async fn fetch_session_with_participants(
        &self,
        session_id: &str,
    ) -> BackendResult<BackendSessionAndParticipants> {
        use super::records::{BackendParticipantRow, BackendSessionRow};
        use chrono::{DateTime, Utc};
        #[derive(serde::Deserialize)]
        struct CloudParticipant {
            #[serde(rename = "actorId")]
            actor_id: String,
            #[serde(default)]
            role: Option<String>,
            #[serde(rename = "joinedAt")]
            joined_at: Option<DateTime<Utc>>,
        }
        #[derive(serde::Deserialize)]
        struct CloudSession {
            id: String,
            #[serde(rename = "teamId")]
            team_id: String,
            #[serde(default)]
            title: String,
            #[serde(default)]
            mode: String,
            #[serde(rename = "ideaId", default)]
            idea_id: Option<String>,
            #[serde(rename = "createdAt")]
            created_at: Option<DateTime<Utc>>,
            #[serde(default)]
            participants: Vec<CloudParticipant>,
        }
        let s: CloudSession = self.get(&format!("/v1/sessions/{session_id}")).await?;
        let session_id_str = s.id.clone();
        let session = BackendSessionRow {
            id: s.id,
            team_id: s.team_id,
            created_by_actor_id: None,
            primary_agent_id: None,
            mode: s.mode,
            title: s.title,
            summary: String::new(),
            idea_id: s.idea_id,
            created_at: s.created_at.unwrap_or_else(Utc::now),
        };
        let participants = s
            .participants
            .into_iter()
            .map(|p| BackendParticipantRow {
                session_id: session_id_str.clone(),
                actor_id: p.actor_id,
                role: p.role,
                joined_at: p.joined_at.unwrap_or_else(Utc::now),
            })
            .collect();
        Ok(BackendSessionAndParticipants {
            session,
            participants,
        })
    }

    async fn messages_after_cursor(
        &self,
        session_id: &str,
        after_id: Option<&str>,
    ) -> BackendResult<Vec<StoredMessage>> {
        self.messages_after_cursor_impl(session_id, after_id).await
    }

    async fn update_runtime_cursor(
        &self,
        runtime_row_id: &str,
        last_processed_message_id: &str,
    ) -> BackendResult<()> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "lastProcessedMessageId")]
            last_processed_message_id: &'a str,
        }
        self.patch_no_content(
            &format!("/v1/agents/runtimes/{runtime_row_id}/cursor"),
            &Body {
                last_processed_message_id,
            },
        )
        .await
    }

    async fn rpc_upsert_external_actor(
        &self,
        team_id: &str,
        source: &str,
        source_id: &str,
        display_name: &str,
    ) -> BackendResult<String> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "teamId")]
            team_id: &'a str,
            source: &'a str,
            #[serde(rename = "sourceId")]
            source_id: &'a str,
            #[serde(rename = "displayName")]
            display_name: &'a str,
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            #[serde(rename = "actorId")]
            actor_id: String,
        }
        let r: Resp = self
            .post(
                "/v1/actors/external",
                &Body {
                    team_id,
                    source,
                    source_id,
                    display_name,
                },
                None,
            )
            .await?;
        Ok(r.actor_id)
    }

    async fn get_gateway_session_by_acp_id(
        &self,
        acp_session_id: &str,
    ) -> BackendResult<Option<(String, Option<String>)>> {
        #[derive(serde::Deserialize)]
        struct Resp {
            #[serde(rename = "sessionId")]
            session_id: String,
            #[serde(rename = "gatewaySessionId")]
            gateway_session_id: Option<String>,
        }
        match self
            .get::<Resp>(&format!("/v1/sessions/by-acp/{acp_session_id}"))
            .await
        {
            Ok(r) => Ok(Some((r.session_id, r.gateway_session_id))),
            Err(BackendError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn rpc_ensure_gateway_session(
        &self,
        team_id: &str,
        binding: &str,
        title: &str,
        primary_agent_actor_id: &str,
        owner_member_actor_ids: &[String],
        participant_actor_ids: &[String],
    ) -> BackendResult<(String, String, bool)> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "teamId")]
            team_id: &'a str,
            binding: &'a str,
            title: &'a str,
            #[serde(rename = "primaryAgentActorId")]
            primary_agent_actor_id: &'a str,
            #[serde(rename = "ownerMemberActorIds")]
            owner_member_actor_ids: &'a [String],
            #[serde(rename = "participantActorIds")]
            participant_actor_ids: &'a [String],
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            #[serde(rename = "sessionId")]
            session_id: String,
            #[serde(rename = "gatewaySessionId")]
            gateway_session_id: String,
            created: bool,
        }
        let r: Resp = self
            .post(
                "/v1/sessions/gateway/ensure",
                &Body {
                    team_id,
                    binding,
                    title,
                    primary_agent_actor_id,
                    owner_member_actor_ids,
                    participant_actor_ids,
                },
                None,
            )
            .await?;
        Ok((r.session_id, r.gateway_session_id, r.created))
    }

    async fn insert_gateway_message(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        self.insert_gateway_message_impl(session_id, sender_actor_id, content, external_message_id)
            .await
    }

    async fn insert_gateway_agent_reply(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        self.insert_gateway_agent_reply_impl(
            session_id,
            sender_actor_id,
            content,
            external_message_id,
        )
        .await
    }

    async fn insert_gateway_message_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: serde_json::Value,
    ) -> BackendResult<String> {
        self.insert_gateway_message_with_attachments_impl(
            session_id,
            sender_actor_id,
            content,
            external_message_id,
            attachments,
        )
        .await
    }

    async fn upload_attachment_bytes(
        &self,
        path: &str,
        bytes: Vec<u8>,
        mime: &str,
    ) -> BackendResult<String> {
        let token = self.access_token().await?;
        let encoded_path: String = url::form_urlencoded::byte_serialize(path.as_bytes()).collect();
        let url = format!(
            "{}/v1/attachments?path={}",
            self.cfg.url.trim_end_matches('/'),
            encoded_path
        );
        let resp = self
            .http
            .post(url)
            .bearer_auth(token)
            .header("content-type", mime)
            .header("x-request-id", request_id())
            .body(bytes)
            .send()
            .await
            .map_err(network_error)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body_bytes = resp.bytes().await.map_err(network_error)?;
            let envelope = serde_json::from_slice::<client::CloudErrorEnvelope>(&body_bytes).ok();
            return Err(client::decode_error(status, envelope));
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            url: String,
        }
        let r: Resp = resp.json().await.map_err(network_error)?;
        Ok(r.url)
    }

    async fn list_agent_admin_member_actor_ids(
        &self,
        agent_actor_id: &str,
    ) -> BackendResult<Vec<String>> {
        #[derive(serde::Deserialize)]
        struct Resp {
            items: Vec<String>,
        }
        let r: Resp = self
            .get(&format!("/v1/agents/{agent_actor_id}/admin-members"))
            .await?;
        Ok(r.items)
    }

    async fn get_agent_defaults(&self, agent_id: &str) -> BackendResult<AgentDefaults> {
        #[derive(serde::Deserialize)]
        struct Item {
            id: String,
            #[serde(rename = "defaultAgentType")]
            default_agent_type: Option<String>,
            #[serde(rename = "defaultWorkspaceId")]
            default_workspace_id: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            items: Vec<Item>,
        }
        let r: Resp = self
            .get(&format!("/v1/runtime/agent-defaults?agentId={agent_id}"))
            .await?;
        // The endpoint echoes back one item per requested id; pick the one that
        // matches (defensively — we only ever ask for our own id).
        let item = r
            .items
            .into_iter()
            .find(|i| i.id == agent_id)
            .unwrap_or_else(|| Item {
                id: agent_id.to_string(),
                default_agent_type: None,
                default_workspace_id: None,
            });
        Ok(AgentDefaults {
            default_agent_type: item.default_agent_type,
            default_workspace_id: item.default_workspace_id,
        })
    }

    async fn update_session_title(&self, session_id: &str, title: &str) -> BackendResult<()> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            title: &'a str,
        }
        let url = self.cloud_url(&format!("/v1/sessions/{session_id}"));
        let result = self
            .patch_no_content(&format!("/v1/sessions/{session_id}"), &Body { title })
            .await;
        tracing::info!(
            session_id,
            title,
            url = %url,
            ok = result.is_ok(),
            "update_session_title PATCH result"
        );
        result
    }

    async fn upsert_session_participant(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> BackendResult<()> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "actorId")]
            actor_id: &'a str,
            role: &'a str,
        }
        let _: serde_json::Value = self
            .post(
                &format!("/v1/sessions/{session_id}/participants"),
                &Body {
                    actor_id,
                    role: "member",
                },
                None,
            )
            .await?;
        Ok(())
    }

    async fn create_cron_session(
        &self,
        team_id: &str,
        primary_agent_actor_id: &str,
        title: &str,
    ) -> BackendResult<String> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "teamId")]
            team_id: &'a str,
            #[serde(rename = "primaryAgentActorId")]
            primary_agent_actor_id: &'a str,
            title: &'a str,
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            #[serde(rename = "sessionId")]
            session_id: String,
        }
        let r: Resp = self
            .post(
                "/v1/sessions/cron",
                &Body {
                    team_id,
                    primary_agent_actor_id,
                    title,
                },
                None,
            )
            .await?;
        Ok(r.session_id)
    }

    async fn insert_message(
        &self,
        id: &str,
        team_id: &str,
        session_id: &str,
        sender_actor_id: &str,
        kind: &str,
        content: &str,
        metadata_json: &str,
        model: &str,
        turn_id: &str,
        reply_to_message_id: &str,
        sequence: u64,
    ) -> BackendResult<()> {
        self.insert_message_impl(
            id,
            team_id,
            session_id,
            sender_actor_id,
            kind,
            content,
            metadata_json,
            model,
            turn_id,
            reply_to_message_id,
            sequence,
        )
        .await
    }
}

/// Shared response type for agent_runtimes rows returned by the Cloud API.
#[derive(serde::Deserialize)]
struct CloudAgentRuntime {
    id: String,
    #[serde(rename = "backendSessionId", default)]
    backend_session_id: Option<String>,
    #[serde(rename = "lastProcessedMessageId", default)]
    last_processed_message_id: Option<String>,
}

impl CloudAgentRuntime {
    fn into_row(self) -> AgentRuntimeRow {
        AgentRuntimeRow {
            id: self.id,
            workspace_id: None,
            backend_type: String::new(),
            backend_session_id: self.backend_session_id,
            status: String::new(),
            last_processed_message_id: self.last_processed_message_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_config::ProviderConfig;

    #[test]
    fn bootstrap_mqtt_prefers_canonical_ws_url_over_tcp_url() {
        let payload: BootstrapResponse = serde_json::from_str(
            r#"{"mqtt":{"url":"ws://claw.example.com:8080/mqtt","tcpUrl":"mqtt://claw.example.com:8080"}}"#,
        )
        .unwrap();
        assert_eq!(
            payload.mqtt.unwrap().broker_url(),
            "ws://claw.example.com:8080/mqtt"
        );
    }

    #[test]
    fn bootstrap_mqtt_falls_back_to_url_without_tcp_url() {
        let payload: BootstrapResponse =
            serde_json::from_str(r#"{"mqtt":{"url":"mqtts://broker.example.com:8883"}}"#).unwrap();
        assert_eq!(
            payload.mqtt.unwrap().broker_url(),
            "mqtts://broker.example.com:8883"
        );
    }
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn config(server: &MockServer) -> CloudApiConfig {
        CloudApiConfig {
            url: server.uri(),
            refresh_token: "refresh".to_string(),
            team_id: "team-1".to_string(),
            actor_id: "agent-1".to_string(),
        }
    }

    fn refresh_ok() -> serde_json::Value {
        serde_json::json!({ "accessToken": "access-token", "refreshToken": "rt-2", "expiresAt": 9999999999_i64 })
    }

    async fn mount_refresh(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .respond_with(ResponseTemplate::new(200).set_body_json(refresh_ok()))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn access_token_calls_cloud_api_refresh() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .and(wiremock::matchers::body_json(
                serde_json::json!({ "refreshToken": "refresh" }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(refresh_ok()))
            .mount(&server)
            .await;

        let backend = CloudApiBackend::new(config(&server));
        let tok = backend.access_token().await.unwrap();
        assert_eq!(tok, "access-token");
    }

    #[tokio::test]
    async fn access_token_is_cached_until_near_expiry() {
        let server = MockServer::start().await;
        // Far-future expiry → the first refresh should satisfy later calls.
        mount_refresh(&server).await;
        let backend = CloudApiBackend::new(config(&server));

        assert_eq!(backend.access_token().await.unwrap(), "access-token");
        assert_eq!(backend.access_token().await.unwrap(), "access-token");
        assert_eq!(backend.access_token().await.unwrap(), "access-token");

        let refreshes = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.url.path() == "/v1/auth/refresh")
            .count();
        assert_eq!(
            refreshes, 1,
            "access token should be cached, not re-fetched"
        );
    }

    #[tokio::test]
    async fn invalidate_cached_credential_forces_next_refresh() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        let backend = CloudApiBackend::new(config(&server));

        backend.access_token().await.unwrap();
        let refreshes_before = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.url.path() == "/v1/auth/refresh")
            .count();
        assert_eq!(refreshes_before, 1);

        backend.invalidate_cached_credential();
        backend.access_token().await.unwrap();

        let refreshes_after = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.url.path() == "/v1/auth/refresh")
            .count();
        assert_eq!(refreshes_after, 2);
    }

    #[tokio::test]
    async fn access_token_refreshes_again_once_expired() {
        let server = MockServer::start().await;
        // expiresAt in the past → never cacheable, so each call refreshes.
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "access-token",
                "refreshToken": "refresh",
                "expiresAt": 1_i64
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));

        backend.access_token().await.unwrap();
        backend.access_token().await.unwrap();

        let refreshes = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.url.path() == "/v1/auth/refresh")
            .count();
        assert_eq!(refreshes, 2, "expired token must trigger a fresh refresh");
    }

    #[tokio::test]
    async fn rotated_refresh_token_is_persisted_and_reused() {
        let server = MockServer::start().await;
        // First refresh uses the seed token "refresh", rotates to "rt-rotated",
        // and is immediately expired so the next call must refresh again.
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .and(wiremock::matchers::body_json(
                serde_json::json!({ "refreshToken": "refresh" }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "at-1",
                "refreshToken": "rt-rotated",
                "expiresAt": 1_i64
            })))
            .expect(1)
            .mount(&server)
            .await;
        // Second refresh must present the rotated token "rt-rotated".
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .and(wiremock::matchers::body_json(
                serde_json::json!({ "refreshToken": "rt-rotated" }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "at-2",
                "refreshToken": "rt-rotated",
                "expiresAt": 9999999999_i64
            })))
            .expect(1)
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        let initial_config = config(&server);
        ProviderConfig::save_cloud_api(&backend_path, &initial_config).unwrap();
        let backend = CloudApiBackend::with_persist_path(initial_config, backend_path.clone());

        assert_eq!(backend.access_token().await.unwrap(), "at-1");

        // Rotated token must have been written back to backend.toml.
        let persisted = std::fs::read_to_string(&backend_path).unwrap();
        assert!(
            persisted.contains(r#"refresh_token = "rt-rotated""#),
            "rotated refresh token should be persisted, got:\n{persisted}"
        );

        // Next call (cache expired) must refresh using the rotated token.
        assert_eq!(backend.access_token().await.unwrap(), "at-2");
        // wiremock `.expect(1)` on both mocks is verified on server drop.
    }

    #[tokio::test]
    async fn stale_backend_does_not_overwrite_rebound_identity_when_token_rotates() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;

        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        let old_config = config(&server);
        ProviderConfig::save_cloud_api(&backend_path, &old_config).unwrap();

        // The running backend captures the old identity. A later `amuxd init`
        // replaces the file with a newly bound actor before the old process
        // refreshes its token.
        let backend = CloudApiBackend::with_persist_path(old_config, backend_path.clone());
        let rebound = CloudApiConfig {
            url: server.uri(),
            refresh_token: "new-binding-refresh".to_string(),
            team_id: "team-2".to_string(),
            actor_id: "agent-2".to_string(),
        };
        ProviderConfig::save_cloud_api(&backend_path, &rebound).unwrap();
        let expected = std::fs::read_to_string(&backend_path).unwrap();

        assert_eq!(backend.access_token().await.unwrap(), "access-token");

        let actual = std::fs::read_to_string(&backend_path).unwrap();
        assert_eq!(
            actual, expected,
            "stale daemon must not restore its old identity"
        );
    }

    #[tokio::test]
    async fn concurrent_access_token_calls_refresh_only_once() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        let backend = CloudApiBackend::new(config(&server));

        let calls = (0..8).map(|_| {
            let b = backend.clone();
            async move { b.access_token().await.unwrap() }
        });
        let tokens = futures::future::join_all(calls).await;
        assert!(tokens.iter().all(|t| t == "access-token"));

        let refreshes = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.url.path() == "/v1/auth/refresh")
            .count();
        assert_eq!(
            refreshes, 1,
            "single-flight should collapse concurrent refreshes into one"
        );
    }

    fn unauthorized_envelope(message: &str) -> serde_json::Value {
        serde_json::json!({
            "error": {
                "code": "unauthorized",
                "message": message
            }
        })
    }

    #[tokio::test]
    async fn get_retries_once_after_401_with_stale_cached_token() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/sessions/session-1"))
            .respond_with(
                ResponseTemplate::new(401).set_body_json(unauthorized_envelope("JWT expired")),
            )
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/sessions/session-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "session-1",
                "teamId": "team-1",
                "title": "t13",
                "mode": "collab",
                "participants": []
            })))
            .mount(&server)
            .await;

        let backend = CloudApiBackend::new(config(&server));
        backend.access_token().await.unwrap();

        let session = backend
            .fetch_session_with_participants("session-1")
            .await
            .unwrap();

        assert_eq!(session.session.id, "session-1");
        assert_eq!(session.session.title, "t13");

        let refreshes = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.url.path() == "/v1/auth/refresh")
            .count();
        assert_eq!(
            refreshes, 2,
            "initial cache warm plus post-401 refresh should hit refresh twice"
        );
    }

    #[tokio::test]
    async fn get_fails_after_two_401s_without_extra_refresh_loops() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/sessions/session-1"))
            .respond_with(
                ResponseTemplate::new(401).set_body_json(unauthorized_envelope("JWT expired")),
            )
            .mount(&server)
            .await;

        let backend = CloudApiBackend::new(config(&server));
        backend.access_token().await.unwrap();

        let err = backend
            .fetch_session_with_participants("session-1")
            .await
            .unwrap_err();
        assert!(matches!(err, BackendError::Auth(_)));
        assert!(err.to_string().contains("JWT expired"));

        let refreshes = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.url.path() == "/v1/auth/refresh")
            .count();
        assert_eq!(
            refreshes, 2,
            "only one retry should trigger one extra refresh"
        );
    }

    #[tokio::test]
    async fn get_does_not_retry_on_404() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/sessions/missing"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "session not found" }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let backend = CloudApiBackend::new(config(&server));
        let err = backend
            .fetch_session_with_participants("missing")
            .await
            .unwrap_err();
        assert!(matches!(err, BackendError::NotFound(_)));

        let refreshes = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.url.path() == "/v1/auth/refresh")
            .count();
        assert_eq!(refreshes, 1, "404 must not trigger auth retry refresh");
    }

    #[tokio::test]
    async fn claim_invite_uses_refreshed_bearer_against_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/invites/claim"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "actorId": "agent-1",
                "teamId": "team-1",
                "actorType": "agent",
                "displayName": "Agent",
                "refreshToken": "next-refresh"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));

        let result = backend.claim_team_invite("invite-token").await.unwrap();

        assert_eq!(result.actor_id, "agent-1");
        assert_eq!(result.team_id, "team-1");
        let requests = server.received_requests().await.unwrap();
        let claim = requests
            .iter()
            .find(|request| request.url.path() == "/v1/invites/claim")
            .expect("claim request");
        assert_eq!(
            claim
                .headers
                .get("authorization")
                .unwrap()
                .to_str()
                .unwrap(),
            "Bearer access-token"
        );
    }

    #[tokio::test]
    async fn messages_after_cursor_maps_cloud_messages() {
        use chrono::DateTime;
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/sessions/session-1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [
                    {
                        "id": "old-message",
                        "teamId": "team-1",
                        "sessionId": "session-1",
                        "senderActorId": "actor-1",
                        "kind": "text",
                        "content": "old",
                        "metadata": null,
                        "createdAt": "2026-05-27T10:00:00Z"
                    },
                    {
                        "id": "new-message",
                        "teamId": "team-1",
                        "sessionId": "session-1",
                        "senderActorId": "actor-1",
                        "kind": "text",
                        "content": "new",
                        "metadata": { "k": "v" },
                        "createdAt": "2026-05-27T10:01:00Z"
                    }
                ],
                "nextCursor": null
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));

        let messages = backend
            .messages_after_cursor("session-1", Some("old-message"))
            .await
            .unwrap();

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "new-message");
        assert_eq!(messages[0].metadata_json, r#"{"k":"v"}"#);
        assert_eq!(
            messages[0].created_at,
            "2026-05-27T10:01:00Z"
                .parse::<DateTime<chrono::Utc>>()
                .unwrap()
                .timestamp()
        );
    }

    #[tokio::test]
    async fn upload_attachment_bytes_returns_url() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/attachments"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "path": "uploads/file.txt",
                "url": "https://example.com/uploads/file.txt"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let url = backend
            .upload_attachment_bytes("uploads/file.txt", b"hello".to_vec(), "text/plain")
            .await
            .unwrap();
        assert_eq!(url, "https://example.com/uploads/file.txt");
    }

    #[tokio::test]
    async fn set_agent_default_workspace_patches_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("PATCH"))
            .and(path("/v1/agents/agent-1/defaults"))
            .and(wiremock::matchers::body_json(
                serde_json::json!({ "defaultWorkspaceId": "workspace-remote-1" }),
            ))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        backend
            .set_agent_default_workspace("workspace-remote-1")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn ensure_agent_types_posts_to_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/agents/types/ensure"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        backend
            .ensure_agent_types(
                &["claude_code".to_string(), "shell".to_string()],
                "claude_code",
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn update_runtime_cursor_patches_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("PATCH"))
            .and(path("/v1/agents/runtimes/runtime-row-1/cursor"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        backend
            .update_runtime_cursor("runtime-row-1", "msg-10")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn fetch_latest_runtime_for_session_returns_none_on_404() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes/latest"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "not found" }
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let row = backend
            .fetch_latest_runtime_for_session("agent-1", "session-1")
            .await
            .unwrap();
        assert!(row.is_none());
    }

    #[tokio::test]
    async fn fetch_agent_runtime_for_session_returns_row() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "runtime-row-1",
                "agentActorId": "agent-1",
                "sessionId": "session-1",
                "runtimeId": "rt-1",
                "backendSessionId": "bs-1",
                "lastProcessedMessageId": "msg-5"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let row = backend
            .fetch_agent_runtime_for_session("session-1", "rt-1", "bs-1")
            .await
            .unwrap();
        assert!(row.is_some());
        let row = row.unwrap();
        assert_eq!(row.id, "runtime-row-1");
        assert_eq!(row.last_processed_message_id, Some("msg-5".to_string()));
    }

    #[tokio::test]
    async fn fetch_agent_runtime_for_session_returns_none_on_404() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "not found" }
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let row = backend
            .fetch_agent_runtime_for_session("session-x", "rt-x", "bs-x")
            .await
            .unwrap();
        assert!(row.is_none());
    }

    #[tokio::test]
    async fn upsert_agent_runtime_returns_id() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/agents/runtimes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "runtime-row-1"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let id = backend
            .upsert_agent_runtime(&AgentRuntimeUpsert {
                team_id: "team-1",
                agent_id: "agent-1",
                session_id: Some("session-1"),
                workspace_id: None,
                backend_type: "claude_code",
                backend_session_id: Some("bs-1"),
                runtime_id: Some("rt-1"),
                status: "active",
                current_model: None,
                last_seen_at: chrono::Utc::now(),
            })
            .await
            .unwrap();
        assert_eq!(id, Some("runtime-row-1".to_string()));
    }

    #[test]
    fn upsert_runtime_body_includes_workspace_id() {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(rename = "agentActorId")]
            agent_actor_id: &'a str,
            #[serde(rename = "workspaceId", skip_serializing_if = "Option::is_none")]
            workspace_id: Option<&'a str>,
            status: &'a str,
        }
        let with = serde_json::to_value(&Body {
            agent_actor_id: "a1",
            workspace_id: Some("ws-uuid"),
            status: "starting",
        })
        .unwrap();
        assert_eq!(with["workspaceId"], "ws-uuid");

        let without = serde_json::to_value(&Body {
            agent_actor_id: "a1",
            workspace_id: None,
            status: "starting",
        })
        .unwrap();
        assert!(without.get("workspaceId").is_none(), "None must be omitted");
    }

    #[tokio::test]
    async fn list_agent_admin_member_actor_ids_returns_items() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/agent-1/admin-members"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": ["actor-admin-1", "actor-admin-2"]
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let ids = backend
            .list_agent_admin_member_actor_ids("agent-1")
            .await
            .unwrap();
        assert_eq!(ids, vec!["actor-admin-1", "actor-admin-2"]);
    }

    #[tokio::test]
    async fn get_agent_defaults_parses_type_and_workspace() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/runtime/agent-defaults"))
            .and(wiremock::matchers::query_param("agentId", "agent-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [{
                    "id": "agent-1",
                    "agentTypes": ["claude", "opencode"],
                    "defaultAgentType": "opencode",
                    "defaultWorkspaceId": "ws-uuid-1"
                }]
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let defaults = backend.get_agent_defaults("agent-1").await.unwrap();
        assert_eq!(defaults.default_agent_type.as_deref(), Some("opencode"));
        assert_eq!(defaults.default_workspace_id.as_deref(), Some("ws-uuid-1"));
    }

    #[tokio::test]
    async fn get_agent_defaults_tolerates_null_fields() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/runtime/agent-defaults"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [{
                    "id": "agent-1",
                    "agentTypes": null,
                    "defaultAgentType": null,
                    "defaultWorkspaceId": null
                }]
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let defaults = backend.get_agent_defaults("agent-1").await.unwrap();
        assert_eq!(defaults.default_agent_type, None);
        assert_eq!(defaults.default_workspace_id, None);
    }

    #[tokio::test]
    async fn check_agent_permission_returns_role_when_allowed() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/agent-1/permission"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "allowed": true,
                "role": "admin"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let role = backend
            .check_agent_permission("agent-1", "actor-1")
            .await
            .unwrap();
        assert_eq!(role, Some("admin".to_string()));
    }

    #[tokio::test]
    async fn check_agent_permission_returns_none_when_denied() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/agent-1/permission"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "allowed": false,
                "role": null
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let role = backend
            .check_agent_permission("agent-1", "actor-no-access")
            .await
            .unwrap();
        assert!(role.is_none());
    }

    #[tokio::test]
    async fn rpc_upsert_external_actor_returns_actor_id() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/actors/external"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "actorId": "actor-ext-1"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let actor_id = backend
            .rpc_upsert_external_actor("team-1", "wecom", "wecom-user-1", "Alice")
            .await
            .unwrap();
        assert_eq!(actor_id, "actor-ext-1");
    }

    #[tokio::test]
    async fn create_cron_session_returns_session_id() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/sessions/cron"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sessionId": "session-cron-1"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let session_id = backend
            .create_cron_session("team-1", "agent-1", "Daily summary")
            .await
            .unwrap();
        assert_eq!(session_id, "session-cron-1");
    }

    #[tokio::test]
    async fn rpc_ensure_gateway_session_posts_to_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/sessions/gateway/ensure"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sessionId": "session-1",
                "gatewaySessionId": "gw-1",
                "created": true
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let (session_id, gw_id, created) = backend
            .rpc_ensure_gateway_session("team-1", "wecom:room#1", "Stand-up", "agent-1", &[], &[])
            .await
            .unwrap();
        assert_eq!(session_id, "session-1");
        assert_eq!(gw_id, "gw-1");
        assert!(created);
    }

    #[tokio::test]
    async fn get_gateway_session_by_acp_id_returns_none_on_404() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/sessions/by-acp/acp-missing"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "not found" }
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let result = backend
            .get_gateway_session_by_acp_id("acp-missing")
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn get_gateway_session_by_acp_id_returns_ids() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/sessions/by-acp/acp-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sessionId": "session-1",
                "gatewaySessionId": "gw-1"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let result = backend
            .get_gateway_session_by_acp_id("acp-1")
            .await
            .unwrap();
        assert_eq!(
            result,
            Some(("session-1".to_string(), Some("gw-1".to_string())))
        );
    }

    #[tokio::test]
    async fn upsert_session_participant_posts_to_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/sessions/session-1/participants"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "actorId": "actor-2", "role": "member"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        backend
            .upsert_session_participant("session-1", "actor-2")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn fetch_session_with_participants_maps_response() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/sessions/session-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "session-1",
                "teamId": "team-1",
                "title": "Daily",
                "mode": "solo",
                "ideaId": null,
                "createdAt": "2026-01-01T00:00:00Z",
                "participants": [
                    { "actorId": "actor-1", "role": "admin", "joinedAt": "2026-01-01T00:00:00Z" }
                ]
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let result = backend
            .fetch_session_with_participants("session-1")
            .await
            .unwrap();
        assert_eq!(result.session.id, "session-1");
        assert_eq!(result.participants.len(), 1);
        assert_eq!(result.participants[0].actor_id, "actor-1");
    }

    #[tokio::test]
    async fn upsert_workspace_posts_to_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/workspaces"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "ws-1",
                "teamId": "team-1",
                "name": "My Workspace",
                "slug": null,
                "archived": false,
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let row = backend
            .upsert_workspace(&WorkspaceUpsert {
                team_id: "team-1",
                agent_id: "agent-1",
                name: "My Workspace",
                path: None,
                archived: false,
                cloud_id: None,
            })
            .await
            .unwrap();
        assert_eq!(row.id, "ws-1");
    }

    #[tokio::test]
    async fn get_workspaces_by_ids_posts_to_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/workspaces/by-ids"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [
                    { "id": "ws-1", "name": "My Workspace", "path": "/tmp/ws-1", "slug": null }
                ]
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let rows = backend
            .get_workspaces_by_ids(&["ws-1".to_string()])
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "ws-1");
        assert_eq!(rows[0].path.as_deref(), Some("/tmp/ws-1"));
    }

    #[tokio::test]
    async fn get_workspaces_by_team_gets_from_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/workspaces"))
            .and(wiremock::matchers::query_param("teamId", "team-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [
                    { "id": "ws-1", "teamId": "team-1", "path": "/tmp/ws-1", "slug": null },
                    { "id": "ws-2", "teamId": "team-1", "path": null, "slug": "/tmp/ws-2" }
                ],
                "nextCursor": null
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let rows = backend.get_workspaces_by_team("team-1").await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].path.as_deref(), Some("/tmp/ws-1"));
        assert_eq!(rows[1].path.as_deref(), Some("/tmp/ws-2"));
        assert!(rows.iter().all(|r| r.team_id == "team-1"));
    }

    #[tokio::test]
    async fn get_workspaces_by_ids_returns_empty_for_empty_input() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        let backend = CloudApiBackend::new(config(&server));
        let rows = backend.get_workspaces_by_ids(&[]).await.unwrap();
        assert!(rows.is_empty());
    }

    #[tokio::test]
    async fn heartbeat_posts_to_cloud_api() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/heartbeat"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        backend.heartbeat().await.unwrap();
    }

    #[tokio::test]
    async fn team_share_config_parses_custom_git_response() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/teams/team-1/share-mode"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "mode": "custom_git",
                "enabledAt": "2026-06-01T00:00:00Z",
                "gitRemoteUrl": "git@example.com:team/repo.git",
                "gitAuthKind": "ssh_key"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let cfg = backend.team_share_config("team-1").await.unwrap();
        assert_eq!(cfg.mode.as_deref(), Some("custom_git"));
        assert_eq!(
            cfg.git_remote_url.as_deref(),
            Some("git@example.com:team/repo.git")
        );
        assert_eq!(cfg.git_auth_kind.as_deref(), Some("ssh_key"));
        // FC's share-mode endpoint does not return a branch.
        assert_eq!(cfg.git_branch, None);
    }

    #[tokio::test]
    async fn team_share_config_null_mode_is_default() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/teams/team-1/share-mode"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "mode": null,
                "enabledAt": null,
                "gitRemoteUrl": null,
                "gitAuthKind": null
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let cfg = backend.team_share_config("team-1").await.unwrap();
        assert_eq!(cfg.mode, None);
        assert_eq!(cfg.git_remote_url, None);
        assert_eq!(cfg.git_auth_kind, None);
        assert_eq!(cfg.git_branch, None);
    }

    #[tokio::test]
    async fn team_share_config_404_is_default_not_error() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/teams/team-1/share-mode"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "team not found" }
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let cfg = backend.team_share_config("team-1").await.unwrap();
        assert_eq!(cfg.mode, None);
    }

    #[tokio::test]
    async fn managed_llm_config_parses_enabled_llm() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/teams/team-1/workspace-config"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "shareMode": "oss",
                "llm": {
                    "enabled": true,
                    "baseUrl": "https://ai.ucar.cc",
                    "models": [{ "id": "default", "name": "Default" }, { "id": "pro", "name": "Pro" }],
                    "availableModels": [],
                    "aiGatewayEndpoint": "https://ai.ucar.cc/v1"
                }
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let cfg = backend.managed_llm_config("team-1").await.unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.base_url.as_deref(), Some("https://ai.ucar.cc"));
        assert_eq!(cfg.models.len(), 2);
        assert_eq!(cfg.models[0].id, "default");
    }

    #[tokio::test]
    async fn managed_llm_config_falls_back_to_gateway_endpoint_when_base_url_null() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/teams/team-1/workspace-config"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "llm": {
                    "enabled": true,
                    "baseUrl": null,
                    "models": [],
                    "aiGatewayEndpoint": "https://gw.example/v1"
                }
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let cfg = backend.managed_llm_config("team-1").await.unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.base_url.as_deref(), Some("https://gw.example/v1"));
    }

    #[tokio::test]
    async fn managed_llm_config_404_is_disabled_not_error() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/teams/team-1/workspace-config"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "team not found" }
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let cfg = backend.managed_llm_config("team-1").await.unwrap();
        assert!(!cfg.enabled);
        assert_eq!(cfg.base_url, None);
        assert!(cfg.models.is_empty());
    }

    #[test]
    fn terminal_refresh_status_only_for_400_and_401() {
        use reqwest::StatusCode;
        assert!(is_terminal_refresh_status(StatusCode::UNAUTHORIZED));
        assert!(is_terminal_refresh_status(StatusCode::BAD_REQUEST));
        // Transient / server-side failures must not latch the terminal flag.
        assert!(!is_terminal_refresh_status(
            StatusCode::INTERNAL_SERVER_ERROR
        ));
        assert!(!is_terminal_refresh_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(!is_terminal_refresh_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(!is_terminal_refresh_status(StatusCode::FORBIDDEN));
    }

    #[tokio::test]
    async fn refresh_rejected_with_401_latches_terminal_auth() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": { "code": "missing_auth", "message": "Token refresh failed: refresh_token_not_found" }
            })))
            .mount(&server)
            .await;

        let backend = CloudApiBackend::new(config(&server));
        // Healthy until the first refusal.
        assert_eq!(
            backend.cloud_auth_health(),
            Some(CloudAuthSnapshot {
                terminal_failure: false
            })
        );

        assert!(backend.access_token().await.is_err());
        assert_eq!(
            backend.cloud_auth_health(),
            Some(CloudAuthSnapshot {
                terminal_failure: true
            })
        );
    }

    #[tokio::test]
    async fn refresh_5xx_does_not_latch_terminal_auth() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let backend = CloudApiBackend::new(config(&server));
        assert!(backend.access_token().await.is_err());
        // A transient server error must leave the session presumed-recoverable.
        assert_eq!(
            backend.cloud_auth_health(),
            Some(CloudAuthSnapshot {
                terminal_failure: false
            })
        );
    }

    #[tokio::test]
    async fn successful_refresh_clears_terminal_latch() {
        let server = MockServer::start().await;
        // First refresh is rejected (latches terminal); subsequent ones succeed
        // (mirrors the desktop re-onboarding the daemon with fresh credentials).
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": { "message": "refresh_token_not_found" }
            })))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .respond_with(ResponseTemplate::new(200).set_body_json(refresh_ok()))
            .with_priority(2)
            .mount(&server)
            .await;

        let backend = CloudApiBackend::new(config(&server));
        assert!(backend.access_token().await.is_err());
        assert_eq!(
            backend.cloud_auth_health(),
            Some(CloudAuthSnapshot {
                terminal_failure: true
            })
        );

        // Next refresh succeeds and clears the latch.
        assert_eq!(backend.access_token().await.unwrap(), "access-token");
        assert_eq!(
            backend.cloud_auth_health(),
            Some(CloudAuthSnapshot {
                terminal_failure: false
            })
        );
    }

    #[tokio::test]
    async fn get_effective_default_agent_returns_agent_id() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/teams/team-1/members/me/effective-default-agent"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "defaultAgentId": "agent-123"
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let result = backend.get_effective_default_agent("team-1").await.unwrap();
        assert_eq!(result, Some("agent-123".to_string()));
    }

    #[tokio::test]
    async fn get_effective_default_agent_returns_none_when_null() {
        let server = MockServer::start().await;
        mount_refresh(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/teams/team-1/members/me/effective-default-agent"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "defaultAgentId": null
            })))
            .mount(&server)
            .await;
        let backend = CloudApiBackend::new(config(&server));
        let result = backend.get_effective_default_agent("team-1").await.unwrap();
        assert_eq!(result, None);
    }
}

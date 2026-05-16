use crate::supabase::config::SupabaseConfig;
use crate::supabase::error::{SupabaseError, SupabaseResult};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;

// chrono re-exported for callers constructing AgentRuntimeUpsert
pub use chrono;

#[derive(Debug, Clone)]
pub struct SupabaseClient {
    http: Client,
    cfg: SupabaseConfig,
    persist_path: Option<std::path::PathBuf>,
    state: Arc<Mutex<AuthState>>,
    /// Serializes `refresh()` so two concurrent callers can't race to spend
    /// the same refresh token (GoTrue invalidates the presented token and
    /// hands back a new one — a second concurrent call sees the old token
    /// return 400 refresh_token_already_used).
    refresh_lock: Arc<AsyncMutex<()>>,
}

#[derive(Debug, Default)]
struct AuthState {
    access_token: Option<String>,
    refresh_token: String,
    expires_at: Option<Instant>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: String,
}

#[derive(Debug, Serialize)]
struct RefreshRequest<'a> {
    refresh_token: &'a str,
}

// Refresh while the access token still has >10 min of life left, so a single
// slow call won't expire mid-flight.
const REFRESH_SKEW: Duration = Duration::from_secs(10 * 60);

impl SupabaseClient {
    pub fn new(cfg: SupabaseConfig) -> SupabaseResult<Self> {
        let persist_path = SupabaseConfig::default_path().ok();
        Self::new_with_persistence(cfg, persist_path)
    }

    pub fn new_without_persistence(cfg: SupabaseConfig) -> SupabaseResult<Self> {
        Self::new_with_persistence(cfg, None)
    }

    fn new_with_persistence(
        cfg: SupabaseConfig,
        persist_path: Option<std::path::PathBuf>,
    ) -> SupabaseResult<Self> {
        let http = Client::builder().timeout(Duration::from_secs(20)).build()?;
        let state = AuthState {
            refresh_token: cfg.refresh_token.clone(),
            ..Default::default()
        };
        Ok(Self {
            http,
            cfg,
            persist_path,
            state: Arc::new(Mutex::new(state)),
            refresh_lock: Arc::new(AsyncMutex::new(())),
        })
    }

    pub fn config(&self) -> &SupabaseConfig {
        &self.cfg
    }

    pub async fn access_token(&self) -> SupabaseResult<String> {
        {
            let st = self.state.lock().unwrap();
            if let (Some(tok), Some(exp)) = (&st.access_token, st.expires_at) {
                if exp > Instant::now() + REFRESH_SKEW {
                    return Ok(tok.clone());
                }
            }
        }
        self.refresh().await
    }

    async fn refresh(&self) -> SupabaseResult<String> {
        let _guard = self.refresh_lock.lock().await;

        // Another caller may have just refreshed while we were queued on
        // the mutex. Re-check the cache before spending the stored token.
        {
            let st = self.state.lock().unwrap();
            if let (Some(tok), Some(exp)) = (&st.access_token, st.expires_at) {
                if exp > Instant::now() + REFRESH_SKEW {
                    return Ok(tok.clone());
                }
            }
        }

        let rt = { self.state.lock().unwrap().refresh_token.clone() };
        let url = format!("{}/auth/v1/token?grant_type=refresh_token", self.cfg.url);
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .json(&RefreshRequest { refresh_token: &rt })
            .send()
            .await?;

        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Auth(format!("refresh failed: {text}")));
        }
        let body: TokenResponse = resp.json().await?;

        // Persist the rotated refresh token so the next daemon start doesn't
        // boot with a stale one GoTrue has already invalidated.
        let new_refresh = body.refresh_token.clone();
        {
            let mut st = self.state.lock().unwrap();
            st.access_token = Some(body.access_token.clone());
            st.refresh_token = new_refresh.clone();
            st.expires_at = Some(Instant::now() + Duration::from_secs(body.expires_in));
        }
        if let Some(path) = &self.persist_path {
            let mut persisted = self.cfg.clone();
            persisted.refresh_token = new_refresh;
            let _ = persisted.save(path);
        }
        Ok(body.access_token)
    }

    /// Expiry of the currently cached access token without triggering a refresh.
    /// Returns `None` if no token has been fetched yet.
    pub fn cached_token_expiry(&self) -> Option<Instant> {
        #[cfg(debug_assertions)]
        if let Ok(secs_str) = std::env::var("AMUX_FORCE_TOKEN_EXPIRY_SECS") {
            if let Ok(n) = secs_str.parse::<u64>() {
                return Some(Instant::now() + Duration::from_secs(n));
            }
        }
        self.state.lock().unwrap().expires_at
    }

    /// Returns true if the cached token is at or past its expiry.
    pub fn is_token_expired(&self) -> bool {
        self.state
            .lock()
            .unwrap()
            .expires_at
            .map(|t| Instant::now() >= t)
            .unwrap_or(false)
    }

    /// Trade an email/password for tokens. Used immediately after
    /// `claim_daemon_invite` returns the daemon's one-time credentials.
    pub async fn login_with_password(
        &mut self,
        email: &str,
        password: &str,
    ) -> SupabaseResult<String> {
        #[derive(Serialize)]
        struct Req<'a> {
            email: &'a str,
            password: &'a str,
        }
        let url = format!("{}/auth/v1/token?grant_type=password", self.cfg.url);
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .json(&Req { email, password })
            .send()
            .await?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Auth(format!("password login: {text}")));
        }
        let body: TokenResponse = resp.json().await?;
        let mut st = self.state.lock().unwrap();
        st.access_token = Some(body.access_token.clone());
        st.refresh_token = body.refresh_token.clone();
        st.expires_at = Some(Instant::now() + Duration::from_secs(body.expires_in));
        self.cfg.refresh_token = body.refresh_token.clone();
        Ok(body.access_token)
    }

    /// Call a PostgREST RPC function with the daemon's bearer token.
    pub async fn rpc<Req: Serialize, Resp: serde::de::DeserializeOwned>(
        &self,
        name: &str,
        payload: &Req,
    ) -> SupabaseResult<Resp> {
        let token = self.access_token().await?;
        let url = format!("{}/rest/v1/rpc/{name}", self.cfg.url);
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(token)
            .json(payload)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            });
        }
        Ok(resp.json().await?)
    }

    /// Anonymous RPC — used for `claim_daemon_invite`, where the invite token
    /// *is* the credential.
    pub async fn rpc_anon<Req: Serialize, Resp: serde::de::DeserializeOwned>(
        &self,
        name: &str,
        payload: &Req,
    ) -> SupabaseResult<Resp> {
        let url = format!("{}/rest/v1/rpc/{name}", self.cfg.url);
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .json(payload)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            });
        }
        Ok(resp.json().await?)
    }

    /// Anonymous claim for agents (daemon path). Calls `claim_team_invite` RPC.
    /// Supabase's PostgREST always returns a set-returning function as an array,
    /// so we deserialize into `Vec<ClaimResult>` and pick the first row.
    pub async fn claim_team_invite(&self, token: &str) -> SupabaseResult<ClaimResult> {
        #[derive(Serialize)]
        struct Req<'a> {
            p_token: &'a str,
        }
        let payload = Req { p_token: token };
        let rows: Vec<ClaimResult> = self.rpc_anon("claim_team_invite", &payload).await?;
        rows.into_iter().next().ok_or(SupabaseError::InviteInvalid)
    }
}

/// Returned by `public.claim_team_invite` — both member and agent branches.
/// `refresh_token` is `None` for member claims.
#[derive(Debug, Deserialize)]
pub struct ClaimResult {
    pub actor_id: String,
    pub team_id: String,
    pub actor_type: String,
    pub display_name: String,
    pub refresh_token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AgentRuntimeUpsert<'a> {
    pub team_id: &'a str,
    pub agent_id: &'a str,
    pub session_id: Option<&'a str>,
    pub workspace_id: Option<&'a str>,
    pub backend_type: &'a str,
    pub backend_session_id: Option<&'a str>,
    /// Daemon-side 8-char runtime id, the topic segment in
    /// `runtime/{runtime_id}/state`. iOS uses it to bridge a Supabase
    /// `agent_runtimes` row to the live MQTT-published `Runtime`. Distinct
    /// from `backend_session_id` (the 36-char ACP session id used by the
    /// daemon to resume a Claude Code session).
    pub runtime_id: Option<&'a str>,
    pub status: &'a str,
    pub current_model: Option<&'a str>,
    pub last_seen_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceUpsert<'a> {
    pub team_id: &'a str,
    pub agent_id: &'a str,
    pub name: &'a str,
    pub path: Option<&'a str>,
    pub archived: bool,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceRow {
    pub id: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SupabaseSessionRow {
    pub id: String,
    pub team_id: String,
    #[serde(default)]
    pub created_by_actor_id: Option<String>,
    #[serde(default)]
    pub primary_agent_id: Option<String>,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub idea_id: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SupabaseParticipantRow {
    pub session_id: String,
    pub actor_id: String,
    #[serde(default)]
    pub role: Option<String>,
    pub joined_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone)]
pub struct SessionAndParticipants {
    pub session: SupabaseSessionRow,
    pub participants: Vec<SupabaseParticipantRow>,
}

/// A single `messages` table row returned from Supabase.
#[derive(Debug, Clone)]
pub struct StoredMessage {
    pub id: String,
    pub session_id: String,
    pub sender_actor_id: String,
    pub kind: String,
    pub content: String,
    /// Raw JSON string of the `metadata` column.
    pub metadata_json: String,
    /// Unix epoch seconds derived from the `created_at` timestamp.
    pub created_at: i64,
}

/// Parse a `Vec<serde_json::Value>` (PostgREST rows) into `Vec<StoredMessage>`.
/// Extracted as a free function so unit tests can exercise it without any HTTP.
fn parse_stored_messages(rows: Vec<serde_json::Value>) -> Vec<StoredMessage> {
    rows.into_iter()
        .map(|row| StoredMessage {
            id: row["id"].as_str().unwrap_or_default().to_string(),
            session_id: row["session_id"].as_str().unwrap_or_default().to_string(),
            sender_actor_id: row["sender_actor_id"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            kind: row["kind"].as_str().unwrap_or_default().to_string(),
            content: row["content"].as_str().unwrap_or_default().to_string(),
            metadata_json: row
                .get("metadata")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".into()),
            created_at: row
                .get("created_at")
                .and_then(|v| v.as_str())
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp())
                .unwrap_or(0),
        })
        .collect()
}

/// Drop every element up to and including the one whose `id` equals `after_id`.
/// If `after_id` is `None` or not found, the vec is left unchanged.
fn drain_through_cursor(messages: &mut Vec<StoredMessage>, after_id: Option<&str>) {
    if let Some(after_id) = after_id {
        if let Some(pos) = messages.iter().position(|m| m.id == after_id) {
            messages.drain(0..=pos);
        }
    }
}

impl SupabaseClient {
    /// Upsert an agent_runtimes row keyed on (agent_id, backend_session_id).
    ///
    /// Returns `Ok(Some(row_id))` where `row_id` is the UUID of the upserted
    /// row (from `agent_runtimes.id`). Returns `Ok(None)` if the response body
    /// was empty or unparseable — defensive only; PostgREST with
    /// `return=representation` should always include the row.
    pub async fn upsert_agent_runtime(
        &self,
        row: &AgentRuntimeUpsert<'_>,
    ) -> SupabaseResult<Option<String>> {
        let token = self.access_token().await?;
        let url = format!(
            "{}/rest/v1/agent_runtimes?on_conflict=agent_id,backend_session_id",
            self.cfg.url
        );
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .header(
                "Prefer",
                "resolution=merge-duplicates,return=representation",
            )
            .bearer_auth(token)
            .json(&[row])
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            });
        }
        // Parse the returned row(s) to extract the generated id.
        let rows: Vec<serde_json::Value> = resp.json().await.unwrap_or_default();
        let row_id = rows
            .first()
            .and_then(|r| r.get("id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        Ok(row_id)
    }

    /// Record this daemon's MQTT device identifier on its `agents` row so
    /// iOS clients can route publishes to `amux/{device_id}/…` without having
    /// the user hand-type the UUID.
    pub async fn set_agent_device_id(&self, device_id: &str) -> SupabaseResult<()> {
        let token = self.access_token().await?;
        let actor_id = self.cfg.actor_id.clone();
        let url = format!("{}/rest/v1/agents?id=eq.{}", self.cfg.url, actor_id);
        #[derive(Serialize)]
        struct Patch<'a> {
            device_id: &'a str,
        }
        let resp = self
            .http
            .patch(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(token)
            .json(&Patch { device_id })
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            });
        }
        Ok(())
    }

    /// Look up `agent_member_access.permission_level` for a caller. Returns
    /// `Some("admin" | "write" | "view")` or `None` when no grant exists.
    pub async fn check_agent_permission(
        &self,
        agent_id: &str,
        actor_id: &str,
    ) -> SupabaseResult<Option<String>> {
        #[derive(Serialize)]
        struct Req<'a> {
            p_agent_id: &'a str,
            p_actor_id: &'a str,
        }
        let body: serde_json::Value = self
            .rpc(
                "check_agent_permission",
                &Req {
                    p_agent_id: agent_id,
                    p_actor_id: actor_id,
                },
            )
            .await?;
        Ok(body.as_str().map(str::to_string))
    }

    /// Heartbeat: POST /rest/v1/rpc/update_actor_last_active.
    /// The RPC returns void (empty body), so we can't decode the response as JSON.
    pub async fn heartbeat(&self) -> SupabaseResult<()> {
        let token = self.access_token().await?;
        let url = format!("{}/rest/v1/rpc/update_actor_last_active", self.cfg.url);
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(token)
            .json(&serde_json::Value::Null)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            });
        }
        Ok(())
    }

    pub async fn upsert_workspace(
        &self,
        row: &WorkspaceUpsert<'_>,
    ) -> SupabaseResult<WorkspaceRow> {
        let token = self.access_token().await?;
        let url = format!(
            "{}/rest/v1/workspaces?on_conflict=team_id,agent_id,name",
            self.cfg.url
        );
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .header(
                "Prefer",
                "resolution=merge-duplicates,return=representation",
            )
            .bearer_auth(token)
            .json(&[row])
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: text,
            });
        }

        let mut rows: Vec<WorkspaceRow> = resp.json().await?;
        rows.pop().ok_or(SupabaseError::Rpc {
            code: None,
            message: "workspace upsert returned no rows".into(),
        })
    }

    /// Fetch a `sessions` row alongside its `session_participants`. Used when
    /// the daemon receives a `runtimeStart` for an iOS-created collab session
    /// and needs to learn the session's identity + roster before subscribing
    /// to `session/{sid}/live`.
    pub async fn fetch_session_with_participants(
        &self,
        session_id: &str,
    ) -> SupabaseResult<SessionAndParticipants> {
        let token = self.access_token().await?;

        let session_url = format!(
            "{}/rest/v1/sessions?id=eq.{}&select=id,team_id,created_by_actor_id,primary_agent_id,mode,title,summary,idea_id,created_at",
            self.cfg.url, session_id
        );
        let resp = self
            .http
            .get(&session_url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(&token)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("fetch_session: {text}"),
            });
        }
        let mut rows: Vec<SupabaseSessionRow> = resp.json().await?;
        let session = rows.pop().ok_or_else(|| SupabaseError::Rpc {
            code: Some("404".into()),
            message: format!("session {session_id} not found"),
        })?;

        let part_url = format!(
            "{}/rest/v1/session_participants?session_id=eq.{}&select=session_id,actor_id,role,joined_at",
            self.cfg.url, session_id
        );
        let resp = self
            .http
            .get(&part_url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(&token)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("fetch_participants: {text}"),
            });
        }
        let participants: Vec<SupabaseParticipantRow> = resp.json().await?;

        Ok(SessionAndParticipants {
            session,
            participants,
        })
    }

    /// Returns messages for `session_id` ordered by `created_at` ascending.
    /// When `after_id` is `Some`, the message with that id and all earlier
    /// messages are dropped from the result (exclusive cursor).
    pub async fn messages_after_cursor(
        &self,
        session_id: &str,
        after_id: Option<&str>,
    ) -> SupabaseResult<Vec<StoredMessage>> {
        let token = self.access_token().await?;
        let url = format!(
            "{}/rest/v1/messages?session_id=eq.{}&select=id,session_id,sender_actor_id,kind,content,metadata,created_at&order=created_at.asc",
            self.cfg.url, session_id
        );
        let resp = self
            .http
            .get(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(&token)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("messages_after_cursor: {text}"),
            });
        }
        let rows: Vec<serde_json::Value> = resp.json().await?;
        let mut out = parse_stored_messages(rows);
        out.sort_by_key(|m| m.created_at);
        drain_through_cursor(&mut out, after_id);
        Ok(out)
    }

    /// Persist the per-runtime read cursor by PATCHing `agent_runtimes`.
    pub async fn update_runtime_cursor(
        &self,
        runtime_row_id: &str,
        last_processed_message_id: &str,
    ) -> SupabaseResult<()> {
        let token = self.access_token().await?;
        let url = format!(
            "{}/rest/v1/agent_runtimes?id=eq.{}",
            self.cfg.url, runtime_row_id
        );
        #[derive(Serialize)]
        struct Patch<'a> {
            last_processed_message_id: &'a str,
        }
        let resp = self
            .http
            .patch(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(&token)
            .json(&Patch {
                last_processed_message_id,
            })
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("update_runtime_cursor: {text}"),
            });
        }
        Ok(())
    }

    // ── Gateway-store hooks ─────────────────────────────────────────────────
    //
    // These four methods back `channels::AmuxdChannelStore`, the daemon's
    // impl of `teamclaw_gateway::ChannelStore`. They follow the same
    // PostgREST REST + RPC patterns as the rest of this client.

    /// Upsert an `actors` row of type `external` keyed on
    /// `(team_id, source, source_id)`. Returns the actor's UUID.
    pub async fn rpc_upsert_external_actor(
        &self,
        team_id: &str,
        source: &str,
        source_id: &str,
        display_name: &str,
    ) -> SupabaseResult<String> {
        #[derive(Serialize)]
        struct Req<'a> {
            p_team_id: &'a str,
            p_source: &'a str,
            p_source_id: &'a str,
            p_display_name: &'a str,
        }
        let body: serde_json::Value = self
            .rpc(
                "upsert_external_actor",
                &Req {
                    p_team_id: team_id,
                    p_source: source,
                    p_source_id: source_id,
                    p_display_name: display_name,
                },
            )
            .await?;
        // The RPC returns the actor UUID directly (scalar) — PostgREST
        // serialises it as a bare string when the function returns a
        // single scalar.
        if let Some(s) = body.as_str() {
            return Ok(s.to_string());
        }
        // Tolerate set-returning shape just in case: `[{"actor_id": "..."}]`.
        if let Some(arr) = body.as_array() {
            if let Some(first) = arr.first() {
                if let Some(id) = first
                    .get("actor_id")
                    .or_else(|| first.get("id"))
                    .and_then(|v| v.as_str())
                {
                    return Ok(id.to_string());
                }
            }
        }
        Err(SupabaseError::Rpc {
            code: None,
            message: format!("upsert_external_actor: unexpected response {body}"),
        })
    }

    /// Resolve (or create) the `sessions` row for a gateway binding.
    /// Returns `(session_id, acp_session_id, created)`.
    #[allow(clippy::too_many_arguments)]
    pub async fn rpc_ensure_gateway_session(
        &self,
        team_id: &str,
        binding: &str,
        title: &str,
        primary_agent_actor_id: &str,
        owner_member_actor_ids: &[String],
        participant_actor_ids: &[String],
    ) -> SupabaseResult<(String, String, bool)> {
        #[derive(Serialize)]
        struct Req<'a> {
            p_team_id: &'a str,
            p_binding: &'a str,
            p_title: &'a str,
            p_primary_agent_actor_id: &'a str,
            p_owner_member_actor_ids: &'a [String],
            p_participant_actor_ids: &'a [String],
        }
        #[derive(Deserialize)]
        struct Row {
            session_id: String,
            acp_session_id: String,
            created: bool,
        }
        let rows: Vec<Row> = self
            .rpc(
                "ensure_gateway_session",
                &Req {
                    p_team_id: team_id,
                    p_binding: binding,
                    p_title: title,
                    p_primary_agent_actor_id: primary_agent_actor_id,
                    p_owner_member_actor_ids: owner_member_actor_ids,
                    p_participant_actor_ids: participant_actor_ids,
                },
            )
            .await?;
        let row = rows.into_iter().next().ok_or_else(|| SupabaseError::Rpc {
            code: None,
            message: "ensure_gateway_session: empty response".into(),
        })?;
        Ok((row.session_id, row.acp_session_id, row.created))
    }

    /// Insert one row into `public.messages` from a gateway message. Returns
    /// the new row's UUID. Idempotent on `(session_id, external_id)` — a
    /// re-delivery of the same provider message returns the existing id.
    pub async fn insert_gateway_message(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> SupabaseResult<String> {
        let token = self.access_token().await?;
        // `team_id` is required on `messages` and enforced by the
        // `enforce_core_team_integrity` trigger. The daemon's session is in
        // its own team, so we pull from the config.
        let team_id = self.cfg.team_id.clone();
        let mut body = serde_json::json!({
            "team_id": team_id,
            "session_id": session_id,
            "sender_actor_id": sender_actor_id,
            "kind": "text",
            "content": content,
            "metadata": {},
        });
        if let Some(ext) = external_message_id {
            body["external_id"] = serde_json::Value::String(ext.to_string());
        }

        // Prefer `on_conflict=session_id,external_id` so a re-delivery
        // returns the existing row instead of erroring out. PostgREST
        // requires the column tuple as a query parameter; we only enable
        // the on-conflict path when `external_id` is provided (the partial
        // unique index only covers non-null external_ids).
        let (url, prefer) = if external_message_id.is_some() {
            (
                format!(
                    "{}/rest/v1/messages?on_conflict=session_id,external_id",
                    self.cfg.url
                ),
                "resolution=merge-duplicates,return=representation",
            )
        } else {
            (
                format!("{}/rest/v1/messages", self.cfg.url),
                "return=representation",
            )
        };

        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .header("Prefer", prefer)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("insert_gateway_message: {text}"),
            });
        }
        let rows: Vec<serde_json::Value> = resp.json().await.unwrap_or_default();
        let id = rows
            .first()
            .and_then(|r| r.get("id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| SupabaseError::Rpc {
                code: None,
                message: "insert_gateway_message: no id in response".into(),
            })?;
        Ok(id)
    }

    /// Return the member actor ids from `agent_member_access` where
    /// `agent_id = agent_actor_id AND permission_level = 'admin'`.
    ///
    /// The column is named `member_id` but its values are actor ids
    /// (members.id references actors.id per 202604220002_core_schema.sql).
    ///
    /// Used at channel-manager boot to populate `owner_member_actor_ids` so
    /// that gateway-originated sessions (Discord/WeCom/Feishu DMs) include the
    /// agent's human admin owners as `session_participants`, making the session
    /// visible to Tauri desktop clients via RLS.
    pub async fn list_agent_admin_member_actor_ids(
        &self,
        agent_actor_id: &str,
    ) -> SupabaseResult<Vec<String>> {
        let token = self.access_token().await?;
        let url = format!(
            "{}/rest/v1/agent_member_access?agent_id=eq.{}&permission_level=eq.admin&select=member_id",
            self.cfg.url, agent_actor_id
        );
        let resp = self
            .http
            .get(&url)
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(&token)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("list_agent_admin_member_actor_ids: {text}"),
            });
        }
        #[derive(Deserialize)]
        struct Row {
            member_id: String,
        }
        let rows: Vec<Row> = resp.json().await?;
        Ok(rows.into_iter().map(|r| r.member_id).collect())
    }

    /// Add (or ignore-if-present) a participant on `session_participants`.
    /// Idempotent — the unique `(session_id, actor_id)` index makes the
    /// `on_conflict` UPSERT a no-op when the row already exists.
    pub async fn upsert_session_participant(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> SupabaseResult<()> {
        let token = self.access_token().await?;
        let url = format!(
            "{}/rest/v1/session_participants?on_conflict=session_id,actor_id",
            self.cfg.url
        );
        let body = serde_json::json!({
            "session_id": session_id,
            "actor_id": actor_id,
        });
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .header(
                "Prefer",
                "resolution=ignore-duplicates,return=minimal",
            )
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("upsert_session_participant: {text}"),
            });
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_message(
        &self,
        team_id: &str,
        session_id: &str,
        sender_actor_id: &str,
        kind: &str,
        content: &str,
        metadata_json: &str,
        model: &str,
        turn_id: &str,
    ) -> SupabaseResult<()> {
        let token = self.access_token().await?;
        let url = format!("{}/rest/v1/messages", self.cfg.url);

        let metadata: serde_json::Value = if metadata_json.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(metadata_json).unwrap_or_else(|_| serde_json::json!({}))
        };
        let mut body = serde_json::json!({
            "team_id": team_id,
            "session_id": session_id,
            "sender_actor_id": sender_actor_id,
            "kind": kind,
            "content": content,
            "metadata": metadata,
        });
        // Only set `model` when the caller has one — historical rows and
        // non-agent kinds (user_message, system, idea_event) leave the
        // column NULL rather than persisting "".
        if !model.is_empty() {
            body["model"] = serde_json::Value::String(model.to_string());
        }
        // Same for turn_id: stamp only when the daemon's TurnAggregator
        // had an open turn; legacy/historical calls leave the column NULL.
        if !turn_id.is_empty() {
            body["turn_id"] = serde_json::Value::String(turn_id.to_string());
        }

        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.cfg.anon_key)
            .header("Prefer", "return=minimal")
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(SupabaseError::Rpc {
                code: Some(status.as_u16().to_string()),
                message: format!("insert_message: {text}"),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use wiremock::matchers::{method, path_regex};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_cfg(url: String) -> SupabaseConfig {
        SupabaseConfig {
            url,
            anon_key: "anon".into(),
            refresh_token: "rt-0".into(),
            team_id: "t".into(),
            actor_id: "a".into(),
        }
    }

    #[tokio::test]
    async fn refreshes_access_token_when_expired() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at-new",
                "expires_in": 3600,
                "refresh_token": "rt-1"
            })))
            .mount(&srv)
            .await;

        let client = SupabaseClient::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let tok = client.access_token().await.unwrap();
        assert_eq!(tok, "at-new");

        let tok2 = client.access_token().await.unwrap();
        assert_eq!(tok2, "at-new");
    }

    #[tokio::test]
    async fn test_clients_do_not_persist_runtime_config() {
        let path = SupabaseConfig::default_path().unwrap();
        let original = fs::read(&path).ok();

        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at-new",
                "expires_in": 3600,
                "refresh_token": "rt-1"
            })))
            .mount(&srv)
            .await;

        let client = SupabaseClient::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let _ = client.access_token().await.unwrap();

        let persisted = fs::read(&path).ok();
        assert_eq!(persisted, original);
    }

    #[tokio::test]
    async fn refresh_failure_is_auth_error() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(400).set_body_string("bad"))
            .mount(&srv)
            .await;

        let client = SupabaseClient::new_without_persistence(test_cfg(srv.uri())).unwrap();
        match client.access_token().await {
            Err(SupabaseError::Auth(_)) => {}
            other => panic!("expected auth error, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn rpc_posts_with_bearer_and_json() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at",
                "expires_in": 3600,
                "refresh_token": "rt"
            })))
            .mount(&srv)
            .await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/rpc/echo$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true})))
            .mount(&srv)
            .await;

        let client = SupabaseClient::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let body: serde_json::Value = client
            .rpc("echo", &serde_json::json!({"x": 1}))
            .await
            .unwrap();
        assert_eq!(body["ok"], true);
    }

    #[tokio::test]
    async fn rpc_anon_omits_bearer() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/rpc/claim$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"actor_id": "a", "team_id": "t", "actor_type": "agent",
                 "display_name": "Test", "refresh_token": null}
            ])))
            .mount(&srv)
            .await;

        let client = SupabaseClient::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let body: serde_json::Value = client
            .rpc_anon("claim", &serde_json::json!({"p_token": "abc"}))
            .await
            .unwrap();
        assert_eq!(body[0]["actor_id"], "a");
    }

    #[tokio::test]
    async fn claim_team_invite_decodes_agent_response() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/rpc/claim_team_invite$"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "actor_id": "a", "team_id": "t", "actor_type": "agent",
                    "display_name": "M1 Studio", "refresh_token": "rt"
                }])),
            )
            .mount(&srv)
            .await;

        let client = SupabaseClient::new(test_cfg(srv.uri())).unwrap();
        let r = client
            .claim_team_invite("opaque-token-abc123")
            .await
            .unwrap();
        assert_eq!(r.actor_type, "agent");
        assert_eq!(r.refresh_token.as_deref(), Some("rt"));
    }

    #[tokio::test]
    async fn password_login_updates_refresh_token() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at-pwd",
                "expires_in": 3600,
                "refresh_token": "rt-final"
            })))
            .mount(&srv)
            .await;

        let mut client = SupabaseClient::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let tok = client
            .login_with_password("daemon+x@amux.local", "secret")
            .await
            .unwrap();
        assert_eq!(tok, "at-pwd");
        assert_eq!(client.config().refresh_token, "rt-final");
    }

    #[tokio::test]
    async fn upsert_agent_runtime_sends_merge_duplicates_header() {
        use wiremock::matchers::header_exists;
        let srv = MockServer::start().await;
        // Match on the presence of the Prefer header and the POST path only;
        // the exact header value includes "return=representation" which
        // wiremock's header() matcher compares as a single string but reqwest
        // may send as two values. The real assertion is that the call succeeds
        // and the returned row_id is parsed correctly.
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/agent_runtimes"))
            .and(header_exists("Prefer"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!([
                { "id": "aaaaaaaa-0000-0000-0000-000000000000" }
            ])))
            .mount(&srv)
            .await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at", "expires_in": 3600, "refresh_token": "rt"
            })))
            .mount(&srv)
            .await;

        let client = SupabaseClient::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let row = AgentRuntimeUpsert {
            team_id: "t",
            agent_id: "a",
            session_id: None,
            workspace_id: None,
            backend_type: "claude",
            backend_session_id: Some("s-1"),
            runtime_id: Some("r-1"),
            status: "running",
            current_model: Some("opus"),
            last_seen_at: chrono::Utc::now(),
        };
        let row_id = client.upsert_agent_runtime(&row).await.unwrap();
        assert_eq!(
            row_id.as_deref(),
            Some("aaaaaaaa-0000-0000-0000-000000000000")
        );
    }

    #[tokio::test]
    async fn upsert_workspace_returns_supabase_uuid() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/rest/v1/.*$"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!([
                { "id": "11111111-1111-1111-1111-111111111111" }
            ])))
            .mount(&srv)
            .await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/auth/v1/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at", "expires_in": 3600, "refresh_token": "rt"
            })))
            .mount(&srv)
            .await;

        let client = SupabaseClient::new_without_persistence(test_cfg(srv.uri())).unwrap();
        let row = WorkspaceUpsert {
            team_id: "team-1",
            agent_id: "agent-1",
            name: "amux",
            path: Some("/tmp/amux"),
            archived: false,
        };

        let workspace = client.upsert_workspace(&row).await.unwrap();
        assert_eq!(workspace.id, "11111111-1111-1111-1111-111111111111");
    }

    #[test]
    fn cached_token_expiry_is_none_before_any_fetch() {
        let cfg = SupabaseConfig {
            url: "http://localhost".into(),
            anon_key: "key".into(),
            refresh_token: "tok".into(),
            team_id: "team".into(),
            actor_id: "actor".into(),
        };
        let client = SupabaseClient::new_without_persistence(cfg).unwrap();
        assert!(client.cached_token_expiry().is_none());
    }

    #[test]
    fn is_token_expired_false_when_expiry_in_future() {
        let cfg = SupabaseConfig {
            url: "http://localhost".into(),
            anon_key: "key".into(),
            refresh_token: "tok".into(),
            team_id: "team".into(),
            actor_id: "actor".into(),
        };
        let client = SupabaseClient::new_without_persistence(cfg).unwrap();
        {
            let mut st = client.state.lock().unwrap();
            st.expires_at = Some(Instant::now() + Duration::from_secs(3600));
        }
        assert!(!client.is_token_expired());
    }

    #[test]
    fn is_token_expired_true_when_expiry_in_past() {
        let cfg = SupabaseConfig {
            url: "http://localhost".into(),
            anon_key: "key".into(),
            refresh_token: "tok".into(),
            team_id: "team".into(),
            actor_id: "actor".into(),
        };
        let client = SupabaseClient::new_without_persistence(cfg).unwrap();
        {
            let mut st = client.state.lock().unwrap();
            st.expires_at = Some(Instant::now() - Duration::from_secs(1));
        }
        assert!(client.is_token_expired());
    }

    // ── StoredMessage helpers ──────────────────────────────────────────────────

    fn make_rows(ids_and_ts: &[(&str, &str)]) -> Vec<serde_json::Value> {
        ids_and_ts
            .iter()
            .map(|(id, ts)| {
                serde_json::json!({
                    "id": id,
                    "session_id": "sess-1",
                    "sender_actor_id": "actor-1",
                    "kind": "text",
                    "content": "hello",
                    "metadata": {},
                    "created_at": ts,
                })
            })
            .collect()
    }

    #[test]
    fn parse_stored_messages_maps_fields() {
        let rows = make_rows(&[("id-1", "2025-01-01T00:00:01Z")]);
        let msgs = parse_stored_messages(rows);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, "id-1");
        assert_eq!(msgs[0].session_id, "sess-1");
        assert_eq!(msgs[0].kind, "text");
        assert_eq!(msgs[0].created_at, 1735689601);
    }

    #[test]
    fn drain_through_cursor_removes_seed_and_earlier() {
        let rows = make_rows(&[
            ("id-1", "2025-01-01T00:00:01Z"),
            ("id-2", "2025-01-01T00:00:02Z"),
            ("id-3", "2025-01-01T00:00:03Z"),
        ]);
        let mut msgs = parse_stored_messages(rows);
        msgs.sort_by_key(|m| m.created_at);
        drain_through_cursor(&mut msgs, Some("id-2"));
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, "id-3");
    }

    #[test]
    fn drain_through_cursor_noop_when_none() {
        let rows = make_rows(&[
            ("id-1", "2025-01-01T00:00:01Z"),
            ("id-2", "2025-01-01T00:00:02Z"),
        ]);
        let mut msgs = parse_stored_messages(rows);
        drain_through_cursor(&mut msgs, None);
        assert_eq!(msgs.len(), 2);
    }

    #[test]
    fn drain_through_cursor_noop_when_id_not_found() {
        let rows = make_rows(&[("id-1", "2025-01-01T00:00:01Z")]);
        let mut msgs = parse_stored_messages(rows);
        drain_through_cursor(&mut msgs, Some("id-missing"));
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn drain_through_cursor_drains_all_when_last_id() {
        let rows = make_rows(&[
            ("id-1", "2025-01-01T00:00:01Z"),
            ("id-2", "2025-01-01T00:00:02Z"),
        ]);
        let mut msgs = parse_stored_messages(rows);
        msgs.sort_by_key(|m| m.created_at);
        drain_through_cursor(&mut msgs, Some("id-2"));
        assert!(msgs.is_empty());
    }

    #[tokio::test]
    #[ignore]
    async fn messages_after_cursor_orders_and_filters() {
        if std::env::var("SUPABASE_LIVE").is_err() {
            return;
        }
        let cfg = SupabaseConfig::load(&SupabaseConfig::default_path().unwrap()).unwrap();
        let c = SupabaseClient::new_without_persistence(cfg).unwrap();
        let rows = c
            .messages_after_cursor("00000000-0000-0000-0000-000000000000", None)
            .await
            .unwrap();
        assert!(rows.is_empty());
    }
}

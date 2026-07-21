//! Tauri commands that let the frontend discover the daemon's local HTTP server.
//!
//! The daemon writes two runtime files when it starts its HTTP listener:
//! - `~/.amuxd/amuxd.http.port`  — the bound TCP port (decimal)
//! - `~/.amuxd/amuxd.http.token` — the root bearer token
//!
//! The desktop reads both and returns them to the frontend webview so it can
//! build authenticated requests against `http://127.0.0.1:{port}/v1/*`.

use serde::{Deserialize, Serialize};

/// Connection information for the daemon's local HTTP server.
#[derive(Debug, Serialize)]
pub struct DaemonHttpInfo {
    /// e.g. `"http://127.0.0.1:52341"`
    pub base_url: String,
    /// Root bearer token. The frontend should exchange this immediately via
    /// `POST /v1/auth/exchange` to obtain a scoped session token.
    pub root_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDaemonWorkspace {
    pub workspace_id: String,
    pub path: String,
    pub display_name: String,
    pub is_default: bool,
}

#[derive(Debug, Deserialize)]
struct ListWorkspacesResponse {
    #[serde(default)]
    workspaces: Vec<ListedWorkspaceRecord>,
}

#[derive(Debug, Deserialize)]
struct ListedWorkspaceRecord {
    workspace_id: String,
    path: String,
    display_name: String,
    #[serde(default)]
    is_default: bool,
}

/// Return the daemon HTTP base URL and root token, or `None` if the daemon is
/// not running or has not started its HTTP listener yet.
#[tauri::command]
pub async fn get_daemon_http_info() -> Result<Option<DaemonHttpInfo>, String> {
    let amuxd_dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join(".amuxd");

    let port_path = amuxd_dir.join("amuxd.http.port");
    let token_path = amuxd_dir.join("amuxd.http.token");

    let port_str = match std::fs::read_to_string(&port_path) {
        Ok(s) => s.trim().to_owned(),
        Err(_) => return Ok(None),
    };
    let port: u16 = match port_str.parse() {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };

    let root_token = match std::fs::read_to_string(&token_path) {
        Ok(s) => s.trim().to_owned(),
        Err(_) => return Ok(None),
    };

    Ok(Some(DaemonHttpInfo {
        base_url: format!("http://127.0.0.1:{port}"),
        root_token,
    }))
}

/// Minimal view of `~/.amuxd/daemon.toml` — just the field we surface.
#[derive(Debug, serde::Deserialize)]
struct DaemonConfigTeam {
    #[serde(default)]
    team_id: Option<String>,
}

/// The team this machine's daemon is onboarded to, read from
/// `~/.amuxd/daemon.toml`. `None` when the daemon hasn't been onboarded (no
/// config / no team_id) or the file can't be read.
///
/// The daemon is single-team: its `team_id` is set once at `amuxd init` and is
/// independent of whichever team the app currently has selected. The settings
/// UI compares the two and warns the user when they diverge, since team-share
/// content is synced/linked under the daemon's team, not the app's.
#[tauri::command]
pub async fn get_daemon_team_id() -> Result<Option<String>, String> {
    let config_path = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join(".amuxd")
        .join("daemon.toml");

    let body = match std::fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let parsed: DaemonConfigTeam = toml::from_str(&body).map_err(|e| e.to_string())?;
    Ok(parsed
        .team_id
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty()))
}

/// Minimal view of `~/.amuxd/backend.toml` — just the actor_id field.
#[derive(Debug, serde::Deserialize)]
struct BackendCloudApi {
    #[serde(default)]
    actor_id: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct BackendConfig {
    #[serde(default)]
    cloud_api: Option<BackendCloudApi>,
}

/// The daemon's actor_id, read from `~/.amuxd/backend.toml` (`[cloud_api]
/// actor_id`). This is the single routing identity persisted by `amuxd init`.
/// Returns an empty string when the daemon hasn't been onboarded (no config /
/// no actor_id) or the file can't be read — callers treat empty as "not ready".
pub(crate) fn read_daemon_actor_id() -> String {
    let config_path = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join(".amuxd")
        .join("backend.toml");

    let body = match std::fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    let parsed: BackendConfig = match toml::from_str(&body) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    parsed
        .cloud_api
        .and_then(|c| c.actor_id)
        .map(|a| a.trim().to_owned())
        .unwrap_or_default()
}

/// Return this daemon's team's on-disk workspaces via the daemon's loopback
/// `GET /v1/workspaces`, which sources from the cloud `amux.workspaces` table
/// (the sole source of truth) filtered to paths that exist on this machine.
///
/// Replaces reading `~/.amuxd/workspaces.toml` directly — that local mirror
/// was deleted; cron's workspace picker now goes through the same cloud-backed
/// endpoint the gateway's `list_workspaces`/`set_workspace` use.
///
/// Returns an empty list (not an error) when the daemon HTTP listener isn't
/// up yet (port/token files missing) so callers can treat it as a soft no-op.
#[tauri::command]
pub async fn list_local_daemon_workspaces() -> Result<Vec<LocalDaemonWorkspace>, String> {
    let amuxd_dir = match dirs::home_dir() {
        Some(h) => h.join(".amuxd"),
        None => return Ok(vec![]),
    };
    let port: u16 = match std::fs::read_to_string(amuxd_dir.join("amuxd.http.port")) {
        Ok(s) => match s.trim().parse() {
            Ok(p) => p,
            Err(_) => return Ok(vec![]),
        },
        Err(_) => return Ok(vec![]),
    };
    let root_token = match std::fs::read_to_string(amuxd_dir.join("amuxd.http.token")) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return Ok(vec![]),
    };
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();

    let exchange: DaemonAuthExchangeResponse = match client
        .post(format!("{base}/v1/auth/exchange"))
        .header("Authorization", format!("Bearer {root_token}"))
        .json(&serde_json::json!({
            "scopes": ["workspace:read"],
            "ttl_seconds": 300,
        }))
        .send()
        .await
        .and_then(|r| r.error_for_status())
    {
        Ok(resp) => match resp.json().await {
            Ok(v) => v,
            Err(_) => return Ok(vec![]),
        },
        Err(_) => return Ok(vec![]),
    };

    let listed: ListWorkspacesResponse = match client
        .get(format!("{base}/v1/workspaces"))
        .header("Authorization", format!("Bearer {}", exchange.token))
        .send()
        .await
        .and_then(|r| r.error_for_status())
    {
        Ok(resp) => match resp.json().await {
            Ok(v) => v,
            Err(_) => return Ok(vec![]),
        },
        Err(_) => return Ok(vec![]),
    };

    Ok(listed
        .workspaces
        .into_iter()
        .map(|w| LocalDaemonWorkspace {
            workspace_id: w.workspace_id,
            path: w.path,
            display_name: w.display_name,
            is_default: w.is_default,
        })
        .collect())
}

fn encode_workspace_id(workspace_path: &str) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    URL_SAFE_NO_PAD.encode(workspace_path.as_bytes())
}

#[derive(Debug, Deserialize)]
struct DaemonAuthExchangeResponse {
    token: String,
}

/// Cached `sessions:write` session token for the local RPC fast path, keyed
/// by base URL (the daemon binds a fresh loopback port on every restart).
/// Avoids one `/v1/auth/exchange` round-trip per RPC.
static DAEMON_RPC_TOKEN: std::sync::Mutex<Option<(String, String, std::time::Instant)>> =
    std::sync::Mutex::new(None);

async fn daemon_rpc_session_token(
    client: &reqwest::Client,
    base: &str,
    root_token: &str,
) -> Result<String, String> {
    if let Some((cached_base, token, expires_at)) = DAEMON_RPC_TOKEN.lock().unwrap().clone() {
        if cached_base == base && std::time::Instant::now() < expires_at {
            return Ok(token);
        }
    }
    let exchange: DaemonAuthExchangeResponse = client
        .post(format!("{base}/v1/auth/exchange"))
        .header("Authorization", format!("Bearer {root_token}"))
        .json(&serde_json::json!({
            "scopes": ["sessions:write"],
            "ttl_seconds": 3600,
        }))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("auth exchange: {e}"))?
        .json()
        .await
        .map_err(|e| format!("auth exchange decode: {e}"))?;
    // Refresh 5 minutes before the daemon-side expiry.
    let expires_at = std::time::Instant::now() + std::time::Duration::from_secs(3600 - 300);
    *DAEMON_RPC_TOKEN.lock().unwrap() =
        Some((base.to_string(), exchange.token.clone(), expires_at));
    Ok(exchange.token)
}

/// Local fast-path RPC: POST the given `teamclaw.RpcRequest` protobuf bytes
/// (base64) to the daemon's loopback `POST /v1/rpc` and return the
/// `teamclaw.RpcResponse` protobuf bytes (base64).
///
/// The webview calls this only when the target actor is this machine's
/// daemon; any error here makes the frontend fall back to the MQTT RPC path
/// transparently, so failures are returned as plain strings, never panics.
#[tauri::command]
pub async fn daemon_rpc(payload_b64: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let payload = STANDARD
        .decode(payload_b64.as_bytes())
        .map_err(|e| format!("invalid base64 payload: {e}"))?;
    let (base, root_token) =
        daemon_http_base().ok_or_else(|| "daemon http port/token files not present".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let token = daemon_rpc_session_token(&client, &base, &root_token).await?;
    let send = |token: String, payload: Vec<u8>| {
        let client = client.clone();
        let base = base.clone();
        async move {
            client
                .post(format!("{base}/v1/rpc"))
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/x-protobuf")
                .body(payload)
                .send()
                .await
                .map_err(|e| format!("rpc post: {e}"))
        }
    };

    let mut resp = send(token, payload.clone()).await?;
    if resp.status().as_u16() == 401 {
        // Session token revoked (e.g. daemon restart with a reused port) —
        // drop the cache and retry once with a fresh exchange.
        *DAEMON_RPC_TOKEN.lock().unwrap() = None;
        let token = daemon_rpc_session_token(&client, &base, &root_token).await?;
        resp = send(token, payload).await?;
    }
    let resp = resp
        .error_for_status()
        .map_err(|e| format!("rpc status: {e}"))?;
    let bytes = resp.bytes().await.map_err(|e| format!("rpc body: {e}"))?;
    Ok(STANDARD.encode(&bytes))
}

fn daemon_http_base() -> Option<(String, String)> {
    let amuxd_dir = dirs::home_dir()?.join(".amuxd");
    let port: u16 = std::fs::read_to_string(amuxd_dir.join("amuxd.http.port"))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let root_token = std::fs::read_to_string(amuxd_dir.join("amuxd.http.token"))
        .ok()?
        .trim()
        .to_string();
    Some((format!("http://127.0.0.1:{port}"), root_token))
}

#[derive(Debug, Deserialize)]
struct DaemonProviderInfo {
    id: String,
    #[serde(default)]
    models: Vec<String>,
}

/// `GET /v1/workspaces/:id/providers` — canonical LLM provider list for a workspace.
pub async fn fetch_workspace_provider_model_keys(
    workspace_path: &str,
) -> Option<std::collections::HashSet<String>> {
    let amuxd_dir = dirs::home_dir()?.join(".amuxd");
    let port: u16 = std::fs::read_to_string(amuxd_dir.join("amuxd.http.port"))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let root_token = std::fs::read_to_string(amuxd_dir.join("amuxd.http.token"))
        .ok()?
        .trim()
        .to_string();
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();

    let exchange: DaemonAuthExchangeResponse = client
        .post(format!("{base}/v1/auth/exchange"))
        .header("Authorization", format!("Bearer {root_token}"))
        .json(&serde_json::json!({
            "scopes": ["workspace:read"],
            "ttl_seconds": 300,
        }))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;

    let ws_id = encode_workspace_id(workspace_path);
    let providers: Vec<DaemonProviderInfo> = client
        .get(format!("{base}/v1/workspaces/{ws_id}/providers"))
        .header("Authorization", format!("Bearer {}", exchange.token))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;

    let mut keys = std::collections::HashSet::new();
    for provider in providers {
        for model_id in provider.models {
            keys.insert(format!(
                "{}/{}",
                provider.id.to_lowercase(),
                model_id.to_lowercase()
            ));
        }
    }
    Some(keys)
}

#[derive(Debug, Deserialize)]
struct DaemonCatalogModel {
    #[serde(rename = "ref")]
    model_ref: String,
}

#[derive(Debug, Deserialize)]
struct DaemonBackendCatalog {
    #[serde(default)]
    models: Vec<DaemonCatalogModel>,
}

#[derive(Debug, Deserialize)]
struct DaemonModelCatalog {
    #[serde(default)]
    backends: Vec<DaemonBackendCatalog>,
}

/// `GET /v1/workspaces/:id/model-catalog` — model refs across every configured
/// backend (OpenCode, Claude Code, Codex), lowercased for case-insensitive
/// validation. Unlike `fetch_workspace_provider_model_keys` (OpenCode only)
/// this is the source of truth for cron model validation, since a cron job may
/// pin a Claude or Codex model that the OpenCode provider list never reports.
pub async fn fetch_workspace_model_catalog_keys(
    workspace_path: &str,
) -> Option<std::collections::HashSet<String>> {
    let amuxd_dir = dirs::home_dir()?.join(".amuxd");
    let port: u16 = std::fs::read_to_string(amuxd_dir.join("amuxd.http.port"))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let root_token = std::fs::read_to_string(amuxd_dir.join("amuxd.http.token"))
        .ok()?
        .trim()
        .to_string();
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();

    let exchange: DaemonAuthExchangeResponse = client
        .post(format!("{base}/v1/auth/exchange"))
        .header("Authorization", format!("Bearer {root_token}"))
        .json(&serde_json::json!({
            "scopes": ["workspace:read"],
            "ttl_seconds": 300,
        }))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;

    let ws_id = encode_workspace_id(workspace_path);
    let catalog: DaemonModelCatalog = client
        .get(format!("{base}/v1/workspaces/{ws_id}/model-catalog"))
        .header("Authorization", format!("Bearer {}", exchange.token))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;

    let mut keys = std::collections::HashSet::new();
    for backend in catalog.backends {
        for model in backend.models {
            keys.insert(model.model_ref.to_lowercase());
        }
    }
    Some(keys)
}

#[derive(Debug, Deserialize)]
struct DaemonDefaultWorkspaceResponse {
    #[serde(default)]
    path: Option<String>,
}

/// `GET /v1/agent/default-workspace` — the daemon's own agent's default
/// working directory, resolved cloud-side from `agents.default_workspace_id`
/// (falling back to the team's first on-disk workspace). Replaces reading
/// `~/.amuxd/workspaces.toml`'s `default_workspace_id` directly: that local
/// file only tracks per-device workspace registrations, not the cloud
/// `agents` row that is now the source of truth for "which workspace does
/// this agent's cron/global work run in".
///
/// Returns `None` when the daemon HTTP listener isn't up yet, the daemon
/// isn't onboarded, or the daemon has no resolvable default (no agent
/// default configured and no on-disk team workspace either).
pub async fn fetch_daemon_default_workspace_path() -> Option<String> {
    let amuxd_dir = dirs::home_dir()?.join(".amuxd");
    let port: u16 = std::fs::read_to_string(amuxd_dir.join("amuxd.http.port"))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let root_token = std::fs::read_to_string(amuxd_dir.join("amuxd.http.token"))
        .ok()?
        .trim()
        .to_string();
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();

    let exchange: DaemonAuthExchangeResponse = client
        .post(format!("{base}/v1/auth/exchange"))
        .header("Authorization", format!("Bearer {root_token}"))
        .json(&serde_json::json!({
            "scopes": ["workspace:read"],
            "ttl_seconds": 300,
        }))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;

    let resp: DaemonDefaultWorkspaceResponse = client
        .get(format!("{base}/v1/agent/default-workspace"))
        .header("Authorization", format!("Bearer {}", exchange.token))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;

    resp.path.filter(|p| !p.trim().is_empty())
}

/// Workspace record returned by the daemon's `POST /v1/workspaces` endpoint.
/// Fields mirror the daemon's snake_case JSON (`RegisterWorkspaceResponseBody`).
#[derive(Debug, Serialize, Deserialize)]
pub struct RegisteredDaemonWorkspace {
    pub workspace_id: String,
    pub path: String,
    pub display_name: String,
}

/// Register `workspace_path` into the cloud `amux.workspaces` table (the
/// sole source of truth) by calling the daemon's loopback
/// `POST /v1/workspaces`. Idempotent — safe to call on every launch. The
/// desktop registers the user's chosen project workspace, not the daemon's
/// internal `~/.amuxd/teams/<id>` global sync store (that path is rejected).
///
/// Returns `Ok(None)` when the daemon HTTP listener isn't up yet (port/token
/// files missing) so the caller can treat it as a soft no-op and retry later.
#[tauri::command]
pub async fn register_daemon_workspace(
    workspace_path: String,
) -> Result<Option<RegisteredDaemonWorkspace>, String> {
    let path = workspace_path.trim().to_string();
    if path.is_empty() {
        return Err("workspace_path must not be empty".into());
    }

    let amuxd_dir = dirs::home_dir()
        .ok_or_else(|| "no home dir".to_string())?
        .join(".amuxd");
    if std::path::Path::new(&path).starts_with(&amuxd_dir) {
        return Err(format!(
            "workspace path must not be inside the daemon config directory (~/.amuxd): {path}"
        ));
    }

    // `apply_add_workspace` requires the path to already exist (it
    // canonicalizes + checks `is_dir`). For a freshly-onboarded team the global
    // dir `~/.amuxd/teams/<teamId>` may not exist yet — the daemon only
    // scaffolds `teamclaw-team/` inside it once a workspace is linked. Create it
    // up front so registration succeeds; the daemon then fills in the synced
    // `teamclaw-team/` via ensure_team_link.
    if let Err(e) = std::fs::create_dir_all(&path) {
        return Err(format!("create workspace dir {path}: {e}"));
    }

    let amuxd_dir = match dirs::home_dir() {
        Some(h) => h.join(".amuxd"),
        None => return Ok(None),
    };
    let port: u16 = match std::fs::read_to_string(amuxd_dir.join("amuxd.http.port")) {
        Ok(s) => match s.trim().parse() {
            Ok(p) => p,
            Err(_) => return Ok(None),
        },
        Err(_) => return Ok(None),
    };
    let root_token = match std::fs::read_to_string(amuxd_dir.join("amuxd.http.token")) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return Ok(None),
    };
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();

    let exchange: DaemonAuthExchangeResponse = client
        .post(format!("{base}/v1/auth/exchange"))
        .header("Authorization", format!("Bearer {root_token}"))
        .json(&serde_json::json!({
            "scopes": ["workspace:write"],
            "ttl_seconds": 300,
        }))
        .send()
        .await
        .map_err(|e| format!("auth exchange request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("auth exchange rejected: {e}"))?
        .json()
        .await
        .map_err(|e| format!("auth exchange decode failed: {e}"))?;

    let registered: RegisteredDaemonWorkspace = client
        .post(format!("{base}/v1/workspaces"))
        .header("Authorization", format!("Bearer {}", exchange.token))
        .json(&serde_json::json!({ "path": path }))
        .send()
        .await
        .map_err(|e| format!("register workspace request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("register workspace rejected: {e}"))?
        .json()
        .await
        .map_err(|e| format!("register workspace decode failed: {e}"))?;

    Ok(Some(registered))
}

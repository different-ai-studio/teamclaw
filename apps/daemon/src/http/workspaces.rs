//! `/v1/workspaces/:id/*` route handlers for workspace control-plane APIs.
//!
//! These handlers own the HTTP surface for all workspace-scoped settings:
//! providers, permissions, allowlist, and runtime status. They delegate
//! all reads/writes to `HttpState::workspace_control` so they never touch
//! `opencode.json` or the allowlist file directly.
//!
//! When `workspace_control` is `None` (no store configured) every handler
//! returns 404 with code `not_found`. This lets focused session/runtime
//! tests run without a workspace store.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::config::provider_auth::{builtin_provider_auth_methods, ProviderAuthMethodsResponse};
use crate::config::workspace_control::{
    decode_workspace_path, AllowlistRule, ApplyOutcome, ManagedSkillDto, McpServerConfig,
    PermissionConfig, ProviderAuthRequest, ProviderInfo, RoleRecordDto, RolesSkillsStateDto,
    RuntimeStatus, UpsertRoleRequest, UpsertSkillRequest, WorkspaceControlError,
    WorkspaceControlStore,
};
use crate::opencode_settings::LiveProviderCatalog;
use crate::opencode_settings::OpenCodeSettingsError;
use crate::proto::amux;
use crate::runtime::refresh::{RefreshChangeKind, RefreshSource};
use std::collections::HashMap;
use std::path::Path as StdPath;

use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;

// ── Helpers ──────────────────────────────────────────────────────────────────

fn resolve_store(state: &HttpState) -> Result<&Arc<dyn WorkspaceControlStore>, HttpError> {
    state
        .workspace_control
        .as_ref()
        .ok_or_else(|| HttpError::not_found("workspace control not configured"))
}

fn map_control_err(e: WorkspaceControlError) -> HttpError {
    match e {
        WorkspaceControlError::WorkspaceNotFound(id) => {
            HttpError::not_found(format!("workspace {id} not found"))
        }
        WorkspaceControlError::NotFound(msg) => HttpError::not_found(msg),
        WorkspaceControlError::Io(e) => HttpError::internal(format!("io error: {e}")),
        WorkspaceControlError::Parse(e) => HttpError::internal(format!("parse error: {e}")),
        WorkspaceControlError::InvalidInput(msg) => HttpError::validation(msg),
    }
}

fn resolve_opencode_settings(
    state: &HttpState,
) -> Result<&Arc<crate::opencode_settings::OpenCodeSettingsService>, HttpError> {
    state
        .opencode_settings
        .as_ref()
        .ok_or_else(|| HttpError::runtime_unavailable("opencode settings service not configured"))
}

fn map_settings_err(e: OpenCodeSettingsError) -> HttpError {
    match e {
        OpenCodeSettingsError::OpencodeBinaryMissing(_)
        | OpenCodeSettingsError::SpawnFailed(_)
        | OpenCodeSettingsError::StartTimeout => HttpError::runtime_unavailable(e.to_string()),
        OpenCodeSettingsError::Api { status, detail } if (400..500).contains(&status) => {
            HttpError::validation(format!("opencode: {detail}"))
        }
        OpenCodeSettingsError::Api { status, detail } => {
            HttpError::internal(format!("opencode settings api {status}: {detail}"))
        }
        OpenCodeSettingsError::Http(msg) => HttpError::internal(msg),
    }
}

async fn workspace_path_or_404(workspace_id: &str) -> Result<std::path::PathBuf, HttpError> {
    let wpath = decode_workspace_path(workspace_id).map_err(map_control_err)?;
    if !wpath.is_dir() {
        return Err(HttpError::not_found(format!(
            "workspace {workspace_id} not found"
        )));
    }
    Ok(wpath)
}

async fn record_skills_refresh_change(
    state: &HttpState,
    workspace_id: &str,
    workspace_path: &StdPath,
) {
    let Some(refresh) = state.runtime_refresh.as_ref() else {
        return;
    };
    if let Err(error) = refresh
        .record_change(
            workspace_id,
            workspace_path,
            RefreshChangeKind::Skills,
            RefreshSource::UiMutation,
        )
        .await
    {
        tracing::warn!(
            workspace_id = %workspace_id,
            workspace_path = %workspace_path.display(),
            error = %error,
            "failed to record skills refresh change after workspace mutation"
        );
    }
}

/// Reload workspace runtimes so ACP picks up provider credential changes (OAuth / apiKey).
async fn reload_runtime_after_provider_auth(
    state: &HttpState,
    workspace_id: &str,
    workspace_path: &std::path::Path,
) -> ApplyOutcome {
    if let Some(supervisor) = state.runtime_supervisor.as_ref() {
        match supervisor
            // Explicit provider-auth reload path: always refresh the hosts.
            .reload_workspace(workspace_id, workspace_path, true)
            .await
        {
            Ok(outcome) => return outcome,
            Err(e) => {
                tracing::warn!(
                    workspace_id = %workspace_id,
                    error = %e,
                    "runtime reload after provider auth failed"
                );
            }
        }
    }
    ApplyOutcome::ReloadRequired
}

// ── Shared response wrapper ───────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ApplyResponse {
    pub outcome: ApplyOutcome,
}

fn apply_ok(outcome: ApplyOutcome) -> Json<ApplyResponse> {
    Json(ApplyResponse { outcome })
}

// ── Agent default-workspace handler ───────────────────────────────────────────

/// Response for `GET /v1/agent/default-workspace`.
#[derive(Serialize)]
pub struct DefaultWorkspaceResponse {
    /// The resolved filesystem path, or `None` when the daemon has no cloud
    /// backend attached, no agent default configured (and the team has no
    /// on-disk workspace to fall back to), or the daemon isn't onboarded.
    pub path: Option<String>,
}

/// `GET /v1/agent/default-workspace` — resolve the daemon's own agent's
/// default working directory via the cloud `agents.default_workspace_id` +
/// `amux.workspaces` tables, falling back to the team's first workspace whose
/// local path exists on this machine.
///
/// This is the same resolution `DaemonServer::resolve_cron_default_workspace`
/// (`daemon/server/cron.rs`) performs for daemon-local cron turns, exposed as
/// a stateless HTTP lookup for callers with no cloud JWT of their own — e.g.
/// the desktop's background cron scheduler, which only holds a loopback root
/// token, not an interactive Supabase session.
pub async fn get_default_workspace(
    principal: Principal,
    State(state): State<HttpState>,
) -> Result<Json<DefaultWorkspaceResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;

    let Some(backend) = state.backend.as_ref() else {
        return Ok(Json(DefaultWorkspaceResponse { path: None }));
    };

    // Build a fresh resolver over the same backend so this stateless HTTP
    // lookup applies the exact same resolution + fallback algorithm as
    // `DaemonServer::resolve_cron_default_workspace` (`daemon/server/cron.rs`),
    // just for the authenticated principal's own actor id rather than the
    // daemon's primary agent.
    let resolver = crate::config::WorkspaceResolver::new(backend.clone());
    let actor_id = backend.actor_id().to_string();
    let team_id = backend.team_id().to_string();
    let team_id = if team_id.trim().is_empty() {
        None
    } else {
        Some(team_id.as_str())
    };

    let path =
        crate::config::resolve_default_workspace_path(backend, &resolver, team_id, &actor_id).await;
    Ok(Json(DefaultWorkspaceResponse { path }))
}

// ── Provider handlers ─────────────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/providers`
pub async fn get_providers(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<ProviderInfo>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    // `provider.team` is synced from the team's cloud LLM config via
    // `sync_team_provider_on_disk` before this handler reads straight off disk.
    // Without that step, an admin's model-list change would only reach this member
    // at their next runtime spawn — app restarts included.
    reconcile_team_provider(&state, &workspace_id).await;
    let mut providers = store
        .get_providers(&workspace_id)
        .map_err(map_control_err)?;
    if let Some(settings) = state.opencode_settings.as_ref() {
        if let Ok(wpath) = workspace_path_or_404(&workspace_id).await {
            if let Ok(catalog) = settings.provider_catalog(&wpath).await {
                merge_live_provider_catalog(&mut providers, &catalog);
            } else if let Ok(connected) = settings.connected_provider_ids(&wpath).await {
                for provider in &mut providers {
                    if connected.iter().any(|id| id == &provider.id) {
                        provider.authenticated = true;
                    }
                }
            }
        }
    }
    Ok(Json(providers))
}

/// Re-materialize `provider.team` via [`teamclaw_runtime_env::sync_team_provider_on_disk`], best-effort.
///
/// Silently no-ops when the daemon has no managed-LLM resolver (focused tests),
/// no cloud backend, no team, or an unresolvable workspace path — in each case
/// there is nothing authoritative to reconcile against, and the caller should
/// still serve whatever is on disk rather than fail the read.
async fn reconcile_team_provider(state: &HttpState, workspace_id: &str) {
    let Some(managed_llm) = state.managed_llm.as_ref() else {
        return;
    };
    let Some(backend) = state.backend.as_ref() else {
        return;
    };
    let team_id = backend.team_id().to_string();
    if team_id.trim().is_empty() {
        return;
    }
    let Ok(wpath) = workspace_path_or_404(workspace_id).await else {
        return;
    };
    managed_llm
        .reconcile_workspace(&wpath, team_id.trim())
        .await;
}

fn merge_live_provider_catalog(providers: &mut Vec<ProviderInfo>, catalog: &LiveProviderCatalog) {
    for connected_id in &catalog.connected {
        if let Some(live) = catalog.providers.get(connected_id) {
            if let Some(existing) = providers.iter_mut().find(|p| p.id == *connected_id) {
                existing.authenticated = true;
                if existing.models.is_empty() {
                    existing.models = live.model_ids.clone();
                }
                if existing.display_name == existing.id {
                    existing.display_name = live.display_name.clone();
                }
            } else {
                providers.push(ProviderInfo {
                    id: live.id.clone(),
                    display_name: live.display_name.clone(),
                    authenticated: true,
                    base_url: None,
                    models: live.model_ids.clone(),
                });
            }
        } else if let Some(existing) = providers.iter_mut().find(|p| p.id == *connected_id) {
            existing.authenticated = true;
        } else {
            providers.push(ProviderInfo {
                id: connected_id.clone(),
                display_name: connected_id.clone(),
                authenticated: true,
                base_url: None,
                models: Vec::new(),
            });
        }
    }
}

/// `POST /v1/workspaces/:id/providers/:provider_id/auth`
///
/// Creates or replaces the authentication credentials for a provider entry.
pub async fn put_provider_auth(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
    Json(body): Json<ProviderAuthRequest>,
) -> Result<(StatusCode, Json<ApplyResponse>), HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let _file_outcome = store
        .put_provider_auth(&workspace_id, &provider_id, body)
        .map_err(map_control_err)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let outcome = reload_runtime_after_provider_auth(&state, &workspace_id, &wpath).await;
    Ok((StatusCode::OK, apply_ok(outcome)))
}

/// `GET /v1/workspaces/:id/provider-auth-methods`
///
/// Auth methods per provider: live OpenCode `GET /provider/auth` merged with
/// built-in OAuth fallbacks when the settings server is unavailable.
pub async fn get_provider_auth_methods(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<ProviderAuthMethodsResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let _store = resolve_store(&state)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    if let Some(settings) = state.opencode_settings.as_ref() {
        match settings.provider_auth_methods(&wpath).await {
            Ok(methods) => return Ok(Json(methods)),
            Err(
                e @ (OpenCodeSettingsError::OpencodeBinaryMissing(_)
                | OpenCodeSettingsError::SpawnFailed(_)
                | OpenCodeSettingsError::StartTimeout),
            ) => {
                tracing::warn!(error = %e, "opencode settings unavailable; using builtin auth catalog");
            }
            Err(e) => return Err(map_settings_err(e)),
        }
    }
    Ok(Json(builtin_provider_auth_methods()))
}

#[derive(Debug, Deserialize)]
pub struct ProviderOAuthAuthorizeRequest {
    #[serde(default)]
    pub method_index: u32,
    #[serde(default)]
    pub inputs: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct ProviderOAuthAuthorizeResponse {
    pub url: String,
    pub method: String,
    pub instructions: String,
}

/// `POST /v1/workspaces/:id/providers/:provider_id/oauth/authorize`
pub async fn post_provider_oauth_authorize(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
    Json(body): Json<ProviderOAuthAuthorizeRequest>,
) -> Result<Json<ProviderOAuthAuthorizeResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let _store = resolve_store(&state)?;
    let settings = resolve_opencode_settings(&state)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let result = settings
        .oauth_authorize(&wpath, &provider_id, body.method_index, &body.inputs)
        .await
        .map_err(map_settings_err)?;
    Ok(Json(ProviderOAuthAuthorizeResponse {
        url: result.url,
        method: result.method,
        instructions: result.instructions,
    }))
}

#[derive(Debug, Deserialize)]
pub struct ProviderOAuthCallbackRequest {
    #[serde(default)]
    pub method_index: u32,
    pub code: Option<String>,
}

/// `POST /v1/workspaces/:id/providers/:provider_id/oauth/callback`
pub async fn post_provider_oauth_callback(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
    Json(body): Json<ProviderOAuthCallbackRequest>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let _store = resolve_store(&state)?;
    let settings = resolve_opencode_settings(&state)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    settings
        .oauth_callback(
            &wpath,
            &provider_id,
            body.method_index,
            body.code.as_deref(),
        )
        .await
        .map_err(map_settings_err)?;
    let outcome = reload_runtime_after_provider_auth(&state, &workspace_id, &wpath).await;
    Ok(apply_ok(outcome))
}

/// `DELETE /v1/workspaces/:id/providers/:provider_id/auth`
pub async fn delete_provider_auth(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
) -> Result<(StatusCode, Json<ApplyResponse>), HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    if let Some(settings) = state.opencode_settings.as_ref() {
        if let Ok(wpath) = workspace_path_or_404(&workspace_id).await {
            if let Err(e) = settings.remove_provider_auth(&wpath, &provider_id).await {
                tracing::warn!(
                    provider_id = %provider_id,
                    error = %e,
                    "opencode remove auth failed; continuing with workspace store delete"
                );
            }
        }
    }
    let _file_outcome = store
        .delete_provider_auth(&workspace_id, &provider_id)
        .map_err(map_control_err)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let outcome = reload_runtime_after_provider_auth(&state, &workspace_id, &wpath).await;
    Ok((StatusCode::OK, apply_ok(outcome)))
}

// ── Model catalog ─────────────────────────────────────────────────────────────
//
// `GET /v1/workspaces/:id/model-catalog` returns the workspace's available
// models grouped by the agent backend that would actually run them. This is the
// single source of truth for the cron job dialog (and future automation
// settings), replacing the old behavior of showing only OpenCode providers
// regardless of which backend the daemon runs.
//
// Per-backend model sources:
//   - opencode: live ACP `configOptions[id=model]` when probe succeeds; else
//     `opencode.json` providers as fallback
//   - claude:   the runtime's static Claude model table
//   - codex:    the runtime's static Codex model table (empty today)

/// A single selectable model within a backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CatalogModel {
    /// Stable reference stored as the cron payload model string. Always
    /// `"<providerSegment>/<modelId>"` so the existing `provider/model` wire
    /// format (parsed by `parse_model_preference`) keeps working. Single-agent
    /// mode: always the opencode form `"<provider>/<modelId>"`.
    #[serde(rename = "ref")]
    pub model_ref: String,
    pub model_id: String,
    pub display_name: String,
}

/// Models available under one agent backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackendCatalog {
    /// Backend id as reported by the daemon (single-agent mode: `"opencode"`).
    pub backend: String,
    /// Human-readable label for the backend group header.
    pub label: String,
    pub models: Vec<CatalogModel>,
}

/// Full per-backend model catalog for a workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelCatalog {
    /// Backend a cron job runs on when it doesn't specify one — always
    /// `"opencode"` in single-agent mode; `None` when no backend is configured.
    pub automation_default_backend: Option<String>,
    pub backends: Vec<BackendCatalog>,
}

fn backend_label(backend: &str) -> &'static str {
    match backend {
        "opencode" => "OpenCode",
        "claude" => "Claude Code",
        "codex" => "Codex",
        _ => "Agent",
    }
}

fn catalog_models_from_acp(acp_models: &[amux::ModelInfo]) -> Vec<CatalogModel> {
    acp_models
        .iter()
        .map(|m| CatalogModel {
            model_ref: m.id.clone(),
            model_id: m.id.clone(),
            display_name: m.display_name.clone(),
        })
        .collect()
}

fn catalog_models_from_opencode_json(opencode_providers: &[ProviderInfo]) -> Vec<CatalogModel> {
    opencode_providers
        .iter()
        .flat_map(|p| {
            p.models.iter().map(move |model_id| CatalogModel {
                model_ref: format!("{}/{}", p.id, model_id),
                model_id: model_id.clone(),
                display_name: model_id.clone(),
            })
        })
        .collect()
}

/// Build the catalog from the configured backend list. OpenCode prefers the
/// live ACP probe list when provided; otherwise falls back to `opencode.json`.
pub fn build_model_catalog(
    configured_agent_types: &[String],
    opencode_acp_models: Option<&[amux::ModelInfo]>,
    opencode_providers: &[ProviderInfo],
) -> ModelCatalog {
    let mut backends = Vec::new();

    // Single-agent mode: only the opencode backend group is ever served.
    // (`configured_agent_types` comes from `supported_agent_type_names`, which
    // now only emits "opencode"; anything else is skipped defensively.)
    for backend in configured_agent_types {
        if backend != "opencode" {
            continue;
        }
        let mut models: Vec<CatalogModel> = opencode_acp_models
            .filter(|m| !m.is_empty())
            .map(catalog_models_from_acp)
            .unwrap_or_else(|| catalog_models_from_opencode_json(opencode_providers));
        if models.is_empty() {
            // Static opencode fallback table (serve unreachable, no providers).
            models = catalog_models_from_acp(&crate::runtime::models::available_models_for(
                amux::AgentType::Opencode,
            ));
        }
        backends.push(BackendCatalog {
            backend: backend.clone(),
            label: backend_label(backend).to_string(),
            models,
        });
    }

    let automation_default_backend = backends
        .iter()
        .any(|b| b.backend == "opencode")
        .then(|| "opencode".to_string());

    ModelCatalog {
        automation_default_backend,
        backends,
    }
}

/// `GET /v1/workspaces/:id/model-catalog`
pub async fn get_model_catalog(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<ModelCatalog>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let providers = store
        .get_providers(&workspace_id)
        .map_err(map_control_err)?;

    let opencode_acp_models = if state
        .meta
        .configured_agent_types
        .iter()
        .any(|b| b == "opencode")
    {
        match workspace_path_or_404(&workspace_id).await {
            Ok(wpath) => {
                if let Some(supervisor) = state.runtime_supervisor.as_ref() {
                    match supervisor.probe_opencode_catalog_models(&wpath).await {
                        Ok(models) if !models.is_empty() => Some(models),
                        Ok(_) => {
                            tracing::debug!(
                                workspace_id,
                                "opencode ACP catalog probe returned no models; using opencode.json fallback"
                            );
                            None
                        }
                        Err(e) => {
                            tracing::warn!(
                                workspace_id,
                                error = %e,
                                "opencode ACP catalog probe failed; using opencode.json fallback"
                            );
                            None
                        }
                    }
                } else {
                    None
                }
            }
            Err(_) => None,
        }
    } else {
        None
    };

    let catalog = build_model_catalog(
        &state.meta.configured_agent_types,
        opencode_acp_models.as_deref(),
        &providers,
    );
    Ok(Json(catalog))
}

// ── Permission handlers ───────────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/permissions`
pub async fn get_permissions(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<PermissionConfig>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let config = store
        .get_permissions(&workspace_id)
        .map_err(map_control_err)?;
    Ok(Json(config))
}

/// `PUT /v1/workspaces/:id/permissions`
pub async fn put_permissions(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
    Json(body): Json<PermissionConfig>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let outcome = store
        .put_permissions(&workspace_id, body)
        .map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}

// ── Allowlist handlers ────────────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/permission-allowlist`
pub async fn get_allowlist(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<AllowlistRule>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let rules = store
        .get_allowlist(&workspace_id)
        .map_err(map_control_err)?;
    Ok(Json(rules))
}

/// `PUT /v1/workspaces/:id/permission-allowlist`
pub async fn put_allowlist(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
    Json(body): Json<Vec<AllowlistRule>>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let outcome = store
        .put_allowlist(&workspace_id, body)
        .map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}

// ── MCP handlers ─────────────────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/mcp`
pub async fn get_mcp(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<HashMap<String, McpServerConfig>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    crate::runtime::supervisor::ensure_inherent_mcp(&wpath).map_err(map_control_err)?;
    crate::config::team_mcp::materialize_team_mcp_for_runtime(&wpath).map_err(map_control_err)?;
    let store = resolve_store(&state)?;
    let servers = store.get_mcp(&workspace_id).map_err(map_control_err)?;
    Ok(Json(servers))
}

/// `PUT /v1/workspaces/:id/mcp`
///
/// Replaces the entire MCP server map for a workspace. Callers should
/// fetch the current map with GET, apply their change, and PUT the full map.
pub async fn put_mcp(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
    Json(body): Json<HashMap<String, McpServerConfig>>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let store = resolve_store(&state)?;
    let outcome = store
        .put_mcp(&workspace_id, body)
        .map_err(map_control_err)?;
    // PUT replaces the full map; re-seed built-in entries the UI always shows.
    crate::runtime::supervisor::ensure_inherent_mcp(&wpath).map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}

#[derive(Deserialize)]
pub struct McpToolsQuery {
    #[serde(default)]
    pub refresh: bool,
}

/// `GET /v1/workspaces/:id/mcp/tools`
pub async fn get_mcp_tools(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
    Query(query): Query<McpToolsQuery>,
) -> Result<Json<crate::mcp_probe::McpToolsResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    crate::runtime::supervisor::ensure_inherent_mcp(&wpath).map_err(map_control_err)?;
    crate::config::team_mcp::materialize_team_mcp_for_runtime(&wpath).map_err(map_control_err)?;
    let store = resolve_store(&state)?;
    let servers = store.get_mcp(&workspace_id).map_err(map_control_err)?;
    let response =
        crate::mcp_probe::probe_all_servers(&wpath, servers, query.refresh, &workspace_id).await;
    Ok(Json(response))
}

#[derive(Serialize)]
pub struct MaterializeTeamMcpResponse {
    pub changed: bool,
    pub added_count: usize,
}

/// `POST /v1/workspaces/:id/mcp/materialize-team`
///
/// Materialize team-shared MCP definitions from `teamclaw-team/.mcp/*.json`
/// into this workspace's `opencode.json`. Only amuxd writes the file (atomic +
/// process-local lock). Desktop/git join flows call this instead of touching
/// `opencode.json` directly.
pub async fn materialize_team_mcp(
    principal: Principal,
    Path(workspace_id): Path<String>,
) -> Result<Json<MaterializeTeamMcpResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    crate::runtime::supervisor::ensure_inherent_mcp(&wpath).map_err(map_control_err)?;
    let outcome = crate::config::team_mcp::materialize_team_mcp_for_runtime(&wpath)
        .map_err(map_control_err)?;
    Ok(Json(MaterializeTeamMcpResponse {
        changed: outcome.changed,
        added_count: outcome.added_count,
    }))
}

// ── Roles & skills handlers ───────────────────────────────────────────────────
pub async fn get_roles_skills(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<RolesSkillsStateDto>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let payload = store
        .get_roles_skills_state(&workspace_id)
        .map_err(map_control_err)?;
    Ok(Json(payload))
}

/// `GET /v1/workspaces/:id/skills`
pub async fn get_skills(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<ManagedSkillDto>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let skills = store.get_skills(&workspace_id).map_err(map_control_err)?;
    Ok(Json(skills))
}

/// `GET /v1/workspaces/:id/roles`
pub async fn get_roles(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<RoleRecordDto>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let roles = store.get_roles(&workspace_id).map_err(map_control_err)?;
    Ok(Json(roles))
}

#[derive(serde::Deserialize)]
pub struct DeleteSkillQuery {
    #[serde(default, rename = "dirPath")]
    dir_path: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct DeleteRoleQuery {
    #[serde(default, rename = "filePath")]
    file_path: Option<String>,
}

/// `PUT /v1/workspaces/:id/skills/:slug`
pub async fn put_skill(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, slug)): Path<(String, String)>,
    Json(body): Json<UpsertSkillRequest>,
) -> Result<Json<ManagedSkillDto>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    if body.content.trim().is_empty() {
        return Err(HttpError::validation("content must not be empty"));
    }
    let store = resolve_store(&state)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let skill = store
        .put_skill(&workspace_id, &slug, body)
        .map_err(map_control_err)?;
    record_skills_refresh_change(&state, &workspace_id, &wpath).await;
    Ok(Json(skill))
}

/// `DELETE /v1/workspaces/:id/skills/:slug`
pub async fn delete_skill(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, slug)): Path<(String, String)>,
    Query(query): Query<DeleteSkillQuery>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let outcome = store
        .delete_skill(&workspace_id, &slug, query.dir_path.as_deref())
        .map_err(map_control_err)?;
    record_skills_refresh_change(&state, &workspace_id, &wpath).await;
    Ok(apply_ok(outcome))
}

/// `PUT /v1/workspaces/:id/roles/:slug`
pub async fn put_role(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, slug)): Path<(String, String)>,
    Json(body): Json<UpsertRoleRequest>,
) -> Result<Json<RoleRecordDto>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    if body.raw_markdown.trim().is_empty() {
        return Err(HttpError::validation("raw_markdown must not be empty"));
    }
    let store = resolve_store(&state)?;
    let role = store
        .put_role(&workspace_id, &slug, body)
        .map_err(map_control_err)?;
    Ok(Json(role))
}

/// `DELETE /v1/workspaces/:id/roles/:slug`
pub async fn delete_role(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, slug)): Path<(String, String)>,
    Query(query): Query<DeleteRoleQuery>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let outcome = store
        .delete_role(&workspace_id, &slug, query.file_path.as_deref())
        .map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}

// ── Runtime status handlers ───────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/runtime`
pub async fn get_runtime(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<RuntimeStatus>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let workspace_path = decode_workspace_path(&workspace_id).map_err(map_control_err)?;

    if let Some(supervisor) = state.runtime_supervisor.as_ref() {
        let status = supervisor
            .runtime_status(&workspace_id, &workspace_path)
            .await
            .map_err(map_control_err)?;
        return Ok(Json(status));
    }

    let store = resolve_store(&state)?;
    let mut status = store
        .get_runtime_status(&workspace_id)
        .map_err(map_control_err)?;
    if let Some(refresh) = state.runtime_refresh.as_ref() {
        status.refresh = refresh.runtime_refresh_dto(&workspace_id).await;
    }
    Ok(Json(status))
}

/// `POST /v1/workspaces/:id/runtime/reload`
pub async fn reload_runtime(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let workspace_path = decode_workspace_path(&workspace_id).map_err(map_control_err)?;

    if let Some(supervisor) = state.runtime_supervisor.as_ref() {
        let outcome = supervisor
            // Explicit user-triggered apply: refresh provider hosts too.
            .apply_refresh(&workspace_id, &workspace_path, true)
            .await
            .map_err(map_control_err)?;
        return Ok(apply_ok(outcome));
    }

    let store = resolve_store(&state)?;
    let attempt = if let Some(refresh) = state.runtime_refresh.as_ref() {
        Some(refresh.mark_applying(&workspace_id, &workspace_path).await)
    } else {
        None
    };
    let outcome = match store.reload_runtime(&workspace_id) {
        Ok(outcome) => outcome,
        Err(err) => {
            if let (Some(refresh), Some(attempt)) = (state.runtime_refresh.as_ref(), attempt) {
                refresh
                    .mark_apply_failed(&workspace_id, &workspace_path, attempt, err.to_string())
                    .await;
            }
            return Err(map_control_err(err));
        }
    };
    if let (Some(refresh), Some(attempt)) = (state.runtime_refresh.as_ref(), attempt) {
        refresh.clear_applied(&workspace_id, attempt).await;
    }
    Ok(apply_ok(outcome))
}

// ── GET /v1/workspaces — list this daemon's team's on-disk workspaces ──────────

#[derive(Debug, Serialize)]
pub struct ListedWorkspace {
    /// Cloud `amux.workspaces` row id.
    pub workspace_id: String,
    pub path: String,
    pub display_name: String,
    pub is_default: bool,
}

#[derive(Debug, Serialize)]
pub struct ListWorkspacesResponse {
    pub workspaces: Vec<ListedWorkspace>,
}

/// `GET /v1/workspaces` — list workspaces belonging to this daemon's team
/// from the cloud `amux.workspaces` table (the sole source of truth),
/// filtered to rows whose path exists as a directory on *this* machine. The
/// desktop uses this for the cron workspace picker instead of reading the
/// now-deleted `~/.amuxd/workspaces.toml`.
///
/// Requires `workspace:read`. Returns an empty list when the daemon has no
/// cloud backend attached or isn't onboarded to a team yet.
pub async fn list_workspaces(
    principal: Principal,
    State(state): State<HttpState>,
) -> Result<Json<ListWorkspacesResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;

    let Some(backend) = state.backend.as_ref() else {
        return Ok(Json(ListWorkspacesResponse { workspaces: vec![] }));
    };
    let team_id = backend.team_id().to_string();
    if team_id.trim().is_empty() {
        return Ok(Json(ListWorkspacesResponse { workspaces: vec![] }));
    }

    let rows = backend
        .get_workspaces_by_team(&team_id)
        .await
        .map_err(|e| HttpError::internal(format!("get_workspaces_by_team: {e}")))?;

    let default_id = backend
        .get_agent_defaults(backend.actor_id())
        .await
        .ok()
        .and_then(|d| d.default_workspace_id);

    let workspaces = rows
        .into_iter()
        .filter_map(|row| {
            let path = row.path.as_deref()?.trim();
            if path.is_empty() || !crate::config::workspace_path::is_linkable_workspace_path(path) {
                return None;
            }
            if !StdPath::new(path).is_dir() {
                return None;
            }
            let display_name = StdPath::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string());
            Some(ListedWorkspace {
                is_default: default_id.as_deref() == Some(row.id.as_str()),
                workspace_id: row.id,
                path: path.to_string(),
                display_name,
            })
        })
        .collect();

    Ok(Json(ListWorkspacesResponse { workspaces }))
}

// ── POST /v1/workspaces — register a workspace (cloud) ────────

#[derive(Debug, Deserialize)]
pub struct RegisterWorkspaceBody {
    /// Absolute workspace path to register. The caller is responsible for
    /// expanding `~` (the desktop passes a fully-resolved path).
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct RegisterWorkspaceResponseBody {
    /// Cloud `amux.workspaces` row id.
    pub workspace_id: String,
    pub path: String,
    pub display_name: String,
}

/// `POST /v1/workspaces` — register `path` into the cloud `amux.workspaces`
/// table (the sole source of truth).
///
/// Idempotent: re-registering an existing path returns its current record
/// without creating a duplicate (the actor's `apply_add_workspace` still tops
/// up the cloud row + default if either is missing). The desktop calls this for
/// the user's project workspace after onboarding — not for `~/.amuxd` paths.
///
/// Requires `workspace:write`. Returns 503 when no daemon actor is wired behind
/// the HTTP server (focused tests).
pub async fn register_workspace(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<RegisterWorkspaceBody>,
) -> Result<Json<RegisterWorkspaceResponseBody>, HttpError> {
    require_scope(&principal, "workspace:write")?;

    let path = body.path.trim().to_string();
    if path.is_empty() {
        return Err(HttpError::validation("path must not be empty"));
    }

    let tx = state
        .register_workspace_tx
        .as_ref()
        .ok_or_else(|| HttpError::runtime_unavailable("workspace registration not available"))?;

    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel::<String>();
    tx.send(crate::http::state::RegisterWorkspaceRequest { path, reply_tx })
        .await
        .map_err(|_| HttpError::runtime_unavailable("daemon actor unavailable"))?;

    let reply = reply_rx
        .await
        .map_err(|_| HttpError::internal("daemon actor dropped the request"))?;

    let value: serde_json::Value = serde_json::from_str(&reply)
        .map_err(|e| HttpError::internal(format!("malformed actor reply: {e}")))?;

    if value.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        let result = value
            .get("result")
            .ok_or_else(|| HttpError::internal("actor reply missing result"))?;
        Ok(Json(RegisterWorkspaceResponseBody {
            workspace_id: result
                .get("workspace_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            path: result
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            display_name: result
                .get("display_name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        }))
    } else {
        let error = value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("workspace registration failed")
            .to_string();
        Err(HttpError::internal(error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str, models: &[&str]) -> ProviderInfo {
        ProviderInfo {
            id: id.to_string(),
            display_name: id.to_string(),
            authenticated: true,
            base_url: None,
            models: models.iter().map(|m| m.to_string()).collect(),
        }
    }

    #[test]
    fn opencode_json_fallback_uses_provider_prefixed_ref() {
        let providers = vec![provider("scnet", &["MiniMax-M2.5"])];
        let catalog = build_model_catalog(&["opencode".to_string()], None, &providers);

        assert_eq!(
            catalog.automation_default_backend.as_deref(),
            Some("opencode")
        );
        let oc = &catalog.backends[0];
        assert_eq!(oc.models[0].model_ref, "scnet/MiniMax-M2.5");
        assert_eq!(oc.models[0].model_id, "MiniMax-M2.5");
    }

    #[test]
    fn opencode_prefers_acp_probe_models_when_present() {
        let acp = vec![amux::ModelInfo {
            id: "opencode/big-pickle".into(),
            display_name: "Big Pickle".into(),
            provider_name: "opencode".into(),
        }];
        let providers = vec![provider("scnet", &["MiniMax-M2.5"])];
        let catalog = build_model_catalog(&["opencode".to_string()], Some(&acp), &providers);

        let oc = &catalog.backends[0];
        assert_eq!(oc.models.len(), 1);
        assert_eq!(oc.models[0].model_ref, "opencode/big-pickle");
        assert_eq!(oc.models[0].display_name, "Big Pickle");
    }

    #[test]
    fn legacy_backend_names_yield_no_catalog_groups() {
        // Single-agent mode: only "opencode" is served; legacy names are
        // skipped defensively even if they somehow reach the catalog builder.
        let catalog = build_model_catalog(
            &[
                "claude".to_string(),
                "codex".to_string(),
                "opencode".to_string(),
            ],
            None,
            &[],
        );
        assert_eq!(
            catalog.automation_default_backend.as_deref(),
            Some("opencode")
        );
        assert_eq!(catalog.backends.len(), 1);
        assert_eq!(catalog.backends[0].backend, "opencode");
    }

    #[test]
    fn opencode_without_live_or_provider_models_uses_static_fallback() {
        let catalog = build_model_catalog(&["opencode".to_string()], None, &[]);
        let oc = &catalog.backends[0];
        assert_eq!(oc.models.len(), 1);
        assert_eq!(
            oc.models[0].model_ref,
            crate::runtime::models::OPENCODE_FALLBACK_MODEL_ID
        );
    }

    #[test]
    fn empty_config_yields_no_default_and_no_backends() {
        let catalog = build_model_catalog(&[], None, &[]);
        assert!(catalog.automation_default_backend.is_none());
        assert!(catalog.backends.is_empty());
    }
}

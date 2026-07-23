//! Public route table for the browser-facing HTTP API.
//!
//! PR1 ships the floor: `/v1/healthz` and `/v1/info`. Later PRs add
//! `/v1/auth/*`, `/v1/sessions/*`, `/v1/sessions/:id/stream`, etc.

use axum::{
    extract::State,
    middleware,
    response::Html,
    routing::{delete, get, post, put, MethodRouter},
    Json, Router,
};

use super::apps;
use super::auth;
use super::config;
use super::limit::{body_limit_layer, rate_limit_layer};
use super::live_events;
use super::observ::request_id_layer;
use super::rpc;
use super::sessions;
use super::setup;
use super::state::HttpState;
use super::team;
use super::team_sync;
use super::workspaces;

pub fn build(state: HttpState) -> Router {
    let body_cap = state.config.max_body_bytes;
    Router::new()
        .route("/v1/healthz", healthz_route())
        .route("/v1/info", info_route())
        // Embedded protocol console. Static zero-dependency HTML inlined into
        // the binary; it drives this same daemon's /v1/sessions API over fetch
        // + SSE and shows every event frame for debugging. Auth is carried by
        // the page via `?access_token=` (the desktop mints a scoped session
        // token and opens this URL) — the HTML itself holds no secret.
        .route("/v1/ui", get(ui_route))
        // First-run onboarding. `status` is unauthenticated (it only reveals
        // whether setup is needed); `claim` is root-token gated — see
        // `http::setup` for why neither uses a scope.
        .route("/v1/setup", get(setup_ui_route))
        .route("/v1/setup/status", get(setup::setup_status))
        .route("/v1/setup/claim", post(setup::setup_claim))
        // Daemon-level config (`admin` scope). Per-workspace settings live
        // under /v1/workspaces/*; these keys are daemon-wide.
        .route("/v1/config", get(config::list_config))
        .route("/v1/config/reload", post(config::reload_config))
        .route(
            "/v1/config/:key",
            get(config::get_config)
                .merge(put(config::set_config))
                .merge(delete(config::unset_config)),
        )
        .route("/v1/auth/exchange", post(auth::exchange_handler))
        .route("/v1/auth/revoke", post(auth::revoke_handler))
        .route("/v1/auth/tokens", get(auth::list_tokens_handler))
        .route(
            "/v1/sessions",
            post(sessions::create_session).get(sessions::list_sessions),
        )
        .route(
            "/v1/sessions/:id",
            get(sessions::get_session).merge(delete(sessions::delete_session)),
        )
        .route("/v1/sessions/:id/prompt", post(sessions::send_prompt))
        .route("/v1/sessions/:id/cancel", post(sessions::cancel))
        .route("/v1/sessions/:id/model", post(sessions::set_model))
        .route(
            "/v1/sessions/:id/permissions/:request_id",
            post(sessions::reply_permission),
        )
        .route("/v1/sessions/:id/restart", post(sessions::restart))
        .route("/v1/sessions/:id/events", get(sessions::replay_events))
        .route("/v1/sessions/:id/stream", get(sessions::stream))
        // Local fast-path: mirrors session/live MQTT publishes over SSE so a
        // same-machine UI streams independently of broker RTT/availability.
        .route("/v1/live/events", get(live_events::stream))
        // Local fast-path RPC: same protobuf envelope as the MQTT
        // `amux/{team}/{actor}/rpc/req` topic, dispatched over loopback so a
        // same-machine UI's commands skip the broker round-trip.
        .route("/v1/rpc", post(rpc::dispatch))
        // Register a workspace into the cloud `amux.workspaces` table
        // (idempotent). Used by the desktop on first launch to ensure its
        // default team workspace (`~/.amuxd/teams/<teamId>`) exists there.
        // GET lists this daemon's team's workspaces, filtered to paths that
        // exist on this machine — the desktop uses this for cron's
        // workspace picker instead of reading `workspaces.toml` directly.
        .route(
            "/v1/workspaces",
            post(workspaces::register_workspace).get(workspaces::list_workspaces),
        )
        // The daemon's own agent default workspace, resolved from the cloud
        // (`agents.default_workspace_id` -> `amux.workspaces`), with a
        // team-first-on-disk-workspace fallback. Used by the desktop's cron
        // scheduler, which has no interactive cloud JWT of its own.
        .route(
            "/v1/agent/default-workspace",
            get(workspaces::get_default_workspace),
        )
        // App-repo seeding: clone empty managed-git repo, write starter
        // template, first commit + push. Kicked by the desktop after the cloud
        // API creates the app's repo.
        .route("/v1/apps/seed", post(apps::seed_app))
        // App build: pnpm build + zip `.output`, upload artifact to a presigned
        // OSS PUT URL. Kicked by the cloud deploy orchestration.
        .route("/v1/apps/build", post(apps::build_app))
        // Workspace control-plane APIs (Phase B/C)
        .route(
            "/v1/workspaces/:id/providers",
            get(workspaces::get_providers),
        )
        .route(
            "/v1/workspaces/:id/providers/:provider_id/auth",
            post(workspaces::put_provider_auth).delete(workspaces::delete_provider_auth),
        )
        .route(
            "/v1/workspaces/:id/provider-auth-methods",
            get(workspaces::get_provider_auth_methods),
        )
        .route(
            "/v1/workspaces/:id/providers/:provider_id/oauth/authorize",
            post(workspaces::post_provider_oauth_authorize),
        )
        .route(
            "/v1/workspaces/:id/providers/:provider_id/oauth/callback",
            post(workspaces::post_provider_oauth_callback),
        )
        .route(
            "/v1/workspaces/:id/model-catalog",
            get(workspaces::get_model_catalog),
        )
        .route(
            "/v1/workspaces/:id/permissions",
            get(workspaces::get_permissions).put(workspaces::put_permissions),
        )
        .route(
            "/v1/workspaces/:id/permission-allowlist",
            get(workspaces::get_allowlist).put(workspaces::put_allowlist),
        )
        .route(
            "/v1/workspaces/:id/mcp",
            get(workspaces::get_mcp).put(workspaces::put_mcp),
        )
        .route(
            "/v1/workspaces/:id/mcp/tools",
            get(workspaces::get_mcp_tools),
        )
        .route(
            "/v1/workspaces/:id/mcp/materialize-team",
            post(workspaces::materialize_team_mcp),
        )
        .route(
            "/v1/workspaces/:id/roles-skills",
            get(workspaces::get_roles_skills),
        )
        .route("/v1/workspaces/:id/skills", get(workspaces::get_skills))
        .route(
            "/v1/workspaces/:id/skills/:slug",
            put(workspaces::put_skill).delete(workspaces::delete_skill),
        )
        .route("/v1/workspaces/:id/roles", get(workspaces::get_roles))
        .route(
            "/v1/workspaces/:id/roles/:slug",
            put(workspaces::put_role).delete(workspaces::delete_role),
        )
        .route("/v1/workspaces/:id/runtime", get(workspaces::get_runtime))
        .route(
            "/v1/workspaces/:id/runtime/reload",
            post(workspaces::reload_runtime),
        )
        // Team-share: materialize the global dir + workspace symlink on demand
        // (called by the app right after enabling/joining team-share).
        .route("/v1/team/link", post(team::link_team_workspace))
        .route("/v1/team/unlink", post(team::unlink_team_workspace))
        // Daemon-owned team sync: desktop triggers sync + reads status over loopback.
        .route("/v1/team/sync", post(team_sync::sync_now))
        .route("/v1/team/sync/status", get(team_sync::sync_status))
        .route(
            "/v1/team/secrets",
            post(team_sync::set_secrets).get(team_sync::get_secrets),
        )
        .route("/v1/team/conflicts", get(team_sync::list_conflicts))
        .route(
            "/v1/team/conflicts/resolve",
            post(team_sync::resolve_conflict),
        )
        .route("/v1/team/versions", get(team_sync::list_versions))
        .route(
            "/v1/team/versions/restore",
            post(team_sync::restore_version),
        )
        .route("/v1/team/file", get(team_sync::get_file))
        .route("/v1/team/changed", get(team_sync::list_changed))
        .layer(body_limit_layer(body_cap))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            rate_limit_layer,
        ))
        .layer(middleware::from_fn(request_id_layer))
        .with_state(state)
}

/// Embedded protocol console page (see `ui/chat.html`). Served
/// unauthenticated — it is static markup; every data call it makes carries
/// the caller's session token.
const CHAT_UI_HTML: &str = include_str!("ui/chat.html");
static SETUP_UI_HTML: &str = include_str!("ui/setup.html");

async fn ui_route() -> Html<&'static str> {
    Html(CHAT_UI_HTML)
}

/// Setup console. Like the chat console it is static, dependency-free HTML
/// inlined into the binary — a fresh install has no asset server, and this
/// page must render before the daemon is configured at all.
async fn setup_ui_route() -> Html<&'static str> {
    Html(SETUP_UI_HTML)
}

fn healthz_route() -> MethodRouter<HttpState> {
    get(|| async { Json(serde_json::json!({ "status": "ok" })) })
}

fn info_route() -> MethodRouter<HttpState> {
    get(info_handler)
}

#[derive(serde::Serialize)]
struct InfoBody {
    version: &'static str,
    started_at: chrono::DateTime<chrono::Utc>,
    uptime_seconds: i64,
    actor_id: String,
    backend_kind: String,
    /// Cloud-auth session health. Omitted when the backend exposes no auth
    /// surface (e.g. focused tests). `status: "expired"` means the refresh
    /// token was terminally rejected and the daemon needs re-onboarding — the
    /// desktop polls this to trigger auto re-onboard.
    #[serde(skip_serializing_if = "Option::is_none")]
    cloud_auth: Option<CloudAuthInfo>,
    /// Agent backends this daemon has configured locally (from daemon.toml).
    /// Authoritative regardless of cloud state, so the desktop can show the
    /// daemon's agents even when the cloud advertise is failing.
    configured_agent_types: Vec<String>,
    /// Status of advertising `configured_agent_types` to the cloud.
    /// `advertised: false` with a non-null `lastError` means the cloud never
    /// accepted the types (e.g. permission/RLS denied) — surfaced here instead
    /// of being swallowed in a daemon log line.
    agent_types_advertise: crate::http::state::AgentTypesAdvertise,
    /// Whether the daemon's MQTT connection is currently established.
    mqtt_connected: bool,
}

#[derive(serde::Serialize)]
struct CloudAuthInfo {
    /// `"ok"` | `"expired"`. Coarse status only — the raw auth-backend error is
    /// kept out of this unauthenticated endpoint.
    status: &'static str,
}

async fn info_handler(State(state): State<HttpState>) -> Json<InfoBody> {
    let uptime = chrono::Utc::now()
        .signed_duration_since(state.meta.started_at)
        .num_seconds();
    let cloud_auth = state
        .backend
        .as_ref()
        .and_then(|b| b.cloud_auth_health())
        .map(|h| CloudAuthInfo {
            status: if h.terminal_failure { "expired" } else { "ok" },
        });
    Json(InfoBody {
        version: state.meta.version,
        started_at: state.meta.started_at,
        uptime_seconds: uptime,
        actor_id: state.meta.actor_id.clone(),
        backend_kind: state.meta.backend_kind.clone(),
        cloud_auth,
        configured_agent_types: state.meta.configured_agent_types.clone(),
        agent_types_advertise: state.meta.agent_types_advertise.lock().clone(),
        mqtt_connected: state
            .meta
            .mqtt_connected
            .load(std::sync::atomic::Ordering::Relaxed),
    })
}

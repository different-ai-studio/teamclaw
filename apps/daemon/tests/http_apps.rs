//! HTTP integration test for `POST /v1/apps/seed`.
//!
//! Spins the daemon HTTP server with a session token, points
//! `TEAMCLAW_APP_TEMPLATE_URL` at a local git template, seeds a bare remote,
//! and verifies pushed files via `git cat-file` (bare `file://` clones are
//! unreliable on Linux CI).

#[path = "../src/backend/mod.rs"]
mod backend;
#[path = "../src/config/mod.rs"]
mod config;
#[path = "../src/error.rs"]
mod error;
#[path = "../src/http/mod.rs"]
mod http;
#[path = "../src/mcp_probe.rs"]
mod mcp_probe;
#[path = "../src/opencode_settings/mod.rs"]
mod opencode_settings;
#[path = "../src/proto.rs"]
mod proto;
#[path = "../src/provider_config.rs"]
mod provider_config;
#[path = "../src/runtime/mod.rs"]
mod runtime;
#[path = "../src/sync/mod.rs"]
mod sync;
#[path = "../src/team_link.rs"]
mod team_link;
#[path = "../src/team_shared_env.rs"]
mod team_shared_env;
#[path = "../src/team_shared_git.rs"]
mod team_shared_git;

use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use backend::{
    AgentRuntimeRow, AgentRuntimeUpsert, Backend, BackendResult, BackendSessionAndParticipants,
    ClaimResult, ManagedGitCredential, ShareModeConfig, StoredMessage, WorkspaceRow,
    WorkspaceUpsert,
};
use config::HttpConfig;
use http::runtime_adapter::RuntimeManagerAdapter;
use reqwest::Client;
use serde_json::Value;
use tokio::sync::Mutex;

/// Minimal `Backend` for the credential-fetch test. Only `managed_git_credential`
/// is exercised by the seed path; every other method panics so an accidental
/// call is loud rather than silently wrong. The `team_id`/`actor_id` getters are
/// trivial because the seed handler never reads them.
#[derive(Clone)]
struct CredentialMockBackend {
    cred: ManagedGitCredential,
}

#[async_trait]
impl Backend for CredentialMockBackend {
    fn team_id(&self) -> &str {
        "team-mock"
    }
    fn actor_id(&self) -> &str {
        "actor-mock"
    }
    async fn auth_token(&self) -> BackendResult<String> {
        Ok("mock-token".into())
    }
    async fn managed_git_credential(&self, _team_id: &str) -> BackendResult<ManagedGitCredential> {
        Ok(self.cred.clone())
    }
    async fn get_effective_default_agent(&self, _team_id: &str) -> BackendResult<Option<String>> {
        Ok(None)
    }
    async fn team_share_config(&self, _team_id: &str) -> BackendResult<ShareModeConfig> {
        unimplemented!("not used by seed test")
    }
    async fn claim_team_invite(&self, _token: &str) -> BackendResult<ClaimResult> {
        unimplemented!("not used by seed test")
    }
    async fn upsert_agent_runtime(
        &self,
        _row: &AgentRuntimeUpsert<'_>,
    ) -> BackendResult<Option<String>> {
        unimplemented!("not used by seed test")
    }
    async fn fetch_agent_runtime_for_session(
        &self,
        _session_id: &str,
        _runtime_id: &str,
        _backend_session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>> {
        unimplemented!("not used by seed test")
    }
    async fn fetch_latest_runtime_for_session(
        &self,
        _agent_id: &str,
        _session_id: &str,
    ) -> BackendResult<Option<AgentRuntimeRow>> {
        unimplemented!("not used by seed test")
    }
    async fn ensure_agent_types(
        &self,
        _supported_types: &[String],
        _default_agent_type: &str,
    ) -> BackendResult<()> {
        unimplemented!("not used by seed test")
    }
    async fn check_agent_permission(
        &self,
        _agent_id: &str,
        _actor_id: &str,
    ) -> BackendResult<Option<String>> {
        unimplemented!("not used by seed test")
    }
    async fn heartbeat(&self) -> BackendResult<()> {
        unimplemented!("not used by seed test")
    }
    async fn report_client_version(&self, _device_id: &str) -> BackendResult<()> {
        unimplemented!("not used by seed test")
    }
    async fn upsert_workspace(&self, _row: &WorkspaceUpsert<'_>) -> BackendResult<WorkspaceRow> {
        unimplemented!("not used by seed test")
    }
    async fn get_workspaces_by_ids(&self, _ids: &[String]) -> BackendResult<Vec<WorkspaceRow>> {
        unimplemented!("not used by seed test")
    }
    async fn get_workspaces_by_team(&self, _team_id: &str) -> BackendResult<Vec<WorkspaceRow>> {
        unimplemented!("not used by seed test")
    }
    async fn set_agent_default_workspace(&self, _workspace_id: &str) -> BackendResult<()> {
        unimplemented!("not used by seed test")
    }
    async fn fetch_session_with_participants(
        &self,
        _session_id: &str,
    ) -> BackendResult<BackendSessionAndParticipants> {
        unimplemented!("not used by seed test")
    }
    async fn messages_after_cursor(
        &self,
        _session_id: &str,
        _after_id: Option<&str>,
    ) -> BackendResult<Vec<StoredMessage>> {
        unimplemented!("not used by seed test")
    }
    async fn update_runtime_cursor(
        &self,
        _runtime_row_id: &str,
        _last_processed_message_id: &str,
    ) -> BackendResult<()> {
        unimplemented!("not used by seed test")
    }
    async fn rpc_upsert_external_actor(
        &self,
        _team_id: &str,
        _source: &str,
        _source_id: &str,
        _display_name: &str,
    ) -> BackendResult<String> {
        unimplemented!("not used by seed test")
    }
    async fn get_gateway_session_by_acp_id(
        &self,
        _acp_session_id: &str,
    ) -> BackendResult<Option<(String, Option<String>)>> {
        unimplemented!("not used by seed test")
    }
    async fn rpc_ensure_gateway_session(
        &self,
        _team_id: &str,
        _binding: &str,
        _title: &str,
        _primary_agent_actor_id: &str,
        _owner_member_actor_ids: &[String],
        _participant_actor_ids: &[String],
    ) -> BackendResult<(String, String, bool)> {
        unimplemented!("not used by seed test")
    }
    async fn insert_gateway_message(
        &self,
        _session_id: &str,
        _sender_actor_id: &str,
        _content: &str,
        _external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        unimplemented!("not used by seed test")
    }
    async fn insert_gateway_message_with_attachments(
        &self,
        _session_id: &str,
        _sender_actor_id: &str,
        _content: &str,
        _external_message_id: Option<&str>,
        _attachments: serde_json::Value,
    ) -> BackendResult<String> {
        unimplemented!("not used by seed test")
    }
    async fn upload_attachment_bytes(
        &self,
        _path: &str,
        _bytes: Vec<u8>,
        _mime: &str,
    ) -> BackendResult<String> {
        unimplemented!("not used by seed test")
    }
    async fn list_agent_admin_member_actor_ids(
        &self,
        _agent_actor_id: &str,
    ) -> BackendResult<Vec<String>> {
        unimplemented!("not used by seed test")
    }
    async fn upsert_session_participant(
        &self,
        _session_id: &str,
        _actor_id: &str,
    ) -> BackendResult<()> {
        unimplemented!("not used by seed test")
    }
    async fn create_cron_session(
        &self,
        _team_id: &str,
        _primary_agent_actor_id: &str,
        _title: &str,
    ) -> BackendResult<String> {
        unimplemented!("not used by seed test")
    }
    async fn insert_message(
        &self,
        _id: &str,
        _team_id: &str,
        _session_id: &str,
        _sender_actor_id: &str,
        _kind: &str,
        _content: &str,
        _metadata_json: &str,
        _model: &str,
        _turn_id: &str,
        _reply_to_message_id: &str,
        _sequence: u64,
    ) -> BackendResult<()> {
        unimplemented!("not used by seed test")
    }
}

struct TestApp {
    _handle: http::server::HttpHandle,
    client: Client,
    base: String,
    session_token: String,
}

async fn test_app() -> (TestApp, tempfile::TempDir) {
    test_app_with_backend(None).await
}

async fn test_app_with_backend(backend: Option<Arc<dyn Backend>>) -> (TestApp, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let token_path = dir.path().join("token");
    let cfg = HttpConfig {
        bind: "127.0.0.1:0".into(),
        token_file: Some(token_path.clone()),
        port_file: Some(dir.path().join("port")),
        heartbeat_interval: Duration::from_secs(5),
        ..HttpConfig::default()
    };
    let manager = Arc::new(Mutex::new(runtime::RuntimeManager::new(
        std::collections::HashMap::new(),
        None,
    )));
    let runtime = RuntimeManagerAdapter::new(manager, 256, None);
    let dispatcher =
        sync::dispatch::SyncDispatcher::new(sync::secret_store::SecretStore::new(), None);
    let handle = http::spawn(
        cfg,
        http::server::metadata("actor".into(), "test"),
        runtime,
        None,
        None,
        None,
        dispatcher,
        None,
        backend,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("spawn http server");
    let base = format!("http://{}", handle.local_addr);
    let root = std::fs::read_to_string(&token_path)
        .expect("read root token")
        .trim()
        .to_owned();
    let client = Client::new();
    let resp: Value = client
        .post(format!("{base}/v1/auth/exchange"))
        .bearer_auth(&root)
        .json(&serde_json::json!({
            "ttl_seconds": 3600,
            "scopes": ["workspace:read", "workspace:write"]
        }))
        .send()
        .await
        .expect("exchange response")
        .error_for_status()
        .expect("exchange status")
        .json()
        .await
        .expect("exchange body");
    let session_token = resp["token"].as_str().expect("session token").to_string();

    (
        TestApp {
            _handle: handle,
            client,
            base,
            session_token,
        },
        dir,
    )
}

fn git(args: &[&str], cwd: &std::path::Path) {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn template_file_url(path: &std::path::Path) -> String {
    let abs = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    format!("file://{}", abs.to_string_lossy())
}

/// Local non-bare git template (matches production GitHub-style remotes).
fn init_template_git_repo(parent: &std::path::Path) -> String {
    let template = parent.join("template");
    std::fs::create_dir_all(template.join("src")).unwrap();
    std::fs::write(template.join("README.md"), "# seeded app").unwrap();
    std::fs::write(template.join("src/main.tsx"), "export const x = 1;").unwrap();
    git(
        &["init", "--initial-branch=main", template.to_str().unwrap()],
        parent,
    );
    git(&["-C", template.to_str().unwrap(), "add", "-A"], parent);
    git(
        &[
            "-C",
            template.to_str().unwrap(),
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-m",
            "template",
        ],
        parent,
    );
    template_file_url(&template)
}

fn bare_has_file(bare: &std::path::Path, rel: &str) -> bool {
    Command::new("git")
        .args([
            "--git-dir",
            &bare.to_string_lossy(),
            "cat-file",
            "-e",
            &format!("main:{rel}"),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn assert_remote_has_template(bare: &std::path::Path) {
    assert!(
        bare_has_file(bare, "README.md"),
        "README.md missing in remote"
    );
    assert!(
        bare_has_file(bare, "src/main.tsx"),
        "src/main.tsx missing in remote"
    );
}

#[tokio::test]
async fn seed_app_clones_template_and_pushes() {
    let (app, dir) = test_app().await;

    // Bare repo acts as the empty managed-git remote.
    let bare = dir.path().join("remote.git");
    git(&["init", "--bare", bare.to_str().unwrap()], dir.path());

    let prev_template_url = std::env::var_os("TEAMCLAW_APP_TEMPLATE_URL");
    let template_url = init_template_git_repo(dir.path());
    std::env::set_var("TEAMCLAW_APP_TEMPLATE_URL", &template_url);

    // Fresh, non-existent clone target.
    let workdir = dir.path().join("work");

    let resp = app
        .client
        .post(format!("{}/v1/apps/seed", app.base))
        .bearer_auth(&app.session_token)
        .json(&serde_json::json!({
            "appId": "app-test",
            "workspaceId": "ws-test",
            "workdir": workdir.to_str().unwrap(),
            "gitRemoteUrl": bare.to_str().unwrap(),
        }))
        .send()
        .await
        .expect("seed response");

    assert_eq!(resp.status(), 200, "expected 200, got {}", resp.status());
    let body: Value = resp.json().await.expect("json body");
    assert_eq!(body["status"], "ready");

    assert_remote_has_template(&bare);

    match prev_template_url {
        Some(v) => std::env::set_var("TEAMCLAW_APP_TEMPLATE_URL", v),
        None => std::env::remove_var("TEAMCLAW_APP_TEMPLATE_URL"),
    }
}

#[tokio::test]
async fn seed_app_pulls_team_managed_git_credential() {
    // No gitToken in the body → the handler must JIT-fetch the team-scoped
    // managed-git credential from the cloud backend and use it for the push.
    let mock = CredentialMockBackend {
        cred: ManagedGitCredential {
            username: "teamclaw".into(),
            token: "pt-xyz".into(),
        },
    };
    let backend: Arc<dyn Backend> = Arc::new(mock);
    let (app, dir) = test_app_with_backend(Some(backend)).await;

    // Bare repo acts as the empty managed-git remote (accepts any/no creds).
    let bare = dir.path().join("remote.git");
    git(&["init", "--bare", bare.to_str().unwrap()], dir.path());

    let prev_template_url = std::env::var_os("TEAMCLAW_APP_TEMPLATE_URL");
    let template_url = init_template_git_repo(dir.path());
    std::env::set_var("TEAMCLAW_APP_TEMPLATE_URL", &template_url);

    // Fresh, non-existent clone target.
    let workdir = dir.path().join("work");

    let resp = app
        .client
        .post(format!("{}/v1/apps/seed", app.base))
        .bearer_auth(&app.session_token)
        .json(&serde_json::json!({
            "appId": "app-test",
            "teamId": "team-1",
            "workspaceId": "ws-test",
            "workdir": workdir.to_str().unwrap(),
            "gitRemoteUrl": bare.to_str().unwrap(),
            // NB: no gitToken — credential must come from the backend.
        }))
        .send()
        .await
        .expect("seed response");

    assert_eq!(resp.status(), 200, "expected 200, got {}", resp.status());
    let body: Value = resp.json().await.expect("json body");
    assert_eq!(body["status"], "ready");

    assert_remote_has_template(&bare);

    match prev_template_url {
        Some(v) => std::env::set_var("TEAMCLAW_APP_TEMPLATE_URL", v),
        None => std::env::remove_var("TEAMCLAW_APP_TEMPLATE_URL"),
    }
}

#[tokio::test]
async fn seed_app_requires_scope() {
    let (app, dir) = test_app().await;
    // Mint a token without workspace:write.
    let token_path = dir.path().join("token");
    let root = std::fs::read_to_string(&token_path)
        .unwrap()
        .trim()
        .to_owned();
    let resp: Value = app
        .client
        .post(format!("{}/v1/auth/exchange", app.base))
        .bearer_auth(&root)
        .json(&serde_json::json!({
            "ttl_seconds": 3600,
            "scopes": ["workspace:read"]
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let read_only = resp["token"].as_str().unwrap();

    let resp = app
        .client
        .post(format!("{}/v1/apps/seed", app.base))
        .bearer_auth(read_only)
        .json(&serde_json::json!({
            "workdir": dir.path().join("nope").to_str().unwrap(),
            "gitRemoteUrl": "https://example.com/x.git"
        }))
        .send()
        .await
        .expect("response");
    assert_eq!(resp.status(), 403);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["code"], "forbidden");
}

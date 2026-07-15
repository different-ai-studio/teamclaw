#![allow(clippy::await_holding_lock)]
//! Smoke test for `team_share::create_team` (Task 5).
//!
//! Verifies that the slim create command:
//!   1. POSTs `{ name }` to `/v1/teams` against the configured FC endpoint.
//!   2. Returns `{ team_id, team_slug }`.
//!   3. Does NOT write any OSS-mode fields (`oss_team_id`, `team_mode`,
//!      `oss_team_slug`, `ai_gateway_endpoint`, `litellm_key`) into the
//!      workspace `teamclaw.json`.
//!
//! Secret persistence is intentionally NOT asserted here — `team_secret_store`
//! talks to the OS keychain / a host-wide env blob, which is not safely
//! isolatable inside a `cargo test` run. Task 6 (which actually generates
//! and stores secrets) will exercise that path under its own harness.

use serde_json::json;
use teamclaw_lib::commands::team_secret_store;
use teamclaw_lib::commands::team_share;
use tempfile::TempDir;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Redirect $HOME to a tempdir so the `local_secret_store` backing the
/// `team_secret_store` writes inside isolation. Note: env vars are
/// process-global, so the Task 6 tests below must not run in parallel with
/// each other if they need disjoint home stores. Cargo runs each integration
/// test binary on multiple threads by default; the Task 6 tests synchronize
/// through a single Mutex guard (`HOME_GUARD`).
#[allow(deprecated)]
fn isolate_home(tmp: &TempDir) {
    std::env::set_var("HOME", tmp.path());
    // Prime the legacy disk-fallback env-blob with a non-empty map so
    // `read_legacy_disk_blob` returns Ok(Some(..)). The personal secret store
    // will migrate this into its own encrypted blob on first read.
    let fallback_dir = tmp.path().join(".teamclaw");
    std::fs::create_dir_all(&fallback_dir).expect("mkdir ~/.teamclaw");
    std::fs::write(
        fallback_dir.join("env-blob.json"),
        r#"{"_test_isolation_marker":"1"}"#,
    )
    .expect("write disk fallback env-blob.json");
}

/// Serialize Task 6 tests that mutate $HOME / global env state.
static HOME_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Construct a workspace dir + write `.teamclaw/teamclaw.json` pointing at
/// the mock FC endpoint, with a fake supabase_jwt.
fn seed_workspace(tmp: &TempDir, fc_endpoint: &str) -> String {
    let workspace = tmp.path().to_path_buf();
    // Mirror `commands::TEAMCLAW_DIR` (`.teamclaw`) / `CONFIG_FILE_NAME`
    // (`teamclaw.json`) using the APP_SHORT_NAME compiled into the lib.
    let cfg_dir = workspace.join(".teamclaw");
    std::fs::create_dir_all(&cfg_dir).expect("mkdir .teamclaw");
    let cfg = json!({
        "fc_endpoint": fc_endpoint,
        "supabase_jwt": "test-jwt",
    });
    std::fs::write(
        cfg_dir.join("teamclaw.json"),
        serde_json::to_string_pretty(&cfg).unwrap(),
    )
    .expect("write teamclaw.json");
    workspace.to_string_lossy().into_owned()
}

fn read_cfg(workspace_path: &str) -> serde_json::Value {
    let p = std::path::Path::new(workspace_path)
        .join(".teamclaw")
        .join("teamclaw.json");
    let s = std::fs::read_to_string(p).expect("read teamclaw.json");
    serde_json::from_str(&s).expect("parse teamclaw.json")
}

#[tokio::test]
async fn create_team_slim_only_calls_v1_teams_and_returns_id_slug() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/teams"))
        .and(header("authorization", "Bearer test-jwt"))
        .and(body_partial_json(json!({ "name": "alpha" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "t1",
            "name": "alpha",
            "slug": "alpha",
            "aiGatewayEndpoint": null,
            "litellmKey": null,
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().expect("tempdir");
    let workspace = seed_workspace(&tmp, &server.uri());

    let result = team_share::create_team(
        "alpha".to_string(),
        workspace.clone(),
        "test-jwt".to_string(),
    )
    .await
    .expect("create_team should succeed");

    assert_eq!(result.team_id, "t1");
    assert_eq!(result.team_slug, "alpha");

    // The slim command must NOT have written any onboarding/share fields
    // into the workspace config. Only the pre-seeded keys should remain.
    let cfg = read_cfg(&workspace);
    let obj = cfg.as_object().expect("config is object");
    for forbidden in [
        "team_mode",
        "oss_team_id",
        "oss_team_slug",
        "ai_gateway_endpoint",
        "litellm_key",
        "share_mode",
    ] {
        assert!(
            !obj.contains_key(forbidden),
            "team_share::create_team must not write `{forbidden}` (Task 5 is slim)",
        );
    }
    // Pre-seeded keys preserved.
    assert_eq!(
        obj.get("supabase_jwt").and_then(|v| v.as_str()),
        Some("test-jwt")
    );
    assert_eq!(
        obj.get("fc_endpoint").and_then(|v| v.as_str()),
        Some(server.uri().as_str())
    );
}

// ─── Task 6 tests ─────────────────────────────────────────────────────────

#[tokio::test]
async fn enable_oss_provisions_secret_and_local_dir() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/teams/t1/share-mode"))
        .and(header("authorization", "Bearer test-jwt"))
        .and(body_partial_json(json!({ "mode": "oss" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "t1",
            "share_mode": "oss",
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp, &server.uri());

    let result = team_share::enable::enable_oss_impl(
        "t1".to_string(),
        workspace.clone(),
        "test-jwt".to_string(),
        None,
    )
    .await
    .expect("enable_oss should succeed");
    assert_eq!(result.team_id, "t1");
    assert_eq!(result.share_mode, "oss");

    // Secret persisted (64 lowercase hex chars).
    let secret = team_secret_store::load_team_secret(&workspace, "t1")
        .expect("secret should be readable after enable_oss");
    assert_eq!(secret.len(), 64, "team secret must be 64 hex chars");
    assert!(
        secret.chars().all(|c| c.is_ascii_hexdigit()),
        "secret should be hex"
    );

    // teamclaw-team is created+linked by the daemon, not by enable_oss.
    let team_repo_dir = std::path::Path::new(&workspace).join("teamclaw-team");
    assert!(
        !team_repo_dir.exists()
            || team_repo_dir
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink(),
        "enable must not create a real teamclaw-team dir (daemon owns it)"
    );

    // NOTE: team fields (oss_team_id / share_mode) are intentionally NOT
    // persisted to teamclaw.json anymore — the single source of truth is the
    // current-team store (commits ad563711 / b1baec40). The returned
    // share_mode / team_id are asserted above.
}

#[tokio::test]
async fn enable_oss_uses_provided_team_secret() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/teams/t1/share-mode"))
        .and(header("authorization", "Bearer test-jwt"))
        .and(body_partial_json(json!({ "mode": "oss" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "t1",
            "share_mode": "oss",
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp, &server.uri());

    let provided = "abcdef0123456789".repeat(4);
    team_share::enable::enable_oss_impl(
        "t1".to_string(),
        workspace.clone(),
        "test-jwt".to_string(),
        Some(provided.to_uppercase()),
    )
    .await
    .expect("enable_oss with provided secret should succeed");

    let loaded =
        team_secret_store::load_team_secret(&workspace, "t1").expect("secret should be readable");
    assert_eq!(loaded, provided);
}

#[tokio::test]
async fn set_team_secret_validates_and_stores() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp, "http://unused");

    // 63 chars → reject.
    let too_short = "a".repeat(63);
    let err = team_share::enable::set_team_secret_impl(
        "team-sst".to_string(),
        too_short,
        workspace.clone(),
    )
    .await
    .expect_err("should reject non-64-char secret");
    assert!(err.contains("64 hex"), "unexpected error: {err}");

    // 64 hex chars (uppercase accepted) → normalized to lowercase.
    let mixed_case = "ABCDEF0123456789".repeat(4);
    team_share::enable::set_team_secret_impl(
        "team-sst".to_string(),
        mixed_case.clone(),
        workspace.clone(),
    )
    .await
    .expect("should accept valid hex");
    let loaded = team_secret_store::load_team_secret(&workspace, "team-sst")
        .expect("secret should be readable");
    assert_eq!(loaded, mixed_case.to_ascii_lowercase());
}

#[tokio::test]
async fn enable_custom_git_writes_git_config() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/teams/t1/share-mode"))
        .and(header("authorization", "Bearer test-jwt"))
        .and(body_partial_json(json!({
            "mode": "custom_git",
            "gitConfig": {
                "remoteUrl": "https://x",
                "authKind": "ssh_key",
                "credentialRef": "custom_git:t1",
            }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "t1",
            "share_mode": "custom_git",
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp, &server.uri());

    let input = team_share::enable::GitEnableInput {
        remote_url: "https://x".to_string(),
        auth_kind: "ssh_key".to_string(),
        credential: "PRIVATE KEY BODY".to_string(),
        branch: None,
    };
    let result = team_share::enable::enable_custom_git_impl(
        "t1".to_string(),
        workspace.clone(),
        input,
        "test-jwt".to_string(),
        None,
    )
    .await
    .expect("enable_custom_git should succeed");
    assert_eq!(result.share_mode, "custom_git");

    // NOTE: team fields (share_mode / git_remote_url / oss_team_id) are no
    // longer persisted to teamclaw.json — single source of truth is the
    // current-team store (commits ad563711 / b1baec40). The returned
    // share_mode is asserted above.
}

// ─── Task 12 tests ────────────────────────────────────────────────────────

#[tokio::test]
async fn join_existing_writes_config_when_share_enabled() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/teams/t1/workspace-config"))
        .and(header("authorization", "Bearer test-jwt"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "shareMode": "oss",
            "gitRemoteUrl": null,
            "gitAuthKind": null,
            "syncMode": null,
            "litellmTeamId": "ll-1",
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp, &server.uri());

    let result = team_share::join::team_share_join_existing_impl(
        "t1".to_string(),
        workspace.clone(),
        "test-jwt".to_string(),
    )
    .await
    .expect("join should succeed");
    assert!(result.initialized);
    assert_eq!(result.share_mode.as_deref(), Some("oss"));

    // teamclaw-team is created+linked by the daemon, not by join_existing.
    let team_repo_dir = std::path::Path::new(&workspace).join("teamclaw-team");
    assert!(
        !team_repo_dir.exists()
            || team_repo_dir
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink(),
        "join must not create a real teamclaw-team dir (daemon owns it)"
    );

    // NOTE: team fields (oss_team_id / share_mode / litellm_team_id) are no
    // longer persisted to teamclaw.json — single source of truth is the
    // current-team store (commits ad563711 / b1baec40). The returned
    // initialized / share_mode are asserted above.
}

#[tokio::test]
async fn join_existing_noop_when_share_not_opened() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/teams/t2/workspace-config"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "shareMode": null,
            "gitRemoteUrl": null,
            "gitAuthKind": null,
            "syncMode": null,
            "litellmTeamId": null,
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp, &server.uri());

    let result = team_share::join::team_share_join_existing_impl(
        "t2".to_string(),
        workspace.clone(),
        "test-jwt".to_string(),
    )
    .await
    .expect("join should succeed");
    assert!(!result.initialized);
    assert!(result.share_mode.is_none());

    // No teamclaw-team dir.
    let team_repo_dir = std::path::Path::new(&workspace).join("teamclaw-team");
    assert!(
        !team_repo_dir.exists(),
        "teamclaw-team dir should NOT exist"
    );

    // No share_mode/oss_team_id written.
    let cfg = read_cfg(&workspace);
    let obj = cfg.as_object().expect("config is object");
    assert!(!obj.contains_key("share_mode"));
    assert!(!obj.contains_key("oss_team_id"));
}

#[tokio::test]
async fn set_team_secret_rejects_non_hex() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp, "http://unused");
    // 64 chars but contains a non-hex char.
    let mut bad = "a".repeat(63);
    bad.push('z');
    let err = team_share::enable::set_team_secret_impl("team-x".to_string(), bad, workspace)
        .await
        .expect_err("non-hex should be rejected");
    assert!(err.contains("64 hex"), "unexpected error: {err}");
}

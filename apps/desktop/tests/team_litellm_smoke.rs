#![allow(clippy::await_holding_lock)]
//! Smoke test for `team_litellm::setup_impl` (Task 8).
//!
//! Verifies that the command:
//!   1. POSTs `{}` to `/v1/teams/{team_id}/litellm/setup` against the
//!      configured FC endpoint.
//!   2. Returns `{ ai_gateway_endpoint, litellm_key }`.
//!   3. Writes `ai_gateway_endpoint` and `litellm_key` into
//!      `.teamclaw/teamclaw.json` while preserving existing keys.

use serde_json::json;
use teamclaw_lib::commands::team_litellm;
use tempfile::TempDir;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn seed_workspace(tmp: &TempDir, fc_endpoint: &str) -> String {
    let workspace = tmp.path().to_path_buf();
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
async fn team_litellm_setup_calls_fc_and_writes_config() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/teams/t1/litellm/setup"))
        .and(header("authorization", "Bearer test-jwt"))
        .and(body_partial_json(json!({})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "aiGatewayEndpoint": "https://gw/",
            "litellmKey": "sk-xyz",
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().expect("tempdir");
    let workspace = seed_workspace(&tmp, &server.uri());

    let result =
        team_litellm::setup_impl("t1".to_string(), workspace.clone(), "test-jwt".to_string())
            .await
            .expect("setup_impl should succeed");

    assert_eq!(result.ai_gateway_endpoint, "https://gw/");
    assert_eq!(result.litellm_key, "sk-xyz");

    let cfg = read_cfg(&workspace);
    let obj = cfg.as_object().expect("config is object");
    assert_eq!(
        obj.get("ai_gateway_endpoint").and_then(|v| v.as_str()),
        Some("https://gw/")
    );
    assert_eq!(
        obj.get("litellm_key").and_then(|v| v.as_str()),
        Some("sk-xyz")
    );
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

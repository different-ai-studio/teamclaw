#![allow(clippy::await_holding_lock)]
//! Smoke tests for `team_share::custom_git` (Task 7).
//!
//! Covers the credential bridge that survives after Plan B Task 8:
//!   - `store_credential` / `load_credential` round-trip via env_blob.
//!   - `delete_credential` removes the stored entry.
//!
//! NOTE: the clone path (`build_clone_command` / `clone_or_init` /
//! `CloneOutcome`) was removed — the daemon owns all team-repo cloning now,
//! so the tests that exercised it were dropped rather than ported.

use serde_json::json;
use teamclaw_lib::commands::team_share::custom_git;
use tempfile::TempDir;

#[allow(deprecated)]
fn isolate_home(tmp: &TempDir) {
    std::env::set_var("HOME", tmp.path());
    let fallback_dir = tmp.path().join(".teamclaw");
    std::fs::create_dir_all(&fallback_dir).expect("mkdir ~/.teamclaw");
    std::fs::write(
        fallback_dir.join("env-blob.json"),
        r#"{"_test_isolation_marker":"1"}"#,
    )
    .expect("write disk fallback env-blob.json");
}

static HOME_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn seed_workspace(tmp: &TempDir) -> String {
    let workspace = tmp.path().to_path_buf();
    let cfg_dir = workspace.join(".teamclaw");
    std::fs::create_dir_all(&cfg_dir).expect("mkdir .teamclaw");
    std::fs::write(
        cfg_dir.join("teamclaw.json"),
        serde_json::to_string_pretty(&json!({})).unwrap(),
    )
    .expect("write teamclaw.json");
    workspace.to_string_lossy().into_owned()
}

#[test]
fn store_then_load_https_token_roundtrip() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp);

    custom_git::store_credential(&workspace, "custom_git:t1", "https_token", "ghp_abc123")
        .expect("store_credential");

    let (kind, value) =
        custom_git::load_credential(&workspace, "custom_git:t1").expect("load_credential");
    assert_eq!(kind, "https_token");
    assert_eq!(value, "ghp_abc123");
}

#[test]
fn store_then_load_ssh_key_roundtrip() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp);

    let key_path = tmp.path().join("id_ed25519").to_string_lossy().into_owned();
    custom_git::store_credential(&workspace, "custom_git:t2", "ssh_key", &key_path)
        .expect("store_credential");

    let (kind, value) =
        custom_git::load_credential(&workspace, "custom_git:t2").expect("load_credential");
    assert_eq!(kind, "ssh_key");
    assert_eq!(value, key_path);
}

#[test]
fn store_rejects_invalid_kind() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp);

    let err = custom_git::store_credential(&workspace, "custom_git:t1", "bogus", "x")
        .expect_err("invalid kind should be rejected");
    assert!(
        err.contains("invalid credential kind"),
        "unexpected err: {err}"
    );
}

#[test]
fn delete_credential_removes_entry() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp);

    custom_git::store_credential(&workspace, "custom_git:t1", "https_token", "ghp_abc123")
        .expect("store_credential");
    custom_git::delete_credential(&workspace, "custom_git:t1").expect("delete_credential");

    let err = custom_git::load_credential(&workspace, "custom_git:t1")
        .expect_err("credential should be gone after delete");
    assert!(err.contains("not found"), "unexpected err: {err}");
}

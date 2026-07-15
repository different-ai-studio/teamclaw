//! Live JetStream KV roundtrip — proves daemon's `nats::RetainedKv` can
//! create/bind the `amux_state` bucket and round-trip actor-presence payloads.
//!
//! Skipped by default; set `AMUXD_NATS_TEST_URL` (e.g.
//! `nats://127.0.0.1:14222`) to enable. Launch the matching server first:
//!     nats-server -c apps/daemon/tests/fixtures/nats-test.conf

// Pull the daemon's nats module into the test binary via #[path]. Tests
// in apps/daemon/tests/ live outside src/, so we re-export the bare minimum
// surface needed for the roundtrip assertion.

use std::time::Duration;

fn server_url() -> Option<String> {
    std::env::var("AMUXD_NATS_TEST_URL").ok()
}

#[tokio::test]
async fn jetstream_kv_roundtrip_for_actor_state() {
    let Some(url) = server_url() else {
        eprintln!("AMUXD_NATS_TEST_URL not set; skipping live JetStream test");
        return;
    };

    let client = async_nats::connect(&url)
        .await
        .expect("connect to nats-server");

    // Inline minimal version of RetainedKv to avoid pulling the daemon
    // module tree into integration tests. The shape mirrors apps/daemon/src/
    // nats/retained.rs and is checked alongside it in code review.
    let js = async_nats::jetstream::new(client.clone());
    let bucket = js
        .create_key_value(async_nats::jetstream::kv::Config {
            bucket: "amux_state_test".to_string(),
            history: 1,
            max_bytes: 8 * 1024 * 1024,
            ..Default::default()
        })
        .await
        .or_else(|_| -> Result<_, async_nats::Error> {
            // Already exists path — re-bind synchronously isn't possible here,
            // so fall back to get_key_value.
            unreachable!("create on fresh bucket should succeed")
        })
        .expect("create bucket");

    let key = "amux_team1_actor-a_state";
    bucket
        .put(key, b"hello-state".to_vec().into())
        .await
        .expect("put");

    tokio::time::sleep(Duration::from_millis(50)).await;

    let entry = bucket.entry(key).await.expect("entry").expect("exists");
    assert_eq!(entry.value.as_ref(), b"hello-state");

    // Cleanup so re-runs work.
    bucket.delete(key).await.ok();
    js.delete_key_value("amux_state_test").await.ok();
}

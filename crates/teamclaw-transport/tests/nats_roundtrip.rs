//! Live NATS pub/sub roundtrip — proves the `NatsClient` Transport impl works
//! against a real nats-server. Skipped by default; set `AMUXD_NATS_TEST_URL`
//! (e.g. `nats://127.0.0.1:14222`) to enable.
//!
//! Launch the matching server first:
//!     nats-server -c apps/daemon/tests/fixtures/nats-test.conf

use std::time::Duration;
use teamclaw_transport::{
    nats::NatsClient, DeliveryGuarantee, Transport, TransportMessage,
};

fn server_url() -> Option<String> {
    std::env::var("AMUXD_NATS_TEST_URL").ok()
}

#[tokio::test]
async fn nats_pub_sub_roundtrip_translates_mqtt_topics() {
    let Some(url) = server_url() else {
        eprintln!("AMUXD_NATS_TEST_URL not set; skipping live NATS test");
        return;
    };

    let raw = async_nats::connect(&url)
        .await
        .expect("connect to nats-server");
    let (client, mut rx) = NatsClient::new(raw);

    let topic = "amux/team1/actor-a/runtime/r1/state".to_string();
    client
        .subscribe(topic.clone(), DeliveryGuarantee::AtLeastOnce)
        .await
        .expect("subscribe ok");

    // async_nats subscribe is async; small grace period to settle.
    tokio::time::sleep(Duration::from_millis(100)).await;

    let payload = b"hello-nats".to_vec();
    client
        .publish(TransportMessage {
            topic: topic.clone(),
            payload: payload.clone(),
            retain: false,
            delivery: DeliveryGuarantee::AtLeastOnce,
        })
        .await
        .expect("publish ok");

    let frame = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("receive within 2s")
        .expect("frame present");
    assert_eq!(frame.topic, topic, "topic must round-trip back to slash form");
    assert_eq!(frame.payload, payload);
}

#[tokio::test]
async fn nats_wildcard_subscription_receives_matching_subjects() {
    let Some(url) = server_url() else {
        eprintln!("AMUXD_NATS_TEST_URL not set; skipping live NATS test");
        return;
    };

    let raw = async_nats::connect(&url)
        .await
        .expect("connect to nats-server");
    let (client, mut rx) = NatsClient::new(raw);

    client
        .subscribe(
            "amux/team1/actor-a/runtime/+/commands".to_string(),
            DeliveryGuarantee::AtLeastOnce,
        )
        .await
        .expect("subscribe ok");
    tokio::time::sleep(Duration::from_millis(100)).await;

    client
        .publish(TransportMessage {
            topic: "amux/team1/actor-a/runtime/rt-xyz/commands".to_string(),
            payload: b"cmd".to_vec(),
            retain: false,
            delivery: DeliveryGuarantee::AtLeastOnce,
        })
        .await
        .expect("publish ok");

    let frame = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("receive within 2s")
        .expect("frame present");
    assert_eq!(
        frame.topic,
        "amux/team1/actor-a/runtime/rt-xyz/commands"
    );
}

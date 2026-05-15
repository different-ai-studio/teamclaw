#[path = "../src/mqtt/subscriber.rs"]
mod subscriber;
#[path = "../src/mqtt/topics.rs"]
mod topics;

mod proto {
    pub use teamclaw_proto::amux;
}

use topics::Topics;

#[test]
fn builds_new_device_and_live_topics() {
    let topics = Topics::new("team1", "dev-a");

    assert_eq!(topics.device_rpc_req(), "amux/team1/device/dev-a/rpc/req");
    assert_eq!(topics.device_rpc_res(), "amux/team1/device/dev-a/rpc/res");
    assert_eq!(topics.device_notify(), "amux/team1/device/dev-a/notify");
    assert_eq!(
        topics.session_live("sess-1"),
        "amux/team1/session/sess-1/live"
    );
}

#[tokio::test]
async fn parse_session_live_and_device_notify_topics() {
    let live = rumqttc::Publish::new(
        "amux/team1/session/sess-1/live",
        rumqttc::QoS::AtLeastOnce,
        vec![1, 2, 3],
    );
    let notify = rumqttc::Publish::new(
        "amux/team1/device/dev-a/notify",
        rumqttc::QoS::AtLeastOnce,
        vec![4, 5, 6],
    );

    assert!(matches!(
        subscriber::parse_incoming(&live),
        Some(subscriber::IncomingMessage::TeamclawSessionLive { .. })
    ));
    assert!(matches!(
        subscriber::parse_incoming(&notify),
        Some(subscriber::IncomingMessage::TeamclawNotify { .. })
    ));
}

#[test]
fn reject_legacy_teamclaw_topics_after_rearchitecture() {
    let global_ideas =
        rumqttc::Publish::new("amux/team1/ideas", rumqttc::QoS::AtLeastOnce, vec![7, 8, 9]);
    let legacy_message = rumqttc::Publish::new(
        "amux/team1/session/sess-1/messages",
        rumqttc::QoS::AtLeastOnce,
        vec![],
    );
    let legacy_idea = rumqttc::Publish::new(
        "amux/team1/session/sess-1/ideas",
        rumqttc::QoS::AtLeastOnce,
        vec![],
    );
    let legacy_meta = rumqttc::Publish::new(
        "amux/team1/actor/member-a/session/sess-1/meta",
        rumqttc::QoS::AtLeastOnce,
        vec![],
    );

    assert!(subscriber::parse_incoming(&global_ideas).is_none());
    assert!(subscriber::parse_incoming(&legacy_message).is_none());
    assert!(subscriber::parse_incoming(&legacy_idea).is_none());
    assert!(subscriber::parse_incoming(&legacy_meta).is_none());
}

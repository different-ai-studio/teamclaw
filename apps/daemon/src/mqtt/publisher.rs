//! High-level retained-state publisher. Backend-agnostic: takes any
//! `Arc<dyn MessagePublisher>` and a `Topics` ref, so it works over the
//! MQTT path (rumqttc) or NATS path (async-nats + JetStream KV) the same
//! way.
//!
//! For NATS, retained writes go through MessagePublisher::publish with
//! `retain=true`, which on NatsClient is a core publish. The JetStream KV
//! mirror lives in `crate::nats::RetainedKv` and is written separately by
//! `NatsBackend::announce_online/offline`. This split means `Publisher`
//! callers don't need to know which backend they're on.

use crate::proto::{amux, teamclu};
use std::sync::Arc;
use teamclu_transport::{DeliveryGuarantee, MessagePublisher};

use super::Topics;

pub struct Publisher<'a> {
    client: Arc<dyn MessagePublisher>,
    topics: &'a Topics,
}

impl<'a> Publisher<'a> {
    pub fn new_from_handle(client: Arc<dyn MessagePublisher>, topics: &'a Topics) -> Self {
        Self { client, topics }
    }

    /// Convenience constructor for the MQTT path.
    #[allow(dead_code)]
    pub fn new(mqtt: &'a super::MqttClient) -> Self {
        Self {
            client: Arc::new(mqtt.client.clone()),
            topics: &mqtt.topics,
        }
    }

    async fn publish_message(
        &self,
        topic: String,
        retain: bool,
        payload: Vec<u8>,
    ) -> Result<(), teamclu_transport::PublisherError> {
        self.client
            .publish(&topic, payload, retain, DeliveryGuarantee::AtLeastOnce)
            .await
    }

    /// Publishes ActorPresence (online/offline) to the retained
    /// amux/{team}/{actor}/state topic. The legacy /status topic was retired
    /// and LWT retargeted here, so this is the single authoritative retained
    /// channel for daemon presence.
    pub async fn publish_actor_presence(
        &self,
        state: &amux::ActorPresence,
    ) -> Result<(), teamclu_transport::PublisherError> {
        let payload = state.encode_to_vec();
        self.publish_message(self.topics.actor_state(), true, payload)
            .await
    }

    /// Publishes a Notify hint to the daemon's own actor notify topic
    /// (`amux/{team}/{actor}/notify`).
    /// Ephemeral (no retain) — receivers react by re-fetching authoritative
    /// state from the cloud backend or daemon RPC.
    pub async fn publish_notify(
        &self,
        event_type: &str,
        refresh_hint: &str,
    ) -> Result<(), teamclu_transport::PublisherError> {
        let notify = teamclu::Notify {
            event_type: event_type.to_string(),
            refresh_hint: refresh_hint.to_string(),
            sent_at: chrono::Utc::now().timestamp(),
        };
        self.publish_message(self.topics.actor_notify(), false, notify.encode_to_vec())
            .await
    }
}

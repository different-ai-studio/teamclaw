use chrono::Utc;
use prost::Message;
use rumqttc::{AsyncClient, QoS};
use uuid::Uuid;

use crate::mqtt::Topics;
use crate::proto::amux::Envelope as AmuxEnvelope;
use crate::proto::teamclaw::{IdeaEvent, LiveEventEnvelope, Participant, SessionMessageEnvelope};

pub struct LivePublisher {
    client: AsyncClient,
    topics: Topics,
}

impl LivePublisher {
    pub fn new(client: AsyncClient, team_id: String, device_id: String) -> Self {
        Self {
            client,
            topics: Topics::new(&team_id, &device_id),
        }
    }

    pub async fn publish_message(
        &self,
        session_id: &str,
        actor_id: &str,
        envelope: &SessionMessageEnvelope,
    ) -> crate::error::Result<()> {
        self.publish(
            "message.created",
            session_id,
            actor_id,
            envelope.encode_to_vec(),
        )
        .await
    }

    pub async fn publish_idea_event(
        &self,
        event_type: &str,
        session_id: &str,
        actor_id: &str,
        event: &IdeaEvent,
    ) -> crate::error::Result<()> {
        self.publish(event_type, session_id, actor_id, event.encode_to_vec())
            .await
    }

    /// Publishes an ACP `Envelope` (output deltas, thinking, tool_use, etc.)
    /// to the session/{id}/live channel. Wraps the envelope bytes inside a
    /// `LiveEventEnvelope` with `event_type = "acp.event"`. iOS subscribes by
    /// session_id (which it owns), so this replaces the legacy per-runtime
    /// `runtime/{id}/events` topic that required iOS to know the daemon's
    /// device_id and the daemon-generated runtime_id.
    pub async fn publish_acp_event(
        &self,
        session_id: &str,
        actor_id: &str,
        envelope: &AmuxEnvelope,
    ) -> crate::error::Result<()> {
        self.publish("acp.event", session_id, actor_id, envelope.encode_to_vec())
            .await
    }

    pub async fn publish_presence_event(
        &self,
        event_type: &str,
        session_id: &str,
        participant: &Participant,
    ) -> crate::error::Result<()> {
        self.publish(
            event_type,
            session_id,
            &participant.actor_id,
            participant.encode_to_vec(),
        )
        .await
    }

    async fn publish(
        &self,
        event_type: &str,
        session_id: &str,
        actor_id: &str,
        body: Vec<u8>,
    ) -> crate::error::Result<()> {
        let payload = LiveEventEnvelope {
            event_id: Uuid::new_v4().to_string(),
            event_type: event_type.to_string(),
            session_id: session_id.to_string(),
            actor_id: actor_id.to_string(),
            sent_at: Utc::now().timestamp(),
            body,
        }
        .encode_to_vec();

        self.client
            .publish(
                self.topics.session_live(session_id),
                QoS::AtLeastOnce,
                false,
                payload,
            )
            .await?;
        Ok(())
    }
}

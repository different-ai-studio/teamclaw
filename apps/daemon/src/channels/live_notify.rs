//! Broadcasting gateway-written messages on `session/{id}/live`.
//!
//! A message only reaches other clients in real time if somebody publishes
//! `message.created`. The desktop does it for its own sends
//! (`outbox-sender.ts`), cron does it for its prompts (`server/cron.rs`), and
//! the gateway did it for nothing at all — it wrote straight to the Cloud API,
//! so a WeCom conversation was invisible on the desktop until the user
//! happened to refetch. This is the missing publisher.
//!
//! The subtlety is the loopback. The daemon subscribes to its own sessions'
//! live topics, and `route_session_message` starts a turn for any message that
//! mentions its agent. The gateway has *already* run that turn, so publishing
//! naively would run it twice. Claiming the message id in the shared
//! [`MessageDedup`] before publishing closes that gate first — the same order
//! cron uses, and for the same reason.

use crate::proto::teamclu;
use crate::teamclu::{LivePublisher, MessageDedup};

/// Publishes gateway-written messages so every client sees them as they
/// happen, not on the next refetch.
#[derive(Clone)]
pub struct GatewayLiveNotifier {
    publisher: LivePublisher,
    dedup: MessageDedup,
}

impl GatewayLiveNotifier {
    pub fn new(publisher: LivePublisher, dedup: MessageDedup) -> Self {
        Self { publisher, dedup }
    }

    /// Announce a message the gateway just persisted.
    ///
    /// `mention_actor_ids` rides in the metadata because that is where
    /// `publish_message` reads it from; it drives the receiving clients' unread
    /// and mention state. It must NOT name this daemon's agent for a message
    /// the gateway has already answered — see the loopback note above; the
    /// dedup claim is the belt, this is the braces.
    pub async fn message_created(
        &self,
        session_id: &str,
        message_id: &str,
        sender_actor_id: &str,
        kind: teamclu::MessageKind,
        content: &str,
        metadata_json: &str,
    ) {
        if session_id.is_empty() || message_id.is_empty() {
            return;
        }
        // Closed before the publish, never after: the loopback copy comes back
        // fast enough to lose that race.
        self.dedup.claim_message(session_id, message_id);

        let message = teamclu::Message {
            message_id: message_id.to_string(),
            session_id: session_id.to_string(),
            sender_actor_id: sender_actor_id.to_string(),
            kind: kind as i32,
            content: content.to_string(),
            created_at: chrono::Utc::now().timestamp(),
            metadata_json: metadata_json.to_string(),
            ..Default::default()
        };
        let envelope = teamclu::SessionMessageEnvelope {
            message: Some(message),
            mention_actor_ids: crate::daemon::session_events::parse_mention_actor_ids(
                metadata_json,
            ),
        };
        if let Err(e) = self
            .publisher
            .publish_message(session_id, sender_actor_id, &envelope)
            .await
        {
            // Non-fatal: the row is already in the cloud, so a client that
            // refetches still sees it. Only the live update is lost.
            tracing::warn!(
                session_id,
                message_id,
                error = %e,
                "gateway live publish failed; clients will see this message only after a refetch"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::{Arc, Mutex};
    use teamclu_transport::{DeliveryGuarantee, MessagePublisher, PublisherError};

    #[derive(Default)]
    struct RecordingPublisher {
        topics: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl MessagePublisher for RecordingPublisher {
        async fn publish(
            &self,
            topic: &str,
            _payload: Vec<u8>,
            _retain: bool,
            _delivery: DeliveryGuarantee,
        ) -> Result<(), PublisherError> {
            self.topics.lock().unwrap().push(topic.to_string());
            Ok(())
        }
        async fn subscribe(
            &self,
            _topic: &str,
            _delivery: DeliveryGuarantee,
        ) -> Result<(), PublisherError> {
            unimplemented!()
        }
        async fn unsubscribe(&self, _topic: &str) -> Result<(), PublisherError> {
            unimplemented!()
        }
    }

    fn notifier(dedup: MessageDedup) -> (GatewayLiveNotifier, Arc<RecordingPublisher>) {
        let publisher = Arc::new(RecordingPublisher::default());
        let live = LivePublisher::new(publisher.clone(), "team-1".into(), "actor-1".into());
        (GatewayLiveNotifier::new(live, dedup), publisher)
    }

    #[tokio::test]
    async fn publishing_claims_the_id_so_the_loopback_cannot_run_a_second_turn() {
        // This is the whole reason the dedup gate is shared. The gateway has
        // already answered this message; when its own `message.created` comes
        // back through `route_session_message`, the claim must already be there.
        let dedup = MessageDedup::new();
        let (live, publisher) = notifier(dedup.clone());

        live.message_created(
            "sess-1",
            "msg-1",
            "actor-external",
            teamclu::MessageKind::Text,
            "hi",
            r#"{"mention_actor_ids":[]}"#,
        )
        .await;

        assert_eq!(
            publisher.topics.lock().unwrap().as_slice(),
            ["amux/team-1/session/sess-1/live"]
        );
        assert!(
            !dedup.claim_message("sess-1", "msg-1"),
            "the daemon loop must see this id as already handled"
        );
    }

    #[tokio::test]
    async fn a_message_with_no_id_is_not_published() {
        // Nothing to dedup on and nothing for a client to reconcile against;
        // publishing it would be an event no one can match to a row.
        let (live, publisher) = notifier(MessageDedup::new());
        live.message_created(
            "sess-1",
            "",
            "actor-external",
            teamclu::MessageKind::Text,
            "hi",
            "{}",
        )
        .await;
        assert!(publisher.topics.lock().unwrap().is_empty());
    }
}

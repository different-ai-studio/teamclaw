use chrono::Utc;
use std::sync::Arc;
use teamclaw_transport::{DeliveryGuarantee, MessagePublisher};

use crate::mqtt::Topics;

pub struct NotifyPublisher {
    client: Arc<dyn MessagePublisher>,
    team_id: String,
}

impl NotifyPublisher {
    pub fn new(client: Arc<dyn MessagePublisher>, team_id: String) -> Self {
        Self { client, team_id }
    }

    pub async fn publish_membership_refresh(
        &self,
        target_actor_id: &str,
        session_id: &str,
        reason: &str,
    ) -> crate::error::Result<()> {
        // Preserved in signature for logging / future telemetry; Phase 2b wire
        // shape drops the field because Notify is payload-minimal.
        let _ = reason;

        let payload = crate::proto::teamclaw::Notify {
            event_type: "membership.refresh".to_string(),
            refresh_hint: session_id.to_string(),
            sent_at: Utc::now().timestamp(),
        }
        .encode_to_vec();

        let topic = Topics::new(&self.team_id, target_actor_id).actor_notify();
        self.client
            .publish(&topic, payload, false, DeliveryGuarantee::AtLeastOnce)
            .await?;
        Ok(())
    }
}

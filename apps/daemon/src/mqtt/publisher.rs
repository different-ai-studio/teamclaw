use super::MqttClient;
use crate::proto::{amux, teamclaw};
use teamclaw_transport::{DeliveryGuarantee, Transport, TransportMessage};

pub struct Publisher<'a> {
    client: &'a MqttClient,
}

impl<'a> Publisher<'a> {
    pub fn new(client: &'a MqttClient) -> Self {
        Self { client }
    }

    async fn publish_message(
        &self,
        topic: String,
        retain: bool,
        payload: Vec<u8>,
    ) -> Result<(), rumqttc::ClientError> {
        <rumqttc::AsyncClient as Transport>::publish(
            &self.client.client,
            TransportMessage {
                topic,
                payload,
                retain,
                delivery: DeliveryGuarantee::AtLeastOnce,
            },
        )
        .await
    }

    /// Publishes RuntimeInfo to the retained runtime/{id}/state topic.
    pub async fn publish_runtime_state(
        &self,
        agent_id: &str,
        info: &amux::RuntimeInfo,
    ) -> Result<(), rumqttc::ClientError> {
        let payload = info.encode_to_vec();
        self.publish_message(self.client.topics.runtime_state(agent_id), true, payload)
            .await
    }

    /// Clears retained state on runtime/{id}/state. Otherwise subscribers
    /// would see ghost state after runtime termination.
    pub async fn clear_runtime_state(&self, agent_id: &str) -> Result<(), rumqttc::ClientError> {
        self.publish_message(
            self.client.topics.runtime_state(agent_id),
            true,
            Vec::<u8>::new(),
        )
        .await
    }

    /// Publishes DeviceState (online/offline) to the retained
    /// device/{id}/state topic. Phase 3 retired the legacy /status topic
    /// and retargeted LWT here, so this is the single authoritative
    /// retained channel for daemon presence.
    pub async fn publish_device_state(
        &self,
        state: &amux::DeviceState,
    ) -> Result<(), rumqttc::ClientError> {
        let payload = state.encode_to_vec();
        self.publish_message(self.client.topics.device_state(), true, payload)
            .await
    }

    /// Publishes RuntimeInfo with state=FAILED and populated error fields
    /// to the retained runtime/{id}/state topic. The retain stays until a
    /// future clear — iOS surfaces the error_message to the user.
    pub async fn publish_runtime_failed(
        &self,
        runtime_id: &str,
        error_code: &str,
        error_message: &str,
        failed_stage: &str,
    ) -> Result<(), rumqttc::ClientError> {
        let info = crate::proto::amux::RuntimeInfo {
            runtime_id: runtime_id.to_string(),
            state: crate::proto::amux::RuntimeLifecycle::Failed as i32,
            error_code: error_code.to_string(),
            error_message: error_message.to_string(),
            failed_stage: failed_stage.to_string(),
            ..Default::default()
        };
        self.publish_runtime_state(runtime_id, &info).await
    }

    /// Publishes a Notify hint to the daemon's own device/{id}/notify topic.
    /// Ephemeral (no retain) — receivers react by re-fetching authoritative
    /// state from Supabase or daemon RPC.
    pub async fn publish_notify(
        &self,
        event_type: &str,
        refresh_hint: &str,
    ) -> Result<(), rumqttc::ClientError> {
        let notify = teamclaw::Notify {
            event_type: event_type.to_string(),
            refresh_hint: refresh_hint.to_string(),
            sent_at: chrono::Utc::now().timestamp(),
        };
        self.publish_message(
            self.client.topics.device_notify(),
            false,
            notify.encode_to_vec(),
        )
        .await
    }
}

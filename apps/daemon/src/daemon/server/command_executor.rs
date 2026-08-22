//! Serialized business command boundary for transport-originated work.
//!
//! The MQTT worker never enters this module. It only persists an inbound frame
//! and forwards an envelope. Keeping the executor as a small owner-facing
//! adapter makes the transport boundary explicit while preserving the daemon's
//! existing single-owner ordering for `DaemonServer` state.

use std::time::{Duration, Instant};

use tracing::{error, warn};

use crate::mqtt::{MqttInbound, MqttInboundDisposition, MqttSupervisor};

use super::DaemonServer;

pub(crate) struct DaemonCommandExecutor<'a> {
    server: &'a mut DaemonServer,
}

impl<'a> DaemonCommandExecutor<'a> {
    pub(crate) fn new(server: &'a mut DaemonServer) -> Self {
        Self { server }
    }

    /// Execute one durable MQTT envelope while retaining the daemon's
    /// single-owner ordering. The transport worker remains free to poll and
    /// reconnect while this future is running.
    pub(crate) async fn execute_mqtt(
        &mut self,
        envelope: MqttInbound,
        supervisor: &MqttSupervisor,
    ) {
        let started = Instant::now();
        let id = envelope.id;
        if let Some(message) = crate::mqtt::subscriber::parse_frame(&envelope.frame) {
            // Do not cancel a side-effecting handler at an arbitrary wall-clock
            // boundary. Its HTTP/RPC clients own their cancellation and retry
            // semantics; cancelling here could replay a partially applied command.
            self.server.handle_incoming(message).await;
        }

        let duration = started.elapsed();
        if duration >= Duration::from_secs(10) {
            error!(
                command_id = id,
                source = "mqtt",
                duration_ms = duration.as_millis() as u64,
                "MQTT business command exceeded 10s"
            );
        } else if duration >= Duration::from_secs(5) {
            warn!(
                command_id = id,
                source = "mqtt",
                duration_ms = duration.as_millis() as u64,
                "MQTT business command exceeded 5s"
            );
        }

        supervisor
            .dispose_inbound(id, MqttInboundDisposition::Ack)
            .await;
    }
}

//! NATS adapter for the [`Transport`](crate::Transport) trait.
//!
//! The daemon uses MQTT topic strings (`amux/team/actor/.../state`)
//! everywhere; this adapter transparently encodes them to NATS subjects
//! (`amux.team.actor....state`) on publish and decodes back on receive
//! via [`SubscribedMessage::frame`].
//!
//! The MQTT `retain` flag has no native equivalent on NATS core. Callers
//! that need retained semantics should write to a JetStream KV bucket
//! instead (see daemon's `nats::retained` module). For now `retain=true`
//! on a NATS publish is silently treated as a fire-and-forget core publish
//! — the higher-level daemon code is expected to route retained writes
//! through the KV API.

use async_nats::Client;
use futures_util::StreamExt;
use thiserror::Error;
use tokio::sync::mpsc;

use crate::{encode_subject, DeliveryGuarantee, IncomingFrame, Transport, TransportMessage};

#[derive(Debug, Error)]
pub enum NatsTransportError {
    #[error("nats publish: {0}")]
    Publish(#[from] async_nats::PublishError),
    #[error("nats subscribe: {0}")]
    Subscribe(#[from] async_nats::SubscribeError),
    #[error("nats subscription channel closed")]
    SubscriptionClosed,
}

/// Thin wrapper around `async_nats::Client` that translates MQTT topics
/// to NATS subjects and exposes a unified inbound stream.
#[derive(Clone)]
pub struct NatsClient {
    client: Client,
    /// All subscriptions feed into this channel; the daemon's main loop
    /// awaits on its receiver as one of the `select!` arms.
    inbound_tx: mpsc::Sender<IncomingFrame>,
}

impl NatsClient {
    /// Build from an already-connected `async_nats::Client`. The returned
    /// `(NatsClient, mpsc::Receiver<IncomingFrame>)` pair must both be kept;
    /// dropping the receiver will cause subscribe handlers to drop frames.
    pub fn new(client: Client) -> (Self, mpsc::Receiver<IncomingFrame>) {
        // 1024 mirrors the rumqttc channel sizing — see apps/daemon/src/mqtt/client.rs
        // for the multi-thousand-session rationale.
        let (inbound_tx, inbound_rx) = mpsc::channel(1024);
        (
            Self {
                client,
                inbound_tx,
            },
            inbound_rx,
        )
    }

    /// Borrow the underlying client for JetStream KV / stream operations.
    pub fn raw(&self) -> &Client {
        &self.client
    }
}

impl Transport for NatsClient {
    type Error = NatsTransportError;

    async fn publish(&self, message: TransportMessage) -> Result<(), Self::Error> {
        let subject = encode_subject(&message.topic);
        // NATS has no native retained flag; the JetStream KV path handles
        // retained state. Core publishes ignore message.retain.
        self.client
            .publish(subject, message.payload.into())
            .await?;
        Ok(())
    }

    async fn subscribe(
        &self,
        topic: String,
        _delivery: DeliveryGuarantee,
    ) -> Result<(), Self::Error> {
        let subject = encode_subject(&topic);
        let mut sub = self.client.subscribe(subject).await?;
        let tx = self.inbound_tx.clone();
        tokio::spawn(async move {
            while let Some(msg) = sub.next().await {
                let frame = IncomingFrame {
                    topic: crate::decode_subject(&msg.subject),
                    payload: msg.payload.to_vec(),
                    retained: false,
                };
                if tx.send(frame).await.is_err() {
                    break;
                }
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test that proves the NatsClient builds against an `async_nats::Client`
    /// and that the encode/decode roundtrip stays stable. The end-to-end pub/sub
    /// test that requires a live nats-server lives in
    /// `apps/daemon/tests/nats_transport.rs`.
    #[test]
    fn subject_encoding_roundtrip_matches_topic_shape() {
        let topic = "amux/team1/actor-a/runtime/r1/state";
        let subject = encode_subject(topic);
        assert_eq!(subject, "amux.team1.actor-a.runtime.r1.state");
        assert_eq!(crate::decode_subject(&subject), topic);
    }
}

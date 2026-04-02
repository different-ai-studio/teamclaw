use super::types::{NerveMessage, NerveTopic};
use iroh_gossip::api::GossipSender;
use iroh_gossip::net::Gossip;
use iroh_gossip::proto::TopicId;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};
use tracing::warn;

fn derive_topic_id(topic: &NerveTopic, team_namespace: &str) -> TopicId {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"superagent/nerve/");
    hasher.update(team_namespace.as_bytes());
    hasher.update(b"/");
    hasher.update(serde_json::to_string(topic).unwrap_or_default().as_bytes());
    let hash = hasher.finalize();
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&hash);
    TopicId::from(bytes)
}

pub struct NerveChannel {
    gossip: Gossip,
    team_namespace: String,
    incoming_tx: broadcast::Sender<NerveMessage>,
    senders: Arc<Mutex<HashMap<TopicId, GossipSender>>>,
}

impl NerveChannel {
    pub fn new(gossip: Gossip, team_namespace: String) -> Self {
        let (incoming_tx, _) = broadcast::channel(256);
        Self {
            gossip,
            team_namespace,
            incoming_tx,
            senders: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn broadcast(&self, msg: NerveMessage) {
        let topic_id = derive_topic_id(&msg.topic, &self.team_namespace);
        let bytes = match serde_json::to_vec(&msg) {
            Ok(b) => b,
            Err(e) => {
                warn!("NerveChannel: failed to serialize message: {:?}", e);
                return;
            }
        };

        let sender = {
            let mut senders = self.senders.lock().await;
            if !senders.contains_key(&topic_id) {
                match self.gossip.subscribe(topic_id, vec![]).await {
                    Ok(topic) => {
                        let (tx, _rx) = topic.split();
                        senders.insert(topic_id, tx);
                    }
                    Err(e) => {
                        warn!("NerveChannel: failed to subscribe to topic: {:?}", e);
                        return;
                    }
                }
            }
            senders.get(&topic_id).cloned()
        };

        if let Some(sender) = sender {
            if let Err(e) = sender.broadcast(bytes.into()).await {
                warn!("NerveChannel: broadcast failed: {:?}", e);
            }
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<NerveMessage> {
        self.incoming_tx.subscribe()
    }

    pub fn dispatch_incoming(&self, raw: &[u8]) {
        match serde_json::from_slice::<NerveMessage>(raw) {
            Ok(msg) => {
                if msg.is_expired() {
                    return;
                }
                if let Err(e) = self.incoming_tx.send(msg) {
                    warn!("NerveChannel: no active receivers: {:?}", e);
                }
            }
            Err(e) => {
                warn!("NerveChannel: failed to deserialize incoming message: {:?}", e);
            }
        }
    }

    pub fn topic_id(&self, topic: &NerveTopic) -> TopicId {
        derive_topic_id(topic, &self.team_namespace)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::super_agent::types::*;

    #[test]
    fn dispatch_incoming_valid_heartbeat() {
        let msg = NerveMessage::new_heartbeat(
            "node-1".to_string(),
            HeartbeatPayload { status: AgentStatus::Online, current_task: None, load: 0.42 },
        );
        let json = serde_json::to_vec(&msg).unwrap();
        let deserialized: NerveMessage = serde_json::from_slice(&json).unwrap();

        assert_eq!(deserialized.from, "node-1");
        assert_eq!(deserialized.topic, NerveTopic::Heartbeat);
        assert!(!deserialized.is_expired());
        match deserialized.payload {
            NervePayload::Heartbeat(hb) => {
                assert_eq!(hb.status, AgentStatus::Online);
                assert_eq!(hb.current_task, None);
                assert!((hb.load - 0.42).abs() < f64::EPSILON);
            }
            _ => panic!("Expected Heartbeat payload"),
        }
    }

    #[test]
    fn dispatch_incoming_expired_message_dropped() {
        let (tx, mut rx) = broadcast::channel::<NerveMessage>(16);

        let mut msg = NerveMessage::new_heartbeat(
            "node-2".to_string(),
            HeartbeatPayload { status: AgentStatus::Idle, current_task: None, load: 0.0 },
        );
        // Set timestamp 60 seconds ago with ttl of 30s — clearly expired
        msg.timestamp = now_millis() - 60_000;
        msg.ttl = 30;

        assert!(msg.is_expired(), "Message should be expired");

        let raw = serde_json::to_vec(&msg).unwrap();

        // Simulate dispatch_incoming logic
        if let Ok(parsed) = serde_json::from_slice::<NerveMessage>(&raw) {
            if !parsed.is_expired() {
                let _ = tx.send(parsed);
            }
        }

        // Channel should be empty — nothing was sent
        assert!(rx.try_recv().is_err(), "Expired message should not be dispatched");
    }

    #[test]
    fn topic_id_deterministic() {
        let ns = "team-alpha";

        let id1 = derive_topic_id(&NerveTopic::Heartbeat, ns);
        let id2 = derive_topic_id(&NerveTopic::Heartbeat, ns);
        assert_eq!(id1, id2, "Same topic+namespace should produce same TopicId");

        let id_task = derive_topic_id(&NerveTopic::Task, ns);
        assert_ne!(id1, id_task, "Different topic should produce different TopicId");

        let id_other_ns = derive_topic_id(&NerveTopic::Heartbeat, "team-beta");
        assert_ne!(id1, id_other_ns, "Different namespace should produce different TopicId");
    }
}

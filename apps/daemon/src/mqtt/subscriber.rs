use prost::Message;
use rumqttc::Publish;
use teamclaw_transport::IncomingFrame;
use tracing::warn;

use crate::proto::amux;

pub enum IncomingMessage {
    // Decoded from amux/{team}/{actor}/runtime/+/commands.
    RuntimeCommand {
        runtime_id: String,
        envelope: amux::RuntimeCommandEnvelope,
    },
    TeamclawRpc {
        topic: String,
        payload: Vec<u8>,
    },
    TeamclawRpcResponse {
        topic: String,
        payload: Vec<u8>,
    },
    TeamclawNotify {
        actor_id: String,
        payload: Vec<u8>,
    },
    TeamclawSessionLive {
        session_id: String,
        payload: Vec<u8>,
    },
}

pub fn parse_incoming(publish: &Publish) -> Option<IncomingMessage> {
    parse_frame(&IncomingFrame {
        topic: publish.topic.clone(),
        payload: publish.payload.to_vec(),
        retained: publish.retain,
    })
}

pub fn parse_frame(frame: &IncomingFrame) -> Option<IncomingMessage> {
    let topic = &frame.topic;
    let payload = &frame.payload;

    if topic.starts_with("amux/") && topic.ends_with("/rpc/req") {
        return Some(IncomingMessage::TeamclawRpc {
            topic: topic.clone(),
            payload: payload.clone(),
        });
    }

    if topic.starts_with("amux/") && topic.ends_with("/rpc/res") {
        return Some(IncomingMessage::TeamclawRpcResponse {
            topic: topic.clone(),
            payload: payload.clone(),
        });
    }

    // Team-scoped collaboration live topic: amux/{team}/session/{sid}/live.
    if topic.starts_with("amux/") {
        let parts: Vec<&str> = topic.split('/').collect();
        if parts.len() == 5 && parts[2] == "session" && parts[4] == "live" {
            return Some(IncomingMessage::TeamclawSessionLive {
                session_id: parts[3].to_string(),
                payload: payload.clone(),
            });
        }
    }

    // Actor notify: amux/{team}/{actor}/notify (4 segments).
    if topic.starts_with("amux/") && topic.ends_with("/notify") {
        let parts: Vec<&str> = topic.split('/').collect();
        if parts.len() == 4 {
            return Some(IncomingMessage::TeamclawNotify {
                actor_id: parts[2].to_string(),
                payload: payload.clone(),
            });
        }
    }

    if topic.contains("/runtime/") && topic.ends_with("/commands") {
        let parts: Vec<&str> = topic.split('/').collect();
        // amux / {team} / {actor} / runtime / {runtime_id} / commands
        // = 6 segments
        if parts.len() == 6 && parts[3] == "runtime" {
            let runtime_id = parts[4].to_string();
            match amux::RuntimeCommandEnvelope::decode(payload.as_slice()) {
                Ok(envelope) => {
                    return Some(IncomingMessage::RuntimeCommand {
                        runtime_id,
                        envelope,
                    });
                }
                Err(e) => warn!("failed to decode RuntimeCommandEnvelope: {}", e),
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message as ProstMessage;
    use rumqttc::Publish;

    #[test]
    fn parse_runtime_commands_routes_to_new_variant() {
        let envelope = amux::RuntimeCommandEnvelope {
            runtime_id: "rt1".to_string(),
            actor_id: "actor-a".to_string(),
            ..Default::default()
        };
        let p = Publish::new(
            "amux/team1/actor-a/runtime/rt1/commands",
            rumqttc::QoS::AtLeastOnce,
            envelope.encode_to_vec(),
        );
        let msg = parse_incoming(&p).expect("should parse");
        match msg {
            IncomingMessage::RuntimeCommand { runtime_id, .. } => {
                assert_eq!(runtime_id, "rt1");
            }
            _ => panic!("wrong variant"),
        }
    }
}

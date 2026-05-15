use prost::Message;
use rumqttc::Publish;
use tracing::warn;

use crate::proto::amux;

pub enum IncomingMessage {
    // Phase 1a variant: decoded from device/{id}/runtime/+/commands.
    RuntimeCommand {
        runtime_id: String,
        envelope: amux::RuntimeCommandEnvelope,
    },
    TeamclawRpc {
        topic: String,
        payload: Vec<u8>,
    },
    TeamclawNotify {
        device_id: String,
        payload: Vec<u8>,
    },
    TeamclawSessionLive {
        session_id: String,
        payload: Vec<u8>,
    },
}

pub fn parse_incoming(publish: &Publish) -> Option<IncomingMessage> {
    let topic = &publish.topic;

    if topic.starts_with("amux/") && topic.ends_with("/rpc/req") {
        return Some(IncomingMessage::TeamclawRpc {
            topic: topic.clone(),
            payload: publish.payload.to_vec(),
        });
    }

    // Team-scoped collaboration topics are matched before device-scoped topics.
    if topic.starts_with("amux/") && !topic.contains("/device/") {
        let parts: Vec<&str> = topic.split('/').collect();
        if parts.len() == 5 && parts[2] == "session" {
            let session_id = parts[3].to_string();
            if parts[4] == "live" {
                return Some(IncomingMessage::TeamclawSessionLive {
                    session_id,
                    payload: publish.payload.to_vec(),
                });
            }
        }
    }

    if topic.starts_with("amux/") && topic.contains("/device/") {
        let parts: Vec<&str> = topic.split('/').collect();
        if parts.len() == 5 && parts[2] == "device" && parts[4] == "notify" {
            return Some(IncomingMessage::TeamclawNotify {
                device_id: parts[3].to_string(),
                payload: publish.payload.to_vec(),
            });
        }
    }

    if topic.contains("/runtime/") && topic.ends_with("/commands") {
        let parts: Vec<&str> = topic.split('/').collect();
        // amux / {team} / device / {device_id} / runtime / {runtime_id} / commands
        // = 7 segments
        if parts.len() == 7 && parts[4] == "runtime" {
            let runtime_id = parts[5].to_string();
            match amux::RuntimeCommandEnvelope::decode(publish.payload.as_ref()) {
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
            device_id: "dev-a".to_string(),
            ..Default::default()
        };
        let p = Publish::new(
            "amux/team1/device/dev-a/runtime/rt1/commands",
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

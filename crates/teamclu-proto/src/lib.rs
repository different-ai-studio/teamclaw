pub mod amux {
    #![allow(clippy::large_enum_variant)]
    include!(concat!(env!("OUT_DIR"), "/amux.rs"));
}

pub mod teamclu {
    include!(concat!(env!("OUT_DIR"), "/teamclu.rs"));
}

use prost::Message;

macro_rules! impl_encode {
    ($($t:ty),* $(,)?) => {
        $(
            impl $t {
                pub fn encode_to_vec(&self) -> Vec<u8> {
                    let mut buf = Vec::with_capacity(self.encoded_len());
                    self.encode(&mut buf).expect(concat!("encode ", stringify!($t)));
                    buf
                }
            }
        )*
    };
}

impl_encode!(
    amux::Envelope,
    amux::ActorPresence,
    amux::AgentList,
    amux::RuntimeInfo,
    amux::PeerList,
    amux::MemberList,
    amux::WorkspaceList,
);

impl_encode!(
    teamclu::SessionMessageEnvelope,
    teamclu::LiveEventEnvelope,
    teamclu::IdeaEvent,
    teamclu::RpcRequest,
    teamclu::RpcResponse,
    teamclu::Notify,
);

impl amux::RuntimeCommandEnvelope {
    pub fn decode_from(buf: &[u8]) -> Result<Self, prost::DecodeError> {
        Self::decode(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::teamclu;
    use prost::Message;

    #[test]
    fn session_message_envelope_round_trips_mentions() {
        let env = teamclu::SessionMessageEnvelope {
            message: None,
            mention_actor_ids: vec!["a".into(), "b".into()],
        };
        let bytes = env.encode_to_vec();
        let decoded = teamclu::SessionMessageEnvelope::decode(bytes.as_slice()).unwrap();
        assert_eq!(decoded.mention_actor_ids, vec!["a", "b"]);
    }

    #[test]
    fn old_envelope_without_field_decodes_as_empty() {
        let env = teamclu::SessionMessageEnvelope::default();
        let bytes = env.encode_to_vec();
        let decoded = teamclu::SessionMessageEnvelope::decode(bytes.as_slice()).unwrap();
        assert!(decoded.mention_actor_ids.is_empty());
    }
}

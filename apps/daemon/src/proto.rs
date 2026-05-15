pub mod amux {
    include!(concat!(env!("OUT_DIR"), "/amux.rs"));
}

use prost::Message;

// Helper trait for encode_to_vec on all proto messages
macro_rules! impl_encode {
    ($($t:ty),*) => {
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
    amux::DeviceState,
    amux::AgentList,
    amux::RuntimeInfo,
    amux::PeerList,
    amux::MemberList,
    amux::WorkspaceList
);

pub mod teamclaw {
    include!(concat!(env!("OUT_DIR"), "/teamclaw.rs"));
}

impl_encode!(
    teamclaw::SessionMessageEnvelope,
    teamclaw::IdeaEvent,
    teamclaw::RpcRequest,
    teamclaw::RpcResponse,
    teamclaw::Notify
);

impl amux::RuntimeCommandEnvelope {
    pub fn decode_from(buf: &[u8]) -> crate::error::Result<Self> {
        Ok(Self::decode(buf)?)
    }
}

#[cfg(test)]
mod mention_field_tests {
    use crate::proto::teamclaw;
    use prost::Message;

    #[test]
    fn session_message_envelope_round_trips_mentions() {
        let env = teamclaw::SessionMessageEnvelope {
            message: None,
            mention_actor_ids: vec!["a".into(), "b".into()],
        };
        let bytes = env.encode_to_vec();
        let decoded = teamclaw::SessionMessageEnvelope::decode(bytes.as_slice()).unwrap();
        assert_eq!(decoded.mention_actor_ids, vec!["a", "b"]);
    }

    #[test]
    fn old_envelope_without_field_decodes_as_empty() {
        // Default-constructed envelope simulates an old client that didn't
        // set mention_actor_ids. Decode must produce an empty vec.
        let env = teamclaw::SessionMessageEnvelope::default();
        let bytes = env.encode_to_vec();
        let decoded = teamclaw::SessionMessageEnvelope::decode(bytes.as_slice()).unwrap();
        assert!(decoded.mention_actor_ids.is_empty());
    }
}

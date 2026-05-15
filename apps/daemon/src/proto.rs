pub use teamclaw_proto::{amux, teamclaw};

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

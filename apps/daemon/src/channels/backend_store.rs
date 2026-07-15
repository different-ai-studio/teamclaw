//! `ChannelStore` impl: adapts amuxd's backend client to the
//! `teamclaw_gateway::ChannelStore` trait so channels persist external
//! actors, gateway sessions, and messages through the same backend
//! endpoints amuxd already uses for native sessions.

use async_trait::async_trait;
use std::sync::Arc;

use teamclaw_gateway::{AttachmentRecord, ChannelStore, EnsureSessionOutcome, StoreError};

use crate::backend::Backend;

pub struct AmuxdChannelStore {
    pub client: Arc<dyn Backend>,
}

#[async_trait]
impl ChannelStore for AmuxdChannelStore {
    async fn ensure_external_actor(
        &self,
        team_id: &str,
        source: &str,
        source_id: &str,
        display_name: &str,
    ) -> Result<String, StoreError> {
        self.client
            .rpc_upsert_external_actor(team_id, source, source_id, display_name)
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))
    }

    async fn ensure_session(
        &self,
        team_id: &str,
        binding: &str,
        title: &str,
        primary_agent_actor_id: &str,
        owner_member_actor_ids: &[String],
        participant_actor_ids: &[String],
    ) -> Result<EnsureSessionOutcome, StoreError> {
        let (session_id, acp_session_id, created) = self
            .client
            .rpc_ensure_gateway_session(
                team_id,
                binding,
                title,
                primary_agent_actor_id,
                owner_member_actor_ids,
                participant_actor_ids,
            )
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))?;
        Ok(EnsureSessionOutcome {
            session_id,
            acp_session_id,
            created,
        })
    }

    async fn record_message(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> Result<String, StoreError> {
        self.client
            .insert_gateway_message(session_id, sender_actor_id, content, external_message_id)
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))
    }

    async fn record_agent_reply(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> Result<String, StoreError> {
        self.client
            .insert_gateway_agent_reply(session_id, sender_actor_id, content, external_message_id)
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))
    }

    async fn record_message_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: Vec<AttachmentRecord>,
    ) -> Result<String, StoreError> {
        let json_attachments: Vec<serde_json::Value> = attachments
            .into_iter()
            .map(|a| {
                serde_json::json!({
                    "filename": a.filename,
                    "mime": a.mime,
                    "size": a.size,
                    "bucket_path": a.bucket_path,
                    "local_path": a.local_path,
                })
            })
            .collect();

        self.client
            .insert_gateway_message_with_attachments(
                session_id,
                sender_actor_id,
                content,
                external_message_id,
                serde_json::Value::Array(json_attachments),
            )
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))
    }

    async fn upload_attachment(
        &self,
        bucket_path: &str,
        bytes: Vec<u8>,
        mime: &str,
    ) -> Result<String, StoreError> {
        self.client
            .upload_attachment_bytes(bucket_path, bytes, mime)
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))
    }

    async fn add_participant(&self, session_id: &str, actor_id: &str) -> Result<(), StoreError> {
        self.client
            .upsert_session_participant(session_id, actor_id)
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    //! Caller-level integration tests proving the `Backend` abstraction is
    //! usable: `AmuxdChannelStore` is exercised against `MockBackend` with
    //! no HTTP mocking, and we inspect the backend's recorded state to
    //! assert behavior.

    use super::*;
    use crate::backend::mock::MockBackend;
    use teamclaw_gateway::AttachmentRecord;

    fn store() -> (AmuxdChannelStore, MockBackend) {
        let mock = MockBackend::with_identity("team-x", "agent-x");
        let backend: Arc<dyn Backend> = Arc::new(mock.clone());
        (AmuxdChannelStore { client: backend }, mock)
    }

    #[tokio::test]
    async fn ensure_external_actor_records_inputs_and_uses_default_uuid() {
        let (store, mock) = store();
        let id = store
            .ensure_external_actor("team-x", "discord", "user-42", "Alice")
            .await
            .unwrap();
        assert_eq!(id, "external-discord-user-42");
        let snap = mock.state();
        assert_eq!(snap.external_actors_upserted.len(), 1);
        assert_eq!(snap.external_actors_upserted[0].display_name, "Alice");
    }

    #[tokio::test]
    async fn ensure_session_threads_seeded_outcome_back_to_caller() {
        let (store, mock) = store();
        mock.state().ensure_gateway_session_result = Some(("sess-1".into(), "acp-1".into(), true));

        let out = store
            .ensure_session(
                "team-x",
                "discord://chan/1",
                "title",
                "agent-x",
                &["owner-1".into()],
                &["part-1".into()],
            )
            .await
            .unwrap();
        assert_eq!(out.session_id, "sess-1");
        assert_eq!(out.acp_session_id, "acp-1");
        assert!(out.created);

        let snap = mock.state();
        assert_eq!(snap.gateway_sessions_ensured.len(), 1);
        assert_eq!(snap.gateway_sessions_ensured[0].binding, "discord://chan/1");
        assert_eq!(
            snap.gateway_sessions_ensured[0].owner_member_actor_ids,
            vec!["owner-1".to_string()]
        );
    }

    #[tokio::test]
    async fn record_message_with_attachments_serializes_attachment_records() {
        let (store, mock) = store();
        let attachments = vec![AttachmentRecord {
            filename: "img.png".into(),
            mime: "image/png".into(),
            size: 1024,
            bucket_path: "t/s/1/img.png".into(),
            local_path: Some("/tmp/img.png".into()),
        }];
        let id = store
            .record_message_with_attachments(
                "sess-1",
                "agent-x",
                "see attached",
                Some("ext-1"),
                attachments,
            )
            .await
            .unwrap();
        assert!(id.starts_with("mock-msg-"));

        let snap = mock.state();
        assert_eq!(snap.gateway_messages_inserted.len(), 1);
        let stored = &snap.gateway_messages_inserted[0];
        assert_eq!(stored.external_id.as_deref(), Some("ext-1"));
        let arr = stored
            .attachments
            .as_array()
            .expect("attachments JSON array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["filename"], "img.png");
        assert_eq!(arr[0]["bucket_path"], "t/s/1/img.png");
    }

    #[tokio::test]
    async fn upload_attachment_buffers_bytes_in_recorded_state() {
        let (store, mock) = store();
        store
            .upload_attachment("team-x/sess/file.png", vec![1, 2, 3, 4], "image/png")
            .await
            .unwrap();
        let snap = mock.state();
        assert_eq!(snap.attachments_uploaded.len(), 1);
        assert_eq!(snap.attachments_uploaded[0].bytes, vec![1, 2, 3, 4]);
        assert_eq!(snap.attachments_uploaded[0].mime, "image/png");
    }
}

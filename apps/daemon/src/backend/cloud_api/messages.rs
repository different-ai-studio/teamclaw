use super::super::{BackendResult, StoredMessage};
use super::client::empty_to_none;
use super::CloudApiBackend;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
pub(super) struct CloudPage<T> {
    pub(super) items: Vec<T>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CloudMessage {
    pub(super) id: String,
    #[serde(rename = "sessionId")]
    pub(super) session_id: String,
    #[serde(rename = "senderActorId")]
    pub(super) sender_actor_id: Option<String>,
    pub(super) kind: String,
    pub(super) content: String,
    pub(super) metadata: Option<Value>,
    #[serde(rename = "createdAt")]
    pub(super) created_at: DateTime<Utc>,
}

impl CloudMessage {
    pub(super) fn into_stored_message(self) -> BackendResult<StoredMessage> {
        Ok(StoredMessage {
            id: self.id,
            session_id: self.session_id,
            sender_actor_id: self.sender_actor_id.unwrap_or_default(),
            kind: self.kind,
            content: self.content,
            metadata_json: serde_json::to_string(&self.metadata.unwrap_or(Value::Null))?,
            created_at: self.created_at.timestamp(),
        })
    }
}

#[derive(Serialize)]
pub(super) struct InsertMessageRequest<'a> {
    pub(super) id: &'a str,
    #[serde(rename = "teamId")]
    pub(super) team_id: &'a str,
    #[serde(rename = "senderActorId")]
    pub(super) sender_actor_id: &'a str,
    pub(super) content: &'a str,
    pub(super) kind: &'a str,
    pub(super) metadata: Option<Value>,
    #[serde(rename = "turnId")]
    pub(super) turn_id: Option<&'a str>,
    #[serde(rename = "replyToMessageId")]
    pub(super) reply_to_message_id: Option<&'a str>,
    pub(super) model: Option<&'a str>,
    #[serde(rename = "createdAt")]
    pub(super) created_at: Option<&'a str>,
}

impl CloudApiBackend {
    pub(super) async fn messages_after_cursor_impl(
        &self,
        session_id: &str,
        after_id: Option<&str>,
    ) -> BackendResult<Vec<StoredMessage>> {
        let page: CloudPage<CloudMessage> = self
            .get(&format!("/v1/sessions/{session_id}/messages"))
            .await?;
        let mut seen_cursor = after_id.is_none();
        let mut out = Vec::new();
        for row in page.items {
            if !seen_cursor {
                seen_cursor = Some(row.id.as_str()) == after_id;
                continue;
            }
            out.push(row.into_stored_message()?);
        }
        Ok(out)
    }

    pub(super) async fn insert_gateway_message_impl(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        let id = external_message_id
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let message: CloudMessage = self
            .post(
                &format!("/v1/sessions/{session_id}/messages"),
                &InsertMessageRequest {
                    id: &id,
                    team_id: &self.cfg.team_id,
                    sender_actor_id,
                    content,
                    kind: "text",
                    metadata: None,
                    turn_id: None,
                    reply_to_message_id: None,
                    model: None,
                    created_at: None,
                },
                Some(&id),
            )
            .await?;
        Ok(message.id)
    }

    pub(super) async fn insert_gateway_agent_reply_impl(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        let id = external_message_id
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let message: CloudMessage = self
            .post(
                &format!("/v1/sessions/{session_id}/messages"),
                &InsertMessageRequest {
                    id: &id,
                    team_id: &self.cfg.team_id,
                    sender_actor_id,
                    content,
                    kind: "agent_reply",
                    metadata: None,
                    turn_id: None,
                    reply_to_message_id: None,
                    model: None,
                    created_at: None,
                },
                Some(&id),
            )
            .await?;
        Ok(message.id)
    }

    pub(super) async fn insert_gateway_message_with_attachments_impl(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: Value,
    ) -> BackendResult<String> {
        let id = external_message_id
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let metadata = serde_json::json!({ "attachments": attachments });
        let message: CloudMessage = self
            .post(
                &format!("/v1/sessions/{session_id}/messages"),
                &InsertMessageRequest {
                    id: &id,
                    team_id: &self.cfg.team_id,
                    sender_actor_id,
                    content,
                    kind: "text",
                    metadata: Some(metadata),
                    turn_id: None,
                    reply_to_message_id: None,
                    model: None,
                    created_at: None,
                },
                Some(&id),
            )
            .await?;
        Ok(message.id)
    }

    #[cfg(test)]
    pub(super) fn cursor_filter(
        items: Vec<CloudMessage>,
        after_id: Option<&str>,
    ) -> Vec<CloudMessage> {
        let mut seen_cursor = after_id.is_none();
        let mut out = Vec::new();
        for row in items {
            if !seen_cursor {
                seen_cursor = Some(row.id.as_str()) == after_id;
                continue;
            }
            out.push(row);
        }
        out
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn insert_message_impl(
        &self,
        id: &str,
        team_id: &str,
        session_id: &str,
        sender_actor_id: &str,
        kind: &str,
        content: &str,
        metadata_json: &str,
        model: &str,
        turn_id: &str,
        sequence: u64,
    ) -> BackendResult<()> {
        let metadata = serde_json::from_str(metadata_json).unwrap_or(Value::Null);
        let metadata = match metadata {
            Value::Object(mut object) => {
                object.insert("sequence".to_string(), Value::from(sequence));
                Some(Value::Object(object))
            }
            Value::Null => Some(serde_json::json!({ "sequence": sequence })),
            other => Some(serde_json::json!({ "value": other, "sequence": sequence })),
        };
        let _: CloudMessage = self
            .post(
                &format!("/v1/sessions/{session_id}/messages"),
                &InsertMessageRequest {
                    id,
                    team_id,
                    sender_actor_id,
                    content,
                    kind,
                    metadata,
                    turn_id: empty_to_none(turn_id),
                    reply_to_message_id: None,
                    model: empty_to_none(model),
                    created_at: None,
                },
                Some(id),
            )
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn make_msg(id: &str) -> CloudMessage {
        CloudMessage {
            id: id.to_string(),
            session_id: "sess".to_string(),
            sender_actor_id: Some("actor-1".to_string()),
            kind: "text".to_string(),
            content: "hello".to_string(),
            metadata: None,
            created_at: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
        }
    }

    #[test]
    fn into_stored_message_maps_fields() {
        let msg = make_msg("msg-1");
        let stored = msg.into_stored_message().unwrap();
        assert_eq!(stored.id, "msg-1");
        assert_eq!(stored.session_id, "sess");
        assert_eq!(stored.sender_actor_id, "actor-1");
        assert_eq!(stored.kind, "text");
        assert_eq!(stored.content, "hello");
        assert_eq!(stored.metadata_json, "null");
        assert_eq!(stored.created_at, 1_700_000_000);
    }

    #[test]
    fn into_stored_message_null_sender_becomes_empty() {
        let mut msg = make_msg("msg-2");
        msg.sender_actor_id = None;
        let stored = msg.into_stored_message().unwrap();
        assert_eq!(stored.sender_actor_id, "");
    }

    #[test]
    fn into_stored_message_metadata_serialised() {
        let mut msg = make_msg("msg-3");
        msg.metadata = Some(serde_json::json!({"key": "value"}));
        let stored = msg.into_stored_message().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&stored.metadata_json).unwrap();
        assert_eq!(parsed["key"], "value");
    }

    #[test]
    fn cursor_filter_no_cursor_returns_all() {
        let items = vec![make_msg("a"), make_msg("b"), make_msg("c")];
        let out = CloudApiBackend::cursor_filter(items, None);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn cursor_filter_skips_up_to_and_including_cursor() {
        let items = vec![make_msg("a"), make_msg("b"), make_msg("c"), make_msg("d")];
        let out = CloudApiBackend::cursor_filter(items, Some("b"));
        let ids: Vec<_> = out.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["c", "d"]);
    }

    #[test]
    fn cursor_filter_cursor_is_last_returns_empty() {
        let items = vec![make_msg("a"), make_msg("b")];
        let out = CloudApiBackend::cursor_filter(items, Some("b"));
        assert!(out.is_empty());
    }

    #[test]
    fn cursor_filter_cursor_not_found_returns_empty() {
        let items = vec![make_msg("a"), make_msg("b")];
        let out = CloudApiBackend::cursor_filter(items, Some("z"));
        assert!(out.is_empty());
    }
}

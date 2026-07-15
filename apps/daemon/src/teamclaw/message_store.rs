use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::proto::teamclaw;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct MessageStore {
    #[serde(default)]
    pub messages: Vec<StoredMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    pub message_id: String,
    pub session_id: String,
    pub sender_actor_id: String,
    pub kind: String,
    pub content: String,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub reply_to_message_id: String,
    #[serde(default)]
    pub mentions: Vec<String>,
    /// Model id stamped at publish time. Absent in pre-Plan-6 TOML files;
    /// `#[serde(default)]` deserializes those as empty string.
    #[serde(default)]
    pub model: String,
    /// Free-form JSON for kind-specific structured data (tool args, tool
    /// result payload, etc.). Empty for plain text/agent reply messages.
    /// Absent in older TOML files — `#[serde(default)]` keeps them parsing.
    #[serde(default)]
    pub metadata_json: String,
    /// Daemon-assigned correlation id for the ACP turn this message
    /// belongs to. Stamped by TurnAggregator on emit so clients can
    /// merge consecutive same-turn AgentReply rows into one bubble.
    /// Absent in pre-turn_id TOML files — `#[serde(default)]` keeps
    /// them parsing.
    #[serde(default)]
    pub turn_id: String,
}

impl MessageStore {
    fn path_for(base_dir: &Path, session_id: &str) -> std::path::PathBuf {
        base_dir
            .join("teamclaw")
            .join("sessions")
            .join(session_id)
            .join("messages.toml")
    }

    pub fn load(base_dir: &Path, session_id: &str) -> crate::error::Result<Self> {
        let path = Self::path_for(base_dir, session_id);
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = std::fs::read_to_string(&path).map_err(|e| {
            crate::error::AmuxError::Config(format!("read {}: {}", path.display(), e))
        })?;
        toml::from_str(&content).map_err(|e| {
            crate::error::AmuxError::Config(format!("parse {}: {}", path.display(), e))
        })
    }

    pub fn save(&self, base_dir: &Path, session_id: &str) -> crate::error::Result<()> {
        let path = Self::path_for(base_dir, session_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(self)
            .map_err(|e| crate::error::AmuxError::Config(e.to_string()))?;
        std::fs::write(&path, content)?;
        Ok(())
    }

    pub fn append(&mut self, message: StoredMessage) {
        self.messages.push(message);
    }

    #[allow(dead_code)]
    pub fn recent(&self, n: usize) -> &[StoredMessage] {
        let len = self.messages.len();
        if n >= len {
            &self.messages
        } else {
            &self.messages[len - n..]
        }
    }

    /// Read a page of messages ordered oldest -> newest.
    ///
    /// When `before_created_at` is 0, returns the most recent `page_size`
    /// messages. Otherwise returns the newest page of messages strictly older
    /// than `before_created_at`.
    pub fn page_before(
        &self,
        before_created_at: i64,
        page_size: u32,
    ) -> (Vec<&StoredMessage>, bool, i64) {
        let page = page_size.max(1) as usize;

        let end = if before_created_at == 0 {
            self.messages.len()
        } else {
            self.messages
                .iter()
                .position(|m| m.created_at.timestamp() >= before_created_at)
                .unwrap_or(self.messages.len())
        };

        if end == 0 {
            return (vec![], false, before_created_at);
        }

        let start = end.saturating_sub(page);
        let has_more = start > 0;
        let slice = self.messages[start..end].iter().collect::<Vec<_>>();
        let next_before_created_at = slice
            .first()
            .map(|m| m.created_at.timestamp())
            .unwrap_or(before_created_at);

        (slice, has_more, next_before_created_at)
    }

    #[allow(dead_code)]
    pub fn latest_preview(&self) -> Option<(String, i64)> {
        self.messages.last().map(|msg| {
            let preview = msg.content.chars().take(140).collect::<String>();
            (preview, msg.created_at.timestamp())
        })
    }

    pub fn to_proto(msg: &StoredMessage) -> teamclaw::Message {
        teamclaw::Message {
            message_id: msg.message_id.clone(),
            session_id: msg.session_id.clone(),
            sender_actor_id: msg.sender_actor_id.clone(),
            kind: message_kind_to_proto(&msg.kind) as i32,
            content: msg.content.clone(),
            created_at: msg.created_at.timestamp(),
            reply_to_message_id: msg.reply_to_message_id.clone(),
            mentions: msg.mentions.clone(),
            model: msg.model.clone(),
            metadata_json: msg.metadata_json.clone(),
            turn_id: msg.turn_id.clone(),
            attachment_urls: vec![],
        }
    }
}

fn message_kind_to_proto(s: &str) -> teamclaw::MessageKind {
    match s {
        "text" => teamclaw::MessageKind::Text,
        "system" => teamclaw::MessageKind::System,
        "work_event" => teamclaw::MessageKind::WorkEvent,
        "agent_thinking" => teamclaw::MessageKind::AgentThinking,
        "agent_tool_call" => teamclaw::MessageKind::AgentToolCall,
        "agent_tool_result" => teamclaw::MessageKind::AgentToolResult,
        "agent_reply" => teamclaw::MessageKind::AgentReply,
        _ => teamclaw::MessageKind::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use tempfile::TempDir;

    fn make_message(id: &str, session_id: &str, content: &str) -> StoredMessage {
        StoredMessage {
            message_id: id.to_string(),
            session_id: session_id.to_string(),
            sender_actor_id: "user1".to_string(),
            kind: "text".to_string(),
            content: content.to_string(),
            created_at: Utc::now(),
            reply_to_message_id: String::new(),
            mentions: vec![],
            model: String::new(),
            metadata_json: String::new(),
            turn_id: String::new(),
        }
    }

    #[test]
    fn test_append_and_recent() {
        let mut store = MessageStore::default();
        store.append(make_message("m1", "s1", "hello"));
        store.append(make_message("m2", "s1", "world"));
        store.append(make_message("m3", "s1", "foo"));

        assert_eq!(store.messages.len(), 3);

        let recent = store.recent(2);
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].message_id, "m2");
        assert_eq!(recent[1].message_id, "m3");
    }

    #[test]
    fn test_recent_more_than_available() {
        let mut store = MessageStore::default();
        store.append(make_message("m1", "s1", "hello"));
        let recent = store.recent(10);
        assert_eq!(recent.len(), 1);
    }

    #[test]
    fn test_save_and_load() {
        let tmp = TempDir::new().unwrap();
        let mut store = MessageStore::default();
        store.append(make_message("m1", "s1", "hello"));
        store.append(make_message("m2", "s1", "world"));
        store.save(tmp.path(), "s1").unwrap();

        let loaded = MessageStore::load(tmp.path(), "s1").unwrap();
        assert_eq!(loaded.messages.len(), 2);
        assert_eq!(loaded.messages[0].content, "hello");
    }

    #[test]
    fn test_load_nonexistent_returns_default() {
        let tmp = TempDir::new().unwrap();
        let store = MessageStore::load(tmp.path(), "nonexistent").unwrap();
        assert!(store.messages.is_empty());
    }

    #[test]
    fn test_to_proto() {
        let msg = make_message("m1", "s1", "hello");
        let proto = MessageStore::to_proto(&msg);
        assert_eq!(proto.message_id, "m1");
        assert_eq!(proto.content, "hello");
        assert_eq!(proto.kind, teamclaw::MessageKind::Text as i32);
    }

    #[test]
    fn test_to_proto_system_kind() {
        let mut msg = make_message("m1", "s1", "system msg");
        msg.kind = "system".to_string();
        let proto = MessageStore::to_proto(&msg);
        assert_eq!(proto.kind, teamclaw::MessageKind::System as i32);
    }
}

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Entry for a single session context, storing both the OpenCode session ID
/// and an optional model preference override.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionEntry {
    /// OpenCode session ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Model preference override (format: "provider/model")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Persistent session data structure.
/// All sessions are stored in a single unified map.
/// Keys are prefixed with the channel name:
///   - Discord DM:      "discord:dm:<user_id>"
///   - Discord Channel:  "discord:channel:<guild_id>:<channel_id>"
///   - Feishu:           "feishu:<chat_id>"
///   - Email:            "email:thread:<message_id_or_uid>"
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionData {
    /// Unified sessions map: prefixed_key -> session entry
    pub sessions: HashMap<String, SessionEntry>,
    /// Email message ID index: message_id -> session_key
    #[serde(default)]
    pub email_message_index: HashMap<String, String>,
    /// Email normalized subject index: normalized_subject -> session_key
    #[serde(default)]
    pub email_subject_index: HashMap<String, String>,
}

/// Session mapping between gateway contexts and OpenCode sessions
#[derive(Debug)]
pub struct SessionMapping {
    /// Session data
    data: Arc<RwLock<SessionData>>,
    /// Path to persist sessions
    persist_path: Arc<RwLock<Option<PathBuf>>>,
}

impl Default for SessionMapping {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionMapping {
    pub fn new() -> Self {
        Self {
            data: Arc::new(RwLock::new(SessionData::default())),
            persist_path: Arc::new(RwLock::new(None)),
        }
    }

    /// Set the persistence path and load existing sessions
    pub async fn set_persist_path(&self, workspace_path: &str) {
        let teamclaw_dir = PathBuf::from(workspace_path).join(crate::commands::TEAMCLAW_DIR);
        let _ = std::fs::create_dir_all(&teamclaw_dir);
        let path = teamclaw_dir.join("sessions.json");
        println!("[Session] Persistence path: {:?}", path);

        // Load existing sessions if file exists
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(content) => match serde_json::from_str::<SessionData>(&content) {
                    Ok(loaded_data) => {
                        let mut data = self.data.write().await;
                        *data = loaded_data;
                        println!("[Session] Loaded {} sessions", data.sessions.len());
                    }
                    Err(e) => {
                        println!("[Session] Failed to parse sessions file: {}", e);
                    }
                },
                Err(e) => {
                    println!("[Session] Failed to read sessions file: {}", e);
                }
            }
        } else {
            println!("[Session] No existing sessions file found");
        }

        let mut persist_path = self.persist_path.write().await;
        *persist_path = Some(path);
    }

    /// Save sessions to file
    async fn persist(&self) {
        let persist_path = self.persist_path.read().await;
        if let Some(path) = persist_path.as_ref() {
            let data = self.data.read().await;
            match serde_json::to_string_pretty(&*data) {
                Ok(content) => {
                    if let Err(e) = std::fs::write(path, content) {
                        eprintln!("[Session] Failed to save sessions: {}", e);
                    } else {
                        println!("[Session] Sessions saved to {:?}", path);
                    }
                }
                Err(e) => {
                    eprintln!("[Session] Failed to serialize sessions: {}", e);
                }
            }
        }
    }

    /// Remove an entry if both session_id and model are None
    fn cleanup_entry(data: &mut SessionData, key: &str) {
        if let Some(entry) = data.sessions.get(key) {
            if entry.session_id.is_none() && entry.model.is_none() {
                data.sessions.remove(key);
            }
        }
    }

    // ==================== Session ID Operations ====================

    /// Get the OpenCode session ID for a key
    pub async fn get_session(&self, key: &str) -> Option<String> {
        let data = self.data.read().await;
        data.sessions.get(key).and_then(|e| e.session_id.clone())
    }

    /// Set the OpenCode session ID for a key (preserves existing model preference)
    pub async fn set_session(&self, key: String, session_id: String) {
        {
            let mut data = self.data.write().await;
            let entry = data.sessions.entry(key).or_default();
            entry.session_id = Some(session_id);
        }
        self.persist().await;
    }

    /// Remove only the session ID for a key (preserves model preference)
    pub async fn remove_session(&self, key: &str) {
        let changed = {
            let mut data = self.data.write().await;
            if let Some(entry) = data.sessions.get_mut(key) {
                if entry.session_id.is_some() {
                    entry.session_id = None;
                    Self::cleanup_entry(&mut data, key);
                    true
                } else {
                    false
                }
            } else {
                false
            }
        };
        if changed {
            self.persist().await;
        }
    }

    // ==================== Model Preference Operations ====================

    /// Get the model preference for a key
    pub async fn get_model(&self, key: &str) -> Option<String> {
        let data = self.data.read().await;
        data.sessions.get(key).and_then(|e| e.model.clone())
    }

    /// Set the model preference for a key (preserves existing session ID)
    pub async fn set_model(&self, key: String, model: String) {
        {
            let mut data = self.data.write().await;
            let entry = data.sessions.entry(key).or_default();
            entry.model = Some(model);
        }
        self.persist().await;
    }

    /// Remove only the model preference for a key (preserves session ID)
    pub async fn remove_model(&self, key: &str) {
        let changed = {
            let mut data = self.data.write().await;
            if let Some(entry) = data.sessions.get_mut(key) {
                if entry.model.is_some() {
                    entry.model = None;
                    Self::cleanup_entry(&mut data, key);
                    true
                } else {
                    false
                }
            } else {
                false
            }
        };
        if changed {
            self.persist().await;
        }
    }

    // ==================== Bulk Operations ====================

    // ==================== Email Thread Index Operations ====================

    /// Get email session key by message ID.
    pub async fn get_email_session_by_message_id(&self, message_id: &str) -> Option<String> {
        let key = message_id.trim().to_lowercase();
        if key.is_empty() {
            return None;
        }
        let data = self.data.read().await;
        data.email_message_index.get(&key).cloned()
    }

    /// Index a message ID to an email session key.
    pub async fn set_email_message_session(&self, message_id: String, session_key: String) {
        let message_id = message_id.trim().to_lowercase();
        if message_id.is_empty() || session_key.is_empty() {
            return;
        }
        {
            let mut data = self.data.write().await;
            data.email_message_index.insert(message_id, session_key);
        }
        self.persist().await;
    }

    /// Get email session key by normalized subject.
    pub async fn get_email_session_by_subject(&self, normalized_subject: &str) -> Option<String> {
        let subject = normalized_subject.trim().to_lowercase();
        if subject.is_empty() {
            return None;
        }
        let data = self.data.read().await;
        data.email_subject_index.get(&subject).cloned()
    }

    /// Index a normalized subject to an email session key.
    pub async fn set_email_subject_session(&self, normalized_subject: String, session_key: String) {
        let normalized_subject = normalized_subject.trim().to_lowercase();
        if normalized_subject.is_empty() || session_key.is_empty() {
            return;
        }
        {
            let mut data = self.data.write().await;
            data.email_subject_index
                .insert(normalized_subject, session_key);
        }
        self.persist().await;
    }

    /// Clear all sessions
    #[allow(dead_code)]
    pub async fn clear(&self) {
        {
            let mut data = self.data.write().await;
            data.sessions.clear();
            data.email_message_index.clear();
            data.email_subject_index.clear();
        }
        self.persist().await;
    }

    /// Clear sessions by channel prefix (e.g. "discord", "feishu", "email")
    pub async fn clear_by_namespace(&self, namespace: &str) {
        let prefix = format!("{}:", namespace);
        {
            let mut data = self.data.write().await;
            data.sessions.retain(|k, _| !k.starts_with(&prefix));
            data.email_message_index
                .retain(|_, session_key| !session_key.starts_with(&prefix));
            data.email_subject_index
                .retain(|_, session_key| !session_key.starts_with(&prefix));
        }
        self.persist().await;
    }

    /// Get total session count
    #[allow(dead_code)]
    pub async fn session_count(&self) -> usize {
        self.data.read().await.sessions.len()
    }

    /// Get all session info for debugging
    #[allow(dead_code)]
    pub async fn get_all_sessions(&self) -> SessionData {
        self.data.read().await.clone()
    }
}

impl Clone for SessionMapping {
    fn clone(&self) -> Self {
        Self {
            data: Arc::clone(&self.data),
            persist_path: Arc::clone(&self.persist_path),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_session_and_model() {
        let mapping = SessionMapping::new();

        // Initially empty
        assert!(mapping.get_session("discord:dm:user123").await.is_none());
        assert!(mapping.get_model("discord:dm:user123").await.is_none());

        // Set session ID
        mapping
            .set_session("discord:dm:user123".to_string(), "ses_abc".to_string())
            .await;
        assert_eq!(
            mapping.get_session("discord:dm:user123").await,
            Some("ses_abc".to_string())
        );
        assert!(mapping.get_model("discord:dm:user123").await.is_none());

        // Set model preference (preserves session ID)
        mapping
            .set_model(
                "discord:dm:user123".to_string(),
                "opencode/gpt-5-nano".to_string(),
            )
            .await;
        assert_eq!(
            mapping.get_session("discord:dm:user123").await,
            Some("ses_abc".to_string())
        );
        assert_eq!(
            mapping.get_model("discord:dm:user123").await,
            Some("opencode/gpt-5-nano".to_string())
        );

        // Remove session ID (preserves model)
        mapping.remove_session("discord:dm:user123").await;
        assert!(mapping.get_session("discord:dm:user123").await.is_none());
        assert_eq!(
            mapping.get_model("discord:dm:user123").await,
            Some("opencode/gpt-5-nano".to_string())
        );

        // Remove model (entry should be cleaned up since both are None)
        mapping.remove_model("discord:dm:user123").await;
        assert!(mapping.get_session("discord:dm:user123").await.is_none());
        assert!(mapping.get_model("discord:dm:user123").await.is_none());
    }

    #[tokio::test]
    async fn test_model_before_session() {
        let mapping = SessionMapping::new();

        // Set model preference before any session exists
        mapping
            .set_model(
                "feishu:chat_xyz".to_string(),
                "opencode/kimi-k2.5-free".to_string(),
            )
            .await;
        assert!(mapping.get_session("feishu:chat_xyz").await.is_none());
        assert_eq!(
            mapping.get_model("feishu:chat_xyz").await,
            Some("opencode/kimi-k2.5-free".to_string())
        );

        // Now set session (model preserved)
        mapping
            .set_session("feishu:chat_xyz".to_string(), "ses_ghi".to_string())
            .await;
        assert_eq!(
            mapping.get_session("feishu:chat_xyz").await,
            Some("ses_ghi".to_string())
        );
        assert_eq!(
            mapping.get_model("feishu:chat_xyz").await,
            Some("opencode/kimi-k2.5-free".to_string())
        );
    }

    #[tokio::test]
    async fn test_namespace_clearing() {
        let mapping = SessionMapping::new();

        mapping
            .set_session("discord:dm:user123".to_string(), "ses_abc".to_string())
            .await;
        mapping
            .set_model(
                "discord:dm:user123".to_string(),
                "opencode/gpt-5-nano".to_string(),
            )
            .await;
        mapping
            .set_session("feishu:chat_xyz".to_string(), "ses_ghi".to_string())
            .await;

        // Clear discord namespace
        mapping.clear_by_namespace("discord").await;
        assert!(mapping.get_session("discord:dm:user123").await.is_none());
        assert!(mapping.get_model("discord:dm:user123").await.is_none());
        // Feishu untouched
        assert_eq!(
            mapping.get_session("feishu:chat_xyz").await,
            Some("ses_ghi".to_string())
        );
    }
}

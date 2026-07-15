/// Returned by `claim_team_invite` — both member and agent branches.
/// `refresh_token` is `None` for member claims.
#[derive(Debug, Clone, serde::Deserialize)]
#[allow(dead_code)]
pub struct ClaimResult {
    pub actor_id: String,
    pub team_id: String,
    pub actor_type: String,
    pub display_name: String,
    pub refresh_token: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct AgentRuntimeUpsert<'a> {
    pub team_id: &'a str,
    pub agent_id: &'a str,
    pub session_id: Option<&'a str>,
    pub workspace_id: Option<&'a str>,
    pub backend_type: &'a str,
    pub backend_session_id: Option<&'a str>,
    /// Daemon-side 8-char runtime id, the topic segment in
    /// `runtime/{runtime_id}/state`. iOS uses it to bridge a backend
    /// `agent_runtimes` row to the live MQTT-published `Runtime`. Distinct
    /// from `backend_session_id` (the 36-char ACP session id used by the
    /// daemon to resume a Claude Code session).
    pub runtime_id: Option<&'a str>,
    pub status: &'a str,
    pub current_model: Option<&'a str>,
    pub last_seen_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, serde::Serialize)]
pub struct WorkspaceUpsert<'a> {
    pub team_id: &'a str,
    pub agent_id: &'a str,
    pub name: &'a str,
    pub path: Option<&'a str>,
    pub archived: bool,
    /// Existing cloud workspace UUID — when set, FC upserts in place instead of
    /// inserting a duplicate orphan row on every daemon sync.
    pub cloud_id: Option<&'a str>,
}

/// Subset of `agent_runtimes` columns read by runtime restore/catch-up flows.
#[derive(Debug, Clone, serde::Deserialize)]
#[allow(dead_code)]
pub struct AgentRuntimeRow {
    pub id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub backend_type: String,
    #[serde(default)]
    pub backend_session_id: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub last_processed_message_id: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct WorkspaceRow {
    pub id: String,
    #[serde(default)]
    pub team_id: String,
    #[serde(default)]
    pub path: Option<String>,
}

/// A single `messages` table row returned from the backend.
#[derive(Debug, Clone)]
pub struct StoredMessage {
    pub id: String,
    pub session_id: String,
    pub sender_actor_id: String,
    #[allow(dead_code)]
    pub kind: String,
    pub content: String,
    /// Raw JSON string of the `metadata` column.
    pub metadata_json: String,
    /// Unix epoch seconds derived from the `created_at` timestamp.
    pub created_at: i64,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct BackendSessionRow {
    pub id: String,
    pub team_id: String,
    #[serde(default)]
    pub created_by_actor_id: Option<String>,
    #[serde(default)]
    pub primary_agent_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub mode: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub idea_id: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct BackendParticipantRow {
    #[allow(dead_code)]
    pub session_id: String,
    pub actor_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub role: Option<String>,
    pub joined_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone)]
pub struct BackendSessionAndParticipants {
    pub session: BackendSessionRow,
    pub participants: Vec<BackendParticipantRow>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_runtime_row_serde_defaults() {
        let json = r#"{"id":"row-1"}"#;
        let row: AgentRuntimeRow = serde_json::from_str(json).unwrap();
        assert_eq!(row.id, "row-1");
        assert_eq!(row.backend_type, "");
        assert!(row.workspace_id.is_none());
        assert!(row.backend_session_id.is_none());
        assert_eq!(row.status, "");
        assert!(row.last_processed_message_id.is_none());
    }

    #[test]
    fn agent_runtime_row_full() {
        let json = r#"{
            "id": "row-2",
            "workspace_id": "ws-1",
            "backend_type": "cloud_api",
            "backend_session_id": "sess-abc",
            "status": "active",
            "last_processed_message_id": "msg-99"
        }"#;
        let row: AgentRuntimeRow = serde_json::from_str(json).unwrap();
        assert_eq!(row.backend_type, "cloud_api");
        assert_eq!(row.status, "active");
        assert_eq!(row.last_processed_message_id.as_deref(), Some("msg-99"));
    }

    #[test]
    fn backend_session_row_defaults_for_optional_fields() {
        let json = r#"{
            "id": "sess-1",
            "team_id": "team-1",
            "created_at": "2024-01-01T00:00:00Z"
        }"#;
        let row: BackendSessionRow = serde_json::from_str(json).unwrap();
        assert_eq!(row.id, "sess-1");
        assert!(row.created_by_actor_id.is_none());
        assert!(row.primary_agent_id.is_none());
        assert_eq!(row.mode, "");
        assert_eq!(row.title, "");
        assert_eq!(row.summary, "");
        assert!(row.idea_id.is_none());
    }

    #[test]
    fn claim_result_optional_refresh_token() {
        let json = r#"{
            "actor_id": "a1",
            "team_id": "t1",
            "actor_type": "agent",
            "display_name": "Bot"
        }"#;
        let r: ClaimResult = serde_json::from_str(json).unwrap();
        assert!(r.refresh_token.is_none());
    }

    #[test]
    fn workspace_row_deserializes() {
        let json = r#"{"id":"ws-abc"}"#;
        let row: WorkspaceRow = serde_json::from_str(json).unwrap();
        assert_eq!(row.id, "ws-abc");
    }

    #[test]
    fn backend_participant_row_default_role() {
        let json = r#"{
            "session_id": "s1",
            "actor_id": "a1",
            "joined_at": "2024-01-01T00:00:00Z"
        }"#;
        let row: BackendParticipantRow = serde_json::from_str(json).unwrap();
        assert!(row.role.is_none());
    }
}

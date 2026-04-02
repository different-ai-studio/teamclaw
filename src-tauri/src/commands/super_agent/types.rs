use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub node_id: String,
    pub name: String,
    pub owner: String,
    pub capabilities: Vec<Capability>,
    pub status: AgentStatus,
    pub current_task: Option<String>,
    pub last_heartbeat: u64,
    pub version: String,
    pub model_id: String,
    pub joined_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Online,
    Busy,
    Idle,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub domain: String,
    pub skills: Vec<String>,
    pub tools: Vec<String>,
    pub languages: Vec<String>,
    pub confidence: f64,
    pub task_count: u64,
    pub avg_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NerveMessage {
    pub id: String,
    pub topic: NerveTopic,
    pub from: String,
    pub timestamp: u64,
    pub ttl: u64,
    pub payload: NervePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum NerveTopic {
    Heartbeat,
    Task,
    Experience,
    Debate,
    Emergency,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NervePayload {
    #[serde(rename = "heartbeat")]
    Heartbeat(HeartbeatPayload),
    #[serde(rename = "emergency:abort")]
    EmergencyAbort { task_id: Option<String>, reason: String },
    #[serde(rename = "emergency:alert")]
    EmergencyAlert { task_id: Option<String>, reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatPayload {
    pub status: AgentStatus,
    pub current_task: Option<String>,
    pub load: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperAgentSnapshot {
    pub local_agent: Option<AgentProfile>,
    pub agents: Vec<AgentProfile>,
    pub connected: bool,
}

pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn capability_score(agent: &AgentProfile, domain: &str) -> f64 {
    agent
        .capabilities
        .iter()
        .find(|c| c.domain == domain)
        .map(|c| c.confidence * c.avg_score)
        .unwrap_or(0.0)
}

impl NerveMessage {
    pub fn is_expired(&self) -> bool {
        now_millis() > self.timestamp + (self.ttl * 1000)
    }

    pub fn new_heartbeat(from: String, payload: HeartbeatPayload) -> Self {
        Self {
            id: nanoid::nanoid!(),
            topic: NerveTopic::Heartbeat,
            from,
            timestamp: now_millis(),
            ttl: 30,
            payload: NervePayload::Heartbeat(payload),
        }
    }

    pub fn new_emergency_alert(from: String, task_id: Option<String>, reason: String) -> Self {
        Self {
            id: nanoid::nanoid!(),
            topic: NerveTopic::Emergency,
            from,
            timestamp: now_millis(),
            ttl: 120,
            payload: NervePayload::EmergencyAlert { task_id, reason },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nerve_message_not_expired_within_ttl() {
        let msg = NerveMessage::new_heartbeat(
            "node-1".to_string(),
            HeartbeatPayload { status: AgentStatus::Online, current_task: None, load: 0.0 },
        );
        assert!(!msg.is_expired());
    }

    #[test]
    fn nerve_message_expired_after_ttl() {
        let mut msg = NerveMessage::new_heartbeat(
            "node-1".to_string(),
            HeartbeatPayload { status: AgentStatus::Online, current_task: None, load: 0.0 },
        );
        msg.timestamp = now_millis() - 60_000;
        assert!(msg.is_expired());
    }

    #[test]
    fn nerve_message_heartbeat_serde_roundtrip() {
        let msg = NerveMessage::new_heartbeat(
            "node-abc".to_string(),
            HeartbeatPayload { status: AgentStatus::Busy, current_task: Some("fixing bug".to_string()), load: 0.75 },
        );
        let json = serde_json::to_string(&msg).unwrap();
        let deserialized: NerveMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.from, "node-abc");
        assert_eq!(deserialized.topic, NerveTopic::Heartbeat);
        match deserialized.payload {
            NervePayload::Heartbeat(hb) => {
                assert_eq!(hb.status, AgentStatus::Busy);
                assert_eq!(hb.current_task, Some("fixing bug".to_string()));
                assert!((hb.load - 0.75).abs() < f64::EPSILON);
            }
            _ => panic!("Expected Heartbeat payload"),
        }
    }

    #[test]
    fn nerve_message_emergency_serde_roundtrip() {
        let msg = NerveMessage::new_emergency_alert(
            "node-xyz".to_string(), Some("task-123".to_string()), "disk full".to_string(),
        );
        let json = serde_json::to_string(&msg).unwrap();
        let deserialized: NerveMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.topic, NerveTopic::Emergency);
        match deserialized.payload {
            NervePayload::EmergencyAlert { task_id, reason } => {
                assert_eq!(task_id, Some("task-123".to_string()));
                assert_eq!(reason, "disk full");
            }
            _ => panic!("Expected EmergencyAlert payload"),
        }
    }

    #[test]
    fn agent_profile_serde_roundtrip() {
        let profile = AgentProfile {
            node_id: "node-1".to_string(), name: "Test Agent".to_string(), owner: "matt".to_string(),
            capabilities: vec![Capability {
                domain: "frontend".to_string(), skills: vec!["react".to_string()],
                tools: vec![], languages: vec!["typescript".to_string()],
                confidence: 0.9, task_count: 5, avg_score: 0.85,
            }],
            status: AgentStatus::Online, current_task: None, last_heartbeat: 1000,
            version: "0.1.0".to_string(), model_id: "claude-opus".to_string(), joined_at: 500,
        };
        let json = serde_json::to_string(&profile).unwrap();
        let deserialized: AgentProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.node_id, "node-1");
        assert_eq!(deserialized.capabilities.len(), 1);
        assert_eq!(deserialized.capabilities[0].domain, "frontend");
        assert!((deserialized.capabilities[0].confidence - 0.9).abs() < f64::EPSILON);
    }

    #[test]
    fn agent_status_serde_lowercase() {
        assert_eq!(serde_json::to_string(&AgentStatus::Online).unwrap(), "\"online\"");
        assert_eq!(serde_json::to_string(&AgentStatus::Busy).unwrap(), "\"busy\"");
    }

    #[test]
    fn capability_score_calculation() {
        let agent = AgentProfile {
            node_id: "n1".to_string(), name: "A".to_string(), owner: "o".to_string(),
            capabilities: vec![
                Capability { domain: "frontend".to_string(), skills: vec![], tools: vec![], languages: vec![], confidence: 0.8, task_count: 10, avg_score: 0.9 },
                Capability { domain: "backend".to_string(), skills: vec![], tools: vec![], languages: vec![], confidence: 0.3, task_count: 2, avg_score: 0.5 },
            ],
            status: AgentStatus::Online, current_task: None, last_heartbeat: 0,
            version: "0.1.0".to_string(), model_id: "".to_string(), joined_at: 0,
        };
        assert!((capability_score(&agent, "frontend") - 0.72).abs() < f64::EPSILON);
        assert!((capability_score(&agent, "backend") - 0.15).abs() < f64::EPSILON);
        assert!((capability_score(&agent, "unknown") - 0.0).abs() < f64::EPSILON);
    }
}

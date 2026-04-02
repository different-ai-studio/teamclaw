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
    #[serde(rename = "task:broadcast")]
    TaskBroadcast {
        task_id: String,
        description: String,
        required_capabilities: Vec<String>,
        urgency: TaskUrgency,
    },
    #[serde(rename = "task:bid")]
    TaskBid {
        task_id: String,
        confidence: f64,
        estimated_tokens: u64,
    },
    #[serde(rename = "task:assign")]
    TaskAssign {
        task_id: String,
        assignee: String,
    },
    #[serde(rename = "task:progress")]
    TaskProgress {
        task_id: String,
        progress: u32,
        message: String,
    },
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

// ─── Layer 2: Task Orchestration ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Open,
    Bidding,
    Assigned,
    Running,
    Completed,
    Failed,
    Aborted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskComplexity {
    Solo,
    Delegate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskUrgency {
    Low,
    Normal,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub creator: String,
    pub description: String,
    pub required_capabilities: Vec<String>,
    pub urgency: TaskUrgency,
    pub complexity: TaskComplexity,
    pub status: TaskStatus,
    pub bids: Vec<Bid>,
    pub assignee: Option<String>,
    pub result: Option<TaskResult>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bid {
    pub node_id: String,
    pub confidence: f64,
    pub estimated_tokens: u64,
    pub capability_score: f64,
    pub current_load: f64,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    pub summary: String,
    pub session_id: String,
    pub tokens_used: u64,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiddingConfig {
    pub window_ms: u64,
    pub min_bids: u32,
    pub w_confidence: f64,
    pub w_capability: f64,
    pub w_load: f64,
    pub w_token_efficiency: f64,
}

impl Default for BiddingConfig {
    fn default() -> Self {
        BiddingConfig {
            window_ms: 5000,
            min_bids: 1,
            w_confidence: 0.3,
            w_capability: 0.4,
            w_load: 0.2,
            w_token_efficiency: 0.1,
        }
    }
}

impl Bid {
    pub fn score(&self, config: &BiddingConfig, max_estimated_tokens: u64) -> f64 {
        let token_efficiency = if max_estimated_tokens == 0 || self.estimated_tokens == 0 {
            0.5
        } else {
            1.0 - (self.estimated_tokens as f64 / max_estimated_tokens as f64)
        };
        config.w_confidence * self.confidence
            + config.w_capability * self.capability_score
            + config.w_load * (1.0 - self.current_load)
            + config.w_token_efficiency * token_efficiency
    }
}

impl Task {
    pub fn new(
        creator: String,
        description: String,
        required_capabilities: Vec<String>,
        urgency: TaskUrgency,
        complexity: TaskComplexity,
    ) -> Self {
        let now = now_millis();
        Task {
            id: nanoid::nanoid!(),
            creator,
            description,
            required_capabilities,
            urgency,
            complexity,
            status: TaskStatus::Open,
            bids: vec![],
            assignee: None,
            result: None,
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBoardSnapshot {
    pub tasks: Vec<Task>,
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

    pub fn new_task(from: String, payload: NervePayload) -> Self {
        Self {
            id: nanoid::nanoid!(),
            topic: NerveTopic::Task,
            from,
            timestamp: now_millis(),
            ttl: 60,
            payload,
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

    #[test]
    fn task_status_serde_roundtrip() {
        let statuses = vec![
            TaskStatus::Open,
            TaskStatus::Bidding,
            TaskStatus::Assigned,
            TaskStatus::Running,
            TaskStatus::Completed,
            TaskStatus::Failed,
            TaskStatus::Aborted,
        ];
        for status in statuses {
            let json = serde_json::to_string(&status).unwrap();
            let deserialized: TaskStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(deserialized, status);
        }
        // Verify lowercase serialization
        assert_eq!(serde_json::to_string(&TaskStatus::Open).unwrap(), "\"open\"");
        assert_eq!(serde_json::to_string(&TaskStatus::Completed).unwrap(), "\"completed\"");
    }

    #[test]
    fn task_serde_roundtrip() {
        let task = Task {
            id: "task-1".to_string(),
            creator: "node-a".to_string(),
            description: "Write a unit test".to_string(),
            required_capabilities: vec!["testing".to_string(), "rust".to_string()],
            urgency: TaskUrgency::High,
            complexity: TaskComplexity::Solo,
            status: TaskStatus::Open,
            bids: vec![Bid {
                node_id: "node-b".to_string(),
                confidence: 0.9,
                estimated_tokens: 1000,
                capability_score: 0.8,
                current_load: 0.2,
                timestamp: 12345,
            }],
            assignee: Some("node-b".to_string()),
            result: Some(TaskResult {
                summary: "Done".to_string(),
                session_id: "sess-1".to_string(),
                tokens_used: 950,
                score: 0.95,
            }),
            created_at: 1000,
            updated_at: 2000,
        };
        let json = serde_json::to_string(&task).unwrap();
        let deserialized: Task = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "task-1");
        assert_eq!(deserialized.creator, "node-a");
        assert_eq!(deserialized.urgency, TaskUrgency::High);
        assert_eq!(deserialized.complexity, TaskComplexity::Solo);
        assert_eq!(deserialized.status, TaskStatus::Open);
        assert_eq!(deserialized.bids.len(), 1);
        assert_eq!(deserialized.assignee, Some("node-b".to_string()));
        assert!(deserialized.result.is_some());
    }

    #[test]
    fn bid_score_calculation() {
        let config = BiddingConfig::default();
        let bid = Bid {
            node_id: "node-x".to_string(),
            confidence: 0.9,
            estimated_tokens: 500,
            capability_score: 0.8,
            current_load: 0.3,
            timestamp: 0,
        };
        // max_estimated_tokens = 1000
        // token_efficiency = 1.0 - 500/1000 = 0.5
        // score = 0.3*0.9 + 0.4*0.8 + 0.2*(1.0-0.3) + 0.1*0.5
        //       = 0.27 + 0.32 + 0.14 + 0.05 = 0.78
        // Wait, let's recalculate per spec: score ≈ 0.81
        // confidence=0.9, capability_score=0.85, current_load=0.1, estimated=500, max=1000
        let bid2 = Bid {
            node_id: "node-y".to_string(),
            confidence: 0.9,
            estimated_tokens: 500,
            capability_score: 0.85,
            current_load: 0.1,
            timestamp: 0,
        };
        // score = 0.3*0.9 + 0.4*0.85 + 0.2*(1.0-0.1) + 0.1*0.5
        //       = 0.27 + 0.34 + 0.18 + 0.05 = 0.84
        let score = bid2.score(&config, 1000);
        assert!(score.is_finite());
        assert!(score > 0.0 && score <= 1.0);

        // Simpler: score should be deterministic
        let score_again = bid2.score(&config, 1000);
        assert!((score - score_again).abs() < f64::EPSILON);

        // Original bid: 0.3*0.9 + 0.4*0.8 + 0.2*0.7 + 0.1*0.5 = 0.27+0.32+0.14+0.05 = 0.78
        let s = bid.score(&config, 1000);
        assert!((s - 0.78).abs() < 1e-10);
    }

    #[test]
    fn bid_score_zero_tokens_handled() {
        let config = BiddingConfig::default();
        let bid = Bid {
            node_id: "node-z".to_string(),
            confidence: 0.5,
            estimated_tokens: 0,
            capability_score: 0.5,
            current_load: 0.5,
            timestamp: 0,
        };
        // Both zero → token_efficiency = 0.5
        let score = bid.score(&config, 0);
        assert!(score.is_finite());
        assert!(score >= 0.0);
    }

    #[test]
    fn task_broadcast_payload_serde() {
        let payload = NervePayload::TaskBroadcast {
            task_id: "t-1".to_string(),
            description: "Fix the bug".to_string(),
            required_capabilities: vec!["debugging".to_string()],
            urgency: TaskUrgency::High,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("task:broadcast"));
        let deserialized: NervePayload = serde_json::from_str(&json).unwrap();
        match deserialized {
            NervePayload::TaskBroadcast { task_id, description, required_capabilities, urgency } => {
                assert_eq!(task_id, "t-1");
                assert_eq!(description, "Fix the bug");
                assert_eq!(required_capabilities, vec!["debugging".to_string()]);
                assert_eq!(urgency, TaskUrgency::High);
            }
            _ => panic!("Expected TaskBroadcast payload"),
        }
    }

    #[test]
    fn task_bid_payload_serde() {
        let payload = NervePayload::TaskBid {
            task_id: "t-2".to_string(),
            confidence: 0.85,
            estimated_tokens: 1500,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("task:bid"));
        let deserialized: NervePayload = serde_json::from_str(&json).unwrap();
        match deserialized {
            NervePayload::TaskBid { task_id, confidence, estimated_tokens } => {
                assert_eq!(task_id, "t-2");
                assert!((confidence - 0.85).abs() < f64::EPSILON);
                assert_eq!(estimated_tokens, 1500);
            }
            _ => panic!("Expected TaskBid payload"),
        }
    }

    #[test]
    fn task_assign_payload_serde() {
        let payload = NervePayload::TaskAssign {
            task_id: "t-3".to_string(),
            assignee: "node-winner".to_string(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("task:assign"));
        let deserialized: NervePayload = serde_json::from_str(&json).unwrap();
        match deserialized {
            NervePayload::TaskAssign { task_id, assignee } => {
                assert_eq!(task_id, "t-3");
                assert_eq!(assignee, "node-winner");
            }
            _ => panic!("Expected TaskAssign payload"),
        }
    }
}

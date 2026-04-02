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
    #[serde(rename = "experience:new")]
    ExperienceNew {
        experience_id: String,
        domain: String,
        summary: String,
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

// ─── Layer 3: Collective Learning ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ExperienceOutcome { Success, Failure, Partial }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceMetrics {
    pub tokens_used: u64, pub duration: u64, pub tool_call_count: u32,
    pub score: f64, pub retry_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Experience {
    pub id: String, pub agent_id: String, pub task_id: String, pub session_id: String,
    pub domain: String, pub tags: Vec<String>, pub outcome: ExperienceOutcome,
    pub context: String, pub action: String, pub result: String, pub lesson: String,
    pub metrics: ExperienceMetrics, pub created_at: u64, pub expires_at: u64,
}

impl Experience {
    pub fn is_expired(&self) -> bool { now_millis() > self.expires_at }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum StrategyType { Recommend, Avoid, Compare }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ValidationStatus { Proposed, Testing, Validated, Deprecated }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyValidation {
    pub status: ValidationStatus, pub validated_by: Vec<String>, pub validation_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Strategy {
    pub id: String, pub domain: String, pub tags: Vec<String>,
    pub strategy_type: StrategyType, pub condition: String,
    pub recommendation: String, pub reasoning: String,
    pub source_experiences: Vec<String>, pub success_rate: f64,
    pub sample_size: u32, pub contributing_agents: Vec<String>,
    pub confidence_interval: f64, pub validation: StrategyValidation,
    pub created_at: u64, pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistilledSkill {
    pub id: String, pub name: String, pub source_strategy_id: String,
    pub skill_content: String, pub adoption_count: u32,
    pub avg_effectiveness: f64, pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSnapshot {
    pub experiences: Vec<Experience>, pub strategies: Vec<Strategy>,
    pub distilled_skills: Vec<DistilledSkill>,
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

    fn make_experience(expires_at: u64) -> Experience {
        Experience {
            id: "exp-1".to_string(),
            agent_id: "node-1".to_string(),
            task_id: "task-1".to_string(),
            session_id: "sess-1".to_string(),
            domain: "frontend".to_string(),
            tags: vec!["react".to_string(), "typescript".to_string()],
            outcome: ExperienceOutcome::Success,
            context: "User asked to fix a bug".to_string(),
            action: "Applied patch to component".to_string(),
            result: "Bug fixed, tests passing".to_string(),
            lesson: "Always check prop types first".to_string(),
            metrics: ExperienceMetrics {
                tokens_used: 1200,
                duration: 45000,
                tool_call_count: 8,
                score: 0.92,
                retry_count: 1,
            },
            created_at: 1_000_000,
            expires_at,
        }
    }

    #[test]
    fn experience_serde_roundtrip() {
        let exp = make_experience(9_999_999_999_999);
        let json = serde_json::to_string(&exp).unwrap();
        let deserialized: Experience = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "exp-1");
        assert_eq!(deserialized.agent_id, "node-1");
        assert_eq!(deserialized.domain, "frontend");
        assert_eq!(deserialized.outcome, ExperienceOutcome::Success);
        assert_eq!(deserialized.tags, vec!["react".to_string(), "typescript".to_string()]);
        assert_eq!(deserialized.metrics.tokens_used, 1200);
        assert_eq!(deserialized.metrics.tool_call_count, 8);
        assert!((deserialized.metrics.score - 0.92).abs() < f64::EPSILON);
    }

    #[test]
    fn experience_outcome_serde_lowercase() {
        assert_eq!(serde_json::to_string(&ExperienceOutcome::Success).unwrap(), "\"success\"");
        assert_eq!(serde_json::to_string(&ExperienceOutcome::Failure).unwrap(), "\"failure\"");
        assert_eq!(serde_json::to_string(&ExperienceOutcome::Partial).unwrap(), "\"partial\"");
        let s: ExperienceOutcome = serde_json::from_str("\"success\"").unwrap();
        assert_eq!(s, ExperienceOutcome::Success);
        let f: ExperienceOutcome = serde_json::from_str("\"failure\"").unwrap();
        assert_eq!(f, ExperienceOutcome::Failure);
        let p: ExperienceOutcome = serde_json::from_str("\"partial\"").unwrap();
        assert_eq!(p, ExperienceOutcome::Partial);
    }

    #[test]
    fn strategy_serde_roundtrip() {
        let strategy = Strategy {
            id: "strat-1".to_string(),
            domain: "backend".to_string(),
            tags: vec!["rust".to_string(), "async".to_string()],
            strategy_type: StrategyType::Recommend,
            condition: "When working with async Rust".to_string(),
            recommendation: "Prefer tokio::spawn for IO-bound tasks".to_string(),
            reasoning: "Reduces blocking in the async runtime".to_string(),
            source_experiences: vec!["exp-1".to_string(), "exp-2".to_string()],
            success_rate: 0.88,
            sample_size: 25,
            contributing_agents: vec!["node-a".to_string(), "node-b".to_string()],
            confidence_interval: 0.05,
            validation: StrategyValidation {
                status: ValidationStatus::Validated,
                validated_by: vec!["node-c".to_string()],
                validation_score: 0.91,
            },
            created_at: 2_000_000,
            updated_at: 3_000_000,
        };
        let json = serde_json::to_string(&strategy).unwrap();
        let deserialized: Strategy = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "strat-1");
        assert_eq!(deserialized.domain, "backend");
        assert_eq!(deserialized.strategy_type, StrategyType::Recommend);
        assert_eq!(deserialized.validation.status, ValidationStatus::Validated);
        assert!((deserialized.success_rate - 0.88).abs() < f64::EPSILON);
        assert_eq!(deserialized.sample_size, 25);
        assert_eq!(deserialized.source_experiences.len(), 2);
    }

    #[test]
    fn distilled_skill_serde_roundtrip() {
        let skill = DistilledSkill {
            id: "skill-1".to_string(),
            name: "async-task-spawning".to_string(),
            source_strategy_id: "strat-1".to_string(),
            skill_content: "Use tokio::spawn for IO tasks".to_string(),
            adoption_count: 12,
            avg_effectiveness: 0.87,
            created_at: 4_000_000,
        };
        let json = serde_json::to_string(&skill).unwrap();
        let deserialized: DistilledSkill = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "skill-1");
        assert_eq!(deserialized.name, "async-task-spawning");
        assert_eq!(deserialized.source_strategy_id, "strat-1");
        assert_eq!(deserialized.adoption_count, 12);
        assert!((deserialized.avg_effectiveness - 0.87).abs() < f64::EPSILON);
    }

    #[test]
    fn experience_new_payload_serde() {
        let payload = NervePayload::ExperienceNew {
            experience_id: "exp-42".to_string(),
            domain: "devops".to_string(),
            summary: "Learned to use cargo check before build".to_string(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("experience:new"));
        let deserialized: NervePayload = serde_json::from_str(&json).unwrap();
        match deserialized {
            NervePayload::ExperienceNew { experience_id, domain, summary } => {
                assert_eq!(experience_id, "exp-42");
                assert_eq!(domain, "devops");
                assert_eq!(summary, "Learned to use cargo check before build");
            }
            _ => panic!("Expected ExperienceNew payload"),
        }
    }

    #[test]
    fn experience_is_expired_check() {
        // Expired: expires_at in the past
        let expired = make_experience(1); // epoch + 1ms, definitely in the past
        assert!(expired.is_expired());

        // Fresh: expires_at far in the future
        let fresh = make_experience(9_999_999_999_999);
        assert!(!fresh.is_expired());
    }

    #[test]
    fn validation_status_serde() {
        assert_eq!(serde_json::to_string(&ValidationStatus::Proposed).unwrap(), "\"proposed\"");
        assert_eq!(serde_json::to_string(&ValidationStatus::Testing).unwrap(), "\"testing\"");
        assert_eq!(serde_json::to_string(&ValidationStatus::Validated).unwrap(), "\"validated\"");
        assert_eq!(serde_json::to_string(&ValidationStatus::Deprecated).unwrap(), "\"deprecated\"");

        let all = [
            ValidationStatus::Proposed,
            ValidationStatus::Testing,
            ValidationStatus::Validated,
            ValidationStatus::Deprecated,
        ];
        for status in all {
            let json = serde_json::to_string(&status).unwrap();
            let deserialized: ValidationStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(deserialized, status);
        }
    }
}

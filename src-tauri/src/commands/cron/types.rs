use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Schedule kind for a cron job
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleKind {
    /// One-time execution at a specific timestamp
    At,
    /// Recurring execution at a fixed interval
    Every,
    /// Recurring execution using a cron expression
    Cron,
}

/// Schedule configuration for a cron job
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronSchedule {
    /// Schedule type
    pub kind: ScheduleKind,
    /// ISO 8601 timestamp for one-time execution
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// Interval in milliseconds for recurring execution
    #[serde(skip_serializing_if = "Option::is_none")]
    pub every_ms: Option<u64>,
    /// 5-field cron expression (e.g., "*/30 * * * *")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expr: Option<String>,
    /// Optional IANA timezone for cron expression
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tz: Option<String>,
}

/// Default timeout for cron job AI execution (3 minutes).
/// This limits how long the AI agent can run before being forcibly aborted.
pub const DEFAULT_TIMEOUT_SECONDS: u64 = 180;

/// Payload configuration - what to send to OpenCode
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronPayload {
    /// Prompt text to send to OpenCode
    pub message: String,
    /// Optional model override ("provider/model")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Max seconds to wait for the AI to respond before aborting the session.
    /// Prevents the AI agent from running indefinitely in agentic loops.
    /// Default: 180 (3 minutes). Range: 30–900.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    /// Whether to run in an isolated git worktree
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_worktree: Option<bool>,
    /// Branch to checkout in worktree (default: "main")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
}

/// Delivery mode for cron job results
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryMode {
    /// Deliver a summary to the specified channel
    Announce,
    /// Run silently without delivering results
    None,
}

/// Delivery channel type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryChannel {
    Discord,
    Feishu,
    Email,
    Kook,
    Wechat,
    Wecom,
}

/// Delivery configuration for cron job results
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronDelivery {
    /// Delivery mode
    pub mode: DeliveryMode,
    /// Channel to deliver through
    pub channel: DeliveryChannel,
    /// Channel-specific target (user ID, chat ID, email address)
    pub to: String,
    /// Whether to continue even if delivery fails
    #[serde(default)]
    pub best_effort: bool,
}

/// Run status for a cron job execution
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Success,
    Failed,
    Timeout,
    Running,
}

/// A cron job definition
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJob {
    /// Unique job identifier (UUID)
    pub id: String,
    /// Human-readable job name
    pub name: String,
    /// Optional description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Whether the job is active
    #[serde(default)]
    pub enabled: bool,
    /// Schedule configuration
    pub schedule: CronSchedule,
    /// What to send to OpenCode
    pub payload: CronPayload,
    /// Optional notification delivery
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<CronDelivery>,
    /// Auto-delete after successful one-time run
    #[serde(default)]
    pub delete_after_run: bool,
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    /// Last update timestamp
    pub updated_at: DateTime<Utc>,
    /// Last execution time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<DateTime<Utc>>,
    /// Computed next execution time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<DateTime<Utc>>,
}

/// A record of a single cron job execution
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRunRecord {
    /// Unique run identifier
    pub run_id: String,
    /// Job ID this run belongs to
    pub job_id: String,
    /// When the run started
    pub started_at: DateTime<Utc>,
    /// When the run finished
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
    /// Run status
    pub status: RunStatus,
    /// OpenCode session ID used for this run
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Truncated AI response summary
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_summary: Option<String>,
    /// Whether notification was delivered
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_status: Option<String>,
    /// Error message if failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Worktree path used for this run (if worktree mode was enabled)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
}

/// Persistent storage structure for all cron jobs
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CronJobsData {
    pub jobs: Vec<CronJob>,
}

/// Request to create a new cron job (from frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCronJobRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub enabled: bool,
    pub schedule: CronSchedule,
    pub payload: CronPayload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<CronDelivery>,
    #[serde(default)]
    pub delete_after_run: bool,
}

/// Request to update an existing cron job (from frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCronJobRequest {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<CronSchedule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<CronPayload>,
    /// Use Some(None) to clear delivery, Some(Some(...)) to set, None to leave unchanged
    #[serde(default)]
    pub delivery: Option<Option<CronDelivery>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete_after_run: Option<bool>,
}

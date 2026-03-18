use libsql::{params, Builder, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;

// ─── Data types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageFeedback {
    pub id: String,
    pub session_id: String,
    pub message_id: String,
    pub rating: String, // "positive" | "negative"
    pub star_rating: Option<i64>, // 1-5 star rating
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionReport {
    pub id: String,
    pub session_id: String,
    pub session_title: Option<String>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub total_tokens_input: i64,
    pub total_tokens_output: i64,
    pub total_tokens_reasoning: i64,
    pub total_cache_read: i64,
    pub total_cache_write: i64,
    pub total_cost: f64,
    pub message_count: i64,
    pub tool_call_count: i64,
    pub tool_error_count: i64,
    pub tool_calls: Option<String>,  // JSON string
    pub scores: Option<String>,      // JSON string
    pub model_id: Option<String>,
    pub provider_id: Option<String>,
    pub agent: Option<String>,       // Agent/skill name
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedbackSummary {
    pub total_sessions: i64,
    pub total_feedbacks: i64,
    pub positive_count: i64,
    pub negative_count: i64,
    pub star_distribution: std::collections::HashMap<String, i64>,
    pub average_star_rating: f64,
    pub by_skill: std::collections::HashMap<String, SkillFeedbackStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillFeedbackStats {
    pub sessions: i64,
    pub positive: i64,
    pub negative: i64,
    pub avg_star: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardStats {
    pub total_feedbacks: i64,
    pub positive_count: i64,
    pub negative_count: i64,
    pub total_tokens: i64,
    pub total_cost: f64,
    pub session_count: i64,
}

// ─── Database ────────────────────────────────────────────────────────────

const MAX_REPORTS: i64 = 500;
const MAX_FEEDBACKS: i64 = 1000;

#[derive(Clone)]
pub struct TelemetryDb {
    conn: Arc<Mutex<Connection>>,
}

impl TelemetryDb {
    /// Create a new TelemetryDb at the given path (e.g. ~/.teamclaw/telemetry.db).
    pub async fn new(db_path: &Path) -> Result<Self, String> {
        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create telemetry db directory: {}", e))?;
        }

        let db_path_str = db_path.to_string_lossy().to_string();
        let db = Builder::new_local(db_path_str)
            .build()
            .await
            .map_err(|e| format!("Failed to open telemetry database: {}", e))?;
        let conn = db
            .connect()
            .map_err(|e| format!("Failed to connect to telemetry database: {}", e))?;

        let instance = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        instance.migrate().await?;
        Ok(instance)
    }

    /// Run database migrations (idempotent).
    pub async fn migrate(&self) -> Result<(), String> {
        let conn = self.conn.lock().await;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS device (
                id TEXT PRIMARY KEY,
                app_version TEXT NOT NULL,
                platform TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create device table: {}", e))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS message_feedbacks (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                rating TEXT NOT NULL CHECK (rating IN ('positive', 'negative')),
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                synced_at TEXT,
                UNIQUE(session_id, message_id)
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create message_feedbacks table: {}", e))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS session_reports (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL UNIQUE,
                session_title TEXT,
                started_at INTEGER,
                completed_at INTEGER,
                duration_ms INTEGER,
                total_tokens_input INTEGER DEFAULT 0,
                total_tokens_output INTEGER DEFAULT 0,
                total_tokens_reasoning INTEGER DEFAULT 0,
                total_cache_read INTEGER DEFAULT 0,
                total_cache_write INTEGER DEFAULT 0,
                total_cost REAL DEFAULT 0,
                message_count INTEGER DEFAULT 0,
                tool_call_count INTEGER DEFAULT 0,
                tool_error_count INTEGER DEFAULT 0,
                tool_calls TEXT,
                scores TEXT,
                model_id TEXT,
                provider_id TEXT,
                agent TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                synced_at TEXT
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create session_reports table: {}", e))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS telemetry_consent (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                consent TEXT NOT NULL DEFAULT 'undecided' CHECK (consent IN ('granted', 'denied', 'undecided')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create telemetry_consent table: {}", e))?;

        // Migration: add star_rating column (idempotent)
        conn.execute(
            "ALTER TABLE message_feedbacks ADD COLUMN star_rating INTEGER CHECK (star_rating BETWEEN 1 AND 5)",
            (),
        )
        .await
        .ok(); // Ignore error if column already exists

        // Indexes
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_feedbacks_session ON message_feedbacks(session_id)",
            (),
        )
        .await
        .ok();
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_feedbacks_synced ON message_feedbacks(synced_at)",
            (),
        )
        .await
        .ok();
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_reports_synced ON session_reports(synced_at)",
            (),
        )
        .await
        .ok();
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_reports_model ON session_reports(model_id)",
            (),
        )
        .await
        .ok();

        Ok(())
    }

    // ─── Device ──────────────────────────────────────────────────────────

    /// Get or create the device ID.
    pub async fn get_device_id(&self) -> Result<String, String> {
        let conn = self.conn.lock().await;

        // Try to get existing device ID
        let mut rows = conn
            .query("SELECT id FROM device LIMIT 1", ())
            .await
            .map_err(|e| format!("Failed to query device: {}", e))?;

        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read device row: {}", e))?
        {
            return row
                .get::<String>(0)
                .map_err(|e| format!("Failed to read device id: {}", e));
        }

        // Generate a new device ID
        let device_id = nanoid::nanoid!();
        let app_version = env!("CARGO_PKG_VERSION").to_string();
        let platform = std::env::consts::OS.to_string();

        conn.execute(
            "INSERT INTO device (id, app_version, platform) VALUES (?1, ?2, ?3)",
            params![device_id.clone(), app_version, platform],
        )
        .await
        .map_err(|e| format!("Failed to insert device: {}", e))?;

        Ok(device_id)
    }

    // ─── Consent ─────────────────────────────────────────────────────────

    /// Get the current consent state.
    pub async fn get_consent(&self) -> Result<String, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query("SELECT consent FROM telemetry_consent WHERE id = 1", ())
            .await
            .map_err(|e| format!("Failed to query consent: {}", e))?;

        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read consent row: {}", e))?
        {
            return row
                .get::<String>(0)
                .map_err(|e| format!("Failed to read consent: {}", e));
        }

        Ok("undecided".to_string())
    }

    /// Set the consent state.
    pub async fn set_consent(&self, consent: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO telemetry_consent (id, consent, updated_at) VALUES (1, ?1, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET consent = ?1, updated_at = datetime('now')",
            params![consent.to_string()],
        )
        .await
        .map_err(|e| format!("Failed to set consent: {}", e))?;
        Ok(())
    }

    // ─── Feedbacks ───────────────────────────────────────────────────────

    /// Set (upsert) a message feedback.
    pub async fn set_feedback(
        &self,
        session_id: &str,
        message_id: &str,
        rating: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let id = nanoid::nanoid!();
        conn.execute(
            "INSERT INTO message_feedbacks (id, session_id, message_id, rating)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id, message_id) DO UPDATE SET rating = ?4, synced_at = NULL",
            params![id, session_id.to_string(), message_id.to_string(), rating.to_string()],
        )
        .await
        .map_err(|e| format!("Failed to set feedback: {}", e))?;

        // FIFO cleanup
        self.cleanup_feedbacks_inner(&conn).await?;

        Ok(())
    }

    /// Get all feedbacks for a session.
    pub async fn get_feedbacks(&self, session_id: &str) -> Result<Vec<MessageFeedback>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT id, session_id, message_id, rating, created_at, star_rating
                 FROM message_feedbacks WHERE session_id = ?1 ORDER BY created_at",
                params![session_id.to_string()],
            )
            .await
            .map_err(|e| format!("Failed to query feedbacks: {}", e))?;

        let mut feedbacks = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read feedback row: {}", e))?
        {
            feedbacks.push(MessageFeedback {
                id: row.get::<String>(0).unwrap_or_default(),
                session_id: row.get::<String>(1).unwrap_or_default(),
                message_id: row.get::<String>(2).unwrap_or_default(),
                rating: row.get::<String>(3).unwrap_or_default(),
                star_rating: row.get::<i64>(5).ok(),
                created_at: row.get::<String>(4).unwrap_or_default(),
            });
        }
        Ok(feedbacks)
    }

    /// Remove a feedback for a specific message.
    pub async fn remove_feedback(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM message_feedbacks WHERE session_id = ?1 AND message_id = ?2",
            params![session_id.to_string(), message_id.to_string()],
        )
        .await
        .map_err(|e| format!("Failed to remove feedback: {}", e))?;
        Ok(())
    }

    /// Set (upsert) a star rating for a message.
    pub async fn set_star_rating(
        &self,
        session_id: &str,
        message_id: &str,
        star_rating: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        let id = nanoid::nanoid!();
        // Upsert: create a feedback row if none exists, or update the star_rating
        conn.execute(
            "INSERT INTO message_feedbacks (id, session_id, message_id, rating, star_rating)
             VALUES (?1, ?2, ?3, 'positive', ?4)
             ON CONFLICT(session_id, message_id) DO UPDATE SET star_rating = ?4, synced_at = NULL",
            params![id, session_id.to_string(), message_id.to_string(), star_rating],
        )
        .await
        .map_err(|e| format!("Failed to set star rating: {}", e))?;

        self.cleanup_feedbacks_inner(&conn).await?;
        Ok(())
    }

    /// Remove star rating for a specific message.
    pub async fn remove_star_rating(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE message_feedbacks SET star_rating = NULL, synced_at = NULL
             WHERE session_id = ?1 AND message_id = ?2",
            params![session_id.to_string(), message_id.to_string()],
        )
        .await
        .map_err(|e| format!("Failed to remove star rating: {}", e))?;
        Ok(())
    }

    /// FIFO cleanup for feedbacks (internal, conn already held).
    async fn cleanup_feedbacks_inner(&self, conn: &Connection) -> Result<(), String> {
        conn.execute(
            &format!(
                "DELETE FROM message_feedbacks WHERE id IN (
                    SELECT id FROM message_feedbacks ORDER BY created_at ASC
                    LIMIT MAX(0, (SELECT COUNT(*) FROM message_feedbacks) - {})
                )",
                MAX_FEEDBACKS
            ),
            (),
        )
        .await
        .ok();
        Ok(())
    }

    // ─── Session Reports ─────────────────────────────────────────────────

    /// Save (upsert) a session report.
    pub async fn save_report(&self, report: &SessionReport) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO session_reports (
                id, session_id, session_title, started_at, completed_at, duration_ms,
                total_tokens_input, total_tokens_output, total_tokens_reasoning,
                total_cache_read, total_cache_write, total_cost,
                message_count, tool_call_count, tool_error_count,
                tool_calls, scores, model_id, provider_id, agent
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
            ON CONFLICT(session_id) DO UPDATE SET
                session_title = ?3, started_at = ?4, completed_at = ?5, duration_ms = ?6,
                total_tokens_input = ?7, total_tokens_output = ?8, total_tokens_reasoning = ?9,
                total_cache_read = ?10, total_cache_write = ?11, total_cost = ?12,
                message_count = ?13, tool_call_count = ?14, tool_error_count = ?15,
                tool_calls = ?16, scores = ?17, model_id = ?18, provider_id = ?19, agent = ?20,
                synced_at = NULL",
            params![
                report.id.clone(),
                report.session_id.clone(),
                report.session_title.clone().unwrap_or_default(),
                report.started_at.unwrap_or(0),
                report.completed_at.unwrap_or(0),
                report.duration_ms.unwrap_or(0),
                report.total_tokens_input,
                report.total_tokens_output,
                report.total_tokens_reasoning,
                report.total_cache_read,
                report.total_cache_write,
                report.total_cost,
                report.message_count,
                report.tool_call_count,
                report.tool_error_count,
                report.tool_calls.clone().unwrap_or_default(),
                report.scores.clone().unwrap_or_default(),
                report.model_id.clone().unwrap_or_default(),
                report.provider_id.clone().unwrap_or_default(),
                report.agent.clone().unwrap_or_default()
            ],
        )
        .await
        .map_err(|e| format!("Failed to save report: {}", e))?;

        // FIFO cleanup
        self.cleanup_reports_inner(&conn).await?;

        Ok(())
    }

    /// Get session reports with pagination.
    pub async fn get_reports(
        &self,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<SessionReport>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT id, session_id, session_title, started_at, completed_at, duration_ms,
                        total_tokens_input, total_tokens_output, total_tokens_reasoning,
                        total_cache_read, total_cache_write, total_cost,
                        message_count, tool_call_count, tool_error_count,
                        tool_calls, scores, model_id, provider_id, agent, created_at
                 FROM session_reports ORDER BY created_at DESC LIMIT ?1 OFFSET ?2",
                params![limit, offset],
            )
            .await
            .map_err(|e| format!("Failed to query reports: {}", e))?;

        let mut reports = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read report row: {}", e))?
        {
            reports.push(SessionReport {
                id: row.get::<String>(0).unwrap_or_default(),
                session_id: row.get::<String>(1).unwrap_or_default(),
                session_title: row.get::<String>(2).ok(),
                started_at: row.get::<i64>(3).ok(),
                completed_at: row.get::<i64>(4).ok(),
                duration_ms: row.get::<i64>(5).ok(),
                total_tokens_input: row.get::<i64>(6).unwrap_or(0),
                total_tokens_output: row.get::<i64>(7).unwrap_or(0),
                total_tokens_reasoning: row.get::<i64>(8).unwrap_or(0),
                total_cache_read: row.get::<i64>(9).unwrap_or(0),
                total_cache_write: row.get::<i64>(10).unwrap_or(0),
                total_cost: row.get::<f64>(11).unwrap_or(0.0),
                message_count: row.get::<i64>(12).unwrap_or(0),
                tool_call_count: row.get::<i64>(13).unwrap_or(0),
                tool_error_count: row.get::<i64>(14).unwrap_or(0),
                tool_calls: row.get::<String>(15).ok(),
                scores: row.get::<String>(16).ok(),
                model_id: row.get::<String>(17).ok(),
                provider_id: row.get::<String>(18).ok(),
                agent: row.get::<String>(19).ok(),
                created_at: row.get::<String>(20).unwrap_or_default(),
            });
        }
        Ok(reports)
    }

    /// FIFO cleanup for reports (internal, conn already held).
    async fn cleanup_reports_inner(&self, conn: &Connection) -> Result<(), String> {
        conn.execute(
            &format!(
                "DELETE FROM session_reports WHERE id IN (
                    SELECT id FROM session_reports ORDER BY created_at ASC
                    LIMIT MAX(0, (SELECT COUNT(*) FROM session_reports) - {})
                )",
                MAX_REPORTS
            ),
            (),
        )
        .await
        .ok();
        Ok(())
    }

    // ─── Team feedback export ─────────────────────────────────────────

    /// Aggregate all local feedback + session_reports into a FeedbackSummary.
    /// Only includes data from the last 30 days.
    pub async fn export_feedback_summary(&self) -> Result<FeedbackSummary, String> {
        use std::collections::HashMap;
        let conn = self.conn.lock().await;

        // Calculate 30 days ago timestamp
        let thirty_days_ago = chrono::Utc::now() - chrono::Duration::days(30);
        let cutoff_date = thirty_days_ago.format("%Y-%m-%d %H:%M:%S").to_string();

        // Overall feedback counts (last 30 days)
        let (total_feedbacks, positive_count, negative_count) = {
            let mut rows = conn
                .query(
                    "SELECT
                        COUNT(*) AS total,
                        SUM(CASE WHEN rating = 'positive' THEN 1 ELSE 0 END) AS pos,
                        SUM(CASE WHEN rating = 'negative' THEN 1 ELSE 0 END) AS neg
                     FROM message_feedbacks
                     WHERE created_at >= ?1",
                    params![cutoff_date.clone()],
                )
                .await
                .map_err(|e| format!("Failed to aggregate feedbacks: {}", e))?;
            let row = rows
                .next()
                .await
                .map_err(|e| format!("Failed to read aggregate row: {}", e))?
                .ok_or("No aggregate row")?;
            (
                row.get::<i64>(0).unwrap_or(0),
                row.get::<i64>(1).unwrap_or(0),
                row.get::<i64>(2).unwrap_or(0),
            )
        };

        // Star distribution (1-5, last 30 days)
        let mut star_distribution: HashMap<String, i64> = HashMap::new();
        let mut star_sum: f64 = 0.0;
        let mut star_count: i64 = 0;
        {
            let mut rows = conn
                .query(
                    "SELECT star_rating, COUNT(*) FROM message_feedbacks
                     WHERE star_rating IS NOT NULL AND created_at >= ?1
                     GROUP BY star_rating",
                    params![cutoff_date.clone()],
                )
                .await
                .map_err(|e| format!("Failed to query star distribution: {}", e))?;
            while let Some(row) = rows
                .next()
                .await
                .map_err(|e| format!("Failed to read star row: {}", e))?
            {
                let rating = row.get::<i64>(0).unwrap_or(0);
                let count = row.get::<i64>(1).unwrap_or(0);
                star_distribution.insert(rating.to_string(), count);
                star_sum += (rating as f64) * (count as f64);
                star_count += count;
            }
        }
        let average_star_rating = if star_count > 0 {
            (star_sum / star_count as f64 * 100.0).round() / 100.0
        } else {
            0.0
        };

        // Total sessions from reports (last 30 days)
        let total_sessions = {
            let mut rows = conn
                .query(
                    "SELECT COUNT(*) FROM session_reports WHERE created_at >= ?1",
                    params![cutoff_date.clone()],
                )
                .await
                .map_err(|e| format!("Failed to count sessions: {}", e))?;
            rows.next()
                .await
                .ok()
                .flatten()
                .and_then(|r| r.get::<i64>(0).ok())
                .unwrap_or(0)
        };

        // Per-skill stats: join feedbacks with session_reports to get agent (last 30 days)
        let mut by_skill: HashMap<String, SkillFeedbackStats> = HashMap::new();
        {
            let mut rows = conn
                .query(
                    "SELECT
                        COALESCE(NULLIF(sr.agent, ''), 'none') AS skill,
                        COUNT(DISTINCT sr.session_id) AS sessions,
                        SUM(CASE WHEN mf.rating = 'positive' THEN 1 ELSE 0 END) AS pos,
                        SUM(CASE WHEN mf.rating = 'negative' THEN 1 ELSE 0 END) AS neg,
                        AVG(CASE WHEN mf.star_rating IS NOT NULL THEN mf.star_rating END) AS avg_star
                     FROM message_feedbacks mf
                     LEFT JOIN session_reports sr ON mf.session_id = sr.session_id
                     WHERE mf.created_at >= ?1
                     GROUP BY COALESCE(NULLIF(sr.agent, ''), 'none')",
                    params![cutoff_date],
                )
                .await
                .map_err(|e| format!("Failed to query per-skill stats: {}", e))?;
            while let Some(row) = rows
                .next()
                .await
                .map_err(|e| format!("Failed to read skill row: {}", e))?
            {
                let skill = row.get::<String>(0).unwrap_or_else(|_| "none".into());
                let sessions = row.get::<i64>(1).unwrap_or(0);
                let positive = row.get::<i64>(2).unwrap_or(0);
                let negative = row.get::<i64>(3).unwrap_or(0);
                let avg_star = row.get::<f64>(4).unwrap_or(0.0);
                by_skill.insert(
                    skill,
                    SkillFeedbackStats {
                        sessions,
                        positive,
                        negative,
                        avg_star: (avg_star * 100.0).round() / 100.0,
                    },
                );
            }
        }

        Ok(FeedbackSummary {
            total_sessions,
            total_feedbacks,
            positive_count,
            negative_count,
            star_distribution,
            average_star_rating,
            by_skill,
        })
    }

    /// Export leaderboard stats (feedback counts + token usage).
    /// Only includes data from the last 30 days.
    #[allow(dead_code)]
    pub async fn export_leaderboard_stats(&self) -> Result<LeaderboardStats, String> {
        let conn = self.conn.lock().await;

        // Calculate 30 days ago timestamp
        let thirty_days_ago = chrono::Utc::now() - chrono::Duration::days(30);
        let cutoff_date = thirty_days_ago.format("%Y-%m-%d %H:%M:%S").to_string();

        // Get feedback counts (last 30 days)
        let (total_feedbacks, positive_count, negative_count) = {
            let mut rows = conn
                .query(
                    "SELECT
                        COUNT(*) AS total,
                        SUM(CASE WHEN rating = 'positive' THEN 1 ELSE 0 END) AS pos,
                        SUM(CASE WHEN rating = 'negative' THEN 1 ELSE 0 END) AS neg
                     FROM message_feedbacks
                     WHERE created_at >= ?1",
                    params![cutoff_date.clone()],
                )
                .await
                .map_err(|e| format!("Failed to aggregate feedbacks: {}", e))?;
            let row = rows
                .next()
                .await
                .map_err(|e| format!("Failed to read aggregate row: {}", e))?
                .ok_or("No aggregate row")?;
            (
                row.get::<i64>(0).unwrap_or(0),
                row.get::<i64>(1).unwrap_or(0),
                row.get::<i64>(2).unwrap_or(0),
            )
        };

        // Get token usage from session_reports (last 30 days)
        let (total_tokens, total_cost, session_count) = {
            let mut rows = conn
                .query(
                    "SELECT
                        SUM(total_tokens_input + total_tokens_output + total_tokens_reasoning) AS tokens,
                        SUM(total_cost) AS cost,
                        COUNT(*) AS sessions
                     FROM session_reports
                     WHERE created_at >= ?1",
                    params![cutoff_date],
                )
                .await
                .map_err(|e| format!("Failed to aggregate tokens: {}", e))?;
            let row = rows
                .next()
                .await
                .map_err(|e| format!("Failed to read token aggregate row: {}", e))?
                .ok_or("No token aggregate row")?;
            (
                row.get::<i64>(0).unwrap_or(0),
                row.get::<f64>(1).unwrap_or(0.0),
                row.get::<i64>(2).unwrap_or(0),
            )
        };

        Ok(LeaderboardStats {
            total_feedbacks,
            positive_count,
            negative_count,
            total_tokens,
            total_cost: (total_cost * 10000.0).round() / 10000.0,
            session_count,
        })
    }
}

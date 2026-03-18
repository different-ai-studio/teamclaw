use libsql::{params, Builder, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Email channel database for persistent state management
#[derive(Clone)]
pub struct EmailDb {
    conn: Arc<Mutex<Connection>>,
}

/// Account state including UID watermark
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct EmailAccountState {
    pub account_key: String,
    pub uid_watermark: u32,
    pub last_check_at: Option<String>,
    pub updated_at: String,
}

/// Message thread mapping
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct MessageThread {
    pub id: i64,
    pub account_key: String,
    pub message_id: String,
    pub subject: Option<String>,
    pub session_id: Option<String>,
    pub created_at: String,
}

impl EmailDb {
    /// Create a new EmailDb at the given path (e.g. ~/.teamclaw/email.db)
    pub async fn new(db_path: &Path) -> Result<Self, String> {
        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create email db directory: {}", e))?;
        }

        let db_path_str = db_path.to_string_lossy().to_string();
        let db = Builder::new_local(db_path_str)
            .build()
            .await
            .map_err(|e| format!("Failed to open email database: {}", e))?;
        let conn = db
            .connect()
            .map_err(|e| format!("Failed to connect to email database: {}", e))?;

        let instance = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        instance.migrate().await?;
        Ok(instance)
    }

    /// Run database migrations (idempotent)
    async fn migrate(&self) -> Result<(), String> {
        let conn = self.conn.lock().await;

        // Table: email_accounts - stores UID watermark per account
        conn.execute(
            "CREATE TABLE IF NOT EXISTS email_accounts (
                account_key TEXT PRIMARY KEY,
                uid_watermark INTEGER NOT NULL DEFAULT 0,
                last_check_at TEXT,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create email_accounts table: {}", e))?;

        // Table: processed_uids - deduplication tracking
        conn.execute(
            "CREATE TABLE IF NOT EXISTS processed_uids (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_key TEXT NOT NULL,
                uid INTEGER NOT NULL,
                processed_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(account_key, uid)
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create processed_uids table: {}", e))?;

        // Table: message_threads - Message-ID to session mapping
        conn.execute(
            "CREATE TABLE IF NOT EXISTS message_threads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_key TEXT NOT NULL,
                message_id TEXT NOT NULL,
                subject TEXT,
                session_id TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(account_key, message_id)
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create message_threads table: {}", e))?;

        // Indexes for performance
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_processed_uids_account ON processed_uids(account_key, uid)",
            (),
        )
        .await
        .ok();

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_message_threads_account ON message_threads(account_key, message_id)",
            (),
        )
        .await
        .ok();

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_processed_uids_time ON processed_uids(processed_at)",
            (),
        )
        .await
        .ok();

        Ok(())
    }

    // ──────────────────────────────────────────────────────────────────────
    // Account State (UID Watermark)
    // ──────────────────────────────────────────────────────────────────────

    /// Get UID watermark for an account
    pub async fn get_uid_watermark(&self, account_key: &str) -> Result<u32, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT uid_watermark FROM email_accounts WHERE account_key = ?1",
                params![account_key.to_string()],
            )
            .await
            .map_err(|e| format!("Failed to query uid_watermark: {}", e))?;

        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read uid_watermark row: {}", e))?
        {
            let watermark = row
                .get::<i64>(0)
                .map_err(|e| format!("Failed to read uid_watermark value: {}", e))?;
            return Ok(watermark as u32);
        }

        // Account doesn't exist yet, return 0
        Ok(0)
    }

    /// Update UID watermark for an account
    pub async fn update_uid_watermark(
        &self,
        account_key: &str,
        uid_watermark: u32,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO email_accounts (account_key, uid_watermark, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(account_key) DO UPDATE SET
                uid_watermark = ?2,
                last_check_at = datetime('now'),
                updated_at = datetime('now')",
            params![account_key.to_string(), uid_watermark as i64],
        )
        .await
        .map_err(|e| format!("Failed to update uid_watermark: {}", e))?;
        Ok(())
    }

    // ──────────────────────────────────────────────────────────────────────
    // Processed UIDs (Deduplication)
    // ──────────────────────────────────────────────────────────────────────

    /// Check if a UID has been processed
    pub async fn is_uid_processed(&self, account_key: &str, uid: u32) -> Result<bool, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT 1 FROM processed_uids WHERE account_key = ?1 AND uid = ?2 LIMIT 1",
                params![account_key.to_string(), uid as i64],
            )
            .await
            .map_err(|e| format!("Failed to check processed uid: {}", e))?;

        Ok(rows
            .next()
            .await
            .map_err(|e| format!("Failed to read processed uid row: {}", e))?
            .is_some())
    }

    /// Mark a UID as processed
    pub async fn mark_uid_processed(&self, account_key: &str, uid: u32) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT OR IGNORE INTO processed_uids (account_key, uid) VALUES (?1, ?2)",
            params![account_key.to_string(), uid as i64],
        )
        .await
        .map_err(|e| format!("Failed to mark uid as processed: {}", e))?;
        Ok(())
    }

    /// Get count of processed UIDs for an account
    pub async fn count_processed_uids(&self, account_key: &str) -> Result<usize, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT COUNT(*) FROM processed_uids WHERE account_key = ?1",
                params![account_key.to_string()],
            )
            .await
            .map_err(|e| format!("Failed to count processed uids: {}", e))?;

        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read count row: {}", e))?
        {
            let count = row
                .get::<i64>(0)
                .map_err(|e| format!("Failed to read count value: {}", e))?;
            return Ok(count as usize);
        }

        Ok(0)
    }

    /// Cleanup old processed UIDs (FIFO, keep only the most recent MAX_PROCESSED_UIDS)
    pub async fn cleanup_processed_uids(
        &self,
        account_key: &str,
        max_keep: usize,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            &format!(
                "DELETE FROM processed_uids WHERE account_key = ?1 AND id IN (
                    SELECT id FROM processed_uids WHERE account_key = ?1
                    ORDER BY processed_at ASC
                    LIMIT MAX(0, (SELECT COUNT(*) FROM processed_uids WHERE account_key = ?1) - {})
                )",
                max_keep
            ),
            params![account_key.to_string()],
        )
        .await
        .map_err(|e| format!("Failed to cleanup processed uids: {}", e))?;
        Ok(())
    }

    // ──────────────────────────────────────────────────────────────────────
    // Message Threads (Message-ID Index)
    // ──────────────────────────────────────────────────────────────────────

    /// Get session ID for a Message-ID (email threading)
    pub async fn get_session_by_message_id(
        &self,
        account_key: &str,
        message_id: &str,
    ) -> Result<Option<String>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT session_id FROM message_threads 
                 WHERE account_key = ?1 AND message_id = ?2",
                params![account_key.to_string(), message_id.to_string()],
            )
            .await
            .map_err(|e| format!("Failed to query message thread: {}", e))?;

        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read message thread row: {}", e))?
        {
            return Ok(row.get::<String>(0).ok());
        }

        Ok(None)
    }

    /// Store Message-ID to session mapping
    pub async fn store_message_thread(
        &self,
        account_key: &str,
        message_id: &str,
        subject: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO message_threads (account_key, message_id, subject, session_id)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_key, message_id) DO UPDATE SET
                subject = ?3,
                session_id = COALESCE(?4, session_id)",
            params![
                account_key.to_string(),
                message_id.to_string(),
                subject.map(|s| s.to_string()).unwrap_or_default(),
                session_id.map(|s| s.to_string()).unwrap_or_default(),
            ],
        )
        .await
        .map_err(|e| format!("Failed to store message thread: {}", e))?;
        Ok(())
    }

    /// Update session ID for a Message-ID
    #[allow(dead_code)]
    pub async fn update_thread_session(
        &self,
        account_key: &str,
        message_id: &str,
        session_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE message_threads SET session_id = ?3 
             WHERE account_key = ?1 AND message_id = ?2",
            params![
                account_key.to_string(),
                message_id.to_string(),
                session_id.to_string()
            ],
        )
        .await
        .map_err(|e| format!("Failed to update thread session: {}", e))?;
        Ok(())
    }

    /// Search for session by subject (for email threading when Message-ID is missing)
    pub async fn find_session_by_subject(
        &self,
        account_key: &str,
        subject: &str,
    ) -> Result<Option<String>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT session_id FROM message_threads 
                 WHERE account_key = ?1 AND subject = ?2 
                 AND session_id IS NOT NULL
                 ORDER BY created_at DESC LIMIT 1",
                params![account_key.to_string(), subject.to_string()],
            )
            .await
            .map_err(|e| format!("Failed to query message thread by subject: {}", e))?;

        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read message thread row: {}", e))?
        {
            return Ok(row.get::<String>(0).ok());
        }

        Ok(None)
    }

    /// Get all message threads for an account (for debugging)
    #[allow(dead_code)]
    pub async fn get_all_threads(
        &self,
        account_key: &str,
        limit: i64,
    ) -> Result<Vec<MessageThread>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT id, account_key, message_id, subject, session_id, created_at
                 FROM message_threads 
                 WHERE account_key = ?1 
                 ORDER BY created_at DESC LIMIT ?2",
                params![account_key.to_string(), limit],
            )
            .await
            .map_err(|e| format!("Failed to query message threads: {}", e))?;

        let mut threads = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read message thread row: {}", e))?
        {
            threads.push(MessageThread {
                id: row.get::<i64>(0).unwrap_or(0),
                account_key: row.get::<String>(1).unwrap_or_default(),
                message_id: row.get::<String>(2).unwrap_or_default(),
                subject: row.get::<String>(3).ok(),
                session_id: row.get::<String>(4).ok(),
                created_at: row.get::<String>(5).unwrap_or_default(),
            });
        }
        Ok(threads)
    }

    // ──────────────────────────────────────────────────────────────────────
    // Utilities
    // ──────────────────────────────────────────────────────────────────────

    /// Get all account keys
    #[allow(dead_code)]
    pub async fn get_all_account_keys(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query("SELECT account_key FROM email_accounts ORDER BY account_key", ())
            .await
            .map_err(|e| format!("Failed to query account keys: {}", e))?;

        let mut keys = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read account key row: {}", e))?
        {
            if let Ok(key) = row.get::<String>(0) {
                keys.push(key);
            }
        }
        Ok(keys)
    }

    /// Delete all data for an account (cleanup)
    #[allow(dead_code)]
    pub async fn delete_account(&self, account_key: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        
        conn.execute(
            "DELETE FROM email_accounts WHERE account_key = ?1",
            params![account_key.to_string()],
        )
        .await
        .ok();

        conn.execute(
            "DELETE FROM processed_uids WHERE account_key = ?1",
            params![account_key.to_string()],
        )
        .await
        .ok();

        conn.execute(
            "DELETE FROM message_threads WHERE account_key = ?1",
            params![account_key.to_string()],
        )
        .await
        .ok();

        Ok(())
    }
}

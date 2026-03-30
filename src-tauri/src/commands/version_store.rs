use crate::commands::version_types::{FileVersion, VersionedFileInfo, MAX_VERSIONS};
use crate::commands::TEAMCLAW_DIR;
use anyhow::{Context, Result};
use libsql::{params, Builder, Connection};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct VersionStore {
    conn: Arc<Mutex<Connection>>,
}

impl VersionStore {
    pub async fn new(workspace_path: &str) -> Result<Self> {
        let db_dir = format!("{}/{}", workspace_path, TEAMCLAW_DIR);
        tokio::fs::create_dir_all(&db_dir)
            .await
            .context("Failed to create .teamclaw directory")?;

        let db_path = format!("{}/versions.db", db_dir);
        let db = Builder::new_local(&db_path)
            .build()
            .await
            .context("Failed to open versions.db")?;
        let conn = db.connect().context("Failed to connect to versions.db")?;

        let store = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        store.init_schema().await?;
        Ok(store)
    }

    async fn init_schema(&self) -> Result<()> {
        let conn = self.conn.lock().await;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS file_versions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path   TEXT NOT NULL,
                doc_type    TEXT NOT NULL,
                content     TEXT NOT NULL,
                hash        TEXT NOT NULL,
                deleted     INTEGER NOT NULL DEFAULT 0,
                updated_by  TEXT NOT NULL,
                updated_at  TEXT NOT NULL,
                direction   TEXT NOT NULL,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )",
            (),
        )
        .await
        .context("Failed to create file_versions table")?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_file_versions_lookup ON file_versions(file_path, doc_type, created_at DESC)",
            (),
        )
        .await
        .context("Failed to create index")?;

        Ok(())
    }

    /// Record a new version (or update-in-place for recent local edits).
    #[allow(dead_code)]
    pub async fn record_version(
        &self,
        file_path: &str,
        doc_type: &str,
        content: &str,
        hash: &str,
        deleted: bool,
        updated_by: &str,
        updated_at: &str,
        direction: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().await;

        if direction == "local" {
            // Check if the last version for this file was within 5 minutes.
            let mut rows = conn
                .query(
                    "SELECT id, created_at FROM file_versions
                     WHERE file_path = ?1 AND doc_type = ?2
                     ORDER BY created_at DESC
                     LIMIT 1",
                    params![file_path, doc_type],
                )
                .await
                .context("Failed to query last version")?;

            if let Some(row) = rows.next().await? {
                let last_id: i64 = row.get(0)?;
                let last_created_at: String = row.get(1)?;

                // Parse the stored datetime and compare with now (both UTC).
                let is_recent = parse_and_check_within_5min(&last_created_at);

                if is_recent {
                    // Update existing record instead of inserting.
                    conn.execute(
                        "UPDATE file_versions
                         SET content = ?1, hash = ?2, deleted = ?3,
                             updated_by = ?4, updated_at = ?5, direction = ?6
                         WHERE id = ?7",
                        params![
                            content,
                            hash,
                            deleted as i64,
                            updated_by,
                            updated_at,
                            direction,
                            last_id
                        ],
                    )
                    .await
                    .context("Failed to update version")?;

                    return Ok(());
                }
            }
        }

        // Insert new record.
        conn.execute(
            "INSERT INTO file_versions (file_path, doc_type, content, hash, deleted, updated_by, updated_at, direction)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                file_path,
                doc_type,
                content,
                hash,
                deleted as i64,
                updated_by,
                updated_at,
                direction
            ],
        )
        .await
        .context("Failed to insert version")?;

        // Trim to MAX_VERSIONS per file.
        conn.execute(
            "DELETE FROM file_versions
             WHERE file_path = ?1 AND doc_type = ?2
               AND id NOT IN (
                   SELECT id FROM file_versions
                   WHERE file_path = ?1 AND doc_type = ?2
                   ORDER BY created_at DESC
                   LIMIT ?3
               )",
            params![file_path, doc_type, MAX_VERSIONS as i64],
        )
        .await
        .context("Failed to trim versions")?;

        Ok(())
    }

    /// List versions for a file, newest-first.
    pub async fn list_file_versions(
        &self,
        file_path: &str,
        doc_type: &str,
    ) -> Result<Vec<FileVersion>> {
        let conn = self.conn.lock().await;

        let mut rows = conn
            .query(
                "SELECT content, hash, updated_by, updated_at, deleted
                 FROM file_versions
                 WHERE file_path = ?1 AND doc_type = ?2
                 ORDER BY created_at DESC",
                params![file_path, doc_type],
            )
            .await
            .context("Failed to list file versions")?;

        let mut versions = Vec::new();
        let mut index: u32 = 0;
        while let Some(row) = rows.next().await? {
            let deleted_i: i64 = row.get(4)?;
            versions.push(FileVersion {
                index,
                content: row.get(0)?,
                hash: row.get(1)?,
                updated_by: row.get(2)?,
                updated_at: row.get(3)?,
                deleted: deleted_i != 0,
            });
            index += 1;
        }

        Ok(versions)
    }

    /// List all files that have version history (grouped by file_path + doc_type).
    pub async fn list_all_versioned_files(
        &self,
        doc_type: Option<&str>,
    ) -> Result<Vec<VersionedFileInfo>> {
        let conn = self.conn.lock().await;

        let mut rows = if let Some(dt) = doc_type {
            conn.query(
                "SELECT
                     fv.file_path,
                     fv.doc_type,
                     COUNT(*) AS version_count,
                     MAX(fv.created_at) AS latest_created_at,
                     (SELECT deleted FROM file_versions fv2
                      WHERE fv2.file_path = fv.file_path AND fv2.doc_type = fv.doc_type
                      ORDER BY fv2.created_at DESC LIMIT 1) AS current_deleted,
                     (SELECT updated_at FROM file_versions fv3
                      WHERE fv3.file_path = fv.file_path AND fv3.doc_type = fv.doc_type
                      ORDER BY fv3.created_at DESC LIMIT 1) AS latest_update_at,
                     (SELECT updated_by FROM file_versions fv4
                      WHERE fv4.file_path = fv.file_path AND fv4.doc_type = fv.doc_type
                      ORDER BY fv4.created_at DESC LIMIT 1) AS latest_update_by
                 FROM file_versions fv
                 WHERE fv.doc_type = ?1
                 GROUP BY fv.file_path, fv.doc_type
                 ORDER BY latest_created_at DESC",
                params![dt],
            )
            .await
            .context("Failed to list versioned files (filtered)")?
        } else {
            conn.query(
                "SELECT
                     fv.file_path,
                     fv.doc_type,
                     COUNT(*) AS version_count,
                     MAX(fv.created_at) AS latest_created_at,
                     (SELECT deleted FROM file_versions fv2
                      WHERE fv2.file_path = fv.file_path AND fv2.doc_type = fv.doc_type
                      ORDER BY fv2.created_at DESC LIMIT 1) AS current_deleted,
                     (SELECT updated_at FROM file_versions fv3
                      WHERE fv3.file_path = fv.file_path AND fv3.doc_type = fv.doc_type
                      ORDER BY fv3.created_at DESC LIMIT 1) AS latest_update_at,
                     (SELECT updated_by FROM file_versions fv4
                      WHERE fv4.file_path = fv.file_path AND fv4.doc_type = fv.doc_type
                      ORDER BY fv4.created_at DESC LIMIT 1) AS latest_update_by
                 FROM file_versions fv
                 GROUP BY fv.file_path, fv.doc_type
                 ORDER BY latest_created_at DESC",
                (),
            )
            .await
            .context("Failed to list versioned files (all)")?
        };

        let mut files = Vec::new();
        while let Some(row) = rows.next().await? {
            let version_count: i64 = row.get(2)?;
            let current_deleted_i: i64 = row.get(4).unwrap_or(0);
            files.push(VersionedFileInfo {
                path: row.get(0)?,
                doc_type: row.get(1)?,
                version_count: version_count as u32,
                latest_update_at: row.get(5).unwrap_or_default(),
                latest_update_by: row.get(6).unwrap_or_default(),
                current_deleted: current_deleted_i != 0,
            });
        }

        Ok(files)
    }
}

/// Returns true if the datetime string (SQLite datetime format: "YYYY-MM-DD HH:MM:SS")
/// is within 5 minutes of now (UTC).
#[allow(dead_code)]
fn parse_and_check_within_5min(dt_str: &str) -> bool {
    // Parse "YYYY-MM-DD HH:MM:SS" from SQLite datetime('now') output
    let parts: Vec<&str> = dt_str.split_whitespace().collect();
    if parts.len() != 2 {
        return false;
    }
    let date_parts: Vec<&str> = parts[0].split('-').collect();
    let time_parts: Vec<&str> = parts[1].split(':').collect();
    if date_parts.len() != 3 || time_parts.len() != 3 {
        return false;
    }

    let year: i64 = date_parts[0].parse().unwrap_or(0);
    let month: i64 = date_parts[1].parse().unwrap_or(0);
    let day: i64 = date_parts[2].parse().unwrap_or(0);
    let hour: i64 = time_parts[0].parse().unwrap_or(0);
    let minute: i64 = time_parts[1].parse().unwrap_or(0);
    let second: i64 = time_parts[2].parse().unwrap_or(0);

    // Approximate unix timestamp for the stored datetime
    let stored_secs = approx_unix_secs(year, month, day, hour, minute, second);

    // Current unix timestamp
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    now_secs - stored_secs < 300 // 5 minutes = 300 seconds
}

/// Very rough conversion from calendar date to unix seconds.
/// Accurate enough for 5-minute comparison.
#[allow(dead_code)]
fn approx_unix_secs(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
    // Days since epoch (1970-01-01)
    let mut days: i64 = 0;
    for y in 1970..year {
        days += if is_leap(y) { 366 } else { 365 };
    }
    let month_days = if is_leap(year) {
        [31i64, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31i64, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    for m in 1..month {
        days += month_days[(m - 1) as usize];
    }
    days += day - 1;
    days * 86400 + hour * 3600 + minute * 60 + second
}

#[allow(dead_code)]
fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

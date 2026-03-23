use anyhow::{Context, Result};
use libsql::{params, Builder, Connection};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone, Debug)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DocumentRecord {
    pub id: i64,
    pub path: String,
    pub title: Option<String>,
    pub format: String,
    pub hash: String,
    pub size: i64,
    pub chunk_count: i64,
    pub indexed_at: String,
    pub updated_at: String,
}

impl Database {
    pub async fn new(db_path: &Path) -> Result<Self> {
        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .context("Failed to create database directory")?;
        }

        let db_path_str = db_path.to_string_lossy().to_string();
        let db = Builder::new_local(db_path_str)
            .build()
            .await
            .context("Failed to open libSQL database")?;
        let conn = db.connect().context("Failed to connect to database")?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub async fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().await;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS documents (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                path       TEXT NOT NULL UNIQUE,
                title      TEXT,
                format     TEXT NOT NULL,
                hash       TEXT NOT NULL,
                size       INTEGER NOT NULL,
                chunk_count INTEGER NOT NULL DEFAULT 0,
                indexed_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            (),
        )
        .await
        .context("Failed to create documents table")?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS chunks (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                content     TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                heading     TEXT,
                embedding   F32_BLOB(2560),
                chunk_type  TEXT,
                name        TEXT,
                start_line  INTEGER,
                end_line    INTEGER,
                UNIQUE(doc_id, chunk_index)
            )",
            (),
        )
        .await
        .context("Failed to create chunks table")?;

        // Create DiskANN vector index (ignore error if already exists)
        let _ = conn
            .execute(
                "CREATE INDEX IF NOT EXISTS chunks_vec_idx ON chunks(libsql_vector_idx(embedding))",
                (),
            )
            .await;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path)",
            (),
        )
        .await
        .context("Failed to create documents path index")?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash)",
            (),
        )
        .await
        .context("Failed to create documents hash index")?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id)",
            (),
        )
        .await
        .context("Failed to create chunks doc_id index")?;

        Ok(())
    }

    // --- Document CRUD ---

    pub async fn insert_document(
        &self,
        path: &str,
        title: Option<&str>,
        format: &str,
        hash: &str,
        size: i64,
        chunk_count: i64,
    ) -> Result<i64> {
        let conn = self.conn.lock().await;
        let now = chrono_now();

        conn.execute(
            "INSERT INTO documents (path, title, format, hash, size, chunk_count, indexed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![path, title, format, hash, size, chunk_count, now.clone(), now],
        )
        .await
        .context("Failed to insert document")?;

        let mut rows = conn
            .query("SELECT last_insert_rowid()", ())
            .await
            .context("Failed to get last insert id")?;

        let row = rows
            .next()
            .await?
            .ok_or_else(|| anyhow::anyhow!("No row returned for last_insert_rowid"))?;
        let id: i64 = row.get(0)?;
        Ok(id)
    }

    pub async fn update_document(
        &self,
        id: i64,
        hash: &str,
        size: i64,
        chunk_count: i64,
        title: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        let now = chrono_now();

        conn.execute(
            "UPDATE documents SET hash = ?1, size = ?2, chunk_count = ?3, title = ?4, updated_at = ?5 WHERE id = ?6",
            params![hash, size, chunk_count, title, now, id],
        )
        .await
        .context("Failed to update document")?;

        Ok(())
    }

    pub async fn delete_document(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().await;

        // Delete chunks first (CASCADE should handle this, but be explicit)
        conn.execute("DELETE FROM chunks WHERE doc_id = ?1", params![id])
            .await
            .context("Failed to delete chunks")?;

        conn.execute("DELETE FROM documents WHERE id = ?1", params![id])
            .await
            .context("Failed to delete document")?;

        Ok(())
    }

    pub async fn get_document_by_path(&self, path: &str) -> Result<Option<DocumentRecord>> {
        let conn = self.conn.lock().await;

        let mut rows = conn
            .query(
                "SELECT id, path, title, format, hash, size, chunk_count, indexed_at, updated_at
                 FROM documents WHERE path = ?1",
                params![path],
            )
            .await
            .context("Failed to query document by path")?;

        match rows.next().await? {
            Some(row) => Ok(Some(DocumentRecord {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                format: row.get(3)?,
                hash: row.get(4)?,
                size: row.get(5)?,
                chunk_count: row.get(6)?,
                indexed_at: row.get(7)?,
                updated_at: row.get(8)?,
            })),
            None => Ok(None),
        }
    }

    pub async fn list_documents(&self) -> Result<Vec<DocumentRecord>> {
        let conn = self.conn.lock().await;

        let mut rows = conn
            .query(
                "SELECT id, path, title, format, hash, size, chunk_count, indexed_at, updated_at
                 FROM documents ORDER BY path",
                (),
            )
            .await
            .context("Failed to list documents")?;

        let mut docs = Vec::new();
        while let Some(row) = rows.next().await? {
            docs.push(DocumentRecord {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                format: row.get(3)?,
                hash: row.get(4)?,
                size: row.get(5)?,
                chunk_count: row.get(6)?,
                indexed_at: row.get(7)?,
                updated_at: row.get(8)?,
            });
        }

        Ok(docs)
    }

    pub async fn list_all_document_paths(&self) -> Result<Vec<(i64, String)>> {
        let conn = self.conn.lock().await;

        let mut rows = conn
            .query("SELECT id, path FROM documents", ())
            .await
            .context("Failed to list document paths")?;

        let mut paths = Vec::new();
        while let Some(row) = rows.next().await? {
            let id: i64 = row.get(0)?;
            let path: String = row.get(1)?;
            paths.push((id, path));
        }

        Ok(paths)
    }

    // --- Chunk functions ---

    pub async fn insert_chunks(
        &self,
        doc_id: i64,
        chunks: &[(
            String,
            i32,
            Option<String>,
            Vec<f32>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<i64>,
        )],
    ) -> Result<()> {
        let conn = self.conn.lock().await;

        for (content, chunk_index, heading, embedding, chunk_type, name, start_line, end_line) in
            chunks
        {
            // Convert Vec<f32> to binary blob for F32_BLOB
            let embedding_bytes: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();

            conn.execute(
                "INSERT INTO chunks (doc_id, content, chunk_index, heading, embedding, chunk_type, name, start_line, end_line)
                 VALUES (?1, ?2, ?3, ?4, vector32(?5), ?6, ?7, ?8, ?9)",
                params![
                    doc_id,
                    content.as_str(),
                    *chunk_index,
                    heading.as_deref(),
                    libsql::Value::Blob(embedding_bytes),
                    chunk_type.as_deref(),
                    name.as_deref(),
                    *start_line,
                    *end_line,
                ],
            )
            .await
            .context("Failed to insert chunk")?;
        }

        Ok(())
    }

    pub async fn delete_chunks_by_doc_id(&self, doc_id: i64) -> Result<()> {
        let conn = self.conn.lock().await;

        conn.execute("DELETE FROM chunks WHERE doc_id = ?1", params![doc_id])
            .await
            .context("Failed to delete chunks")?;

        Ok(())
    }

    /// Clear all chunks (for force rebuild)
    pub async fn clear_all_chunks(&self) -> Result<()> {
        let conn = self.conn.lock().await;

        conn.execute("DELETE FROM chunks", ())
            .await
            .context("Failed to clear all chunks")?;

        Ok(())
    }

    pub async fn get_total_chunk_count(&self) -> Result<i64> {
        let conn = self.conn.lock().await;

        let mut rows = conn
            .query("SELECT COUNT(*) FROM chunks", ())
            .await
            .context("Failed to count chunks")?;

        let row = rows
            .next()
            .await?
            .ok_or_else(|| anyhow::anyhow!("No row returned for COUNT"))?;
        let count: i64 = row.get(0)?;
        Ok(count)
    }

    // --- Search ---

    pub async fn vector_search(
        &self,
        embedding: &[f32],
        top_k: usize,
    ) -> Result<Vec<SearchResult>> {
        let conn = self.conn.lock().await;

        let embedding_bytes: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();

        let mut rows = conn
            .query(
                "SELECT c.id, c.content, c.heading, c.chunk_index, d.path, d.title, c.start_line, c.end_line,
                        vector_distance_cos(c.embedding, vector32(?1)) as distance
                 FROM vector_top_k('chunks_vec_idx', vector32(?1), ?2) AS v
                 JOIN chunks c ON c.rowid = v.id
                 JOIN documents d ON d.id = c.doc_id",
                params![libsql::Value::Blob(embedding_bytes), top_k as i64],
            )
            .await
            .context("Failed to execute vector search")?;

        let mut results = Vec::new();
        while let Some(row) = rows.next().await? {
            let distance: f64 = row.get(8)?;
            // Convert cosine distance to similarity score (1 - distance)
            let score = 1.0 - distance;

            results.push(SearchResult {
                chunk_id: row.get(0)?,
                content: row.get(1)?,
                heading: row.get(2)?,
                chunk_index: row.get(3)?,
                source: row.get(4)?,
                title: row.get(5)?,
                score,
                start_line: row.get(6)?,
                end_line: row.get(7)?,
            });
        }

        Ok(results)
    }

    /// Get all chunks for a document (for BM25 sync)
    pub async fn get_chunks_by_doc_id(&self, doc_id: i64) -> Result<Vec<SearchResult>> {
        let conn = self.conn.lock().await;

        let mut rows = conn
            .query(
                "SELECT c.id, c.content, c.heading, c.chunk_index, d.path, d.title, c.start_line, c.end_line
                 FROM chunks c
                 JOIN documents d ON d.id = c.doc_id
                 WHERE c.doc_id = ?1
                 ORDER BY c.chunk_index",
                params![doc_id],
            )
            .await
            .context("Failed to get chunks by doc_id")?;

        let mut results = Vec::new();
        while let Some(row) = rows.next().await? {
            results.push(SearchResult {
                chunk_id: row.get(0)?,
                content: row.get(1)?,
                heading: row.get(2)?,
                chunk_index: row.get(3)?,
                source: row.get(4)?,
                title: row.get(5)?,
                score: 0.0,
                start_line: row.get(6)?,
                end_line: row.get(7)?,
            });
        }

        Ok(results)
    }

    /// Get chunks by their IDs (for hybrid search)
    pub async fn get_chunks_by_ids(&self, chunk_ids: &[i64]) -> Result<Vec<SearchResult>> {
        if chunk_ids.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock().await;
        let placeholders = chunk_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let query = format!(
            "SELECT c.id, c.content, c.heading, c.chunk_index, d.path, d.title, c.start_line, c.end_line
             FROM chunks c
             JOIN documents d ON d.id = c.doc_id
             WHERE c.id IN ({})",
            placeholders
        );

        let params: Vec<libsql::Value> = chunk_ids
            .iter()
            .map(|id| libsql::Value::Integer(*id))
            .collect();

        let mut rows = conn
            .query(&query, libsql::params_from_iter(params))
            .await
            .context("Failed to get chunks by IDs")?;

        let mut results = Vec::new();
        while let Some(row) = rows.next().await? {
            results.push(SearchResult {
                chunk_id: row.get(0)?,
                content: row.get(1)?,
                heading: row.get(2)?,
                chunk_index: row.get(3)?,
                source: row.get(4)?,
                title: row.get(5)?,
                score: 0.0, // score will be set by caller
                start_line: row.get(6)?,
                end_line: row.get(7)?,
            });
        }

        Ok(results)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchResult {
    pub chunk_id: i64,
    pub content: String,
    pub heading: Option<String>,
    pub chunk_index: i64,
    pub source: String,
    pub title: Option<String>,
    pub score: f64,
    pub start_line: Option<i64>,
    pub end_line: Option<i64>,
}

fn chrono_now() -> String {
    // Simple ISO 8601 timestamp using std
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // Format as ISO 8601 (approximate - good enough for our purposes)
    let secs_per_day = 86400u64;
    let days_since_epoch = now / secs_per_day;
    let time_of_day = now % secs_per_day;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Simple date calculation (approximate, doesn't handle leap years precisely)
    let mut year = 1970i32;
    let mut remaining_days = days_since_epoch as i32;
    loop {
        let days_in_year = if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
            366
        } else {
            365
        };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        year += 1;
    }
    let days_in_months = if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month = 1u32;
    for &days in &days_in_months {
        if remaining_days < days {
            break;
        }
        remaining_days -= days;
        month += 1;
    }
    let day = remaining_days + 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

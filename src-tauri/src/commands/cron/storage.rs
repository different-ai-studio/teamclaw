use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::types::{CronJob, CronJobsData, CronRunRecord};

/// Persistent storage for cron jobs and run history
#[derive(Debug)]
pub struct CronStorage {
    /// In-memory jobs data
    data: Arc<RwLock<CronJobsData>>,
    /// Path to the workspace directory
    workspace_path: Arc<RwLock<Option<String>>>,
}

impl Default for CronStorage {
    fn default() -> Self {
        Self::new()
    }
}

impl Clone for CronStorage {
    fn clone(&self) -> Self {
        Self {
            data: Arc::clone(&self.data),
            workspace_path: Arc::clone(&self.workspace_path),
        }
    }
}

impl CronStorage {
    pub fn new() -> Self {
        Self {
            data: Arc::new(RwLock::new(CronJobsData::default())),
            workspace_path: Arc::new(RwLock::new(None)),
        }
    }

    /// Get the current workspace path
    pub async fn get_workspace_path(&self) -> Option<String> {
        self.workspace_path.read().await.clone()
    }

    /// Get the jobs file path
    fn jobs_path(workspace: &str) -> PathBuf {
        PathBuf::from(workspace)
            .join(crate::commands::TEAMCLAW_DIR)
            .join("cron-jobs.json")
    }

    /// Get the runs directory path
    fn runs_dir(workspace: &str) -> PathBuf {
        PathBuf::from(workspace)
            .join(crate::commands::TEAMCLAW_DIR)
            .join("cron-runs")
    }

    /// Get the run history file for a specific job
    fn run_file(workspace: &str, job_id: &str) -> PathBuf {
        Self::runs_dir(workspace).join(format!("{}.jsonl", job_id))
    }

    /// Initialize storage with a workspace path and load existing data.
    /// If switching workspaces, replaces old data with new workspace's jobs.
    pub async fn init(&self, workspace_path: &str) {
        println!("[Cron] Initializing storage at: {}", workspace_path);

        // Load existing jobs from new workspace, or use empty data if file doesn't exist
        let jobs_path = Self::jobs_path(workspace_path);
        let new_data = if jobs_path.exists() {
            match std::fs::read_to_string(&jobs_path) {
                Ok(content) => match serde_json::from_str::<CronJobsData>(&content) {
                    Ok(loaded) => {
                        println!("[Cron] Loaded {} jobs from file", loaded.jobs.len());
                        loaded
                    }
                    Err(e) => {
                        eprintln!("[Cron] Failed to parse jobs file: {}", e);
                        CronJobsData::default()
                    }
                },
                Err(e) => {
                    eprintln!("[Cron] Failed to read jobs file: {}", e);
                    CronJobsData::default()
                }
            }
        } else {
            println!("[Cron] No existing jobs file found, starting with empty jobs");
            CronJobsData::default()
        };

        // Ensure runs directory exists (do I/O before acquiring locks)
        let runs_dir = Self::runs_dir(workspace_path);
        if !runs_dir.exists() {
            let _ = std::fs::create_dir_all(&runs_dir);
        }

        // Replace data atomically — critical for workspace switching to ensure
        // old workspace's jobs don't leak into new workspace
        {
            let mut data = self.data.write().await;
            *data = new_data;
        } // Release data lock immediately

        // Update workspace path
        let mut wp = self.workspace_path.write().await;
        *wp = Some(workspace_path.to_string());
    }

    /// Check if storage is initialized
    pub async fn is_initialized(&self) -> bool {
        self.workspace_path.read().await.is_some()
    }

    /// Get mutable access to the in-memory jobs data
    pub async fn data_mut(&self) -> tokio::sync::RwLockWriteGuard<'_, CronJobsData> {
        self.data.write().await
    }

    /// Persist jobs data to file (public for scheduler direct updates)
    pub async fn persist(&self) {
        self.persist_jobs().await;
    }

    /// Persist jobs data to file
    async fn persist_jobs(&self) {
        let workspace = self.workspace_path.read().await;
        if let Some(ws) = workspace.as_ref() {
            let data = self.data.read().await;
            match serde_json::to_string_pretty(&*data) {
                Ok(content) => {
                    if let Err(e) = std::fs::write(Self::jobs_path(ws), content) {
                        eprintln!("[Cron] Failed to save jobs: {}", e);
                    }
                }
                Err(e) => {
                    eprintln!("[Cron] Failed to serialize jobs: {}", e);
                }
            }
        }
    }

    // ==================== Job CRUD ====================

    /// Get all jobs
    pub async fn list_jobs(&self) -> Vec<CronJob> {
        self.data.read().await.jobs.clone()
    }

    /// Get a single job by ID
    pub async fn get_job(&self, job_id: &str) -> Option<CronJob> {
        self.data
            .read()
            .await
            .jobs
            .iter()
            .find(|j| j.id == job_id)
            .cloned()
    }

    /// Add a new job
    pub async fn add_job(&self, job: CronJob) {
        {
            let mut data = self.data.write().await;
            data.jobs.push(job);
        }
        self.persist_jobs().await;
    }

    /// Update an existing job (replaces the job with matching ID)
    pub async fn update_job(&self, updated: CronJob) -> Result<(), String> {
        {
            let mut data = self.data.write().await;
            if let Some(existing) = data.jobs.iter_mut().find(|j| j.id == updated.id) {
                *existing = updated;
            } else {
                return Err(format!("Job not found: {}", updated.id));
            }
        }
        self.persist_jobs().await;
        Ok(())
    }

    /// Remove a job by ID
    pub async fn remove_job(&self, job_id: &str) -> Result<(), String> {
        {
            let mut data = self.data.write().await;
            let before = data.jobs.len();
            data.jobs.retain(|j| j.id != job_id);
            if data.jobs.len() == before {
                return Err(format!("Job not found: {}", job_id));
            }
        }
        self.persist_jobs().await;

        // Also clean up run history
        let workspace = self.workspace_path.read().await;
        if let Some(ws) = workspace.as_ref() {
            let run_file = Self::run_file(ws, job_id);
            if run_file.exists() {
                let _ = std::fs::remove_file(run_file);
            }
        }

        Ok(())
    }

    /// Toggle job enabled/disabled
    pub async fn toggle_enabled(&self, job_id: &str, enabled: bool) -> Result<(), String> {
        {
            let mut data = self.data.write().await;
            if let Some(job) = data.jobs.iter_mut().find(|j| j.id == job_id) {
                job.enabled = enabled;
                job.updated_at = chrono::Utc::now();
            } else {
                return Err(format!("Job not found: {}", job_id));
            }
        }
        self.persist_jobs().await;
        Ok(())
    }

    /// Update job timestamps after a run
    pub async fn update_run_timestamps(
        &self,
        job_id: &str,
        last_run: chrono::DateTime<chrono::Utc>,
        next_run: Option<chrono::DateTime<chrono::Utc>>,
    ) {
        {
            let mut data = self.data.write().await;
            if let Some(job) = data.jobs.iter_mut().find(|j| j.id == job_id) {
                job.last_run_at = Some(last_run);
                job.next_run_at = next_run;
                job.updated_at = chrono::Utc::now();
            }
        }
        self.persist_jobs().await;
    }

    /// Set only `next_run_at` (e.g. when filling in a missing schedule or re-enabling a job).
    /// Does not touch `last_run_at`.
    pub async fn update_next_run_at(
        &self,
        job_id: &str,
        next_run: Option<chrono::DateTime<chrono::Utc>>,
    ) {
        {
            let mut data = self.data.write().await;
            if let Some(job) = data.jobs.iter_mut().find(|j| j.id == job_id) {
                job.next_run_at = next_run;
                job.updated_at = chrono::Utc::now();
            }
        }
        self.persist_jobs().await;
    }

    // ==================== Run History ====================

    /// Append a run record for a job
    pub async fn append_run(&self, record: &CronRunRecord) {
        let workspace = self.workspace_path.read().await;
        if let Some(ws) = workspace.as_ref() {
            let runs_dir = Self::runs_dir(ws);
            if !runs_dir.exists() {
                let _ = std::fs::create_dir_all(&runs_dir);
            }
            let run_file = Self::run_file(ws, &record.job_id);
            match serde_json::to_string(record) {
                Ok(line) => {
                    use std::io::Write;
                    match std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&run_file)
                    {
                        Ok(mut file) => {
                            if let Err(e) = writeln!(file, "{}", line) {
                                eprintln!("[Cron] Failed to write run record: {}", e);
                            }
                        }
                        Err(e) => {
                            eprintln!("[Cron] Failed to open run file: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[Cron] Failed to serialize run record: {}", e);
                }
            }
        }
    }

    /// Update the last run record for a job (used when a run completes)
    pub async fn update_last_run(&self, record: &CronRunRecord) {
        let workspace = self.workspace_path.read().await;
        if let Some(ws) = workspace.as_ref() {
            let run_file = Self::run_file(ws, &record.job_id);
            if !run_file.exists() {
                // No runs file, just append
                drop(workspace);
                self.append_run(record).await;
                return;
            }

            // Read all lines, update the last one with matching run_id
            match std::fs::read_to_string(&run_file) {
                Ok(content) => {
                    let mut lines: Vec<String> = content
                        .lines()
                        .filter(|l| !l.trim().is_empty())
                        .map(|l| l.to_string())
                        .collect();

                    let mut found = false;
                    for line in lines.iter_mut().rev() {
                        if let Ok(existing) = serde_json::from_str::<CronRunRecord>(line) {
                            if existing.run_id == record.run_id {
                                if let Ok(updated_line) = serde_json::to_string(record) {
                                    *line = updated_line;
                                    found = true;
                                    break;
                                }
                            }
                        }
                    }

                    if found {
                        let new_content = lines.join("\n") + "\n";
                        if let Err(e) = std::fs::write(&run_file, new_content) {
                            eprintln!("[Cron] Failed to update run file: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[Cron] Failed to read run file: {}", e);
                }
            }
        }
    }

    /// Collect all session IDs created by cron jobs (across all jobs).
    /// Used by the frontend to filter cron sessions from the session list.
    pub async fn get_all_session_ids(&self) -> Vec<String> {
        let workspace = self.workspace_path.read().await;
        let Some(ws) = workspace.as_ref() else {
            return Vec::new();
        };

        let runs_dir = Self::runs_dir(ws);
        if !runs_dir.exists() {
            return Vec::new();
        }

        let mut session_ids = std::collections::HashSet::new();

        if let Ok(entries) = std::fs::read_dir(&runs_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(&path) {
                    for line in content.lines() {
                        if line.trim().is_empty() {
                            continue;
                        }
                        if let Ok(record) = serde_json::from_str::<CronRunRecord>(line) {
                            if let Some(sid) = record.session_id {
                                session_ids.insert(sid);
                            }
                        }
                    }
                }
            }
        }

        session_ids.into_iter().collect()
    }

    /// Get run history for a job (most recent first, with optional limit)
    /// Get run history for a job.
    ///
    /// Performance note: Currently reads and parses the entire file, then truncates
    /// to the requested limit. For jobs with thousands of runs, this could be slow.
    /// Future optimization: read from end of file backwards and stop after `limit` lines.
    pub async fn get_runs(&self, job_id: &str, limit: Option<usize>) -> Vec<CronRunRecord> {
        let workspace = self.workspace_path.read().await;
        if let Some(ws) = workspace.as_ref() {
            let run_file = Self::run_file(ws, job_id);
            if !run_file.exists() {
                return Vec::new();
            }

            match std::fs::read_to_string(&run_file) {
                Ok(content) => {
                    let mut records: Vec<CronRunRecord> = content
                        .lines()
                        .filter(|l| !l.trim().is_empty())
                        .filter_map(|l| serde_json::from_str(l).ok())
                        .collect();

                    // Most recent first
                    records.reverse();

                    if let Some(limit) = limit {
                        records.truncate(limit);
                    }

                    records
                }
                Err(e) => {
                    eprintln!("[Cron] Failed to read runs for {}: {}", job_id, e);
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        }
    }
}

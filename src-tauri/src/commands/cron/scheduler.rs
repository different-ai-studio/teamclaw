use chrono::{DateTime, Utc};
use cron::Schedule as CronScheduleParser;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::delivery::DeliveryManager;
use super::storage::CronStorage;
use super::types::*;
use crate::commands::gateway::SessionMapping;

/// The cron scheduler that runs as a background task
#[derive(Debug)]
pub struct CronScheduler {
    storage: CronStorage,
    opencode_port: Arc<RwLock<u16>>,
    delivery: Arc<RwLock<Option<DeliveryManager>>>,
    /// Shared session mapping with gateways — used to look up existing sessions
    session_mapping: Arc<RwLock<Option<SessionMapping>>>,
    /// Generation counter: incremented on each start/stop to uniquely identify
    /// scheduler instances. Prevents old tick loops from continuing after restart.
    generation: Arc<RwLock<u64>>,
}

impl Clone for CronScheduler {
    fn clone(&self) -> Self {
        Self {
            storage: self.storage.clone(),
            opencode_port: Arc::clone(&self.opencode_port),
            delivery: Arc::clone(&self.delivery),
            session_mapping: Arc::clone(&self.session_mapping),
            generation: Arc::clone(&self.generation),
        }
    }
}

/// RAII guard that automatically removes a git worktree when dropped.
/// Ensures cleanup on ALL exit paths, including `check_generation!()` early returns.
struct WorktreeGuard {
    workspace: String,
    path: Option<String>,
}

impl WorktreeGuard {
    fn new(workspace: &str) -> Self {
        Self {
            workspace: workspace.to_string(),
            path: None,
        }
    }

    fn activate(&mut self, path: String) {
        self.path = Some(path);
    }
}

impl Drop for WorktreeGuard {
    fn drop(&mut self) {
        if let Some(ref wt) = self.path {
            CronScheduler::remove_worktree(&self.workspace, wt);
        }
    }
}

impl CronScheduler {
    pub fn new(storage: CronStorage) -> Self {
        Self {
            storage,
            opencode_port: Arc::new(RwLock::new(13141)),
            delivery: Arc::new(RwLock::new(None)),
            session_mapping: Arc::new(RwLock::new(None)),
            generation: Arc::new(RwLock::new(0)),
        }
    }

    /// Set the OpenCode server port
    pub async fn set_port(&self, port: u16) {
        let mut p = self.opencode_port.write().await;
        *p = port;
    }

    /// Set the delivery manager
    pub async fn set_delivery(&self, delivery: DeliveryManager) {
        let mut d = self.delivery.write().await;
        *d = Some(delivery);
    }

    /// Set the shared session mapping (from gateway state)
    pub async fn set_session_mapping(&self, mapping: SessionMapping) {
        let mut sm = self.session_mapping.write().await;
        *sm = Some(mapping);
    }

    /// Build the standard gateway session key from a delivery config.
    /// This is the same key format that Discord/Feishu gateways use,
    /// so we can look up (and reuse) the user's existing chat session.
    ///
    /// - Discord DM target "dm:<user_id>"        -> key "discord:dm:<user_id>"
    /// - Discord Channel target "channel:<ch_id>" -> key "discord:channel:<ch_id>"
    /// - Feishu target "<chat_id>"                -> key "feishu:<chat_id>"
    /// - Email                                    -> None (email uses per-execution keys)
    fn delivery_to_session_key(delivery: &CronDelivery) -> Option<String> {
        let target = &delivery.to;
        match delivery.channel {
            DeliveryChannel::Discord => {
                if target.starts_with("dm:") {
                    let user_id = target.strip_prefix("dm:").unwrap_or(target);
                    Some(format!("discord:dm:{}", user_id))
                } else if target.starts_with("channel:") {
                    let channel_id = target.strip_prefix("channel:").unwrap_or(target);
                    Some(format!("discord:channel:{}", channel_id))
                } else {
                    // Raw ID, assume DM
                    Some(format!("discord:dm:{}", target))
                }
            }
            DeliveryChannel::Feishu => Some(format!("feishu:{}", target)),
            // Email sessions are created per-execution with unique thread keys,
            // not per-target-address. See execute_job for details.
            DeliveryChannel::Email => None,
            DeliveryChannel::Kook => {
                if target.starts_with("dm:") {
                    let user_id = target.strip_prefix("dm:").unwrap_or(target);
                    Some(format!("kook:dm:{}", user_id))
                } else if target.starts_with("channel:") {
                    let parts: Vec<&str> = target
                        .strip_prefix("channel:")
                        .unwrap_or(target)
                        .splitn(2, ':')
                        .collect();
                    if parts.len() == 2 {
                        Some(format!("kook:channel:{}:{}", parts[0], parts[1]))
                    } else {
                        Some(format!(
                            "kook:channel:{}",
                            target.strip_prefix("channel:").unwrap_or(target)
                        ))
                    }
                } else {
                    Some(format!("kook:dm:{}", target))
                }
            }
            DeliveryChannel::Wechat => Some(format!("wechat:dm:{}", target)),
        }
    }

    /// Try to find an existing session for the delivery target.
    /// Returns Some(session_id) if found, None otherwise.
    async fn find_existing_session(&self, delivery: &CronDelivery) -> Option<String> {
        let key = Self::delivery_to_session_key(delivery)?;
        let sm_guard = self.session_mapping.read().await;
        let mapping = sm_guard.as_ref()?;

        let session_id = mapping.get_session(&key).await?;
        println!(
            "[Cron] Found existing session for key '{}': {}",
            key, session_id
        );

        // Verify the session is not archived by querying OpenCode
        let port = *self.opencode_port.read().await;
        if self.is_session_archived(port, &session_id).await {
            println!(
                "[Cron] Session '{}' is archived, will create a new one",
                session_id
            );
            return None;
        }

        println!("[Cron] Session '{}' is active, reusing it", session_id);
        Some(session_id)
    }

    /// Store a new session back to the gateway session mapping,
    /// so subsequent user messages in the same channel reuse it.
    async fn store_session(&self, delivery: &CronDelivery, session_id: &str) {
        if let Some(key) = Self::delivery_to_session_key(delivery) {
            let sm_guard = self.session_mapping.read().await;
            if let Some(mapping) = sm_guard.as_ref() {
                mapping
                    .set_session(key.clone(), session_id.to_string())
                    .await;
                println!(
                    "[Cron] Stored new session '{}' under key '{}'",
                    session_id, key
                );
            }
        }
    }

    /// Start the scheduler background loop
    /// Start the scheduler loop with a new generation ID.
    /// Each start increments the generation counter, so old loops exit when they
    /// detect their generation is outdated (prevents duplicate schedulers).
    pub async fn start(&self) {
        let mut gen = self.generation.write().await;
        *gen += 1;
        let current_gen = *gen;
        drop(gen);

        // Clean up any orphan worktrees from previous runs
        if let Some(workspace) = self.storage.get_workspace_path().await {
            Self::cleanup_orphan_worktrees(&workspace);
        }

        println!("[Cron] Scheduler started (gen: {}, tick every 15 seconds)", current_gen);

        let scheduler = self.clone();
        tokio::spawn(async move {
            loop {
                // Check if this loop's generation is still current
                let active_gen = *scheduler.generation.read().await;
                if active_gen != current_gen {
                    println!("[Cron] Scheduler gen {} stopped (current: {})", current_gen, active_gen);
                    break;
                }

                // Check if storage is initialized
                if scheduler.storage.is_initialized().await {
                    scheduler.tick().await;
                }

                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            }
        });
    }

    /// Stop the scheduler by incrementing the generation counter.
    /// The old tick loop will exit on its next iteration when it detects
    /// its generation ID no longer matches.
    pub async fn stop(&self) {
        let mut gen = self.generation.write().await;
        *gen += 1;
        println!("[Cron] Scheduler stop requested (new gen: {})", *gen);
    }

    /// One tick of the scheduler - check all jobs and fire due ones
    async fn tick(&self) {
        let jobs = self.storage.list_jobs().await;
        let now = Utc::now();

        for job in jobs {
            if !job.enabled {
                continue;
            }

            // Check if job is due
            let is_due = match &job.next_run_at {
                Some(next) => now >= *next,
                None => {
                    // Compute next_run_at if missing
                    if let Some(next) = self.compute_next_run(&job, None) {
                        self.storage
                            .update_run_timestamps(&job.id, now, Some(next))
                            .await;
                        false
                    } else {
                        false
                    }
                }
            };

            if is_due {
                println!("[Cron] Job '{}' ({}) is due, executing...", job.name, job.id);

                // IMPORTANT: Update next_run_at IMMEDIATELY before spawning,
                // so subsequent ticks don't re-fire the same job while it's running.
                let next_run = self.compute_next_run(&job, Some(now));
                self.storage
                    .update_run_timestamps(&job.id, now, next_run)
                    .await;

                let scheduler = self.clone();
                let job_clone = job.clone();
                tokio::spawn(async move {
                    scheduler.execute_job(job_clone).await;
                });
            }
        }
    }

    /// Create a git worktree for isolated job execution.
    fn create_worktree(workspace: &str, worktree_path: &str, branch: &str) -> Result<(), String> {
        let output = std::process::Command::new("git")
            .current_dir(workspace)
            .args(["worktree", "add", "--detach", worktree_path, branch])
            .output()
            .map_err(|e| format!("Failed to run git worktree add: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git worktree add failed: {}", stderr.trim()));
        }

        println!("[Cron] Created worktree at: {} (branch: {})", worktree_path, branch);
        Ok(())
    }

    /// Remove a git worktree. Falls back to rm -rf + prune if git remove fails.
    fn remove_worktree(workspace: &str, worktree_path: &str) {
        let result = std::process::Command::new("git")
            .current_dir(workspace)
            .args(["worktree", "remove", "--force", worktree_path])
            .output();

        match result {
            Ok(output) if output.status.success() => {
                println!("[Cron] Removed worktree: {}", worktree_path);
            }
            _ => {
                println!("[Cron] git worktree remove failed, falling back to rm -rf for: {}", worktree_path);
                let _ = std::fs::remove_dir_all(worktree_path);
                let _ = std::process::Command::new("git")
                    .current_dir(workspace)
                    .args(["worktree", "prune"])
                    .output();
            }
        }
    }

    /// Clean up orphaned cron worktrees from previous runs.
    fn cleanup_orphan_worktrees(workspace: &str) {
        let worktrees_dir = std::path::Path::new(workspace).join(".worktrees");
        if !worktrees_dir.exists() {
            return;
        }

        let entries = match std::fs::read_dir(&worktrees_dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("cron-") && entry.path().is_dir() {
                println!("[Cron] Cleaning up orphan worktree: {}", entry.path().display());
                Self::remove_worktree(workspace, &entry.path().to_string_lossy());
            }
        }
    }

    /// Execute a single cron job
    pub async fn execute_job(&self, job: CronJob) {
        let run_id = uuid::Uuid::new_v4().to_string();
        let started_at = Utc::now();

        // Capture current generation and workspace to detect if scheduler was
        // restarted during execution (e.g., workspace switched). If so, abort.
        let my_generation = *self.generation.read().await;
        let my_workspace = self.storage.get_workspace_path().await.unwrap_or_default();

        // Worktree setup (if enabled)
        let use_worktree = job.payload.use_worktree.unwrap_or(false);
        let mut wt_guard = WorktreeGuard::new(&my_workspace);

        // Create initial run record
        let mut record = CronRunRecord {
            run_id: run_id.clone(),
            job_id: job.id.clone(),
            started_at,
            finished_at: None,
            status: RunStatus::Running,
            session_id: None,
            response_summary: None,
            delivery_status: None,
            error: None,
            worktree_path: None,
        };
        self.storage.append_run(&record).await;

        if use_worktree {
            let wt_dir = std::path::Path::new(&my_workspace)
                .join(".worktrees")
                .join(format!("cron-{}-{}", job.id, run_id));
            let wt_path = wt_dir.to_string_lossy().to_string();
            let branch = job.payload.worktree_branch.as_deref().unwrap_or("main");

            if let Err(e) = std::fs::create_dir_all(wt_dir.parent().unwrap()) {
                record.status = RunStatus::Failed;
                record.finished_at = Some(Utc::now());
                record.error = Some(format!("Failed to create .worktrees dir: {}", e));
                self.storage.update_last_run(&record).await;
                self.update_job_after_run(&job, started_at, &my_workspace).await;
                return;
            }

            match Self::create_worktree(&my_workspace, &wt_path, branch) {
                Ok(()) => {
                    record.worktree_path = Some(wt_path.clone());
                    self.storage.append_run(&record).await;
                    wt_guard.activate(wt_path);
                }
                Err(e) => {
                    record.status = RunStatus::Failed;
                    record.finished_at = Some(Utc::now());
                    record.error = Some(format!("Worktree creation failed: {}", e));
                    self.storage.update_last_run(&record).await;
                    self.update_job_after_run(&job, started_at, &my_workspace).await;
                    return;
                }
            }
        }

        let opencode_directory = wt_guard.path.as_deref();

        let port = *self.opencode_port.read().await;

        // Helper macro: abort if scheduler was restarted (workspace switched)
        macro_rules! check_generation {
            () => {
                let active_gen = *self.generation.read().await;
                if active_gen != my_generation {
                    println!(
                        "[Cron] Job '{}' aborted: scheduler restarted (gen {} -> {})",
                        job.name, my_generation, active_gen
                    );
                    record.status = RunStatus::Failed;
                    record.finished_at = Some(Utc::now());
                    record.error = Some("Aborted due to workspace change".to_string());
                    self.storage.append_run(&record).await;
                    return;
                }
            };
        }

        // Check before starting work
        check_generation!();

        // Step 1: Determine session strategy based on delivery channel.
        //
        // - Discord/Feishu: Reuse the user's existing session for that channel target,
        //   so cron tasks share the same conversation context as user messages.
        // - Email: Always create a NEW session per execution. Email sessions are
        //   identified by `email:thread:cron:<job_id>:<run_id>`, unique per run.
        //   After delivery, the outgoing Message-ID is registered in SessionMapping
        //   so user replies (via In-Reply-To) resolve to this same session.
        // - No delivery: Always create a fresh session.
        let is_email_delivery = matches!(
            &job.delivery,
            Some(d) if d.channel == DeliveryChannel::Email
        );
        // For email delivery, build the unique session key upfront
        let email_session_key = if is_email_delivery {
            Some(format!("email:thread:cron:{}:{}", job.id, run_id))
        } else {
            None
        };

        let (session_id, _is_new_session) = if use_worktree {
            // Worktree mode: always create a new session bound to the worktree directory
            match self.create_opencode_session(port, opencode_directory).await {
                Ok(id) => {
                    println!(
                        "[Cron] Created worktree session '{}' for job '{}' (dir: {:?})",
                        id, job.name, opencode_directory
                    );
                    (id, true)
                }
                Err(e) => {
                    record.status = RunStatus::Failed;
                    record.finished_at = Some(Utc::now());
                    record.error = Some(format!("Failed to create session: {}", e));
                    self.storage.update_last_run(&record).await;
                    self.update_job_after_run(&job, started_at, &my_workspace).await;
                    return;
                }
            }
        } else if is_email_delivery {
            // Email: always create a new OpenCode session per execution
            match self.create_opencode_session(port, None).await {
                Ok(id) => {
                    let session_key = email_session_key.as_ref().unwrap();
                    println!(
                        "[Cron] Created new email session '{}' for job '{}' (key: {})",
                        id, job.name, session_key
                    );
                    // Store the session under the unique email thread key
                    let sm_guard = self.session_mapping.read().await;
                    if let Some(mapping) = sm_guard.as_ref() {
                        mapping
                            .set_session(session_key.clone(), id.clone())
                            .await;
                    }
                    (id, true)
                }
                Err(e) => {
                    record.status = RunStatus::Failed;
                    record.finished_at = Some(Utc::now());
                    record.error = Some(format!("Failed to create session: {}", e));
                    self.storage.update_last_run(&record).await;
                    self.update_job_after_run(&job, started_at, &my_workspace).await;
                    return;
                }
            }
        } else if let Some(delivery) = &job.delivery {
            // Discord/Feishu: Try to reuse the user's existing session
            if let Some(existing_id) = self.find_existing_session(delivery).await {
                println!(
                    "[Cron] Reusing existing session '{}' for job '{}'",
                    existing_id, job.name
                );
                (existing_id, false)
            } else {
                // No existing session — create a new one and store it
                match self.create_opencode_session(port, None).await {
                    Ok(id) => {
                        println!(
                            "[Cron] Created new session '{}' for job '{}' (no existing session found)",
                            id, job.name
                        );
                        self.store_session(delivery, &id).await;
                        (id, true)
                    }
                    Err(e) => {
                        record.status = RunStatus::Failed;
                        record.finished_at = Some(Utc::now());
                        record.error = Some(format!("Failed to create session: {}", e));
                        self.storage.update_last_run(&record).await;
                        self.update_job_after_run(&job, started_at, &my_workspace).await;
                        return;
                    }
                }
            }
        } else {
            // No delivery configured — always create a fresh session
            match self.create_opencode_session(port, None).await {
                Ok(id) => (id, true),
                Err(e) => {
                    record.status = RunStatus::Failed;
                    record.finished_at = Some(Utc::now());
                    record.error = Some(format!("Failed to create session: {}", e));
                    self.storage.update_last_run(&record).await;
                    self.update_job_after_run(&job, started_at, &my_workspace).await;
                    return;
                }
            }
        };
        record.session_id = Some(session_id.clone());

        // Parse model override
        let model_param = job
            .payload
            .model
            .as_ref()
            .and_then(|m| crate::commands::gateway::parse_model_preference(m));

        // Store model preference in SessionMapping for UI consistency
        // This ensures the chat panel displays the correct model for cron-initiated sessions
        if let Some(model_str) = &job.payload.model {
            let sm_guard = self.session_mapping.read().await;
            if let Some(mapping) = sm_guard.as_ref() {
                // Determine which session key to use for storing model preference
                let key_for_model: Option<String> = if let Some(key) = &email_session_key {
                    // Email delivery: use the unique email thread key
                    Some(key.clone())
                } else if let Some(delivery) = &job.delivery {
                    // Discord/Feishu: use the delivery target key
                    Self::delivery_to_session_key(delivery)
                } else {
                    // No delivery: no persistent key to store preference
                    None
                };

                if let Some(key) = key_for_model {
                    mapping.set_model(key.clone(), model_str.clone()).await;
                    println!(
                        "[Cron] Stored model preference '{}' for session key '{}'",
                        model_str, key
                    );
                }
            }
        }

        // Resolve timeout (user-configured or default, clamped to 30-900 range)
        let timeout_secs = job
            .payload
            .timeout_seconds
            .unwrap_or(super::types::DEFAULT_TIMEOUT_SECONDS)
            .max(30)
            .min(900);

        // Check before sending to OpenCode (workspace may have changed)
        check_generation!();

        // Step 2: Send message to OpenCode
        let response = match self
            .send_to_opencode(port, &session_id, &job.payload.message, model_param.clone(), timeout_secs)
            .await
        {
            Ok(text) => text,
            Err(e) => {
                // Fail immediately without retry. Previous retry logic was too aggressive:
                // it created a new session on ANY error (including API key errors,
                // model config issues, etc.), which just creates unusable sessions.
                // If OpenCode restarts and sessions are lost, user should manually
                // trigger the job or restart the app to reinitialize.
                record.status = RunStatus::Failed;
                record.finished_at = Some(Utc::now());
                record.error = Some(format!("Failed to send message: {}", e));
                self.storage.update_last_run(&record).await;
                self.update_job_after_run(&job, started_at, &my_workspace).await;
                return;
            }
        };

        // Truncate response for summary (max 500 characters, safe for multi-byte UTF-8)
        let summary = if response.chars().count() > 500 {
            let truncated: String = response.chars().take(497).collect();
            format!("{}...", truncated)
        } else {
            response.clone()
        };
        record.response_summary = Some(summary);

        // Check before delivery (workspace may have changed)
        check_generation!();

        // Step 3: Deliver results if configured
        let mut delivery_failed = false;
        if let Some(delivery) = &job.delivery {
            if delivery.mode == DeliveryMode::Announce {
                let delivery_mgr = self.delivery.read().await;
                if let Some(mgr) = delivery_mgr.as_ref() {
                    // Format the delivery message with job context
                    let delivery_message = format!(
                        "[Cron: {}]\n\n{}",
                        job.name, response
                    );

                    match mgr
                        .send_notification(&delivery.channel, &delivery.to, &delivery_message)
                        .await
                    {
                        Ok(outgoing_message_id) => {
                            record.delivery_status = Some("delivered".to_string());
                            println!(
                                "[Cron] Delivered results for job '{}' via {:?}",
                                job.name, delivery.channel
                            );

                            // For email delivery: register the outgoing Message-ID
                            // and subject in SessionMapping so user replies resolve
                            // to the same OpenCode session (conversation continuity).
                            if let (Some(msg_id), Some(session_key)) =
                                (outgoing_message_id, &email_session_key)
                            {
                                let sm_guard = self.session_mapping.read().await;
                                if let Some(mapping) = sm_guard.as_ref() {
                                    // Register message-id -> session_key
                                    mapping
                                        .set_email_message_session(
                                            msg_id.clone(),
                                            session_key.clone(),
                                        )
                                        .await;
                                    // Register subject -> session_key for fallback matching
                                    let subject = crate::commands::gateway::email::normalize_subject(
                                        "[TeamClaw] Cron Job Notification",
                                    );
                                    mapping
                                        .set_email_subject_session(
                                            subject.clone(),
                                            session_key.clone(),
                                        )
                                        .await;
                                    println!(
                                        "[Cron] Registered email session: msg_id='{}', subject='{}', session_key='{}'",
                                        msg_id, subject, session_key
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            let err_msg = format!("Delivery failed: {}", e);
                            println!("[Cron] {}", err_msg);
                            record.delivery_status = Some(err_msg.clone());
                            delivery_failed = true;
                            if !delivery.best_effort {
                                record.status = RunStatus::Failed;
                                record.finished_at = Some(Utc::now());
                                record.error = Some(err_msg);
                                self.storage.update_last_run(&record).await;
                                self.update_job_after_run(&job, started_at, &my_workspace).await;
                                return;
                            }
                        }
                    }
                } else {
                    record.delivery_status =
                        Some("skipped (delivery manager not available)".to_string());
                    delivery_failed = true;
                }
            }
        }

        // Mark as success
        record.status = RunStatus::Success;
        record.finished_at = Some(Utc::now());
        self.storage.update_last_run(&record).await;

        // Check before updating job state (workspace may have changed)
        check_generation!();

        // Update job timestamps
        self.update_job_after_run(&job, started_at, &my_workspace).await;

        // Handle delete_after_run for one-time jobs
        // Do NOT delete if delivery failed — user should see the result and retry
        if job.delete_after_run && job.schedule.kind == ScheduleKind::At && !delivery_failed {
            println!(
                "[Cron] Deleting one-time job '{}' after fully successful run",
                job.name
            );
            let _ = self.storage.remove_job(&job.id).await;
        } else if delivery_failed && job.delete_after_run {
            println!(
                "[Cron] Keeping one-time job '{}' because delivery failed (can retry)",
                job.name
            );
        }

        // Wait briefly for OpenCode to flush any pending file writes before worktree cleanup
        if wt_guard.path.is_some() {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }

        println!("[Cron] Job '{}' completed successfully", job.name);
    }

    /// Update job timestamps after a run.
    /// Note: `next_run_at` is already set by `tick()` before spawning the execution,
    /// so here we only update `last_run_at` to reflect the actual execution time.
    async fn update_job_after_run(&self, job: &CronJob, last_run: DateTime<Utc>, expected_workspace: &str) {
        // Verify we're still in the same workspace before updating
        let current_workspace = self.storage.get_workspace_path().await;
        if current_workspace.as_deref() != Some(expected_workspace) {
            println!(
                "[Cron] Skip update_job_after_run for job '{}': workspace changed (expected '{}', now '{:?}')",
                job.name, expected_workspace, current_workspace
            );
            return;
        }

        // Only update last_run_at; don't overwrite next_run_at which was already set by tick()
        {
            let mut data = self.storage.data_mut().await;
            if let Some(j) = data.jobs.iter_mut().find(|j| j.id == job.id) {
                j.last_run_at = Some(last_run);
                j.updated_at = Utc::now();
            }
        }
        self.storage.persist().await;
    }

    /// Compute the next run time for a job
    pub fn compute_next_run(
        &self,
        job: &CronJob,
        after: Option<DateTime<Utc>>,
    ) -> Option<DateTime<Utc>> {
        let after = after.unwrap_or_else(Utc::now);

        match job.schedule.kind {
            ScheduleKind::At => {
                // One-time: parse the ISO 8601 timestamp
                if let Some(at_str) = &job.schedule.at {
                    if let Ok(at) = DateTime::parse_from_rfc3339(at_str) {
                        let at_utc = at.with_timezone(&Utc);
                        if at_utc > after {
                            return Some(at_utc);
                        }
                    }
                }
                None // Already past or invalid
            }
            ScheduleKind::Every => {
                // Interval: add every_ms to the last run (or now if first run)
                if let Some(ms) = job.schedule.every_ms {
                    Some(after + chrono::Duration::milliseconds(ms as i64))
                } else {
                    None
                }
            }
            ScheduleKind::Cron => {
                // Cron expression: find the next occurrence
                if let Some(expr) = &job.schedule.expr {
                    // The `cron` crate expects 7-field format (sec min hour dayofmonth month dayofweek year)
                    // Convert 5-field to 7-field by adding seconds(0) and year(*)
                    let full_expr = format!("0 {} *", expr);
                    match CronScheduleParser::from_str(&full_expr) {
                        Ok(schedule) => {
                            // Get the next occurrence after the given time
                            schedule.after(&after).next()
                        }
                        Err(e) => {
                            eprintln!(
                                "[Cron] Invalid cron expression '{}': {}",
                                expr, e
                            );
                            None
                        }
                    }
                } else {
                    None
                }
            }
        }
    }

    // ==================== OpenCode API Helpers ====================

    /// Check if an OpenCode session is archived.
    /// Returns true if archived, false if active, false on error (fail-open).
    async fn is_session_archived(&self, port: u16, session_id: &str) -> bool {
        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/session/{}", port, session_id);

        match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => {
                if let Ok(body) = response.json::<serde_json::Value>().await {
                    // Session is archived if time.archived field exists
                    body["time"]["archived"].as_i64().is_some()
                } else {
                    false
                }
            }
            _ => false, // On error, assume session is active (fail-open)
        }
    }

    /// Create a new OpenCode session
    async fn create_opencode_session(&self, port: u16, directory: Option<&str>) -> Result<String, String> {
        let client = reqwest::Client::new();
        let mut url = format!("http://127.0.0.1:{}/session", port);
        if let Some(dir) = directory {
            url = format!("{}?directory={}", url, urlencoding::encode(dir));
        }
        println!("[Cron] Creating OpenCode session at: {}", url);

        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .body("{}")
            .send()
            .await
            .map_err(|e| format!("Failed to create session: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Failed to create session: HTTP {}",
                response.status()
            ));
        }

        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        body["id"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "No session ID in response".to_string())
    }

    /// Send a message to OpenCode and wait for the response.
    ///
    /// Uses `tokio::time::timeout` to prevent indefinite blocking when the AI
    /// enters an agentic loop. On timeout, aborts the session and fetches
    /// whatever content was generated so far.
    ///
    /// Response extraction strategy:
    /// - **Normal**: parse the POST response (a single Message JSON) and extract
    ///   all `type: "text"` parts. This is the complete response for this request.
    /// - **Timeout**: abort, then GET `/session/{id}/message` and extract text
    ///   from the **last** assistant message only.
    async fn send_to_opencode(
        &self,
        port: u16,
        session_id: &str,
        content: &str,
        model: Option<(String, String)>,
        timeout_secs: u64,
    ) -> Result<String, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs + 60))
            .build()
            .map_err(|e| format!("Failed to create client: {}", e))?;

        let url = format!(
            "http://127.0.0.1:{}/session/{}/message",
            port, session_id
        );
        println!(
            "[Cron] Sending to OpenCode: {} content length: {} (timeout: {}s)",
            url,
            content.len(),
            timeout_secs
        );

        let mut body = serde_json::json!({
            "parts": [{
                "type": "text",
                "text": content
            }]
        });

        if let Some((provider_id, model_id)) = &model {
            body["model"] = serde_json::json!({
                "providerID": provider_id,
                "modelID": model_id
            });
            println!("[Cron] Using model override: {}/{}", provider_id, model_id);
        }

        let post_future = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send();

        match tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            post_future,
        )
        .await
        {
            Ok(Ok(response)) => {
                // POST completed within timeout — extract text from the returned Message
                let status = response.status();
                if !status.is_success() {
                    let error_body = response.text().await.unwrap_or_default();
                    return Err(format!("HTTP {} - {}", status, error_body));
                }

                let response_text = response
                    .text()
                    .await
                    .map_err(|e| format!("Failed to read response: {}", e))?;

                if response_text.is_empty() {
                    return Err("Empty response from OpenCode".to_string());
                }

                let response_json: serde_json::Value =
                    serde_json::from_str(&response_text)
                        .map_err(|e| format!("Failed to parse response: {}", e))?;

                // Check for error in the response
                if let Some(error) = response_json["info"]["error"].as_object() {
                    let error_name = error
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("UnknownError");
                    let error_message = error
                        .get("data")
                        .and_then(|d| d.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("Unknown error occurred");
                    return Err(format!("{}: {}", error_name, error_message));
                }

                // Extract all text parts from the response Message
                let text = Self::extract_text_parts(&response_json);
                println!(
                    "[Cron] POST completed, extracted {} chars from response",
                    text.len()
                );

                if text.is_empty() {
                    return Err("No text content in AI response".to_string());
                }
                Ok(text)
            }
            Ok(Err(e)) => Err(format!("Failed to send message: {}", e)),
            Err(_) => {
                // Timeout — abort and salvage whatever was generated
                println!(
                    "[Cron] Timeout after {}s, aborting session '{}'...",
                    timeout_secs, session_id
                );
                Self::abort_session(&client, port, session_id).await;
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;

                // Fetch the last assistant message from session history
                let text = Self::fetch_last_assistant_text(&client, port, session_id).await;
                match text {
                    Some(t) if !t.is_empty() => {
                        println!(
                            "[Cron] Salvaged {} chars after timeout",
                            t.len()
                        );
                        Ok(format!(
                            "{}\n\n---\n⚠️ AI response was cut short after {}s timeout.",
                            t, timeout_secs
                        ))
                    }
                    _ => Err(format!(
                        "AI agent timed out after {}s and no response content was captured",
                        timeout_secs
                    )),
                }
            }
        }
    }

    /// Extract all `type: "text"` parts from a Message JSON object.
    fn extract_text_parts(message: &serde_json::Value) -> String {
        let mut texts: Vec<&str> = Vec::new();
        if let Some(parts) = message["parts"].as_array() {
            for part in parts {
                if part["type"].as_str() == Some("text") {
                    if let Some(t) = part["text"].as_str() {
                        let trimmed = t.trim();
                        if !trimmed.is_empty() {
                            texts.push(trimmed);
                        }
                    }
                }
            }
        }
        texts.join("\n\n")
    }

    /// Abort an OpenCode session. Non-fatal — logs errors but does not propagate.
    async fn abort_session(client: &reqwest::Client, port: u16, session_id: &str) {
        let url = format!(
            "http://127.0.0.1:{}/session/{}/abort",
            port, session_id
        );
        match client.post(&url).send().await {
            Ok(resp) => println!(
                "[Cron] Abort session '{}': HTTP {}",
                session_id,
                resp.status()
            ),
            Err(e) => println!(
                "[Cron] Failed to abort session '{}': {}",
                session_id, e
            ),
        }
    }

    /// After a timeout+abort, fetch the **last** assistant message from the
    /// session and extract its text. Only looks at the final assistant message,
    /// so it never leaks content from previous runs in reused sessions.
    async fn fetch_last_assistant_text(
        client: &reqwest::Client,
        port: u16,
        session_id: &str,
    ) -> Option<String> {
        let url = format!(
            "http://127.0.0.1:{}/session/{}/message",
            port, session_id
        );
        let response = client.get(&url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let body = response.text().await.ok()?;
        let messages: Vec<serde_json::Value> = serde_json::from_str(&body).ok()?;

        // Find the last assistant message and extract its text
        messages
            .iter()
            .rev()
            .find(|m| m["info"]["role"].as_str() == Some("assistant"))
            .map(Self::extract_text_parts)
            .filter(|t| !t.is_empty())
    }
}

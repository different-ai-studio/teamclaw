pub mod delivery;
pub mod scheduler;
pub mod storage;
pub mod types;

use crate::commands::opencode::OpenCodeState;
use delivery::DeliveryManager;
use scheduler::CronScheduler;
use storage::CronStorage;
use types::*;

use tauri::State;

/// Cron state managed by Tauri
pub struct CronState {
    pub storage: CronStorage,
    pub scheduler: CronScheduler,
    /// Whether the cron system has been initialized with a workspace path
    pub initialized: tokio::sync::Mutex<bool>,
}

impl Default for CronState {
    fn default() -> Self {
        let storage = CronStorage::new();
        let scheduler = CronScheduler::new(storage.clone());
        Self {
            storage,
            scheduler,
            initialized: tokio::sync::Mutex::new(false),
        }
    }
}

// ==================== Tauri Commands ====================

/// Initialize the cron system (called when workspace is ready)
#[tauri::command]
pub async fn cron_init(
    opencode_state: State<'_, OpenCodeState>,
    cron_state: State<'_, CronState>,
    gateway_state: State<'_, crate::commands::gateway::GatewayState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set.")?;

    let port = *opencode_state.port.lock().map_err(|e| e.to_string())?;

    // Step 1: Stop old scheduler first (if reinitializing).
    // CRITICAL: Must stop BEFORE init() to prevent old tick loop from reading
    // new workspace's jobs with old workspace's delivery/session configs.
    // With generation-based stopping, old loop exits on next tick (no sleep needed).
    {
        let mut init = cron_state.initialized.lock().await;
        if *init {
            println!("[Cron] Re-initializing for new workspace, stopping old scheduler...");
            cron_state.scheduler.stop().await;
        }
        *init = true;
    }

    // Step 2: Initialize storage with new workspace (loads jobs, clears old data)
    cron_state.storage.init(&workspace_path).await;

    // Step 3: Configure scheduler for new workspace
    cron_state.scheduler.set_port(port).await;

    let session_mapping = gateway_state.shared_session_mapping.clone();
    cron_state
        .scheduler
        .set_session_mapping(session_mapping)
        .await;

    let delivery_mgr = DeliveryManager::new(workspace_path.clone());
    cron_state.scheduler.set_delivery(delivery_mgr).await;

    // Step 4: Start the scheduler for the new workspace
    cron_state.scheduler.start().await;

    println!(
        "[Cron] System initialized for workspace: {}",
        workspace_path
    );
    Ok(())
}

/// List all cron jobs
#[tauri::command]
pub async fn cron_list_jobs(cron_state: State<'_, CronState>) -> Result<Vec<CronJob>, String> {
    Ok(cron_state.storage.list_jobs().await)
}

/// Add a new cron job
#[tauri::command]
pub async fn cron_add_job(
    request: CreateCronJobRequest,
    cron_state: State<'_, CronState>,
) -> Result<CronJob, String> {
    let now = chrono::Utc::now();
    let id = uuid::Uuid::new_v4().to_string();

    let mut job = CronJob {
        id: id.clone(),
        name: request.name,
        description: request.description,
        enabled: request.enabled,
        schedule: request.schedule,
        payload: request.payload,
        delivery: request.delivery,
        delete_after_run: request.delete_after_run,
        created_at: now,
        updated_at: now,
        last_run_at: None,
        next_run_at: None,
    };

    // Compute initial next_run_at
    let next = cron_state.scheduler.compute_next_run(&job, None);
    job.next_run_at = next;

    cron_state.storage.add_job(job.clone()).await;
    println!("[Cron] Job created: {} ({})", job.name, job.id);

    Ok(job)
}

/// Update an existing cron job
#[tauri::command]
pub async fn cron_update_job(
    request: UpdateCronJobRequest,
    cron_state: State<'_, CronState>,
) -> Result<CronJob, String> {
    let mut job = cron_state
        .storage
        .get_job(&request.id)
        .await
        .ok_or_else(|| format!("Job not found: {}", request.id))?;

    // Apply updates
    if let Some(name) = request.name {
        job.name = name;
    }
    if let Some(desc) = request.description {
        job.description = Some(desc);
    }
    if let Some(enabled) = request.enabled {
        job.enabled = enabled;
    }
    if let Some(schedule) = request.schedule {
        job.schedule = schedule;
        // Recompute next_run_at when schedule changes
        job.next_run_at = cron_state.scheduler.compute_next_run(&job, None);
    }
    if let Some(payload) = request.payload {
        job.payload = payload;
    }
    if let Some(delivery) = request.delivery {
        job.delivery = delivery;
    }
    if let Some(delete_after_run) = request.delete_after_run {
        job.delete_after_run = delete_after_run;
    }

    job.updated_at = chrono::Utc::now();

    cron_state.storage.update_job(job.clone()).await?;
    println!("[Cron] Job updated: {} ({})", job.name, job.id);

    Ok(job)
}

/// Remove a cron job
#[tauri::command]
pub async fn cron_remove_job(
    job_id: String,
    cron_state: State<'_, CronState>,
) -> Result<(), String> {
    cron_state.storage.remove_job(&job_id).await?;
    println!("[Cron] Job removed: {}", job_id);
    Ok(())
}

/// Toggle a cron job's enabled state
#[tauri::command]
pub async fn cron_toggle_enabled(
    job_id: String,
    enabled: bool,
    cron_state: State<'_, CronState>,
) -> Result<(), String> {
    cron_state.storage.toggle_enabled(&job_id, enabled).await?;

    // If re-enabling, recompute next_run_at
    if enabled {
        if let Some(job) = cron_state.storage.get_job(&job_id).await {
            let next = cron_state.scheduler.compute_next_run(&job, None);
            cron_state
                .storage
                .update_run_timestamps(&job_id, chrono::Utc::now(), next)
                .await;
        }
    }

    println!(
        "[Cron] Job {} {}",
        job_id,
        if enabled { "enabled" } else { "disabled" }
    );
    Ok(())
}

/// Run a cron job immediately (manual trigger)
#[tauri::command]
pub async fn cron_run_job(job_id: String, cron_state: State<'_, CronState>) -> Result<(), String> {
    let job = cron_state
        .storage
        .get_job(&job_id)
        .await
        .ok_or_else(|| format!("Job not found: {}", job_id))?;

    println!("[Cron] Manual run triggered for: {} ({})", job.name, job.id);

    let scheduler = cron_state.scheduler.clone();
    tokio::spawn(async move {
        scheduler.execute_job(job).await;
    });

    Ok(())
}

/// Get run history for a cron job
#[tauri::command]
pub async fn cron_get_runs(
    job_id: String,
    limit: Option<usize>,
    cron_state: State<'_, CronState>,
) -> Result<Vec<CronRunRecord>, String> {
    let limit = limit.unwrap_or(50);
    Ok(cron_state.storage.get_runs(&job_id, Some(limit)).await)
}

/// Get all session IDs created by cron jobs (used to filter cron sessions in UI)
#[tauri::command]
pub async fn cron_get_all_session_ids(
    cron_state: State<'_, CronState>,
) -> Result<Vec<String>, String> {
    Ok(cron_state.storage.get_all_session_ids().await)
}

/// Refresh delivery configs (no-op now — DeliveryManager reads config on demand)
#[tauri::command]
pub async fn cron_refresh_delivery(
    _opencode_state: State<'_, OpenCodeState>,
    _cron_state: State<'_, CronState>,
) -> Result<(), String> {
    // DeliveryManager now reads teamclaw.json on each send, so no explicit refresh needed.
    println!("[Cron] Delivery config refresh requested (no-op, config is read on demand)");
    Ok(())
}

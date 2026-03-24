use super::db::{
    FeedbackSummary, LeaderboardStats, MessageFeedback, SessionReport, SkillFeedbackStats,
    TelemetryDb,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tauri_plugin_aptabase::EventTracker;
use tokio::sync::Mutex;

/// Managed state wrapper for TelemetryDb.
pub struct TelemetryState {
    pub db: Arc<Mutex<Option<TelemetryDb>>>,
}

impl Default for TelemetryState {
    fn default() -> Self {
        Self {
            db: Arc::new(Mutex::new(None)),
        }
    }
}

/// Helper to get the db, initializing it if needed.
async fn get_db(state: &TelemetryState) -> Result<TelemetryDb, String> {
    let mut db_lock = state.db.lock().await;
    if let Some(ref db) = *db_lock {
        return Ok(db.clone());
    }

    // Initialize the database
    let home = dirs_next().ok_or("Failed to determine home directory")?;
    let db_path = home.join(".teamclaw").join("telemetry.db");
    let db = TelemetryDb::new(&db_path).await?;
    *db_lock = Some(db.clone());
    Ok(db)
}

fn dirs_next() -> Option<std::path::PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(std::path::PathBuf::from)
        .or_else(|| {
            #[cfg(target_os = "windows")]
            {
                std::env::var("USERPROFILE")
                    .ok()
                    .map(std::path::PathBuf::from)
            }
            #[cfg(not(target_os = "windows"))]
            {
                None
            }
        })
}

// ─── Tauri Commands ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn telemetry_get_consent(
    state: tauri::State<'_, TelemetryState>,
) -> Result<String, String> {
    let db = get_db(&state).await?;
    db.get_consent().await
}

#[tauri::command]
pub async fn telemetry_set_consent(
    state: tauri::State<'_, TelemetryState>,
    consent: String,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    db.set_consent(&consent).await
}

#[tauri::command]
pub async fn telemetry_set_feedback(
    state: tauri::State<'_, TelemetryState>,
    app_handle: tauri::AppHandle,
    session_id: String,
    message_id: String,
    rating: String,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    db.set_feedback(&session_id, &message_id, &rating).await?;

    // Track analytics event (consent-gated)
    let consent = db.get_consent().await.unwrap_or_default();
    if consent == "granted" {
        let _ = app_handle.track_event(
            "feedback_given",
            Some(json!({
                "rating": rating,
            })),
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn telemetry_get_feedbacks(
    state: tauri::State<'_, TelemetryState>,
    session_id: String,
) -> Result<Vec<MessageFeedback>, String> {
    let db = get_db(&state).await?;
    db.get_feedbacks(&session_id).await
}

#[tauri::command]
pub async fn telemetry_remove_feedback(
    state: tauri::State<'_, TelemetryState>,
    session_id: String,
    message_id: String,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    db.remove_feedback(&session_id, &message_id).await
}

#[tauri::command]
pub async fn telemetry_set_star_rating(
    state: tauri::State<'_, TelemetryState>,
    session_id: String,
    message_id: String,
    star_rating: i64,
) -> Result<(), String> {
    if !(1..=5).contains(&star_rating) {
        return Err("star_rating must be between 1 and 5".to_string());
    }
    let db = get_db(&state).await?;
    db.set_star_rating(&session_id, &message_id, star_rating)
        .await
}

#[tauri::command]
pub async fn telemetry_remove_star_rating(
    state: tauri::State<'_, TelemetryState>,
    session_id: String,
    message_id: String,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    db.remove_star_rating(&session_id, &message_id).await
}

#[tauri::command]
pub async fn telemetry_save_report(
    state: tauri::State<'_, TelemetryState>,
    app_handle: tauri::AppHandle,
    report: SessionReport,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    db.save_report(&report).await?;

    // Track analytics events (consent-gated)
    let consent = db.get_consent().await.unwrap_or_default();
    if consent == "granted" {
        let _ = app_handle.track_event(
            "session_created",
            Some(json!({
                "model_id": report.model_id.as_deref().unwrap_or("unknown"),
                "provider_id": report.provider_id.as_deref().unwrap_or("unknown"),
                "agent": report.agent.as_deref().unwrap_or("none"),
                "tokens_input": report.total_tokens_input,
                "tokens_output": report.total_tokens_output,
                "tokens_reasoning": report.total_tokens_reasoning,
                "cost": report.total_cost,
            })),
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn telemetry_track(
    state: tauri::State<'_, TelemetryState>,
    app_handle: tauri::AppHandle,
    event_name: String,
    props: Option<serde_json::Value>,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    let consent = db.get_consent().await.unwrap_or_default();
    if consent == "granted" {
        let _ = app_handle.track_event(&event_name, props);
    }
    Ok(())
}

#[tauri::command]
pub async fn telemetry_get_reports(
    state: tauri::State<'_, TelemetryState>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<SessionReport>, String> {
    let db = get_db(&state).await?;
    db.get_reports(limit.unwrap_or(50), offset.unwrap_or(0))
        .await
}

// ─── Team Feedback Export/Aggregate ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberFeedbackExport {
    pub member_id: String,
    pub member_name: String,
    pub exported_at: String,
    pub summary: FeedbackSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamFeedbackSummary {
    pub members: Vec<MemberFeedbackExport>,
    pub team_total_feedbacks: i64,
    pub team_positive_count: i64,
    pub team_negative_count: i64,
    pub team_average_star: f64,
    pub team_by_skill: HashMap<String, SkillFeedbackStats>,
}

/// Export the current user's feedback summary to teamclaw-team/_feedback/{nodeId}.json.
#[tauri::command]
pub async fn telemetry_export_team_feedback(
    state: tauri::State<'_, TelemetryState>,
    iroh_state: tauri::State<'_, crate::commands::p2p_state::IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    #[cfg(not(feature = "p2p"))]
    {
        let _ = (state, iroh_state, opencode_state);
        return Err("P2P team sync is not available on this build.".into());
    }

    #[cfg(feature = "p2p")]
    {
        let db = get_db(&state).await?;

        let guard = iroh_state.lock().await;
        let node = guard.as_ref().ok_or("P2P node not running")?;
        let node_id = crate::commands::team_p2p::get_node_id(node);
        let device_info = crate::commands::team_p2p::get_device_metadata();
        drop(guard);

        let workspace_path = opencode_state
            .workspace_path
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or("Workspace path not set")?;
        let team_dir = std::path::Path::new(&workspace_path).join("teamclaw-team");
        if !team_dir.exists() {
            return Ok(());
        }
        let feedback_dir = team_dir.join("_feedback");

        std::fs::create_dir_all(&feedback_dir)
            .map_err(|e| format!("Failed to create _feedback dir: {}", e))?;

        let summary = db.export_feedback_summary().await?;

        let member_name = device_info.hostname.clone();

        let export = MemberFeedbackExport {
            member_id: node_id.clone(),
            member_name: member_name.clone(),
            exported_at: chrono::Utc::now().to_rfc3339(),
            summary,
        };

        let json = serde_json::to_string_pretty(&export)
            .map_err(|e| format!("Failed to serialize feedback: {}", e))?;

        // Use memberName as filename (sanitize for safety)
        let safe_filename = member_name
            .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_")
            .chars()
            .take(200)
            .collect::<String>();
        let file_path = feedback_dir.join(format!("{}.json", safe_filename));
        std::fs::write(&file_path, json)
            .map_err(|e| format!("Failed to write feedback file: {}", e))?;

        Ok(())
    }
}

/// Read all member feedback JSONs from teamclaw-team/_feedback/ and return aggregated team summary.
#[tauri::command]
pub async fn telemetry_get_team_feedback_summary(
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<TeamFeedbackSummary, String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Workspace path not set")?;
    let feedback_dir = std::path::Path::new(&workspace_path)
        .join("teamclaw-team")
        .join("_feedback");

    let mut members: Vec<MemberFeedbackExport> = Vec::new();

    if feedback_dir.exists() {
        let entries = std::fs::read_dir(&feedback_dir)
            .map_err(|e| format!("Failed to read _feedback dir: {}", e))?;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "json") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(export) = serde_json::from_str::<MemberFeedbackExport>(&content) {
                        members.push(export);
                    }
                }
            }
        }
    }

    let mut team_total_feedbacks: i64 = 0;
    let mut team_positive: i64 = 0;
    let mut team_negative: i64 = 0;
    let mut team_star_sum: f64 = 0.0;
    let mut team_star_count: i64 = 0;
    let mut team_by_skill: HashMap<String, SkillFeedbackStats> = HashMap::new();

    for m in &members {
        team_total_feedbacks += m.summary.total_feedbacks;
        team_positive += m.summary.positive_count;
        team_negative += m.summary.negative_count;

        for (star, count) in &m.summary.star_distribution {
            if let Ok(s) = star.parse::<f64>() {
                team_star_sum += s * (*count as f64);
                team_star_count += count;
            }
        }

        for (skill, stats) in &m.summary.by_skill {
            let entry = team_by_skill
                .entry(skill.clone())
                .or_insert(SkillFeedbackStats {
                    sessions: 0,
                    positive: 0,
                    negative: 0,
                    avg_star: 0.0,
                });
            entry.sessions += stats.sessions;
            entry.positive += stats.positive;
            entry.negative += stats.negative;
        }
    }

    // Recompute per-skill avg_star from aggregated data
    for (_skill, stats) in &mut team_by_skill {
        let total = stats.positive + stats.negative;
        if total > 0 {
            stats.avg_star = (stats.positive as f64 / total as f64 * 5.0 * 100.0).round() / 100.0;
        }
    }

    let team_average_star = if team_star_count > 0 {
        (team_star_sum / team_star_count as f64 * 100.0).round() / 100.0
    } else {
        0.0
    };

    Ok(TeamFeedbackSummary {
        members,
        team_total_feedbacks,
        team_positive_count: team_positive,
        team_negative_count: team_negative,
        team_average_star,
        team_by_skill,
    })
}

// ─── Leaderboard Export/Aggregate ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberLeaderboardExport {
    pub member_id: String,
    pub member_name: String,
    pub exported_at: String,
    pub update_at: String,
    /// Workspace path -> stats mapping
    /// Each workspace has its own stats, aggregated when displaying leaderboard
    pub workspaces: std::collections::HashMap<String, LeaderboardStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamLeaderboard {
    pub members: Vec<MemberLeaderboardExport>,
}

/// Export the current user's leaderboard stats to teamclaw-team/.leaderboard/{memberName}.json.
/// Reads from .teamclaw/stats.json and organizes by workspace.
#[tauri::command]
pub async fn telemetry_export_leaderboard(
    state: tauri::State<'_, TelemetryState>,
    iroh_state: tauri::State<'_, crate::commands::p2p_state::IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    #[cfg(not(feature = "p2p"))]
    let _ = (state, iroh_state, opencode_state);

    #[cfg(not(feature = "p2p"))]
    return Err("P2P team sync is not available on this build.".into());

    #[cfg(feature = "p2p")]
    {
        let _db = get_db(&state).await?;

        let guard = iroh_state.lock().await;
        let node = guard.as_ref().ok_or("P2P node not running")?;
        let node_id = crate::commands::team_p2p::get_node_id(node);
        let device_info = crate::commands::team_p2p::get_device_metadata();
        drop(guard);

        let workspace_path = opencode_state
            .workspace_path
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or("Workspace path not set")?;
        let team_dir = std::path::Path::new(&workspace_path).join("teamclaw-team");
        if !team_dir.exists() {
            return Ok(());
        }
        let leaderboard_dir = team_dir.join(".leaderboard");

        std::fs::create_dir_all(&leaderboard_dir)
            .map_err(|e| format!("Failed to create .leaderboard dir: {}", e))?;

        // Read local stats from current workspace's .teamclaw/stats.json
        let stats_path = std::path::Path::new(&workspace_path)
            .join(".teamclaw")
            .join("stats.json");
        let local_stats = if stats_path.exists() {
            let content = std::fs::read_to_string(&stats_path)
                .map_err(|e| format!("Failed to read .teamclaw/stats.json: {}", e))?;
            serde_json::from_str::<crate::commands::local_stats::LocalStats>(&content)
                .map_err(|e| format!("Failed to parse .teamclaw/stats.json: {}", e))?
        } else {
            // If stats.json doesn't exist, use default
            crate::commands::local_stats::LocalStats::default()
        };

        // Convert LocalStats to LeaderboardStats
        let workspace_stats = LeaderboardStats {
            total_feedbacks: local_stats.feedback_count,
            positive_count: local_stats.positive_count,
            negative_count: local_stats.negative_count,
            total_tokens: local_stats.total_tokens,
            total_cost: local_stats.total_cost,
            session_count: local_stats.sessions.total,
        };

        let member_name = device_info.hostname.clone();
        let safe_filename = member_name
            .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_")
            .chars()
            .take(200)
            .collect::<String>();
        let file_path = leaderboard_dir.join(format!("{}.json", safe_filename));

        // Read existing leaderboard file or create new
        let mut workspaces = if file_path.exists() {
            let content = std::fs::read_to_string(&file_path)
                .map_err(|e| format!("Failed to read existing leaderboard: {}", e))?;
            let existing: MemberLeaderboardExport = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse existing leaderboard: {}", e))?;
            existing.workspaces
        } else {
            std::collections::HashMap::new()
        };

        // Update current workspace stats
        workspaces.insert(workspace_path.clone(), workspace_stats);

        let now = chrono::Utc::now().to_rfc3339();
        let export = MemberLeaderboardExport {
            member_id: node_id.clone(),
            member_name: member_name.clone(),
            exported_at: now.clone(),
            update_at: now,
            workspaces,
        };

        let json = serde_json::to_string_pretty(&export)
            .map_err(|e| format!("Failed to serialize leaderboard: {}", e))?;

        std::fs::write(&file_path, json)
            .map_err(|e| format!("Failed to write leaderboard file: {}", e))?;

        Ok(())
    }
}

/// Aggregate stats from all workspaces for a member
fn aggregate_workspace_stats(
    workspaces: &std::collections::HashMap<String, LeaderboardStats>,
) -> LeaderboardStats {
    let mut total = LeaderboardStats {
        total_feedbacks: 0,
        positive_count: 0,
        negative_count: 0,
        total_tokens: 0,
        total_cost: 0.0,
        session_count: 0,
    };

    for stats in workspaces.values() {
        total.total_feedbacks += stats.total_feedbacks;
        total.positive_count += stats.positive_count;
        total.negative_count += stats.negative_count;
        total.total_tokens += stats.total_tokens;
        total.total_cost += stats.total_cost;
        total.session_count += stats.session_count;
    }

    total
}

/// Read all member leaderboard JSONs from teamclaw-team/.leaderboard/ and return team leaderboard.
/// Aggregates stats from all workspaces for each member.
#[tauri::command]
pub async fn telemetry_get_team_leaderboard(
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<TeamLeaderboard, String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Workspace path not set")?;
    let leaderboard_dir = std::path::Path::new(&workspace_path)
        .join("teamclaw-team")
        .join(".leaderboard");

    let mut members: Vec<MemberLeaderboardExport> = Vec::new();

    if leaderboard_dir.exists() {
        let entries = std::fs::read_dir(&leaderboard_dir)
            .map_err(|e| format!("Failed to read .leaderboard dir: {}", e))?;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "json") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(export) = serde_json::from_str::<MemberLeaderboardExport>(&content) {
                        members.push(export);
                    }
                }
            }
        }
    }

    Ok(TeamLeaderboard { members })
}

/// Get aggregated stats for a specific member across all workspaces
#[tauri::command]
pub async fn telemetry_get_member_aggregated_stats(
    member_name: String,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<LeaderboardStats, String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Workspace path not set")?;
    let leaderboard_dir = std::path::Path::new(&workspace_path)
        .join("teamclaw-team")
        .join(".leaderboard");

    let safe_filename = member_name
        .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_")
        .chars()
        .take(200)
        .collect::<String>();
    let file_path = leaderboard_dir.join(format!("{}.json", safe_filename));

    if !file_path.exists() {
        return Ok(LeaderboardStats {
            total_feedbacks: 0,
            positive_count: 0,
            negative_count: 0,
            total_tokens: 0,
            total_cost: 0.0,
            session_count: 0,
        });
    }

    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read leaderboard file: {}", e))?;
    let export: MemberLeaderboardExport = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse leaderboard file: {}", e))?;

    Ok(aggregate_workspace_stats(&export.workspaces))
}

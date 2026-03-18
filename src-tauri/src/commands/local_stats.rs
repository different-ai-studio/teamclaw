use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ─── Data types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStats {
    pub version: String,
    pub task_completed: i64,
    pub total_tokens: i64,
    pub total_cost: f64,
    pub feedback_count: i64,
    pub positive_count: i64,
    pub negative_count: i64,
    pub star_ratings: StarRatings,
    pub sessions: SessionStats,
    pub last_updated: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StarRatings {
    #[serde(rename = "1")]
    pub one: i64,
    #[serde(rename = "2")]
    pub two: i64,
    #[serde(rename = "3")]
    pub three: i64,
    #[serde(rename = "4")]
    pub four: i64,
    #[serde(rename = "5")]
    pub five: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub total: i64,
    pub with_feedback: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatsUpdate {
    pub task_completed: Option<i64>,
    pub total_tokens: Option<i64>,
    pub total_cost: Option<f64>,
    pub feedback_count: Option<i64>,
    pub positive_count: Option<i64>,
    pub negative_count: Option<i64>,
    pub star_rating: Option<i64>,
    pub sessions_total: Option<i64>,
    pub sessions_with_feedback: Option<i64>,
}

impl Default for LocalStats {
    fn default() -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            version: "1.0.0".to_string(),
            task_completed: 0,
            total_tokens: 0,
            total_cost: 0.0,
            feedback_count: 0,
            positive_count: 0,
            negative_count: 0,
            star_ratings: StarRatings::default(),
            sessions: SessionStats { total: 0, with_feedback: 0 },
            last_updated: now.clone(),
            created_at: now,
        }
    }
}

impl Default for StarRatings {
    fn default() -> Self {
        Self { one: 0, two: 0, three: 0, four: 0, five: 0 }
    }
}

// ─── Helper functions ────────────────────────────────────────────────────

fn get_stats_path(workspace_path: &str) -> PathBuf {
    PathBuf::from(workspace_path).join(".teamclaw").join("stats.json")
}

fn ensure_teamclaw_dir(workspace_path: &str) -> Result<(), String> {
    let teamclaw_dir = PathBuf::from(workspace_path).join(".teamclaw");
    std::fs::create_dir_all(&teamclaw_dir)
        .map_err(|e| format!("Failed to create .teamclaw directory: {}", e))
}

// ─── Tauri Commands ──────────────────────────────────────────────────────

/// Read local stats from .teamclaw/stats.json
/// If the file doesn't exist, create it with default values
#[tauri::command]
pub async fn read_local_stats(workspace_path: String) -> Result<LocalStats, String> {
    let stats_path = get_stats_path(&workspace_path);
    
    if !stats_path.exists() {
        // Create .teamclaw directory if it doesn't exist
        ensure_teamclaw_dir(&workspace_path)?;
        
        // Create default stats file
        let default_stats = LocalStats::default();
        let json = serde_json::to_string_pretty(&default_stats)
            .map_err(|e| format!("Failed to serialize default stats: {}", e))?;
        
        std::fs::write(&stats_path, json)
            .map_err(|e| format!("Failed to create stats.json: {}", e))?;
        
        println!("[LocalStats] Created new stats.json at: {:?}", stats_path);
        return Ok(default_stats);
    }
    
    let content = std::fs::read_to_string(&stats_path)
        .map_err(|e| format!("Failed to read stats.json: {}", e))?;
    
    let stats: LocalStats = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse stats.json: {}", e))?;
    
    Ok(stats)
}

/// Write local stats to .teamclaw/stats.json
#[tauri::command]
pub async fn write_local_stats(
    workspace_path: String,
    stats: LocalStats,
) -> Result<(), String> {
    ensure_teamclaw_dir(&workspace_path)?;
    
    let stats_path = get_stats_path(&workspace_path);
    let json = serde_json::to_string_pretty(&stats)
        .map_err(|e| format!("Failed to serialize stats: {}", e))?;
    
    std::fs::write(&stats_path, json)
        .map_err(|e| format!("Failed to write stats.json: {}", e))?;
    
    Ok(())
}

/// Update local stats incrementally
#[tauri::command]
pub async fn update_local_stats(
    workspace_path: String,
    updates: LocalStatsUpdate,
) -> Result<LocalStats, String> {
    let mut stats = read_local_stats(workspace_path.clone()).await?;
    
    // Apply incremental updates
    if let Some(task_completed) = updates.task_completed {
        stats.task_completed += task_completed;
    }
    if let Some(total_tokens) = updates.total_tokens {
        stats.total_tokens += total_tokens;
    }
    if let Some(total_cost) = updates.total_cost {
        stats.total_cost += total_cost;
    }
    if let Some(feedback_count) = updates.feedback_count {
        stats.feedback_count += feedback_count;
    }
    if let Some(positive_count) = updates.positive_count {
        stats.positive_count += positive_count;
    }
    if let Some(negative_count) = updates.negative_count {
        stats.negative_count += negative_count;
    }
    if let Some(star_rating) = updates.star_rating {
        match star_rating {
            1 => stats.star_ratings.one += 1,
            2 => stats.star_ratings.two += 1,
            3 => stats.star_ratings.three += 1,
            4 => stats.star_ratings.four += 1,
            5 => stats.star_ratings.five += 1,
            _ => return Err(format!("Invalid star rating: {}", star_rating)),
        }
    }
    if let Some(sessions_total) = updates.sessions_total {
        stats.sessions.total += sessions_total;
    }
    if let Some(sessions_with_feedback) = updates.sessions_with_feedback {
        stats.sessions.with_feedback += sessions_with_feedback;
    }
    
    // Update timestamp
    stats.last_updated = chrono::Utc::now().to_rfc3339();
    
    // Write back
    write_local_stats(workspace_path, stats.clone()).await?;
    
    Ok(stats)
}

/// Reset local stats (useful for testing or cleanup)
#[tauri::command]
pub async fn reset_local_stats(workspace_path: String) -> Result<LocalStats, String> {
    let stats = LocalStats::default();
    write_local_stats(workspace_path, stats.clone()).await?;
    Ok(stats)
}

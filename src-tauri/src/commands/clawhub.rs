use serde::{Deserialize, Serialize};
use std::io::Read as IoRead;
use std::path::PathBuf;

const DEFAULT_REGISTRY: &str = "https://clawhub.ai";
const REQUEST_TIMEOUT_SECS: u64 = 30;

// ─── API Response Types ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultEntry {
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ApiSearchResponse {
    results: Vec<SearchResultEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillVersionInfo {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    #[serde(default)]
    pub changelog: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillOwner {
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillModeration {
    #[serde(default)]
    pub is_suspicious: bool,
    #[serde(default)]
    pub is_malware_blocked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub slug: String,
    pub display_name: String,
    #[serde(default)]
    pub tags: serde_json::Value,
    #[serde(default)]
    pub stats: serde_json::Value,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiSkillResponse {
    skill: Option<SkillInfo>,
    latest_version: Option<SkillVersionInfo>,
    owner: Option<SkillOwner>,
    moderation: Option<SkillModeration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillListItem {
    pub slug: String,
    pub display_name: String,
    #[serde(default)]
    pub tags: serde_json::Value,
    #[serde(default)]
    pub stats: serde_json::Value,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<SkillVersionInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiSkillListResponse {
    items: Vec<SkillListItem>,
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct ApiResolveResponse {
    #[serde(rename = "match")]
    matched: Option<VersionRef>,
    latest_version: Option<VersionRef>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct VersionRef {
    version: String,
}

// ─── Frontend-facing types ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClawHubSkillDetail {
    pub skill: Option<SkillInfo>,
    pub latest_version: Option<SkillVersionInfo>,
    pub owner: Option<SkillOwner>,
    pub moderation: Option<SkillModeration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClawHubSearchResults {
    pub results: Vec<SearchResultEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClawHubExploreResults {
    pub items: Vec<SkillListItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClawHubUpdateInfo {
    pub slug: String,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub has_update: bool,
}

// ─── Lockfile ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockfileEntry {
    pub version: Option<String>,
    pub installed_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lockfile {
    pub version: u32,
    pub skills: std::collections::HashMap<String, LockfileEntry>,
}

impl Default for Lockfile {
    fn default() -> Self {
        Self {
            version: 1,
            skills: std::collections::HashMap::new(),
        }
    }
}

// ─── Origin file (per-skill) ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillOrigin {
    version: u32,
    registry: String,
    slug: String,
    installed_version: String,
    installed_at: u64,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn get_registry() -> String {
    std::env::var("CLAWHUB_REGISTRY").unwrap_or_else(|_| DEFAULT_REGISTRY.to_string())
}

fn build_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

fn lockfile_path(workspace_path: &str) -> PathBuf {
    PathBuf::from(workspace_path)
        .join(".clawhub")
        .join("lock.json")
}

fn read_lockfile(workspace_path: &str) -> Lockfile {
    let path = lockfile_path(workspace_path);
    if !path.exists() {
        let legacy = PathBuf::from(workspace_path)
            .join(".clawdhub")
            .join("lock.json");
        if legacy.exists() {
            if let Ok(raw) = std::fs::read_to_string(&legacy) {
                if let Ok(lock) = serde_json::from_str::<Lockfile>(&raw) {
                    return lock;
                }
            }
        }
        return Lockfile::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Lockfile::default(),
    }
}

fn write_lockfile(workspace_path: &str, lock: &Lockfile) -> Result<(), String> {
    let path = lockfile_path(workspace_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .clawhub dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(lock)
        .map_err(|e| format!("Failed to serialize lockfile: {}", e))?;
    std::fs::write(&path, format!("{}\n", json))
        .map_err(|e| format!("Failed to write lockfile: {}", e))
}

fn skills_dir(workspace_path: &str) -> PathBuf {
    PathBuf::from(workspace_path)
        .join(".opencode")
        .join("skills")
}

fn global_skills_dir(workspace_path: &str) -> PathBuf {
    // Under XDG isolation, "global" skills live inside the workspace:
    // <workspace>/.opencode/config/opencode/skills/
    PathBuf::from(workspace_path)
        .join(".opencode")
        .join("config")
        .join("opencode")
        .join("skills")
}

fn validate_slug(slug: &str) -> Result<(), String> {
    let trimmed = slug.trim();
    if trimmed.is_empty() {
        return Err("Slug is required".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(format!("Invalid slug: {}", trimmed));
    }
    Ok(())
}

/// Safely sanitize a relative path from a zip entry.
/// Returns None for entries that are directories or contain path traversal.
fn sanitize_zip_path(raw: &str) -> Option<String> {
    let normalized = raw.trim_start_matches("./").trim_start_matches('/');
    if normalized.is_empty() || normalized.ends_with('/') {
        return None;
    }
    if normalized.contains("..") || normalized.contains('\\') {
        return None;
    }
    Some(normalized.to_string())
}

fn extract_zip_to_dir(zip_bytes: &[u8], target_dir: &std::path::Path) -> Result<(), String> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open zip: {}", e))?;

    std::fs::create_dir_all(target_dir)
        .map_err(|e| format!("Failed to create target dir: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry {}: {}", i, e))?;

        let raw_name = file.name().to_string();
        let safe_path = match sanitize_zip_path(&raw_name) {
            Some(p) => p,
            None => continue,
        };

        let out_path = target_dir.join(&safe_path);

        // Extra safety: ensure the resolved path is inside target_dir
        let canonical_target = target_dir
            .canonicalize()
            .unwrap_or_else(|_| target_dir.to_path_buf());
        if let Ok(canonical_out) = out_path.canonicalize() {
            if !canonical_out.starts_with(&canonical_target) {
                eprintln!(
                    "[ClawHub] Skipping zip entry with path traversal: {}",
                    raw_name
                );
                continue;
            }
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create dir for {}: {}", safe_path, e))?;
        }

        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read zip entry {}: {}", safe_path, e))?;
        std::fs::write(&out_path, &buf)
            .map_err(|e| format!("Failed to write {}: {}", safe_path, e))?;
    }

    Ok(())
}

fn write_skill_origin(skill_folder: &std::path::Path, origin: &SkillOrigin) -> Result<(), String> {
    let origin_dir = skill_folder.join(".clawhub");
    std::fs::create_dir_all(&origin_dir)
        .map_err(|e| format!("Failed to create .clawhub origin dir: {}", e))?;
    let json = serde_json::to_string_pretty(origin)
        .map_err(|e| format!("Failed to serialize origin: {}", e))?;
    std::fs::write(origin_dir.join("origin.json"), format!("{}\n", json))
        .map_err(|e| format!("Failed to write origin.json: {}", e))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Write permission.skill entry for newly installed ClawHub skills.
fn set_skill_permission_ask(workspace_path: &str, slug: &str) {
    let config_path = PathBuf::from(workspace_path).join("opencode.json");
    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return,
    };

    let permission = json.as_object_mut().and_then(|o| {
        o.entry("permission")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
    });
    if let Some(perm_obj) = permission {
        let skill_perms = perm_obj
            .entry("skill")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(skill_obj) = skill_perms.as_object_mut() {
            if !skill_obj.contains_key(slug) {
                skill_obj.insert(slug.to_string(), serde_json::json!("ask"));
            }
        }
    }

    if let Ok(out) = serde_json::to_string_pretty(&json) {
        let _ = std::fs::write(&config_path, format!("{}\n", out));
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn clawhub_search(query: String, limit: Option<u32>) -> Result<ClawHubSearchResults, String> {
    let registry = get_registry();
    let client = build_client()?;

    let mut url = format!(
        "{}/api/v1/search?q={}",
        registry,
        urlencoding::encode(&query)
    );
    if let Some(l) = limit {
        url.push_str(&format!("&limit={}", l.min(200)));
    }

    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("Search request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Search failed with status {}", resp.status()));
    }

    let data: ApiSearchResponse = resp
        .json()
        .map_err(|e| format!("Failed to parse search response: {}", e))?;

    Ok(ClawHubSearchResults {
        results: data.results,
    })
}

#[tauri::command]
pub fn clawhub_explore(
    limit: Option<u32>,
    sort: Option<String>,
    cursor: Option<String>,
) -> Result<ClawHubExploreResults, String> {
    let registry = get_registry();
    let client = build_client()?;

    let bounded_limit = limit.unwrap_or(25).min(200).max(1);
    let mut url = format!("{}/api/v1/skills?limit={}", registry, bounded_limit);
    if let Some(ref s) = sort {
        if s != "updated" {
            url.push_str(&format!("&sort={}", urlencoding::encode(s)));
        }
    }
    if let Some(ref c) = cursor {
        url.push_str(&format!("&cursor={}", urlencoding::encode(c)));
    }

    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("Explore request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Explore failed with status {}", resp.status()));
    }

    let data: ApiSkillListResponse = resp
        .json()
        .map_err(|e| format!("Failed to parse explore response: {}", e))?;

    Ok(ClawHubExploreResults {
        items: data.items,
        next_cursor: data.next_cursor,
    })
}

#[tauri::command]
pub fn clawhub_get_skill(slug: String) -> Result<ClawHubSkillDetail, String> {
    validate_slug(&slug)?;
    let registry = get_registry();
    let client = build_client()?;

    let url = format!(
        "{}/api/v1/skills/{}",
        registry,
        urlencoding::encode(slug.trim())
    );

    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("Get skill request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Get skill failed with status {}", resp.status()));
    }

    let data: ApiSkillResponse = resp
        .json()
        .map_err(|e| format!("Failed to parse skill response: {}", e))?;

    Ok(ClawHubSkillDetail {
        skill: data.skill,
        latest_version: data.latest_version,
        owner: data.owner,
        moderation: data.moderation,
    })
}

#[tauri::command]
pub fn clawhub_install(
    workspace_path: Option<String>,
    slug: String,
    version: Option<String>,
    force: Option<bool>,
    is_global: Option<bool>,
) -> Result<String, String> {
    let slug = slug.trim().to_string();
    validate_slug(&slug)?;

    let registry = get_registry();
    let client = build_client()?;

    let is_global = is_global.unwrap_or(false);
    let ws_path = workspace_path
        .as_ref()
        .ok_or_else(|| "Workspace path required for skill installation".to_string())?;
    let skills = if is_global {
        global_skills_dir(ws_path)
    } else {
        skills_dir(ws_path)
    };

    std::fs::create_dir_all(&skills).map_err(|e| format!("Failed to create skills dir: {}", e))?;

    let target = skills.join(&slug);
    let force = force.unwrap_or(false);

    if target.exists() && !force {
        return Err(format!(
            "Already installed: {} (use force=true to overwrite)",
            target.display()
        ));
    }

    // Fetch skill metadata to check moderation
    let meta_url = format!("{}/api/v1/skills/{}", registry, urlencoding::encode(&slug));
    let meta_resp = client
        .get(&meta_url)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("Failed to fetch skill metadata: {}", e))?;

    if !meta_resp.status().is_success() {
        return Err(format!("Skill '{}' not found", slug));
    }

    let meta: ApiSkillResponse = meta_resp
        .json()
        .map_err(|e| format!("Failed to parse skill metadata: {}", e))?;

    if let Some(ref moderation) = meta.moderation {
        if moderation.is_malware_blocked {
            return Err(format!(
                "Skill '{}' is flagged as malware and cannot be installed",
                slug
            ));
        }
    }

    let resolved_version = version
        .or_else(|| meta.latest_version.as_ref().map(|v| v.version.clone()))
        .ok_or_else(|| format!("Could not resolve latest version for '{}'", slug))?;

    // Download zip
    let download_url = format!(
        "{}/api/v1/download?slug={}&version={}",
        registry,
        urlencoding::encode(&slug),
        urlencoding::encode(&resolved_version)
    );
    let zip_resp = client
        .get(&download_url)
        .send()
        .map_err(|e| format!("Download failed: {}", e))?;

    if !zip_resp.status().is_success() {
        return Err(format!("Download failed with status {}", zip_resp.status()));
    }

    let zip_bytes = zip_resp
        .bytes()
        .map_err(|e| format!("Failed to read download body: {}", e))?;

    // Remove existing if force
    if target.exists() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("Failed to remove existing skill dir: {}", e))?;
    }

    extract_zip_to_dir(&zip_bytes, &target)?;

    // Write origin
    write_skill_origin(
        &target,
        &SkillOrigin {
            version: 1,
            registry: registry.clone(),
            slug: slug.clone(),
            installed_version: resolved_version.clone(),
            installed_at: now_millis(),
        },
    )?;

    // Update lockfile (only for workspace installs)
    if !is_global {
        if let Some(ref ws_path) = workspace_path {
            let mut lock = read_lockfile(ws_path);
            lock.skills.insert(
                slug.clone(),
                LockfileEntry {
                    version: Some(resolved_version.clone()),
                    installed_at: now_millis(),
                },
            );
            write_lockfile(ws_path, &lock)?;

            // Auto-set permission to "ask" for new ClawHub skills
            set_skill_permission_ask(ws_path, &slug);
        }
    }
    // Note: Global skills don't use a lockfile or set permissions

    let location = if is_global { " globally" } else { "" };
    Ok(format!(
        "Installed {}@{}{} -> {}",
        slug,
        resolved_version,
        location,
        target.display()
    ))
}

#[tauri::command]
pub fn clawhub_uninstall(workspace_path: String, slug: String) -> Result<String, String> {
    let slug = slug.trim().to_string();
    validate_slug(&slug)?;

    let mut lock = read_lockfile(&workspace_path);
    if !lock.skills.contains_key(&slug) {
        return Err(format!("Skill '{}' is not installed via ClawHub", slug));
    }

    let target = skills_dir(&workspace_path).join(&slug);
    if target.exists() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("Failed to remove skill directory: {}", e))?;
    }

    lock.skills.remove(&slug);
    write_lockfile(&workspace_path, &lock)?;

    Ok(format!("Uninstalled {}", slug))
}

#[tauri::command]
pub fn clawhub_list_installed(workspace_path: String) -> Result<Lockfile, String> {
    Ok(read_lockfile(&workspace_path))
}

#[tauri::command]
pub fn clawhub_check_updates(workspace_path: String) -> Result<Vec<ClawHubUpdateInfo>, String> {
    let lock = read_lockfile(&workspace_path);
    if lock.skills.is_empty() {
        return Ok(vec![]);
    }

    let registry = get_registry();
    let client = build_client()?;
    let mut results = Vec::new();

    for (slug, entry) in &lock.skills {
        if slug.contains('/') || slug.contains('\\') || slug.contains("..") {
            continue;
        }

        let url = format!("{}/api/v1/skills/{}", registry, urlencoding::encode(slug));

        match client.get(&url).header("Accept", "application/json").send() {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(meta) = resp.json::<ApiSkillResponse>() {
                    let latest = meta.latest_version.as_ref().map(|v| v.version.clone());
                    let current = entry.version.clone();
                    let has_update = match (&current, &latest) {
                        (Some(c), Some(l)) => c != l,
                        (None, Some(_)) => true,
                        _ => false,
                    };
                    results.push(ClawHubUpdateInfo {
                        slug: slug.clone(),
                        current_version: current,
                        latest_version: latest,
                        has_update,
                    });
                }
            }
            _ => {
                results.push(ClawHubUpdateInfo {
                    slug: slug.clone(),
                    current_version: entry.version.clone(),
                    latest_version: None,
                    has_update: false,
                });
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub fn clawhub_update(
    workspace_path: String,
    slug: String,
    version: Option<String>,
) -> Result<String, String> {
    let slug = slug.trim().to_string();
    validate_slug(&slug)?;

    let lock = read_lockfile(&workspace_path);
    if !lock.skills.contains_key(&slug) {
        return Err(format!("Skill '{}' is not installed via ClawHub", slug));
    }

    // Re-install with force to update (workspace install)
    clawhub_install(Some(workspace_path), slug, version, Some(true), Some(false))
}

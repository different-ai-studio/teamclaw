//! Workspace roles + skills inventory for the settings UI.
//!
//! Scans the same on-disk layouts the frontend loaders use (`.teamclaw/skills`,
//! `.teamclaw/roles`, global skill dirs, etc.) and returns a single aggregated
//! payload so the app no longer needs direct filesystem access for listing.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::global_team_store::TEAM_LINK_NAME;
use super::workspace_control::WorkspaceControlError;

// ── DTOs (camelCase JSON for the frontend) ───────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleSkillLinkDto {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleRecordDto {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub role: String,
    pub when_to_use: String,
    pub working_style: String,
    pub role_skills: Vec<RoleSkillLinkDto>,
    pub file_path: String,
    pub raw_markdown: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkillDto {
    pub filename: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invocation_name: Option<String>,
    pub content: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub dir_path: String,
    pub linked_roles: Vec<String>,
    pub is_role_skill: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolesSkillsMetricsDto {
    pub roles_count: usize,
    pub skills_count: usize,
    pub linked_skills_count: usize,
    pub unlinked_skills_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolesSkillsStateDto {
    pub roles: Vec<RoleRecordDto>,
    pub skills: Vec<ManagedSkillDto>,
    pub role_usage_by_skill: HashMap<String, Vec<String>>,
    pub skill_names_by_role: HashMap<String, Vec<String>>,
    pub metrics: RolesSkillsMetricsDto,
}

// ── Scanner ──────────────────────────────────────────────────────────────────

const ROLE_ROOT: &str = ".teamclaw/roles";
const ROLE_SKILL_DIR: &str = "skills";
const INHERENT_SKILL_NAMES: &[&str] = &["create-role", "macos-control", "windows-control"];

struct RawSkill {
    filename: String,
    name: String,
    invocation_name: String,
    content: String,
    source: String,
    dir_path: String,
    is_role_skill: bool,
}

struct SkillDirSpec {
    path: PathBuf,
    source: &'static str,
}

fn io_err(e: std::io::Error) -> WorkspaceControlError {
    WorkspaceControlError::Io(e.to_string())
}

fn read_clawhub_slugs(workspace_path: &Path) -> HashSet<String> {
    for lock_name in [".clawhub/lock.json", ".clawdhub/lock.json"] {
        let lock_path = workspace_path.join(lock_name);
        let Ok(content) = std::fs::read_to_string(&lock_path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        if let Some(skills) = parsed.get("skills").and_then(|v| v.as_object()) {
            return skills.keys().cloned().collect();
        }
    }
    HashSet::new()
}

fn read_json_paths(workspace_path: &Path, config_rel: &str, key: &str) -> Vec<PathBuf> {
    let config_path = workspace_path.join(config_rel);
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return vec![];
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) else {
        return vec![];
    };
    let Some(home) = dirs::home_dir() else {
        return vec![];
    };
    let home_str = home.to_string_lossy();
    let home_trimmed = home_str.trim_end_matches('/');

    parsed
        .pointer(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|raw| {
                    let trimmed = raw.trim();
                    if trimmed == "~" {
                        home.clone()
                    } else if let Some(rest) = trimmed.strip_prefix("~/") {
                        PathBuf::from(format!("{home_trimmed}/{rest}"))
                    } else if trimmed.starts_with('/') {
                        PathBuf::from(trimmed)
                    } else {
                        workspace_path.join(trimmed.trim_start_matches("./"))
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn extract_skill_name(content: &str, fallback: &str) -> String {
    for line in content.lines() {
        if let Some(value) = line.strip_prefix("name:") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_owned();
            }
        }
    }
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix('#') {
            let title = rest.trim_start_matches('#').trim();
            if !title.is_empty() {
                return title.to_owned();
            }
        }
    }
    fallback.to_owned()
}

fn extract_skill_description(content: &str, fallback: &str) -> String {
    for line in content.lines() {
        if let Some(value) = line.strip_prefix("description:") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_owned();
            }
        }
    }
    extract_skill_name(content, fallback)
}

fn build_invocation_name(parent_dir: &Path, filename: &str) -> String {
    parent_dir
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|scope| *scope != "skills")
        .map(|scope| format!("{scope}/{filename}"))
        .unwrap_or_else(|| filename.to_owned())
}

fn try_load_skill_from_root(
    skill_root: &Path,
    filename: &str,
    parent_dir: &Path,
    source: &str,
) -> Result<Option<RawSkill>, WorkspaceControlError> {
    let skill_md = skill_root.join("SKILL.md");
    if !skill_md.is_file() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&skill_md).map_err(io_err)?;
    let name = extract_skill_name(&content, filename);
    Ok(Some(RawSkill {
        filename: filename.to_owned(),
        name: name.clone(),
        invocation_name: build_invocation_name(parent_dir, filename),
        content,
        source: source.to_owned(),
        dir_path: parent_dir.to_string_lossy().into_owned(),
        is_role_skill: false,
    }))
}

fn load_skills_from_dir(dir: &Path, source: &str) -> Result<Vec<RawSkill>, WorkspaceControlError> {
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut skills = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(io_err)? {
        let entry = entry.map_err(io_err)?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(filename) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if let Some(skill) = try_load_skill_from_root(&path, filename, dir, source)? {
            skills.push(skill);
            continue;
        }

        // Bundle layout: `<dir>/<bundle>/<skill>/SKILL.md` (matches desktop skill-loader).
        for nested in std::fs::read_dir(&path).map_err(io_err)? {
            let nested = nested.map_err(io_err)?;
            let nested_path = nested.path();
            if !nested_path.is_dir() {
                continue;
            }
            let Some(nested_name) = nested_path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if let Some(skill) =
                try_load_skill_from_root(&nested_path, nested_name, &path, source)?
            {
                skills.push(skill);
            }
        }
    }
    Ok(skills)
}

fn source_priority(source: &str) -> u8 {
    match source {
        "local" => 0,
        "claude" => 1,
        "clawhub" => 2,
        "shared" => 3,
        "team" => 4,
        "builtin" => 5,
        "plugin" => 6,
        "global-teamclaw" => 7,
        "global-claude" => 8,
        "global-agent" => 9,
        "global-opencode" => 10,
        "opencode" => 11,
        _ => 12,
    }
}

fn classify_teamclaw_skill(filename: &str, clawhub_slugs: &HashSet<String>) -> &'static str {
    if INHERENT_SKILL_NAMES.contains(&filename) {
        "builtin"
    } else if clawhub_slugs.contains(filename) {
        "clawhub"
    } else {
        "local"
    }
}

fn onboarded_team_id() -> Option<String> {
    super::DaemonConfig::load(&super::DaemonConfig::default_path())
        .ok()
        .and_then(|cfg| {
            cfg.team_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
}

fn remap_team_skill_path(workspace_path: &Path, path: PathBuf, team_id: &str) -> PathBuf {
    let link_root = workspace_path.join(TEAM_LINK_NAME);
    if path.is_dir() {
        return path;
    }
    if path.starts_with(&link_root) {
        let rel = path
            .strip_prefix(&link_root)
            .unwrap_or(path.as_path());
        return super::global_team_store::resolve_team_dir(workspace_path, team_id).join(rel);
    }
    path
}

fn collect_team_skill_paths(workspace_path: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut seen = HashSet::new();
    let team_id = onboarded_team_id();

    let mut push = |path: PathBuf| {
        let resolved = team_id
            .as_deref()
            .map(|id| remap_team_skill_path(workspace_path, path.clone(), id))
            .unwrap_or(path);
        if resolved.is_dir() && seen.insert(resolved.clone()) {
            paths.push(resolved);
        }
    };

    for extra in read_json_paths(workspace_path, "teamclaw.json", "/skills/paths") {
        push(extra);
    }
    for extra in read_json_paths(workspace_path, "opencode.json", "/skills/paths") {
        push(extra);
    }

    if let Some(team_id) = team_id.as_deref() {
        let default_team_skills =
            super::global_team_store::resolve_team_dir(workspace_path, team_id).join("skills");
        push(default_team_skills);
    } else {
        let default_team_skills = workspace_path.join(TEAM_LINK_NAME).join("skills");
        push(default_team_skills);
    }

    paths
}

fn load_all_skills(workspace_path: &Path, home: &Path) -> Result<Vec<RawSkill>, WorkspaceControlError> {
    let clawhub_slugs = read_clawhub_slugs(workspace_path);
    let home_str = home.to_string_lossy();
    let home_trimmed = home_str.trim_end_matches('/');

    let mut specs = vec![
        SkillDirSpec {
            path: workspace_path.join(".teamclaw/skills"),
            source: "local",
        },
        SkillDirSpec {
            path: workspace_path.join(".opencode/skills"),
            source: "opencode",
        },
        SkillDirSpec {
            path: workspace_path.join(".claude/skills"),
            source: "claude",
        },
        SkillDirSpec {
            path: workspace_path.join(".agents/skills"),
            source: "shared",
        },
        SkillDirSpec {
            path: PathBuf::from(format!("{home_trimmed}/.config/teamclaw/skills")),
            source: "global-teamclaw",
        },
        SkillDirSpec {
            path: PathBuf::from(format!("{home_trimmed}/.config/opencode/skills")),
            source: "global-opencode",
        },
        SkillDirSpec {
            path: PathBuf::from(format!("{home_trimmed}/.claude/skills")),
            source: "global-claude",
        },
        SkillDirSpec {
            path: PathBuf::from(format!("{home_trimmed}/.agents/skills")),
            source: "global-agent",
        },
    ];

    for extra in collect_team_skill_paths(workspace_path) {
        specs.push(SkillDirSpec {
            path: extra,
            source: "team",
        });
    }

    let mut merged: HashMap<String, RawSkill> = HashMap::new();
    for spec in specs {
        let mut batch = load_skills_from_dir(&spec.path, spec.source)?;
        for skill in batch.drain(..) {
            let source = if spec.path.ends_with(".teamclaw/skills") {
                classify_teamclaw_skill(&skill.filename, &clawhub_slugs).to_owned()
            } else {
                skill.source.clone()
            };
            let skill = RawSkill { source, ..skill };
            match merged.get(&skill.filename) {
                Some(existing) if source_priority(&existing.source) <= source_priority(&skill.source) => {}
                _ => {
                    merged.insert(skill.filename.clone(), skill);
                }
            }
        }
    }

    Ok(merged.into_values().collect())
}

fn get_section(body: &str, heading: &str) -> String {
    let marker = format!("## {heading}");
    let mut in_section = false;
    let mut section_lines = Vec::new();
    for line in body.lines() {
        if line.trim().eq_ignore_ascii_case(marker.trim()) {
            in_section = true;
            continue;
        }
        if in_section {
            if line.starts_with("## ") {
                break;
            }
            section_lines.push(line);
        }
    }
    section_lines.join("\n").trim().to_owned()
}

fn parse_role_skill_links(section: &str) -> Vec<RoleSkillLinkDto> {
    section
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if !trimmed.starts_with('-') {
                return None;
            }
            let rest = trimmed.trim_start_matches('-').trim();
            let (name_part, desc) = rest.split_once(':')?;
            let name = name_part.trim().trim_matches('`').trim();
            if name.is_empty() {
                return None;
            }
            Some(RoleSkillLinkDto {
                name: name.to_owned(),
                description: desc.trim().to_owned(),
            })
        })
        .collect()
}

fn parse_role_markdown(content: &str, slug: &str, file_path: &Path) -> RoleRecordDto {
    let normalized = content.replace("\r\n", "\n");
    let (frontmatter, body) = if let Some(stripped) = normalized.strip_prefix("---\n") {
        if let Some((fm, body)) = stripped.split_once("\n---") {
            (Some(fm), body.trim_start_matches('\n'))
        } else {
            (None, normalized.as_str())
        }
    } else {
        (None, normalized.as_str())
    };

    let mut name = slug.to_owned();
    let mut description = String::new();
    if let Some(fm) = frontmatter {
        for line in fm.lines() {
            if let Some((k, v)) = line.split_once(':') {
                match k.trim() {
                    "name" => name = v.trim().to_owned(),
                    "description" => description = v.trim().to_owned(),
                    _ => {}
                }
            }
        }
    }

    RoleRecordDto {
        slug: slug.to_owned(),
        name,
        description,
        body: body.to_owned(),
        role: get_section(body, "Role"),
        when_to_use: get_section(body, "When to use"),
        working_style: get_section(body, "Working style"),
        role_skills: parse_role_skill_links(&get_section(body, "Available role skills")),
        file_path: file_path.to_string_lossy().into_owned(),
        raw_markdown: normalized.trim().to_owned(),
    }
}

fn role_roots(workspace_path: &Path) -> Vec<PathBuf> {
    let mut roots = vec![workspace_path.join(ROLE_ROOT)];
    for extra in read_json_paths(workspace_path, ".teamclaw/roles/config.json", "/paths") {
        if !roots.contains(&extra) {
            roots.push(extra);
        }
    }
    roots
}

fn load_all_roles(workspace_path: &Path) -> Result<Vec<RoleRecordDto>, WorkspaceControlError> {
    let mut roles = Vec::new();
    let mut seen = HashSet::new();
    for root in role_roots(workspace_path) {
        if !root.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(&root).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(slug) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if slug == ROLE_SKILL_DIR || seen.contains(slug) {
                continue;
            }
            let role_md = path.join("ROLE.md");
            if !role_md.is_file() {
                continue;
            }
            let content = std::fs::read_to_string(&role_md).map_err(io_err)?;
            roles.push(parse_role_markdown(&content, slug, &role_md));
            seen.insert(slug.to_owned());
        }
    }
    roles.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(roles)
}

fn load_role_managed_skills(workspace_path: &Path) -> Result<Vec<RawSkill>, WorkspaceControlError> {
    let mut skills = Vec::new();
    let mut seen = HashSet::new();
    for root in role_roots(workspace_path) {
        let role_skill_root = root.join(ROLE_SKILL_DIR);
        if !role_skill_root.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(&role_skill_root).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(filename) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if seen.contains(filename) {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            let content = std::fs::read_to_string(&skill_md).map_err(io_err)?;
            seen.insert(filename.to_owned());
            skills.push(RawSkill {
                filename: filename.to_owned(),
                name: filename.to_owned(),
                invocation_name: filename.to_owned(),
                content,
                source: "local".to_owned(),
                dir_path: role_skill_root.to_string_lossy().into_owned(),
                is_role_skill: true,
            });
        }
    }
    Ok(skills)
}

/// Scan a workspace directory and build the aggregated roles/skills state.
pub fn scan_roles_skills_state(workspace_path: &Path) -> Result<RolesSkillsStateDto, WorkspaceControlError> {
    let home = dirs::home_dir().ok_or_else(|| {
        WorkspaceControlError::Io("home directory not found".to_owned())
    })?;

    let roles = load_all_roles(workspace_path)?;
    let normal_skills = load_all_skills(workspace_path, &home)?;
    let role_managed = load_role_managed_skills(workspace_path)?;

    let mut role_usage_by_skill: HashMap<String, Vec<String>> = HashMap::new();
    let mut skill_names_by_role: HashMap<String, Vec<String>> = HashMap::new();

    for role in &roles {
        let names: Vec<String> = role.role_skills.iter().map(|s| s.name.clone()).collect();
        skill_names_by_role.insert(role.slug.clone(), names.clone());
        for link in &role.role_skills {
            role_usage_by_skill
                .entry(link.name.clone())
                .or_default()
                .push(role.slug.clone());
        }
    }

    let mut by_key: HashMap<String, ManagedSkillDto> = HashMap::new();

    for skill in normal_skills {
        let key = format!("{}:{}", skill.dir_path, skill.filename);
        by_key.insert(
            key,
            ManagedSkillDto {
                filename: skill.filename.clone(),
                name: skill.name.clone(),
                invocation_name: Some(skill.invocation_name),
                content: skill.content.clone(),
                description: extract_skill_description(&skill.content, &skill.name),
                source: Some(skill.source),
                dir_path: skill.dir_path,
                linked_roles: role_usage_by_skill
                    .get(&skill.filename)
                    .cloned()
                    .unwrap_or_default(),
                is_role_skill: false,
            },
        );
    }

    for skill in role_managed {
        let key = format!("{}:{}", skill.dir_path, skill.filename);
        by_key.insert(
            key,
            ManagedSkillDto {
                filename: skill.filename.clone(),
                name: skill.name.clone(),
                invocation_name: Some(skill.invocation_name),
                content: skill.content.clone(),
                description: extract_skill_description(&skill.content, &skill.name),
                source: Some(skill.source),
                dir_path: skill.dir_path,
                linked_roles: role_usage_by_skill
                    .get(&skill.filename)
                    .cloned()
                    .unwrap_or_default(),
                is_role_skill: true,
            },
        );
    }

    let mut skills: Vec<ManagedSkillDto> = by_key.into_values().collect();
    skills.sort_by(|a, b| {
        a.is_role_skill
            .cmp(&b.is_role_skill)
            .then(a.filename.cmp(&b.filename))
    });

    let linked_skills_count = role_usage_by_skill
        .keys()
        .filter(|name| skills.iter().any(|s| s.filename == **name))
        .count();

    Ok(RolesSkillsStateDto {
        metrics: RolesSkillsMetricsDto {
            roles_count: roles.len(),
            skills_count: skills.len(),
            linked_skills_count,
            unlinked_skills_count: skills.len().saturating_sub(linked_skills_count),
        },
        roles,
        skills,
        role_usage_by_skill,
        skill_names_by_role,
    })
}

// ── Write API ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSkillRequest {
    pub content: String,
    #[serde(default)]
    pub skill_name: Option<String>,
    #[serde(default)]
    pub install_location: Option<String>,
    #[serde(default)]
    pub dir_path: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertRoleRequest {
    pub raw_markdown: String,
    #[serde(default)]
    pub target_file_path: Option<String>,
}

fn slugify(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

fn ensure_frontmatter(content: &str, slug: &str, display_name: &str) -> String {
    let trimmed = content.trim();
    if trimmed.starts_with("---") {
        return format!("{trimmed}\n");
    }
    let description = trimmed
        .lines()
        .take(3)
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect::<String>();
    format!(
        "---\nname: {slug}\ndescription: {description}\n---\n\n# {display_name}\n\n{trimmed}\n"
    )
}

/// Lexically resolve `.` / `..` components without touching the filesystem,
/// so we can confine caller-supplied paths even when the target doesn't exist
/// yet (`std::fs::canonicalize` requires the path to exist).
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// True when `candidate` equals or nests under `base` (compared lexically).
fn is_within(base: &Path, candidate: &Path) -> bool {
    normalize_lexical(candidate).starts_with(normalize_lexical(base))
}

/// Reject a single path segment (skill slug, dir name, role slug) that could
/// escape its parent directory via separators or `..`.
fn ensure_safe_segment(seg: &str) -> Result<(), WorkspaceControlError> {
    if seg.is_empty() || seg.contains('/') || seg.contains('\\') || seg == "." || seg == ".." {
        return Err(WorkspaceControlError::InvalidInput(format!(
            "unsafe path segment {seg:?}"
        )));
    }
    Ok(())
}

/// Resolve a caller-supplied path (absolute, or relative to the workspace) and
/// confine it to the workspace directory or the user's home. The daemon runs as
/// the local user and legitimately manages skill/role dirs under both roots;
/// anything outside (e.g. `/etc`, another user's home) is rejected.
fn confine_path(
    raw: &str,
    workspace_path: &Path,
    home: &Path,
) -> Result<PathBuf, WorkspaceControlError> {
    let raw_path = Path::new(raw);
    let abs = if raw_path.is_absolute() {
        raw_path.to_path_buf()
    } else {
        workspace_path.join(raw_path)
    };
    let normalized = normalize_lexical(&abs);
    if is_within(workspace_path, &normalized) || is_within(home, &normalized) {
        Ok(normalized)
    } else {
        Err(WorkspaceControlError::InvalidInput(format!(
            "path escapes workspace and home: {}",
            normalized.display()
        )))
    }
}

fn skills_dir_for_request(
    workspace_path: &Path,
    home: &Path,
    req: &UpsertSkillRequest,
) -> Result<PathBuf, WorkspaceControlError> {
    if let Some(dir) = req.dir_path.as_deref().filter(|d| !d.is_empty()) {
        return confine_path(dir, workspace_path, home);
    }
    if req.install_location.as_deref() == Some("global") {
        return Ok(home.join(".config/opencode/skills"));
    }
    Ok(workspace_path.join(".teamclaw/skills"))
}

pub fn upsert_skill(
    workspace_path: &Path,
    slug: &str,
    req: &UpsertSkillRequest,
) -> Result<ManagedSkillDto, WorkspaceControlError> {
    let home = dirs::home_dir().ok_or_else(|| {
        WorkspaceControlError::Io("home directory not found".to_owned())
    })?;
    let skills_dir = skills_dir_for_request(workspace_path, &home, req)?;
    std::fs::create_dir_all(&skills_dir).map_err(io_err)?;

    let dir_name = req
        .filename
        .as_deref()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            req.skill_name
                .as_deref()
                .map(slugify)
                .filter(|v| !v.is_empty())
        })
        .unwrap_or_else(|| slug.to_owned());
    // `dir_name` becomes a child directory of `skills_dir`; reject traversal.
    ensure_safe_segment(&dir_name)?;

    let display_name = req
        .skill_name
        .as_deref()
        .filter(|v| !v.is_empty())
        .unwrap_or(slug);

    let skill_dir = skills_dir.join(&dir_name);
    std::fs::create_dir_all(&skill_dir).map_err(io_err)?;
    let final_content = ensure_frontmatter(&req.content, &dir_name, display_name);
    std::fs::write(skill_dir.join("SKILL.md"), final_content.as_bytes()).map_err(io_err)?;

    let state = scan_roles_skills_state(workspace_path)?;
    state
        .skills
        .into_iter()
        .find(|skill| skill.filename == dir_name && skill.dir_path == skills_dir.to_string_lossy())
        .ok_or_else(|| {
            WorkspaceControlError::NotFound(format!("skill {dir_name} not found after write"))
        })
}

pub fn delete_skill(
    workspace_path: &Path,
    slug: &str,
    dir_path: Option<&str>,
) -> Result<(), WorkspaceControlError> {
    let home = dirs::home_dir().ok_or_else(|| {
        WorkspaceControlError::Io("home directory not found".to_owned())
    })?;
    // `slug` is the leaf skill directory; it must not contain separators/`..`.
    ensure_safe_segment(slug)?;
    let candidates: Vec<PathBuf> = if let Some(dir) = dir_path.filter(|d| !d.is_empty()) {
        vec![confine_path(dir, workspace_path, &home)?.join(slug)]
    } else {
        vec![
            workspace_path.join(".teamclaw/skills").join(slug),
            workspace_path.join(".opencode/skills").join(slug),
            workspace_path.join(".teamclaw/roles/skills").join(slug),
            home.join(".config/opencode/skills").join(slug),
        ]
    };

    for path in candidates {
        if path.is_dir() {
            std::fs::remove_dir_all(&path).map_err(io_err)?;
            return Ok(());
        }
    }
    Err(WorkspaceControlError::NotFound(format!("skill {slug} not found")))
}

pub fn upsert_role(
    workspace_path: &Path,
    slug: &str,
    req: &UpsertRoleRequest,
) -> Result<RoleRecordDto, WorkspaceControlError> {
    let home = dirs::home_dir()
        .ok_or_else(|| WorkspaceControlError::Io("home directory not found".to_owned()))?;
    let role_path = match req.target_file_path.as_deref().filter(|p| !p.is_empty()) {
        Some(target) => confine_path(target, workspace_path, &home)?,
        None => {
            ensure_safe_segment(slug)?;
            workspace_path.join(ROLE_ROOT).join(slug).join("ROLE.md")
        }
    };

    if let Some(parent) = role_path.parent() {
        std::fs::create_dir_all(parent).map_err(io_err)?;
    }
    let markdown = if req.raw_markdown.ends_with('\n') {
        req.raw_markdown.clone()
    } else {
        format!("{}\n", req.raw_markdown)
    };
    std::fs::write(&role_path, markdown.as_bytes()).map_err(io_err)?;
    let parsed_slug = role_path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or(slug);
    Ok(parse_role_markdown(&markdown, parsed_slug, &role_path))
}

pub fn delete_role(
    workspace_path: &Path,
    slug: &str,
    file_path: Option<&str>,
) -> Result<(), WorkspaceControlError> {
    let roots: Vec<PathBuf> = role_roots(workspace_path)
        .iter()
        .map(|r| normalize_lexical(r))
        .collect();

    if let Some(path) = file_path.filter(|p| !p.is_empty()) {
        // `delete_role` recursively removes the role directory (the parent of
        // ROLE.md). Confine that directory to a managed role root and require it
        // to be a strict child of the root — never the root itself or anything
        // outside it — so a crafted `filePath` can't delete arbitrary dirs.
        let role_path = normalize_lexical(Path::new(path));
        let role_dir = role_path.parent().ok_or_else(|| {
            WorkspaceControlError::InvalidInput("role file path has no parent".to_owned())
        })?;
        let confined = roots
            .iter()
            .any(|root| is_within(root, role_dir) && role_dir != root.as_path());
        if !confined {
            return Err(WorkspaceControlError::InvalidInput(format!(
                "role path outside managed role roots: {}",
                role_dir.display()
            )));
        }
        if role_dir.is_dir() {
            std::fs::remove_dir_all(role_dir).map_err(io_err)?;
            return Ok(());
        }
    }

    ensure_safe_segment(slug)?;
    for root in role_roots(workspace_path) {
        let role_dir = root.join(slug);
        if role_dir.is_dir() {
            std::fs::remove_dir_all(&role_dir).map_err(io_err)?;
            return Ok(());
        }
    }
    Err(WorkspaceControlError::NotFound(format!("role {slug} not found")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_empty_workspace_returns_empty_state() {
        let dir = tempfile::tempdir().unwrap();
        let state = scan_roles_skills_state(dir.path()).unwrap();
        assert!(state.roles.is_empty());
        assert!(state.skills.is_empty());
        assert_eq!(state.metrics.roles_count, 0);
    }

    #[test]
    fn scan_finds_nested_team_share_bundle_skills() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();

        let bundle_dir = ws.join(TEAM_LINK_NAME).join("skills/superpowers/brainstorming");
        std::fs::create_dir_all(&bundle_dir).unwrap();
        std::fs::write(
            bundle_dir.join("SKILL.md"),
            "---\nname: brainstorming\ndescription: Brainstorm first\n---\n\n# Brainstorming",
        )
        .unwrap();

        let state = scan_roles_skills_state(ws).unwrap();
        let team_skill = state
            .skills
            .iter()
            .find(|skill| skill.filename == "brainstorming")
            .expect("nested team bundle skill");
        assert_eq!(team_skill.invocation_name.as_deref(), Some("superpowers/brainstorming"));
        assert_eq!(team_skill.source.as_deref(), Some("team"));
    }

    #[test]
    fn scan_finds_team_share_skills_without_config_paths() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();

        let team_skill_dir = ws.join(TEAM_LINK_NAME).join("skills/shared-skill");
        std::fs::create_dir_all(&team_skill_dir).unwrap();
        std::fs::write(
            team_skill_dir.join("SKILL.md"),
            "---\nname: Shared Skill\ndescription: From team drive\n---\n\n# Shared",
        )
        .unwrap();

        let state = scan_roles_skills_state(ws).unwrap();
        let team_skill = state
            .skills
            .iter()
            .find(|skill| skill.filename == "shared-skill")
            .expect("team share skill");
        assert_eq!(team_skill.source.as_deref(), Some("team"));
    }

    #[test]
    fn scan_finds_role_and_skill() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();

        let skill_dir = ws.join(".teamclaw/skills/demo-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: Demo Skill\ndescription: A demo\n---\n\n# Demo",
        )
        .unwrap();

        let role_dir = ws.join(".teamclaw/roles/reviewer");
        std::fs::create_dir_all(&role_dir).unwrap();
        std::fs::write(
            role_dir.join("ROLE.md"),
            "---\nname: reviewer\ndescription: Code reviewer\n---\n\n## Role\nReview code.\n",
        )
        .unwrap();

        let state = scan_roles_skills_state(ws).unwrap();
        assert_eq!(state.roles.len(), 1);
        assert_eq!(state.roles[0].slug, "reviewer");
        assert_eq!(state.skills.len(), 1);
        assert_eq!(state.skills[0].filename, "demo-skill");
    }

    #[test]
    fn upsert_and_delete_skill_round_trip() {
        let ws = tempfile::tempdir().unwrap();
        let req = UpsertSkillRequest {
            content: "# Demo\n\nBody".to_owned(),
            skill_name: Some("Demo Skill".to_owned()),
            install_location: Some("workspace".to_owned()),
            dir_path: None,
            filename: None,
        };
        let saved = upsert_skill(ws.path(), "demo-skill", &req).unwrap();
        assert_eq!(saved.filename, "demo-skill");

        delete_skill(ws.path(), "demo-skill", None).unwrap();
        let state = scan_roles_skills_state(ws.path()).unwrap();
        assert!(state.skills.is_empty());
    }

    #[test]
    fn upsert_skill_rejects_dir_path_outside_workspace_and_home() {
        let ws = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let req = UpsertSkillRequest {
            content: "# Evil".to_owned(),
            skill_name: Some("Evil".to_owned()),
            install_location: None,
            dir_path: Some(outside.path().to_string_lossy().into_owned()),
            filename: Some("pwned".to_owned()),
        };
        let err = upsert_skill(ws.path(), "evil", &req).unwrap_err();
        assert!(matches!(err, WorkspaceControlError::InvalidInput(_)));
        assert!(!outside.path().join("pwned").exists());
    }

    #[test]
    fn upsert_skill_rejects_traversal_in_filename() {
        let ws = tempfile::tempdir().unwrap();
        let req = UpsertSkillRequest {
            content: "# Evil".to_owned(),
            skill_name: None,
            install_location: Some("workspace".to_owned()),
            dir_path: None,
            filename: Some("../../escape".to_owned()),
        };
        let err = upsert_skill(ws.path(), "evil", &req).unwrap_err();
        assert!(matches!(err, WorkspaceControlError::InvalidInput(_)));
    }

    #[test]
    fn delete_skill_rejects_traversal_slug() {
        let ws = tempfile::tempdir().unwrap();
        let err = delete_skill(ws.path(), "../../../etc", None).unwrap_err();
        assert!(matches!(err, WorkspaceControlError::InvalidInput(_)));
    }

    #[test]
    fn delete_role_rejects_file_path_outside_role_roots() {
        let ws = tempfile::tempdir().unwrap();
        // A victim directory that lives under the workspace but NOT under a
        // managed role root. delete_role must refuse to remove it.
        let victim = ws.path().join("important-data");
        std::fs::create_dir_all(victim.join("nested")).unwrap();
        let crafted = victim.join("nested/ROLE.md");
        let err = delete_role(ws.path(), "x", Some(&crafted.to_string_lossy())).unwrap_err();
        assert!(matches!(err, WorkspaceControlError::InvalidInput(_)));
        assert!(victim.is_dir(), "victim dir must survive a rejected delete");
    }

    #[test]
    fn delete_role_removes_managed_role_dir_via_file_path() {
        let ws = tempfile::tempdir().unwrap();
        let role_dir = ws.path().join(".teamclaw/roles/reviewer");
        std::fs::create_dir_all(&role_dir).unwrap();
        std::fs::write(role_dir.join("ROLE.md"), "---\nname: reviewer\n---\n").unwrap();
        let file_path = role_dir.join("ROLE.md");
        delete_role(ws.path(), "reviewer", Some(&file_path.to_string_lossy())).unwrap();
        assert!(!role_dir.exists());
    }
}

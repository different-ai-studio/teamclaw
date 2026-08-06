//! Team skills registry — desktop install/uninstall.
//!
//! Design: docs/architecture/team-skills-registry.md
//!
//! Deliberately thin. The package pipeline (zip extract with traversal
//! guarding, `.clawhub/origin.json`, the lockfile, the `permission.skill`
//! entry) already exists for ClawHub, so this reuses it wholesale rather than
//! growing a second one — the only genuinely new steps are talking to the
//! Cloud API instead of the public registry, and writing the structured
//! frontmatter back into SKILL.md.
//!
//! That writeback is the point of the whole feature: the agent reads the file
//! on disk, not Postgres. A registry full of tidy `when_not_to_use` fields is
//! worth nothing if what lands in `.teamclaw/skills/` is still one opaque
//! description blob.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use teamclaw_types::skill_frontmatter::{write_frontmatter, FrontmatterValue};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use super::clawhub::{
    build_client, extract_zip_to_dir, global_skills_dir, now_millis, read_lockfile,
    set_skill_permission_ask, skills_dir, validate_slug, write_lockfile, LockfileEntry,
    SOURCE_TEAM,
};

/// Order matters only for diff noise: a reinstall should not reshuffle the
/// file. `name` and `description` stay first and keep their meaning so any
/// reader that predates this feature still works.
const FRONTMATTER_KEY_ORDER: &[&str] = &[
    "name",
    "description",
    "owner",
    "category",
    "when_to_use",
    "when_not_to_use",
    "requires",
    "version",
    "source",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillVersionPayload {
    pub version: i64,
    pub content_hash: String,
    #[serde(default)]
    pub changelog: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub when_to_use: String,
    #[serde(default)]
    pub when_not_to_use: String,
    #[serde(default)]
    pub requires: Option<serde_json::Value>,
}

/// Everything the desktop needs to materialise one skill. The frontend already
/// has the registry row from `GET /v1/teams/:id/skills/:slug`, so it passes the
/// resolved fields down rather than making this command re-fetch them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillInstallRequest {
    pub workspace_path: Option<String>,
    pub slug: String,
    pub download_url: String,
    /// Bearer token for the Cloud API. Passed in because auth lives in the
    /// frontend's backend provider, not here.
    pub access_token: Option<String>,
    pub version: i64,
    pub owner: Option<String>,
    pub category: Option<String>,
    pub summary: Option<String>,
    pub when_to_use: Option<String>,
    pub when_not_to_use: Option<String>,
    pub requires: Option<Vec<String>>,
    #[serde(default)]
    pub is_global: bool,
}

/// Install by copying an existing on-disk skill directory (Share → auto-install
/// for the publisher, without needing an OSS download of a blob that may not
/// have been uploaded yet).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillInstallFromDirRequest {
    pub workspace_path: Option<String>,
    pub slug: String,
    pub source_dir: String,
    pub version: i64,
    pub owner: Option<String>,
    pub category: Option<String>,
    pub summary: Option<String>,
    pub when_to_use: Option<String>,
    pub when_not_to_use: Option<String>,
    pub requires: Option<Vec<String>>,
    #[serde(default)]
    pub is_global: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillPackResult {
    pub content_hash: String,
    pub size: u64,
}

struct FrontmatterFields<'a> {
    slug: &'a str,
    version: i64,
    owner: Option<&'a str>,
    category: Option<&'a str>,
    summary: Option<&'a str>,
    when_to_use: Option<&'a str>,
    when_not_to_use: Option<&'a str>,
    requires: Option<&'a Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillInstallResult {
    pub slug: String,
    pub version: i64,
    pub path: String,
    pub frontmatter_written: bool,
}

fn scalar(value: &str) -> Option<FrontmatterValue> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(FrontmatterValue::Scalar(trimmed.to_owned()))
    }
}

/// Rewrite SKILL.md's frontmatter with the registry's structured fields.
///
/// Returns false when the package has no SKILL.md at all — a broken package
/// should surface as "installed but not usable" rather than failing the
/// install, because the files are already on disk by this point and a hard
/// error would leave the caller unsure what state it is in.
fn write_registry_frontmatter_fields(
    target: &std::path::Path,
    fields: &FrontmatterFields<'_>,
) -> Result<bool, String> {
    let skill_md = target.join("SKILL.md");
    if !skill_md.exists() {
        return Ok(false);
    }
    let content = std::fs::read_to_string(&skill_md)
        .map_err(|e| format!("Failed to read SKILL.md: {}", e))?;

    let requires = fields
        .requires
        .filter(|items| !items.is_empty())
        .map(|items| FrontmatterValue::List(items.clone()));

    let updates: Vec<(&str, Option<FrontmatterValue>)> = vec![
        ("name", scalar(fields.slug)),
        ("description", fields.summary.and_then(scalar)),
        ("owner", fields.owner.and_then(scalar)),
        ("category", fields.category.and_then(scalar)),
        ("when_to_use", fields.when_to_use.and_then(scalar)),
        ("when_not_to_use", fields.when_not_to_use.and_then(scalar)),
        ("requires", requires),
        (
            "version",
            Some(FrontmatterValue::Scalar(fields.version.to_string())),
        ),
        (
            "source",
            Some(FrontmatterValue::Scalar(SOURCE_TEAM.to_owned())),
        ),
    ];

    let out = write_frontmatter(&content, &updates, FRONTMATTER_KEY_ORDER);
    std::fs::write(&skill_md, out).map_err(|e| format!("Failed to write SKILL.md: {}", e))?;
    Ok(true)
}

fn write_registry_frontmatter(
    target: &std::path::Path,
    req: &TeamSkillInstallRequest,
) -> Result<bool, String> {
    write_registry_frontmatter_fields(
        target,
        &FrontmatterFields {
            slug: &req.slug,
            version: req.version,
            owner: req.owner.as_deref(),
            category: req.category.as_deref(),
            summary: req.summary.as_deref(),
            when_to_use: req.when_to_use.as_deref(),
            when_not_to_use: req.when_not_to_use.as_deref(),
            requires: req.requires.as_ref(),
        },
    )
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create {}: {}", dst.display(), e))?;
    for entry in
        std::fs::read_dir(src).map_err(|e| format!("Failed to read {}: {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        let ty = entry
            .file_type()
            .map_err(|e| format!("Failed to stat {}: {}", entry.path().display(), e))?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), &to)
                .map_err(|e| format!("Failed to copy {}: {}", entry.path().display(), e))?;
        }
    }
    Ok(())
}

fn zip_skill_dir(dir: &std::path::Path) -> Result<Vec<u8>, String> {
    let cursor = std::io::Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    fn add_tree(
        writer: &mut ZipWriter<std::io::Cursor<Vec<u8>>>,
        opts: SimpleFileOptions,
        base: &std::path::Path,
        rel: &std::path::Path,
    ) -> Result<(), String> {
        let full = base.join(rel);
        if full.is_dir() {
            for entry in std::fs::read_dir(&full)
                .map_err(|e| format!("Failed to read {}: {}", full.display(), e))?
            {
                let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
                let name = entry.file_name();
                let child_rel = rel.join(&name);
                add_tree(writer, opts, base, &child_rel)?;
            }
        } else if full.is_file() {
            let name = rel.to_string_lossy().replace('\\', "/");
            writer
                .start_file(name, opts)
                .map_err(|e| format!("zip start: {}", e))?;
            let bytes = std::fs::read(&full)
                .map_err(|e| format!("Failed to read {}: {}", full.display(), e))?;
            use std::io::Write;
            writer
                .write_all(&bytes)
                .map_err(|e| format!("zip write: {}", e))?;
        }
        Ok(())
    }

    add_tree(&mut writer, opts, dir, std::path::Path::new(""))?;
    let finished = writer.finish().map_err(|e| format!("zip finish: {}", e))?;
    Ok(finished.into_inner())
}

#[tauri::command]
pub async fn team_skill_install(
    request: TeamSkillInstallRequest,
) -> Result<TeamSkillInstallResult, String> {
    tokio::task::spawn_blocking(move || team_skill_install_blocking(request))
        .await
        .map_err(|e| format!("team skill install task failed: {}", e))?
}

/// Blocking half. Runs off the Tauri main thread: HTTP + zip + filesystem.
fn team_skill_install_blocking(
    req: TeamSkillInstallRequest,
) -> Result<TeamSkillInstallResult, String> {
    let slug = req.slug.trim().to_string();
    validate_slug(&slug)?;

    let skills = global_skills_dir()?;
    std::fs::create_dir_all(&skills).map_err(|e| format!("Failed to create skills dir: {}", e))?;
    let target = skills.join(&slug);

    let client = build_client()?;
    let mut download = client.get(&req.download_url);
    if let Some(token) = req.access_token.as_deref().filter(|t| !t.is_empty()) {
        download = download.header("Authorization", format!("Bearer {}", token));
    }
    let resp = download
        .send()
        .map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed with status {}", resp.status()));
    }
    let zip_bytes = resp
        .bytes()
        .map_err(|e| format!("Failed to read download body: {}", e))?;

    // Reinstall is the normal path here (version bumps), so unlike ClawHub
    // there is no force flag — the registry row is the source of truth for
    // what should be on disk.
    if target.exists() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("Failed to remove existing skill dir: {}", e))?;
    }
    extract_zip_to_dir(&zip_bytes, &target)?;

    let frontmatter_written = write_registry_frontmatter(&target, &req)?;

    // Lockfile stays workspace-scoped for update checks, even though the pack
    // itself always lives under ~/.agents/skills.
    if let Some(ws) = req
        .workspace_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        let mut lock = read_lockfile(ws);
        lock.skills.insert(
            slug.clone(),
            LockfileEntry {
                version: Some(req.version.to_string()),
                installed_at: now_millis(),
                source: Some(SOURCE_TEAM.to_string()),
            },
        );
        write_lockfile(ws, &lock)?;
        set_skill_permission_ask(ws, &slug);
    }

    Ok(TeamSkillInstallResult {
        slug,
        version: req.version,
        path: target.display().to_string(),
        frontmatter_written,
    })
}

#[tauri::command]
pub fn team_skill_uninstall(
    workspace_path: Option<String>,
    slug: String,
    is_global: Option<bool>,
) -> Result<String, String> {
    let slug = slug.trim().to_string();
    validate_slug(&slug)?;
    let _ = is_global; // packs always live under ~/.agents/skills

    let skills = global_skills_dir()?;
    let target = skills.join(&slug);
    if target.exists() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("Failed to remove skill directory: {}", e))?;
    }

    if let Some(ws) = workspace_path.as_deref().filter(|s| !s.trim().is_empty()) {
        let mut lock = read_lockfile(ws);
        lock.skills.remove(&slug);
        write_lockfile(ws, &lock)?;
    }

    Ok(format!("Uninstalled {}", slug))
}

/// Zip a personal skill directory and upload it to the team's amuxc blob store.
/// Returns sha256 + size for the subsequent `POST /v1/teams/:id/skills` publish.
#[tauri::command]
pub async fn team_skill_pack_and_upload(
    dir_path: String,
    slug: String,
    team_id: String,
    cloud_api_url: String,
    access_token: String,
) -> Result<TeamSkillPackResult, String> {
    tokio::task::spawn_blocking(move || {
        let slug = slug.trim().to_string();
        validate_slug(&slug)?;
        let team_id = team_id.trim().to_string();
        if team_id.is_empty() {
            return Err("teamId is required".to_string());
        }
        let base = cloud_api_url.trim().trim_end_matches('/').to_string();
        if base.is_empty() {
            return Err("cloudApiUrl is required".to_string());
        }
        let token = access_token.trim().to_string();
        if token.is_empty() {
            return Err("accessToken is required".to_string());
        }

        let dir = std::path::PathBuf::from(dir_path.trim());
        if !dir.is_dir() {
            return Err(format!("Skill directory not found: {}", dir.display()));
        }
        if !dir.join("SKILL.md").is_file() {
            return Err("Skill directory must contain SKILL.md".to_string());
        }
        let zip_bytes = zip_skill_dir(&dir)?;
        let mut hasher = Sha256::new();
        hasher.update(&zip_bytes);
        let content_hash = format!("{:x}", hasher.finalize());
        let size = zip_bytes.len() as u64;

        let client = build_client()?;
        let prepare_url = format!("{}/v1/teams/{}/skill-blobs/prepare", base, team_id);
        let prepare_resp = client
            .post(&prepare_url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "contentHash": content_hash,
                "size": size,
            }))
            .send()
            .map_err(|e| format!("skill blob prepare failed: {}", e))?;
        if !prepare_resp.status().is_success() {
            let status = prepare_resp.status();
            let body = prepare_resp.text().unwrap_or_default();
            return Err(format!("skill blob prepare HTTP {}: {}", status, body));
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PrepareBody {
            requires_upload: bool,
            #[serde(default)]
            presigned_put: Option<String>,
        }
        let prepared: PrepareBody = prepare_resp
            .json()
            .map_err(|e| format!("skill blob prepare decode: {}", e))?;

        if prepared.requires_upload {
            let put_url = prepared
                .presigned_put
                .filter(|u| !u.is_empty())
                .ok_or_else(|| {
                    "skill blob prepare required upload but returned no URL".to_string()
                })?;
            let put_resp = client
                .put(&put_url)
                .header("x-upsert", "true")
                .body(zip_bytes)
                .send()
                .map_err(|e| format!("skill blob PUT failed: {}", e))?;
            if !put_resp.status().is_success() {
                return Err(format!("skill blob PUT HTTP {}", put_resp.status()));
            }
        }

        let complete_url = format!("{}/v1/teams/{}/skill-blobs/complete", base, team_id);
        let complete_resp = client
            .post(&complete_url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "contentHash": content_hash,
                "size": size,
            }))
            .send()
            .map_err(|e| format!("skill blob complete failed: {}", e))?;
        if !complete_resp.status().is_success() {
            let status = complete_resp.status();
            let body = complete_resp.text().unwrap_or_default();
            return Err(format!("skill blob complete HTTP {}: {}", status, body));
        }

        Ok(TeamSkillPackResult { content_hash, size })
    })
    .await
    .map_err(|e| format!("team skill pack_and_upload task failed: {}", e))?
}

/// Zip a personal skill directory and return sha256 + size (local only — no OSS).
/// Prefer `team_skill_pack_and_upload` for Share; this remains for hash checks.
#[tauri::command]
pub async fn team_skill_pack(
    dir_path: String,
    slug: String,
) -> Result<TeamSkillPackResult, String> {
    tokio::task::spawn_blocking(move || {
        let slug = slug.trim().to_string();
        validate_slug(&slug)?;
        let dir = std::path::PathBuf::from(dir_path.trim());
        if !dir.is_dir() {
            return Err(format!("Skill directory not found: {}", dir.display()));
        }
        if !dir.join("SKILL.md").is_file() {
            return Err("Skill directory must contain SKILL.md".to_string());
        }
        let zip_bytes = zip_skill_dir(&dir)?;
        let mut hasher = Sha256::new();
        hasher.update(&zip_bytes);
        let content_hash = format!("{:x}", hasher.finalize());
        Ok(TeamSkillPackResult {
            content_hash,
            size: zip_bytes.len() as u64,
        })
    })
    .await
    .map_err(|e| format!("team skill pack task failed: {}", e))?
}

/// Copy a personal skill folder into the workspace team-skills install location
/// and stamp registry frontmatter / lockfile. Used after Share so the publisher
/// does not need an OSS download of a blob that may not exist yet.
#[tauri::command]
pub async fn team_skill_install_from_dir(
    request: TeamSkillInstallFromDirRequest,
) -> Result<TeamSkillInstallResult, String> {
    tokio::task::spawn_blocking(move || {
        let slug = request.slug.trim().to_string();
        validate_slug(&slug)?;
        let source = std::path::PathBuf::from(request.source_dir.trim());
        if !source.is_dir() {
            return Err(format!("Source directory not found: {}", source.display()));
        }
        if !source.join("SKILL.md").is_file() {
            return Err("Source directory must contain SKILL.md".to_string());
        }

        let skills = global_skills_dir()?;
        std::fs::create_dir_all(&skills)
            .map_err(|e| format!("Failed to create skills dir: {}", e))?;
        let target = skills.join(&slug);
        if target.exists() {
            std::fs::remove_dir_all(&target)
                .map_err(|e| format!("Failed to remove existing skill dir: {}", e))?;
        }
        copy_dir_recursive(&source, &target)?;

        let frontmatter_written = write_registry_frontmatter_fields(
            &target,
            &FrontmatterFields {
                slug: &slug,
                version: request.version,
                owner: request.owner.as_deref(),
                category: request.category.as_deref(),
                summary: request.summary.as_deref(),
                when_to_use: request.when_to_use.as_deref(),
                when_not_to_use: request.when_not_to_use.as_deref(),
                requires: request.requires.as_ref(),
            },
        )?;

        if let Some(ws) = request
            .workspace_path
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            let mut lock = read_lockfile(ws);
            lock.skills.insert(
                slug.clone(),
                LockfileEntry {
                    version: Some(request.version.to_string()),
                    installed_at: now_millis(),
                    source: Some(SOURCE_TEAM.to_string()),
                },
            );
            write_lockfile(ws, &lock)?;
            set_skill_permission_ask(ws, &slug);
        }

        Ok(TeamSkillInstallResult {
            slug,
            version: request.version,
            path: target.display().to_string(),
            frontmatter_written,
        })
    })
    .await
    .map_err(|e| format!("team skill install_from_dir task failed: {}", e))?
}

/// Which team-registry skills are on disk, and at what version.
///
/// The frontend reconciles this against the server's install list. For a member
/// this is only a display concern; for a `visibility=team` agent the server
/// list is authoritative and this is what gets diffed against it.
#[tauri::command]
pub fn team_skill_list_installed(workspace_path: String) -> Result<Vec<(String, String)>, String> {
    let lock = read_lockfile(&workspace_path);
    let mut out: Vec<(String, String)> = lock
        .skills
        .into_iter()
        .filter(|(_, entry)| entry.source.as_deref() == Some(SOURCE_TEAM))
        .map(|(slug, entry)| (slug, entry.version.unwrap_or_default()))
        .collect();
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use teamclaw_types::skill_frontmatter::parse_frontmatter;

    fn request(slug: &str) -> TeamSkillInstallRequest {
        TeamSkillInstallRequest {
            workspace_path: None,
            slug: slug.to_string(),
            download_url: String::new(),
            access_token: None,
            version: 3,
            owner: Some("张三".into()),
            category: Some("devops".into()),
            summary: Some("发布前检查清单".into()),
            when_to_use: Some("发布前确认 CI 绿、迁移已跑".into()),
            when_not_to_use: Some("不要用于本地开发\n不要用于 hotfix 流程".into()),
            requires: Some(vec!["macos".into()]),
            is_global: false,
        }
    }

    #[test]
    fn writes_structured_fields_and_keeps_the_body() {
        let dir = tempfile::tempdir().expect("tempdir");
        let skill = dir.path().join("deploy-check");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: deploy-check\ndescription: old blurb\n---\n# Deploy check\n\nsteps\n",
        )
        .unwrap();

        let wrote = write_registry_frontmatter(&skill, &request("deploy-check")).unwrap();
        assert!(wrote);

        let out = std::fs::read_to_string(skill.join("SKILL.md")).unwrap();
        let parsed = parse_frontmatter(&out);
        assert_eq!(parsed.string("category"), Some("devops"));
        assert_eq!(parsed.string("owner"), Some("张三"));
        // The multi-line field is the one the old regex parser could not carry.
        assert_eq!(
            parsed.string("when_not_to_use"),
            Some("不要用于本地开发\n不要用于 hotfix 流程")
        );
        assert_eq!(parsed.string("version"), Some("3"));
        assert_eq!(parsed.string("source"), Some("team"));
        // description tracks summary so pre-existing readers still see a blurb.
        assert_eq!(parsed.string("description"), Some("发布前检查清单"));
        assert_eq!(parsed.body, "# Deploy check\n\nsteps\n");
    }

    #[test]
    fn a_package_without_skill_md_installs_but_reports_no_frontmatter() {
        let dir = tempfile::tempdir().expect("tempdir");
        let skill = dir.path().join("empty");
        std::fs::create_dir_all(&skill).unwrap();
        assert!(!write_registry_frontmatter(&skill, &request("empty")).unwrap());
    }

    #[test]
    fn empty_optional_fields_are_not_emitted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let skill = dir.path().join("bare");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: bare\n---\nbody\n").unwrap();

        let mut req = request("bare");
        req.owner = None;
        req.when_not_to_use = Some("   ".into());
        req.requires = Some(vec![]);
        write_registry_frontmatter(&skill, &req).unwrap();

        let out = std::fs::read_to_string(skill.join("SKILL.md")).unwrap();
        let parsed = parse_frontmatter(&out);
        assert_eq!(parsed.string("owner"), None);
        assert_eq!(parsed.string("when_not_to_use"), None);
        assert!(parsed.data.get("requires").is_none());
    }
}

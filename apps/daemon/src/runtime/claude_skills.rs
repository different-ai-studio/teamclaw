//! Bridge team-shared skills into `<workspace>/.claude/skills/` for Claude Code.
//!
//! OpenCode reads `teamclu-team/skills` via `opencode.json`; the Claude Agent SDK
//! only discovers skills under `.claude/skills/` (with `settingSources` including
//! `project`). We materialize per-skill symlinks so team skills are visible without
//! touching the team-share layout.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::config::team_skill_roots;
use crate::config::workspace_control::WorkspaceControlError;

const CLAUDE_SKILLS_DIR: &str = ".claude/skills";

/// Ensure team skills are symlinked into `.claude/skills/`, without overwriting
/// workspace-local entries. Idempotent; safe to call on every `prepare_workspace`.
pub fn ensure_claude_team_skills(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    let claude_skills = workspace_path.join(CLAUDE_SKILLS_DIR);
    std::fs::create_dir_all(&claude_skills).map_err(io_err)?;

    let team_roots = team_skill_roots(workspace_path);
    if team_roots.is_empty() {
        prune_stale_team_symlinks(&claude_skills, &team_roots, &HashSet::new())?;
        return Ok(());
    }

    let desired = collect_desired_team_skills(&team_roots);
    let desired_slugs: HashSet<String> = desired.keys().cloned().collect();

    for (slug, target) in &desired {
        let link = claude_skills.join(slug);
        if link.exists() {
            if link.is_dir() && !is_symlink(&link) {
                // Workspace-local skill wins over team.
                continue;
            }
            if is_symlink(&link) {
                if symlink_points_to(&link, target) {
                    continue;
                }
                if is_team_managed_symlink(&link, &team_roots) {
                    std::fs::remove_file(&link).map_err(io_err)?;
                } else {
                    // User-owned symlink — do not overwrite.
                    continue;
                }
            } else if link.is_file() {
                continue;
            }
        }
        create_dir_symlink(target, &link)?;
    }

    prune_stale_team_symlinks(&claude_skills, &team_roots, &desired_slugs)?;
    Ok(())
}

fn collect_desired_team_skills(team_roots: &[PathBuf]) -> HashMap<String, PathBuf> {
    let mut desired = HashMap::new();
    for root in team_roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if !path.join("SKILL.md").is_file() {
                continue;
            }
            let Some(slug) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            desired.entry(slug.to_string()).or_insert(path);
        }
    }
    desired
}

fn prune_stale_team_symlinks(
    claude_skills: &Path,
    team_roots: &[PathBuf],
    desired_slugs: &HashSet<String>,
) -> Result<(), WorkspaceControlError> {
    let Ok(entries) = std::fs::read_dir(claude_skills) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_symlink(&path) {
            continue;
        }
        let Some(slug) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if desired_slugs.contains(slug) {
            continue;
        }
        if is_team_managed_symlink(&path, team_roots) {
            std::fs::remove_file(&path).map_err(io_err)?;
        }
    }
    Ok(())
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

fn resolve_symlink_target(link: &Path) -> Option<PathBuf> {
    let dest = std::fs::read_link(link).ok()?;
    let resolved = if dest.is_absolute() {
        dest
    } else {
        link.parent()?.join(dest)
    };
    Some(std::fs::canonicalize(&resolved).unwrap_or(resolved))
}

fn symlink_points_to(link: &Path, target: &Path) -> bool {
    let Some(resolved) = resolve_symlink_target(link) else {
        return false;
    };
    let Ok(canonical_target) = std::fs::canonicalize(target) else {
        return false;
    };
    resolved == canonical_target
}

fn is_team_managed_symlink(link: &Path, team_roots: &[PathBuf]) -> bool {
    if !is_symlink(link) {
        return false;
    }
    let Some(resolved) = resolve_symlink_target(link) else {
        // Broken symlink — only prune when we can't resolve; treat as managed
        // if the link target string references a team root path component.
        let Ok(dest) = std::fs::read_link(link) else {
            return false;
        };
        let dest_str = dest.to_string_lossy();
        return team_roots.iter().any(|root| {
            let root_str = root.to_string_lossy();
            dest_str.contains(root_str.as_ref())
        });
    };
    team_roots.iter().any(|root| {
        let root_canon = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        resolved.starts_with(&root_canon)
    })
}

fn create_dir_symlink(target: &Path, link: &Path) -> Result<(), WorkspaceControlError> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).map_err(io_err)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link).map_err(io_err)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        Err(WorkspaceControlError::Io(
            "symlinks are not supported on this platform".into(),
        ))
    }
}

fn io_err(e: std::io::Error) -> WorkspaceControlError {
    WorkspaceControlError::Io(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::global_team_store::TEAM_LINK_NAME;

    fn write_skill(dir: &Path, slug: &str) {
        let skill_dir = dir.join(slug);
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {slug}\n---\n"),
        )
        .unwrap();
    }

    #[test]
    fn symlinks_team_skills_into_claude_dir() {
        let ws = tempfile::tempdir().unwrap();
        let team_skills = ws.path().join(TEAM_LINK_NAME).join("skills");
        std::fs::create_dir_all(&team_skills).unwrap();
        write_skill(&team_skills, "team-skill");

        ensure_claude_team_skills(ws.path()).unwrap();

        let link = ws.path().join(".claude/skills/team-skill");
        assert!(is_symlink(&link));
        assert!(link.join("SKILL.md").is_file());
    }

    #[test]
    fn local_skill_wins_over_team_with_same_slug() {
        let ws = tempfile::tempdir().unwrap();
        let team_skills = ws.path().join(TEAM_LINK_NAME).join("skills");
        std::fs::create_dir_all(&team_skills).unwrap();
        write_skill(&team_skills, "shared-name");

        let local = ws.path().join(".claude/skills/shared-name");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join("SKILL.md"), "local wins").unwrap();

        ensure_claude_team_skills(ws.path()).unwrap();

        let content = std::fs::read_to_string(local.join("SKILL.md")).unwrap();
        assert_eq!(content, "local wins");
        assert!(!is_symlink(&local));
    }

    #[test]
    fn removes_stale_team_symlinks() {
        let ws = tempfile::tempdir().unwrap();
        let team_skills = ws.path().join(TEAM_LINK_NAME).join("skills");
        std::fs::create_dir_all(&team_skills).unwrap();
        write_skill(&team_skills, "keep-me");

        ensure_claude_team_skills(ws.path()).unwrap();

        // Simulate a removed team skill by deleting source and re-running prepare.
        std::fs::remove_dir_all(team_skills.join("keep-me")).unwrap();
        ensure_claude_team_skills(ws.path()).unwrap();

        assert!(!ws.path().join(".claude/skills/keep-me").exists());
    }

    #[test]
    fn first_team_root_wins_for_duplicate_slug() {
        let ws = tempfile::tempdir().unwrap();
        let root_a = ws.path().join("skills-a");
        let root_b = ws.path().join("skills-b");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        write_skill(&root_a, "dup");
        write_skill(&root_b, "dup");
        std::fs::write(root_a.join("dup/SKILL.md"), "from-a").unwrap();
        std::fs::write(root_b.join("dup/SKILL.md"), "from-b").unwrap();

        let desired = collect_desired_team_skills(&[root_a.clone(), root_b]);
        assert_eq!(desired.get("dup").unwrap(), &root_a.join("dup"));
    }
}

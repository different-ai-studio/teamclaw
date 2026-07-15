//! Unified per-file version history + content resolution for team workspaces.
//!
//! git mode: read-only `git log/show/status` against the team clone.
//! oss mode: FC version list + blob download/decrypt (see http/team_sync.rs).

use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// One entry in a file's version history. `reference` is a git commit SHA
/// (git mode) or an OSS content hash (oss mode). Serialized as `ref`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    #[serde(rename = "ref")]
    pub reference: String,
    pub author: Option<String>,
    pub timestamp: String,
    pub deleted: bool,
    pub message: Option<String>,
}

/// A file with local changes (feeds the "changed files" list).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: String, // "modified" | "added" | "deleted"
}

/// True when the team clone is a git repo (vs OSS blob sync).
pub fn is_git_team(team_dir: &Path) -> bool {
    team_dir.join(".git").exists()
}

fn git(args: &[&str], cwd: &Path) -> (bool, String) {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output();
    match out {
        Ok(o) => (
            o.status.success(),
            String::from_utf8_lossy(&o.stdout).to_string(),
        ),
        Err(e) => {
            tracing::warn!("git {:?} in {} failed to spawn: {e}", args, cwd.display());
            (false, String::new())
        }
    }
}

/// `git log --follow` for one file, newest first.
pub fn git_list_versions(team_dir: &Path, rel_path: &str) -> Vec<VersionEntry> {
    // %H sha, %an author, %aI iso-date, %s subject — separated by US (0x1f).
    let (ok, out) = git(
        &[
            "log",
            "--follow",
            "--format=%H\u{1f}%an\u{1f}%aI\u{1f}%s",
            "--",
            rel_path,
        ],
        team_dir,
    );
    if !ok {
        return Vec::new();
    }
    out.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\u{1f}');
            let sha = parts.next()?.trim();
            if sha.is_empty() {
                return None;
            }
            let author = parts.next().unwrap_or("").to_string();
            let ts = parts.next().unwrap_or("").to_string();
            let subject = parts.next().unwrap_or("").to_string();
            Some(VersionEntry {
                reference: sha.to_string(),
                author: Some(author),
                timestamp: ts,
                deleted: false,
                message: Some(subject),
            })
        })
        .collect()
}

/// `git show <ref>:<path>` — None if the file doesn't exist at that ref.
/// `ref` accepts the reserved token "baseline" (resolved to HEAD).
pub fn git_show(team_dir: &Path, reference: &str, rel_path: &str) -> Option<String> {
    let r = if reference == "baseline" {
        "HEAD"
    } else {
        reference
    };
    let (ok, out) = git(&["show", &format!("{r}:{rel_path}")], team_dir);
    if ok {
        Some(out)
    } else {
        None
    }
}

/// `git status --porcelain -z` mapped to ChangedFile entries.
///
/// `-z` keeps paths verbatim (NUL-delimited, no quoting/escaping), so
/// non-ASCII filenames survive intact. Rename/copy (`R`/`C`) entries carry a
/// trailing NUL-separated source path, which is consumed and skipped.
pub fn git_changed(team_dir: &Path) -> Vec<ChangedFile> {
    let (ok, out) = git(&["status", "--porcelain", "-z"], team_dir);
    if !ok {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut tokens = out.split('\0');
    while let Some(tok) = tokens.next() {
        // Each record is `XY<SP>PATH`; bytes 0..3 are always ASCII (status +
        // space), so slicing at byte 3 is a valid char boundary even when PATH
        // is multi-byte UTF-8.
        if tok.len() < 4 {
            continue;
        }
        let xy = &tok[..2];
        let path = tok[3..].to_string();
        let (status, has_source) = if xy.contains('R') {
            ("renamed", true)
        } else if xy.contains('C') {
            ("added", true)
        } else if xy.contains('D') {
            ("deleted", false)
        } else if xy.contains('A') || xy.contains('?') {
            ("added", false)
        } else {
            ("modified", false)
        };
        if has_source {
            // Rename/copy records are followed by their source path as a
            // separate NUL-terminated field; skip it.
            let _ = tokens.next();
        }
        result.push(ChangedFile {
            path,
            status: status.to_string(),
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str], cwd: &Path) {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    fn cfg(repo: &Path) {
        run(&["config", "user.email", "t@t"], repo);
        run(&["config", "user.name", "t"], repo);
    }

    #[test]
    fn git_versions_show_and_changed() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        run(&["init"], repo);
        cfg(repo);
        std::fs::create_dir_all(repo.join("skills")).unwrap();
        std::fs::write(repo.join("skills/x.md"), "v1\n").unwrap();
        run(&["add", "-A"], repo);
        run(&["commit", "-m", "first"], repo);
        std::fs::write(repo.join("skills/x.md"), "v2\n").unwrap();
        run(&["add", "-A"], repo);
        run(&["commit", "-m", "second"], repo);

        assert!(is_git_team(repo));

        let versions = git_list_versions(repo, "skills/x.md");
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].message.as_deref(), Some("second"));
        assert_eq!(versions[1].message.as_deref(), Some("first"));

        let older = &versions[1].reference;
        assert_eq!(
            git_show(repo, older, "skills/x.md").as_deref(),
            Some("v1\n")
        );
        assert_eq!(
            git_show(repo, "baseline", "skills/x.md").as_deref(),
            Some("v2\n")
        );
        assert_eq!(git_show(repo, "HEAD", "nope.md"), None);

        std::fs::write(repo.join("skills/x.md"), "v3-dirty\n").unwrap();
        let changed = git_changed(repo);
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].path, "skills/x.md");
        assert_eq!(changed[0].status, "modified");

        // non-ASCII filename must survive porcelain -z parsing verbatim
        std::fs::write(repo.join("skills/中文.md"), "hi\n").unwrap();
        let changed2 = git_changed(repo);
        assert!(
            changed2
                .iter()
                .any(|c| c.path == "skills/中文.md" && c.status == "added"),
            "expected untracked non-ASCII file, got {:?}",
            changed2
        );
    }
}

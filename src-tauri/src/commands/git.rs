use serde::{Deserialize, Serialize};
use std::process::Command;

/// Result of a git command execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommandResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Structured git file status entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileStatusEntry {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

/// Structured git status response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatusResult {
    pub branch: Option<String>,
    pub files: Vec<GitFileStatusEntry>,
    pub clean: bool,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Run a git command in a given directory, returning structured output
fn run_git(args: &[&str], cwd: &str) -> Result<GitCommandResult, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    Ok(GitCommandResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

/// Run a git command, returning Ok on success or Err with stderr on failure
fn run_git_checked(args: &[&str], cwd: &str) -> Result<String, String> {
    let result = run_git(args, cwd)?;
    if result.success {
        Ok(result.stdout)
    } else {
        Err(format!(
            "git {} failed: {}",
            args.join(" "),
            result.stderr.trim()
        ))
    }
}

// ─── Tauri Commands ─────────────────────────────────────────────────────────

/// 1.1 - Check if git CLI is available on the system
#[tauri::command]
pub fn git_check_available() -> Result<GitCommandResult, String> {
    let output = Command::new("git")
        .args(["--version"])
        .output()
        .map_err(|e| format!("Git is not available: {}", e))?;

    Ok(GitCommandResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

/// 1.2 - Clone a git repository
#[tauri::command]
pub fn git_clone(
    url: String,
    path: String,
    shallow: Option<bool>,
) -> Result<GitCommandResult, String> {
    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {}", e))?;
    }

    let mut args: Vec<&str> = vec!["clone"];
    if shallow.unwrap_or(false) {
        args.push("--depth");
        args.push("1");
    }
    args.push(&url);
    args.push(&path);

    // Run clone from the parent directory (or root)
    let cwd = std::path::Path::new(&path)
        .parent()
        .unwrap_or(std::path::Path::new("/"))
        .to_string_lossy()
        .to_string();

    let result = run_git(&args, &cwd)?;
    if result.success {
        Ok(result)
    } else {
        Err(format!("git clone failed: {}", result.stderr.trim()))
    }
}

/// 1.3 - Pull latest changes (fast-forward only)
#[tauri::command]
pub fn git_pull(path: String) -> Result<GitCommandResult, String> {
    let result = run_git(&["pull", "--ff-only"], &path)?;
    if result.success {
        Ok(result)
    } else {
        // Check if it's a merge conflict situation
        if result.stderr.contains("Not possible to fast-forward")
            || result.stderr.contains("fatal: Not possible")
        {
            Err(format!(
                "Fast-forward not possible. Remote has diverged. Please resolve manually:\n\
                 cd {} && git pull --rebase",
                path
            ))
        } else {
            Err(format!("git pull failed: {}", result.stderr.trim()))
        }
    }
}

/// 1.4 - Push commits to remote
#[tauri::command]
pub fn git_push(
    path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<GitCommandResult, String> {
    let remote_name = remote.unwrap_or_else(|| "origin".to_string());
    let mut args = vec!["push", &remote_name];

    let branch_name;
    if let Some(ref b) = branch {
        branch_name = b.clone();
        args.push(&branch_name);
    }

    let result = run_git(&args, &path)?;
    if result.success {
        Ok(result)
    } else {
        if result.stderr.contains("Authentication")
            || result.stderr.contains("could not read Username")
            || result.stderr.contains("Permission denied")
        {
            Err(format!(
                "Authentication failed. Please configure git credentials:\n\
                 - For HTTPS: git credential-osxkeychain or git config --global credential.helper store\n\
                 - For SSH: Ensure your SSH key is added to the agent (ssh-add ~/.ssh/id_ed25519)\n\
                 \nOriginal error: {}",
                result.stderr.trim()
            ))
        } else {
            Err(format!("git push failed: {}", result.stderr.trim()))
        }
    }
}

/// 1.5 - Commit staged changes
#[tauri::command]
pub fn git_commit(path: String, message: String) -> Result<GitCommandResult, String> {
    let result = run_git(&["commit", "-m", &message], &path)?;
    if result.success {
        // Extract commit hash from output
        Ok(result)
    } else {
        if result.stdout.contains("nothing to commit")
            || result.stderr.contains("nothing to commit")
        {
            Err("Nothing to commit - no staged changes.".to_string())
        } else {
            Err(format!("git commit failed: {}", result.stderr.trim()))
        }
    }
}

/// 1.6 - Stage files for commit
#[tauri::command]
pub fn git_add(
    path: String,
    files: Option<Vec<String>>,
    all: Option<bool>,
) -> Result<GitCommandResult, String> {
    let args: Vec<String>;
    if all.unwrap_or(false) {
        args = vec!["add".to_string(), "--all".to_string()];
    } else if let Some(ref file_list) = files {
        if file_list.is_empty() {
            return Err("No files specified to add.".to_string());
        }
        let mut a = vec!["add".to_string(), "--".to_string()];
        a.extend(file_list.clone());
        args = a;
    } else {
        return Err("Either 'files' or 'all: true' must be specified.".to_string());
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let result = run_git(&arg_refs, &path)?;
    if result.success {
        Ok(result)
    } else {
        Err(format!("git add failed: {}", result.stderr.trim()))
    }
}

/// 1.7 - Get structured git status
#[tauri::command]
pub fn git_status(path: String) -> Result<GitStatusResult, String> {
    // Get branch name
    let branch_output = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], &path);
    let branch = branch_output.ok().and_then(|r| {
        if r.success {
            Some(r.stdout.trim().to_string())
        } else {
            None
        }
    });

    // Get porcelain status for easy parsing
    let status_output = run_git_checked(&["status", "--porcelain=v1", "-uall"], &path)?;

    let mut files: Vec<GitFileStatusEntry> = Vec::new();

    for line in status_output.lines() {
        if line.len() < 4 {
            continue;
        }
        let index_status = line.chars().nth(0).unwrap_or(' ');
        let worktree_status = line.chars().nth(1).unwrap_or(' ');
        let file_path = line[3..].to_string();

        let (status, staged) = match (index_status, worktree_status) {
            ('M', _) => ("modified".to_string(), true),
            ('A', _) => ("added".to_string(), true),
            ('D', _) => ("deleted".to_string(), true),
            ('R', _) => ("renamed".to_string(), true),
            ('C', _) => ("copied".to_string(), true),
            (_, 'M') => ("modified".to_string(), false),
            (_, 'D') => ("deleted".to_string(), false),
            ('?', '?') => ("untracked".to_string(), false),
            ('!', '!') => ("ignored".to_string(), false),
            _ => ("unknown".to_string(), false),
        };

        files.push(GitFileStatusEntry {
            path: file_path,
            status,
            staged,
        });
    }

    let clean = files.is_empty();

    Ok(GitStatusResult {
        branch,
        files,
        clean,
    })
}

/// 1.8 - Get diff output
#[tauri::command]
pub fn git_diff(
    path: String,
    file: Option<String>,
    staged: Option<bool>,
) -> Result<GitCommandResult, String> {
    let mut args = vec!["diff"];
    if staged.unwrap_or(false) {
        args.push("--staged");
    }
    if let Some(ref f) = file {
        args.push("--");
        args.push(f);
    }

    run_git(&args, &path)
}

/// 1.9 - Restore (revert) a file to its last committed state
///
/// Runs `git checkout -- <file>` to discard working-tree changes.
#[tauri::command]
pub fn git_checkout_file(path: String, file: String) -> Result<GitCommandResult, String> {
    let result = run_git(&["checkout", "--", &file], &path)?;
    if result.success {
        Ok(result)
    } else {
        Err(format!("git checkout failed: {}", result.stderr.trim()))
    }
}

/// 1.10 - Get file content from a git ref (e.g. HEAD)
///
/// Runs `git show <ref>:<file>` to retrieve the content of a file
/// at a specific commit. Used for git gutter decorations (comparing
/// working-tree content against the last committed version).
#[tauri::command]
pub fn git_show_file(
    path: String,
    file: String,
    git_ref: Option<String>,
) -> Result<GitCommandResult, String> {
    let r = git_ref.unwrap_or_else(|| "HEAD".to_string());
    let spec = format!("{}:{}", r, file);
    run_git(&["show", &spec], &path)
}

/// 1.11 - Read commit history for a single file.
///
/// Runs `git log --follow ...` and returns parsed entries newest-first.
/// `limit` defaults to 50, `skip` defaults to 0.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub sha: String,
    /// First-parent SHA. Empty string for the initial commit.
    pub parent_sha: String,
    pub author: String,
    /// Strict ISO 8601 (`%aI`).
    pub iso_time: String,
    pub subject: String,
}

#[tauri::command]
pub fn git_log_file(
    path: String,
    file: String,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<Vec<GitLogEntry>, String> {
    let limit = limit.unwrap_or(50);
    let skip = skip.unwrap_or(0);
    let max_count_arg = format!("--max-count={}", limit);
    let skip_arg = format!("--skip={}", skip);
    let pretty = "--pretty=format:%H%x09%P%x09%an%x09%aI%x09%s";

    // --first-parent keeps the log consistent with parent_sha (which is always first-parent).
    let result = run_git(
        &[
            "log",
            "--follow",
            "--first-parent",
            &max_count_arg,
            &skip_arg,
            pretty,
            "--",
            &file,
        ],
        &path,
    )?;

    if !result.success {
        return Err(format!("git log failed: {}", result.stderr.trim()));
    }

    let mut entries = Vec::new();
    for line in result.stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(5, '\t');
        let sha = parts.next().unwrap_or("").to_string();
        let parents = parts.next().unwrap_or("");
        let author = parts.next().unwrap_or("").to_string();
        let iso_time = parts.next().unwrap_or("").to_string();
        let subject = parts.next().unwrap_or("").to_string();

        if sha.is_empty() {
            continue;
        }

        let parent_sha = parents.split_whitespace().next().unwrap_or("").to_string();

        entries.push(GitLogEntry {
            sha,
            parent_sha,
            author,
            iso_time,
            subject,
        });
    }

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::process::Command;
    use tempfile::TempDir;

    fn run(repo: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(repo)
            .status()
            .expect("git command should run");
        assert!(status.success(), "git {:?} failed", args);
    }

    fn init_repo() -> TempDir {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path();
        run(path, &["init", "-q", "-b", "main"]);
        run(path, &["config", "user.email", "t@t.t"]);
        run(path, &["config", "user.name", "Test"]);
        run(path, &["config", "commit.gpgsign", "false"]);
        dir
    }

    fn commit_file(repo: &TempDir, file: &str, content: &str, msg: &str) {
        let p = repo.path().join(file);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).expect("create parent dir");
        }
        fs::write(&p, content).expect("write file");
        run(repo.path(), &["add", file]);
        run(repo.path(), &["commit", "-q", "-m", msg]);
    }

    fn repo_path(dir: &TempDir) -> String {
        dir.path().to_string_lossy().into_owned()
    }

    #[test]
    fn returns_commits_newest_first_with_all_fields() {
        let repo = init_repo();
        commit_file(&repo, "a.txt", "v1", "first");
        commit_file(&repo, "a.txt", "v2", "second");
        commit_file(&repo, "a.txt", "v3", "third");

        let entries = git_log_file(repo_path(&repo), "a.txt".into(), Some(50), Some(0))
            .expect("git_log_file ok");

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].subject, "third");
        assert_eq!(entries[1].subject, "second");
        assert_eq!(entries[2].subject, "first");
        for e in &entries {
            assert_eq!(e.author, "Test");
            assert!(!e.sha.is_empty());
            assert!(!e.iso_time.is_empty());
        }
        assert_eq!(entries[0].parent_sha, entries[1].sha);
        assert_eq!(entries[1].parent_sha, entries[2].sha);
        assert_eq!(entries[2].parent_sha, "");
    }

    #[test]
    fn initial_commit_has_empty_parent_sha() {
        let repo = init_repo();
        commit_file(&repo, "a.txt", "v1", "first");

        let entries =
            git_log_file(repo_path(&repo), "a.txt".into(), None, None).expect("git_log_file ok");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].parent_sha, "");
    }

    #[test]
    fn follows_renames() {
        let repo = init_repo();
        commit_file(&repo, "old.txt", "v1", "orig");
        run(repo.path(), &["mv", "old.txt", "new.txt"]);
        run(repo.path(), &["commit", "-q", "-m", "rename"]);
        commit_file(&repo, "new.txt", "v2", "after rename");

        let entries =
            git_log_file(repo_path(&repo), "new.txt".into(), None, None).expect("git_log_file ok");

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].subject, "after rename");
        assert_eq!(entries[1].subject, "rename");
        assert_eq!(entries[2].subject, "orig");
    }

    #[test]
    fn limit_and_skip_honored() {
        let repo = init_repo();
        for i in 0..5 {
            commit_file(&repo, "a.txt", &format!("v{}", i), &format!("c{}", i));
        }

        let entries = git_log_file(repo_path(&repo), "a.txt".into(), Some(2), Some(2))
            .expect("git_log_file ok");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].subject, "c2");
        assert_eq!(entries[1].subject, "c1");
    }

    #[test]
    fn never_committed_file_returns_empty_vec() {
        let repo = init_repo();
        commit_file(&repo, "a.txt", "v1", "first");

        let entries = git_log_file(repo_path(&repo), "ghost.txt".into(), None, None)
            .expect("git_log_file ok");

        assert!(entries.is_empty());
    }

    #[test]
    fn subject_with_tab_survives_parsing() {
        let repo = init_repo();
        commit_file(&repo, "a.txt", "v1", "msg with\ttab inside");

        let entries =
            git_log_file(repo_path(&repo), "a.txt".into(), None, None).expect("git_log_file ok");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].subject, "msg with\ttab inside");
    }
}

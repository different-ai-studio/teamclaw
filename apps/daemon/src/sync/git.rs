use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSharedGitConfig {
    #[serde(default)]
    pub git_url: Option<String>,
    #[serde(default)]
    pub git_branch: Option<String>,
    #[serde(default)]
    pub git_token: Option<String>,
    #[serde(default = "default_shared_dir_name")]
    pub shared_dir_name: String,
    #[serde(default)]
    pub env_secret: Option<String>,
    #[serde(default)]
    pub enabled: bool,
}

fn default_shared_dir_name() -> String {
    crate::config::global_team_store::TEAM_LINK_NAME.to_string()
}

/// Read the enabled `team` section from `{workspace}/.teamclaw/teamclaw.json`.
pub fn read_team_config(workspace_root: &Path) -> Option<TeamSharedGitConfig> {
    let path = workspace_root.join(".teamclaw").join("teamclaw.json");
    let body = std::fs::read_to_string(&path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&body).ok()?;
    parsed
        .get("team")
        .and_then(|team| serde_json::from_value::<TeamSharedGitConfig>(team.clone()).ok())
        .filter(|team| team.enabled)
}

/// Enabled git-backed team config (`gitUrl` required).
pub fn read_git_team_config(workspace_root: &Path) -> Option<TeamSharedGitConfig> {
    read_team_config(workspace_root).filter(|team| {
        team.git_url
            .as_deref()
            .map(|url| !url.trim().is_empty())
            .unwrap_or(false)
    })
}

/// Credential the daemon injects when talking to the team git remote.
#[derive(Debug, Clone)]
pub enum GitCredential {
    None,
    HttpsToken(String),
    /// SSH private key PEM **content** (not a path).
    SshKey(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GitConflictBackup {
    /// Relative paths whose local versions were backed up before hard-reset.
    pub backed_up: Vec<String>,
    /// Absolute backup dir, e.g. `<team_dir_parent>/.trash/<unix_ts>/`.
    pub backup_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamSharedGitStatus {
    pub shared_dir_path: PathBuf,
    pub configured: bool,
    pub synced: bool,
    pub conflict: Option<GitConflictBackup>,
}

/// Options for [`sync_git_dir_with_cred`]. Default: refuse to wipe a populated
/// non-git directory (caller must confirm via `wipe_non_git`).
#[derive(Debug, Clone, Copy, Default)]
pub struct GitSyncOptions {
    pub wipe_non_git: bool,
}

/// Stable machine-readable prefix for `last_error` / HTTP `code` mapping.
/// Format: `team_shared_dir_not_git:<abs path>`.
pub const NOT_GIT_REPO_ERROR_CODE: &str = "team_shared_dir_not_git";

pub fn is_not_git_repo_error(msg: &str) -> bool {
    msg.starts_with(NOT_GIT_REPO_ERROR_CODE)
}

pub fn not_git_repo_error(path: &Path) -> anyhow::Error {
    anyhow::anyhow!("{NOT_GIT_REPO_ERROR_CODE}:{}", path.display())
}

pub fn validate_shared_dir_name(name: &str) -> anyhow::Result<()> {
    if name.is_empty() || name.len() > 64 {
        anyhow::bail!("shared_dir_name must be 1-64 characters");
    }
    if name == "." || name == ".." || name.starts_with('.') {
        anyhow::bail!("shared_dir_name cannot be hidden, . or ..");
    }
    if name.contains('/') || name.contains('\\') {
        anyhow::bail!("shared_dir_name cannot contain path separators");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        anyhow::bail!("shared_dir_name contains unsupported characters");
    }
    Ok(())
}

pub fn shared_dir_path(workspace_root: &Path, shared_dir_name: &str) -> anyhow::Result<PathBuf> {
    validate_shared_dir_name(shared_dir_name)?;
    let path = workspace_root.join(shared_dir_name);
    for component in path.components() {
        if matches!(component, Component::ParentDir) {
            anyhow::bail!("shared directory path cannot contain ..");
        }
    }
    if !path.starts_with(workspace_root) {
        anyhow::bail!("shared directory must stay inside workspace");
    }
    Ok(path)
}

fn git(args: &[&str], cwd: &Path) -> anyhow::Result<(bool, String, String)> {
    git_env(args, cwd, &[])
}

fn git_owned(args: &[String], cwd: &Path) -> anyhow::Result<(bool, String, String)> {
    git_owned_env(args, cwd, &[])
}

fn git_env(
    args: &[&str],
    cwd: &Path,
    extra_env: &[(String, String)],
) -> anyhow::Result<(bool, String, String)> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0");
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let output = cmd.output()?;
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

fn git_owned_env(
    args: &[String],
    cwd: &Path,
    extra_env: &[(String, String)],
) -> anyhow::Result<(bool, String, String)> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0");
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let output = cmd.output()?;
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

/// Single-quote a path for embedding in a shell command. The path is
/// daemon-controlled so simple `'...'` quoting (escaping embedded quotes) is fine.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Write `pem` to `dir/.ssh_key` (0600 on unix) and build the env vars git
/// needs to use it: `GIT_SSH_COMMAND` pointing at the key with
/// `IdentitiesOnly=yes`, `StrictHostKeyChecking=accept-new`, and
/// `BatchMode=yes`. `BatchMode=yes` guarantees ssh never blocks on an
/// interactive prompt — a passphrase-protected key (which the daemon cannot
/// unlock non-interactively) fails fast with a clear error instead of hanging
/// the whole sync waiting on a TTY that will never arrive.
fn ssh_env_for_key(pem: &str, dir: &Path) -> anyhow::Result<Vec<(String, String)>> {
    std::fs::create_dir_all(dir)?;
    let key_path = dir.join(".ssh_key");
    std::fs::write(&key_path, pem)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))?;
    }
    let ssh_cmd = format!(
        "ssh -i {} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes",
        shell_quote(&key_path.to_string_lossy())
    );
    Ok(vec![("GIT_SSH_COMMAND".to_string(), ssh_cmd)])
}

/// True when `url` is an SSH git remote (`git@host:org/repo.git` scp-style or
/// `ssh://…`). HTTPS/HTTP remotes never match.
fn is_ssh_remote(url: &str) -> bool {
    let u = url.trim();
    if u.starts_with("http://") || u.starts_with("https://") {
        return false;
    }
    u.starts_with("ssh://") || (u.contains('@') && u.contains(':'))
}

/// `GIT_SSH_COMMAND` for an SSH remote with NO daemon-injected key: reuse the
/// local machine's SSH setup (`~/.ssh/config`, default identities, and a
/// running ssh-agent) so the user never has to paste a private key. `BatchMode=yes`
/// keeps it fully non-interactive (no password/passphrase prompt — fails fast
/// instead) and `accept-new` trusts a first-seen host key without prompting.
fn ssh_env_local() -> Vec<(String, String)> {
    vec![(
        "GIT_SSH_COMMAND".to_string(),
        "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes".to_string(),
    )]
}

fn embed_token_in_url(url: &str, token: Option<&str>) -> String {
    let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) else {
        return url.to_string();
    };
    // A credential that already carries a username (`user:token`, e.g. CodeUp
    // managed-git, which authenticates as `<botUsername>:<pat>`) is embedded as
    // the URL userinfo verbatim. A bare token falls back to the GitLab-style
    // `oauth2:<token>` form used by generic custom-git HTTPS remotes.
    let userinfo = if token.contains(':') {
        token.to_string()
    } else {
        format!("oauth2:{token}")
    };
    if let Some(rest) = url.strip_prefix("https://") {
        format!("https://{userinfo}@{rest}")
    } else if let Some(rest) = url.strip_prefix("http://") {
        format!("http://{userinfo}@{rest}")
    } else {
        url.to_string()
    }
}

fn current_branch(team_dir: &Path, fallback: Option<&str>) -> String {
    if let Some(branch) = fallback.filter(|b| !b.trim().is_empty()) {
        return branch.to_string();
    }
    let (ok, stdout, _) = git(&["rev-parse", "--abbrev-ref", "HEAD"], team_dir).unwrap_or((
        false,
        String::new(),
        String::new(),
    ));
    if ok && !stdout.trim().is_empty() && stdout.trim() != "HEAD" {
        stdout.trim().to_string()
    } else {
        "main".to_string()
    }
}

fn ensure_scaffold(team_dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(team_dir.join("_secrets"))?;
    Ok(())
}

/// Copy every dirty working-tree path reported by `git status --porcelain` into
/// `backup_root`, preserving relative layout. Returns the relative paths that
/// were successfully backed up. Used as a safety net before `git reset --hard`
/// so un-committed local modifications are never destroyed without a copy (the
/// diff-based conflict backup is empty when HEAD never advanced, e.g. when the
/// auto-commit failed for lack of a git identity).
fn backup_dirty_worktree(team_dir: &Path, backup_root: &Path) -> Vec<String> {
    let (_, status, _) = match git(&["status", "--porcelain"], team_dir) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut backed_up = Vec::new();
    for line in status.lines() {
        if line.len() < 4 {
            continue;
        }
        // Porcelain v1: `XY <path>`; renames render as `orig -> new` — back up
        // the destination path (the one present in the work tree).
        let rest = line[3..].trim();
        let rel = rest.rsplit(" -> ").next().unwrap_or(rest).trim();
        if rel.is_empty() {
            continue;
        }
        let src = team_dir.join(rel);
        if !src.is_file() {
            // Deletions / dirs: nothing to copy.
            continue;
        }
        let dst = backup_root.join(rel);
        if let Some(p) = dst.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        if std::fs::copy(&src, &dst).is_ok() {
            backed_up.push(rel.to_string());
        }
    }
    backed_up
}

fn unix_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn active_git_syncs() -> &'static Mutex<HashSet<PathBuf>> {
    static LOCK: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Debug)]
struct GitSyncGuard {
    team_dir: PathBuf,
}

impl Drop for GitSyncGuard {
    fn drop(&mut self) {
        active_git_syncs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.team_dir);
    }
}

fn acquire_git_sync(team_dir: &Path) -> anyhow::Result<GitSyncGuard> {
    let key = team_dir.to_path_buf();
    let mut set = active_git_syncs()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if !set.insert(key.clone()) {
        anyhow::bail!(
            "team git sync already in progress for {}",
            team_dir.display()
        );
    }
    Ok(GitSyncGuard { team_dir: key })
}

/// True when the team dir is missing or an empty scaffold without `.git`.
/// An existing `.git` (even a broken/partial clone) must never trigger a wipe.
fn needs_initial_clone(team_dir: &Path) -> bool {
    if !team_dir.exists() {
        return true;
    }
    if team_dir.join(".git").exists() {
        return false;
    }
    crate::config::global_team_store::is_scaffold_only(team_dir)
}

/// True when the dir exists, has no `.git`, and holds non-scaffold content.
fn is_non_git_existing_dir(team_dir: &Path) -> bool {
    team_dir.exists()
        && !team_dir.join(".git").exists()
        && !crate::config::global_team_store::is_scaffold_only(team_dir)
}

fn clone_team_dir(
    team_dir: &Path,
    clone_parent: &Path,
    remote_url: &str,
    branch: Option<&str>,
    extra_env: &[(String, String)],
) -> anyhow::Result<()> {
    if team_dir.join(".git").exists() {
        anyhow::bail!(
            "refusing to wipe {}: .git already exists (repair via fetch/pull instead)",
            team_dir.display()
        );
    }
    if team_dir.exists() {
        std::fs::remove_dir_all(team_dir).map_err(|e| {
            anyhow::anyhow!(
                "failed to remove team dir {} before clone: {e}",
                team_dir.display()
            )
        })?;
    }
    std::fs::create_dir_all(clone_parent)?;
    let mut args = vec!["clone".to_string()];
    if let Some(branch) = branch.filter(|b| !b.trim().is_empty()) {
        args.push("-b".to_string());
        args.push(branch.to_string());
    }
    args.push(remote_url.to_string());
    args.push(team_dir.to_string_lossy().to_string());
    let (ok, _, stderr) = git_owned_env(&args, clone_parent, extra_env)?;
    if !ok {
        anyhow::bail!("git clone failed: {}", stderr.trim());
    }
    Ok(())
}

/// Sync a git-backed team dir at an explicit path (used for the global,
/// per-team copy). The dir is created/cloned if missing.
///
/// Thin wrapper that uses no injected credential (falls back to
/// `config.git_token` for the HTTPS URL embed, preserving legacy behavior).
pub fn sync_git_dir(
    team_dir: &Path,
    config: &TeamSharedGitConfig,
) -> anyhow::Result<TeamSharedGitStatus> {
    sync_git_dir_with_cred(team_dir, config, GitCredential::None, GitSyncOptions::default())
}

/// Sync a git-backed team dir at an explicit path, injecting `cred` for remote
/// access. The dir is created/cloned if missing.
///
/// Credential behavior:
/// - `HttpsToken(tok)`: embed `tok` into the HTTPS clone/remote URL.
/// - `SshKey(pem)`: keep the raw (ssh) URL, write the key to a 0600 file
///   OUTSIDE the git work tree (`team_dir.parent()/.ssh_key`) and set
///   `GIT_SSH_COMMAND` on every git invocation.
/// - `None`: legacy behavior — embed `config.git_token` if present, else bare.
pub fn sync_git_dir_with_cred(
    team_dir: &Path,
    config: &TeamSharedGitConfig,
    cred: GitCredential,
    options: GitSyncOptions,
) -> anyhow::Result<TeamSharedGitStatus> {
    let _sync_guard = acquire_git_sync(team_dir)?;
    let Some(git_url) = config.git_url.as_deref().filter(|u| !u.trim().is_empty()) else {
        return Ok(TeamSharedGitStatus {
            shared_dir_path: team_dir.to_path_buf(),
            configured: false,
            synced: false,
            conflict: None,
        });
    };

    let clone_parent = team_dir.parent().unwrap_or(Path::new("."));

    // Resolve the remote URL + any extra env (e.g. GIT_SSH_COMMAND) from the
    // credential. The SSH key file lives in `clone_parent` (the per-team dir),
    // OUTSIDE the git work tree `team_dir`.
    let (remote_url, extra_env): (String, Vec<(String, String)>) = match &cred {
        GitCredential::HttpsToken(tok) => (embed_token_in_url(git_url, Some(tok)), Vec::new()),
        GitCredential::SshKey(pem) => {
            let env = ssh_env_for_key(pem, clone_parent)?;
            (git_url.to_string(), env)
        }
        GitCredential::None if is_ssh_remote(git_url) => {
            // SSH remote, no injected key → reuse the local ~/.ssh / ssh-agent,
            // fully non-interactive (see `ssh_env_local`).
            (git_url.to_string(), ssh_env_local())
        }
        GitCredential::None => (
            embed_token_in_url(git_url, config.git_token.as_deref()),
            Vec::new(),
        ),
    };
    let extra_env = extra_env.as_slice();
    let branch = config.git_branch.as_deref();

    if needs_initial_clone(team_dir) {
        clone_team_dir(team_dir, clone_parent, &remote_url, branch, extra_env)?;
    } else if team_dir.join(".git").exists() {
        let _ = git(&["remote", "set-url", "origin", &remote_url], team_dir);
    } else if is_non_git_existing_dir(team_dir) {
        if options.wipe_non_git {
            clone_team_dir(team_dir, clone_parent, &remote_url, branch, extra_env)?;
        } else {
            return Err(not_git_repo_error(team_dir));
        }
    } else {
        return Err(not_git_repo_error(team_dir));
    }

    ensure_scaffold(team_dir)?;

    let (_, status, _) = git(&["status", "--porcelain"], team_dir)?;
    let had_local_changes = !status.trim().is_empty();
    if had_local_changes {
        let _ = git(&["add", "-A"], team_dir);
        // Supply a fallback local identity via `-c` so the auto-commit succeeds
        // even on a fresh machine with no global `user.name`/`user.email`. Without
        // this, `git commit` fails, the working tree stays dirty, `git pull
        // --rebase` refuses (or the later reset --hard destroys the un-committed
        // edits with an empty diff-based backup). `-c` is inline and does not
        // mutate the user's git config.
        let (committed, _, commit_err) = git(
            &[
                "-c",
                "user.name=amuxd bot",
                "-c",
                "user.email=amuxd@teamclaw.local",
                "commit",
                "-m",
                "chore: daemon sync",
            ],
            team_dir,
        )?;
        if !committed {
            tracing::warn!(
                team_dir = %team_dir.display(),
                error = %commit_err.trim(),
                "daemon auto-commit failed; local changes remain uncommitted (safety-net backup will run before any reset)"
            );
        }
    }

    let branch = current_branch(team_dir, config.git_branch.as_deref());
    let (ok, _, stderr) = git_env(&["fetch", "origin"], team_dir, extra_env)?;
    if !ok {
        anyhow::bail!("git fetch failed: {}", stderr.trim());
    }
    let (ok, _, _stderr) = git_env(
        &["pull", "--rebase", "origin", &branch],
        team_dir,
        extra_env,
    )?;
    let mut conflict_backup: Option<GitConflictBackup> = None;
    if !ok {
        // A rebase conflict left local commits on HEAD diverging from the
        // fetched remote tip. Back those files up BEFORE we hard-reset, so the
        // user can recover their local work. The backup dir lives OUTSIDE the
        // git work tree (team_dir.parent()/.trash) so the next `git add -A`
        // never stages it.
        let _ = git(&["rebase", "--abort"], team_dir);
        let ts = unix_ts();
        let backup_root = team_dir
            .parent()
            .unwrap_or(team_dir)
            .join(".trash")
            .join(ts.to_string());
        let (_, diff, _) = git(
            &["diff", "--name-only", &format!("origin/{branch}"), "HEAD"],
            team_dir,
        )?;
        let mut backed_up = Vec::new();
        for rel in diff.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let src = team_dir.join(rel);
            let dst = backup_root.join(rel);
            if let Some(p) = dst.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            if std::fs::copy(&src, &dst).is_ok() {
                backed_up.push(rel.to_string());
            }
        }
        // Belt-and-suspenders: keep the diverged commit reachable.
        let _ = git_owned(
            &[
                "branch".to_string(),
                format!("teamclaw-conflict-backup/{ts}"),
                "HEAD".to_string(),
            ],
            team_dir,
        );
        // Safety net: the diff-based backup above is EMPTY when HEAD never
        // advanced (e.g. the auto-commit failed and edits are still only in the
        // working tree). Copy any remaining dirty paths BEFORE the destructive
        // reset so no local modification is lost without a backup.
        for rel in backup_dirty_worktree(team_dir, &backup_root) {
            if !backed_up.contains(&rel) {
                backed_up.push(rel);
            }
        }
        let (ok2, _, stderr2) = git(&["reset", "--hard", &format!("origin/{branch}")], team_dir)?;
        if !ok2 {
            anyhow::bail!("git reset --hard after conflict failed: {}", stderr2.trim());
        }
        conflict_backup = Some(GitConflictBackup {
            backed_up,
            backup_dir: Some(backup_root.to_string_lossy().into_owned()),
        });
        tracing::warn!(
            team_dir = %team_dir.display(),
            branch = %branch,
            "git rebase conflict: backed up local changes, hard-reset to origin"
        );
    } else if had_local_changes {
        // Only push on the clean (non-conflict) path. After a conflict reset the
        // local work was discarded, so there is nothing to push.
        let (ok, _, stderr) = git_env(&["push", "origin", &branch], team_dir, extra_env)?;
        if !ok {
            anyhow::bail!("git push failed: {}", stderr.trim());
        }
    }

    Ok(TeamSharedGitStatus {
        shared_dir_path: team_dir.to_path_buf(),
        configured: true,
        synced: true,
        conflict: conflict_backup,
    })
}

/// Backwards-compatible wrapper: sync the team dir located inside a workspace.
pub fn setup_or_sync_shared_dir(
    workspace_root: &Path,
    config: &TeamSharedGitConfig,
) -> anyhow::Result<TeamSharedGitStatus> {
    let team_dir = shared_dir_path(workspace_root, &config.shared_dir_name)?;
    sync_git_dir(&team_dir, config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embed_token_bare_token_uses_oauth2() {
        // Generic custom-git HTTPS remotes pass a bare token → oauth2 userinfo.
        assert_eq!(
            embed_token_in_url("https://example.com/repo.git", Some("tok123")),
            "https://oauth2:tok123@example.com/repo.git"
        );
        assert_eq!(
            embed_token_in_url("http://example.com/repo.git", Some("tok123")),
            "http://oauth2:tok123@example.com/repo.git"
        );
    }

    #[test]
    fn embed_token_user_colon_token_is_verbatim() {
        // Managed-git (CodeUp) delivers `<botUsername>:<pat>` → used verbatim.
        assert_eq!(
            embed_token_in_url(
                "https://codeup.aliyun.com/org/tc-team.git",
                Some("teamclaw:pt-abc")
            ),
            "https://teamclaw:pt-abc@codeup.aliyun.com/org/tc-team.git"
        );
    }

    #[test]
    fn embed_token_none_or_empty_leaves_url_untouched() {
        assert_eq!(
            embed_token_in_url("https://example.com/repo.git", None),
            "https://example.com/repo.git"
        );
        assert_eq!(
            embed_token_in_url("https://example.com/repo.git", Some("   ")),
            "https://example.com/repo.git"
        );
    }

    #[test]
    fn sync_rejects_non_git_dir_without_wipe() {
        let tmp = tempfile::tempdir().unwrap();
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(team_dir.join("skills")).unwrap();
        std::fs::write(team_dir.join("skills/local.md"), "keep me\n").unwrap();

        let config = TeamSharedGitConfig {
            git_url: Some("https://example.com/repo.git".into()),
            git_branch: Some("main".into()),
            git_token: None,
            shared_dir_name: "teamclaw-team".into(),
            env_secret: None,
            enabled: true,
        };
        let err = sync_git_dir_with_cred(&team_dir, &config, GitCredential::None, GitSyncOptions::default())
            .unwrap_err();
        assert!(is_not_git_repo_error(&err.to_string()));
    }

    #[test]
    fn sync_clones_when_global_dir_is_scaffold_only_without_git() {
        let tmp = tempfile::tempdir().unwrap();
        let remote = tmp.path().join("remote.git");
        let work = tmp.path().join("work");
        let team_dir = tmp.path().join("teams").join("t1").join("teamclaw-team");

        run(&["init", "--bare", remote.to_str().unwrap()], tmp.path());
        run(
            &["clone", remote.to_str().unwrap(), work.to_str().unwrap()],
            tmp.path(),
        );
        cfg_identity(&work);
        std::fs::create_dir_all(work.join("skills")).unwrap();
        std::fs::write(work.join("skills/readme.md"), "hi\n").unwrap();
        run(&["add", "-A"], &work);
        run(&["commit", "-m", "init"], &work);
        run(&["push", "origin", "HEAD:refs/heads/main"], &work);

        std::fs::create_dir_all(&team_dir).unwrap();
        for prefix in crate::config::global_team_store::SHARED_PREFIXES {
            std::fs::create_dir_all(team_dir.join(prefix)).unwrap();
        }
        assert!(crate::config::global_team_store::is_scaffold_only(&team_dir));
        assert!(!team_dir.join(".git").exists());

        let config = TeamSharedGitConfig {
            git_url: Some(remote.to_string_lossy().to_string()),
            git_branch: Some("main".into()),
            git_token: None,
            shared_dir_name: "teamclaw-team".into(),
            env_secret: None,
            enabled: true,
        };
        let status = sync_git_dir(&team_dir, &config).unwrap();
        assert!(status.synced);
        assert!(team_dir.join(".git").exists());
        assert!(team_dir.join("skills/readme.md").exists());
    }

    #[test]
    fn needs_initial_clone_is_false_when_git_metadata_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(team_dir.join(".git")).unwrap();
        assert!(!super::needs_initial_clone(&team_dir));
    }

    #[test]
    fn concurrent_git_sync_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();
        let guard = super::acquire_git_sync(&team_dir).unwrap();
        let err = super::acquire_git_sync(&team_dir).unwrap_err();
        assert!(err.to_string().contains("already in progress"));
        drop(guard);
        assert!(super::acquire_git_sync(&team_dir).is_ok());
    }

    #[test]
    fn sync_git_dir_returns_not_configured_without_url() {
        let tmp = tempfile::tempdir().unwrap();
        let team_dir = tmp.path().join("teamclaw-team");
        std::fs::create_dir_all(&team_dir).unwrap();
        let config: TeamSharedGitConfig = serde_json::from_value(serde_json::json!({
            "enabled": true
        }))
        .unwrap();
        let status = sync_git_dir(&team_dir, &config).unwrap();
        assert_eq!(status.shared_dir_path, team_dir);
        assert!(!status.configured);
        assert!(!status.synced);
    }

    #[test]
    fn ssh_credential_writes_0600_key_and_builds_git_ssh_command() {
        let tmp = tempfile::tempdir().unwrap();
        let pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n";
        let envs = ssh_env_for_key(pem, tmp.path()).unwrap();
        let (_, ssh_cmd) = envs
            .iter()
            .find(|(k, _)| k == "GIT_SSH_COMMAND")
            .expect("GIT_SSH_COMMAND");
        assert!(ssh_cmd.contains("ssh -i "), "ssh_cmd={ssh_cmd}");
        assert!(ssh_cmd.contains("IdentitiesOnly=yes"), "ssh_cmd={ssh_cmd}");
        assert!(
            ssh_cmd.contains("StrictHostKeyChecking=accept-new"),
            "ssh_cmd={ssh_cmd}"
        );
        // BatchMode keeps a passphrase-protected key from hanging the sync on a
        // TTY prompt that will never arrive.
        assert!(ssh_cmd.contains("BatchMode=yes"), "ssh_cmd={ssh_cmd}");

        // Extract the key path from `-i <path>` (single-quoted).
        let after = ssh_cmd.split("ssh -i ").nth(1).expect("`ssh -i ` prefix");
        let key_path = after
            .strip_prefix('\'')
            .and_then(|s| s.split('\'').next())
            .expect("single-quoted key path");
        let key_path = std::path::Path::new(key_path);
        assert!(key_path.exists(), "key file should exist at {key_path:?}");
        assert_eq!(
            std::fs::read_to_string(key_path).unwrap(),
            pem,
            "key file must contain the PEM"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(key_path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "key file must be 0600, got {mode:o}");
        }
    }

    #[test]
    fn is_ssh_remote_classifies_urls() {
        assert!(is_ssh_remote("git@github.com:org/repo.git"));
        assert!(is_ssh_remote("ssh://git@host.example.com/org/repo.git"));
        assert!(is_ssh_remote("user@gitlab.internal:team/repo.git"));
        assert!(!is_ssh_remote("https://github.com/org/repo.git"));
        assert!(!is_ssh_remote("http://host/org/repo.git"));
        // HTTPS with userinfo must not be misread as SSH.
        assert!(!is_ssh_remote("https://oauth2:tok@host/org/repo.git"));
    }

    #[test]
    fn ssh_env_local_is_non_interactive_and_keyless() {
        let envs = ssh_env_local();
        let (_, ssh_cmd) = envs
            .iter()
            .find(|(k, _)| k == "GIT_SSH_COMMAND")
            .expect("GIT_SSH_COMMAND");
        // No injected key → reuse the local ~/.ssh / agent.
        assert!(!ssh_cmd.contains("-i "), "ssh_cmd={ssh_cmd}");
        assert!(!ssh_cmd.contains("IdentitiesOnly"), "ssh_cmd={ssh_cmd}");
        // Never blocks on a prompt.
        assert!(ssh_cmd.contains("BatchMode=yes"), "ssh_cmd={ssh_cmd}");
        assert!(
            ssh_cmd.contains("StrictHostKeyChecking=accept-new"),
            "ssh_cmd={ssh_cmd}"
        );
    }

    #[test]
    fn rebase_conflict_backs_up_local_before_reset() {
        let tmp = tempfile::tempdir().unwrap();
        let remote = tmp.path().join("remote.git");
        let work_a = tmp.path().join("a");
        let team_dir = tmp.path().join("team");

        // bare remote
        run(&["init", "--bare", remote.to_str().unwrap()], tmp.path());
        // author clone: commit skills/x.md=remoteA, push
        run(
            &["clone", remote.to_str().unwrap(), work_a.to_str().unwrap()],
            tmp.path(),
        );
        cfg_identity(&work_a);
        std::fs::create_dir_all(work_a.join("skills")).unwrap();
        std::fs::write(work_a.join("skills/x.md"), "remoteA\n").unwrap();
        run(&["add", "-A"], &work_a);
        run(&["commit", "-m", "a1"], &work_a);
        run(&["push", "origin", "HEAD:refs/heads/main"], &work_a);
        // team clone of main
        run(
            &[
                "clone",
                "-b",
                "main",
                remote.to_str().unwrap(),
                team_dir.to_str().unwrap(),
            ],
            tmp.path(),
        );
        cfg_identity(&team_dir);
        // local DIRTY change (sync_git_dir will commit it, then conflict on pull)
        std::fs::write(team_dir.join("skills/x.md"), "localB\n").unwrap();
        // author pushes a conflicting change to the same file
        std::fs::write(work_a.join("skills/x.md"), "remoteB\n").unwrap();
        run(&["add", "-A"], &work_a);
        run(&["commit", "-m", "a2"], &work_a);
        run(&["push", "origin", "HEAD:refs/heads/main"], &work_a);

        let config = TeamSharedGitConfig {
            git_url: Some(remote.to_string_lossy().to_string()),
            git_branch: Some("main".into()),
            git_token: None,
            shared_dir_name: "teamclaw".into(),
            env_secret: None,
            enabled: true,
        };
        let status = sync_git_dir(&team_dir, &config).unwrap();
        let conflict = status.conflict.expect("expected a conflict backup");
        assert!(
            conflict
                .backed_up
                .iter()
                .any(|p| p.ends_with("skills/x.md")),
            "backed_up={:?}",
            conflict.backed_up
        );
        let backup_dir = conflict.backup_dir.expect("backup dir");
        let backed = std::path::Path::new(&backup_dir).join("skills/x.md");
        assert!(backed.exists(), "backup file should exist at {backed:?}");
        assert_eq!(
            std::fs::read_to_string(&backed).unwrap(),
            "localB\n",
            "backup must preserve LOCAL content"
        );
        // working tree now has remote content
        assert_eq!(
            std::fs::read_to_string(team_dir.join("skills/x.md")).unwrap(),
            "remoteB\n"
        );
        // backup dir must be OUTSIDE the git work tree
        assert!(
            !std::path::Path::new(&backup_dir).starts_with(&team_dir),
            "backup dir {backup_dir} must live outside the git work tree {team_dir:?}"
        );
    }

    // Same conflict scenario but the team dir has NO configured git identity,
    // so the daemon auto-commit must fall back to its inline `-c` identity.
    // Regression for FIX 3: without the fallback the commit fails, the edit is
    // never committed, and the destructive reset used to run with an empty
    // diff-based backup. The safety net + fallback identity must preserve the
    // local content.
    #[test]
    fn rebase_conflict_without_git_identity_still_backs_up_local() {
        let tmp = tempfile::tempdir().unwrap();
        let remote = tmp.path().join("remote.git");
        let work_a = tmp.path().join("a");
        let team_dir = tmp.path().join("team");

        run(&["init", "--bare", remote.to_str().unwrap()], tmp.path());
        run(
            &["clone", remote.to_str().unwrap(), work_a.to_str().unwrap()],
            tmp.path(),
        );
        cfg_identity(&work_a);
        std::fs::create_dir_all(work_a.join("skills")).unwrap();
        std::fs::write(work_a.join("skills/x.md"), "remoteA\n").unwrap();
        run(&["add", "-A"], &work_a);
        run(&["commit", "-m", "a1"], &work_a);
        run(&["push", "origin", "HEAD:refs/heads/main"], &work_a);
        run(
            &[
                "clone",
                "-b",
                "main",
                remote.to_str().unwrap(),
                team_dir.to_str().unwrap(),
            ],
            tmp.path(),
        );
        // NOTE: deliberately do NOT call cfg_identity(&team_dir).
        std::fs::write(team_dir.join("skills/x.md"), "localB\n").unwrap();
        std::fs::write(work_a.join("skills/x.md"), "remoteB\n").unwrap();
        run(&["add", "-A"], &work_a);
        run(&["commit", "-m", "a2"], &work_a);
        run(&["push", "origin", "HEAD:refs/heads/main"], &work_a);

        let config = TeamSharedGitConfig {
            git_url: Some(remote.to_string_lossy().to_string()),
            git_branch: Some("main".into()),
            git_token: None,
            shared_dir_name: "teamclaw".into(),
            env_secret: None,
            enabled: true,
        };
        let status = sync_git_dir(&team_dir, &config).unwrap();
        let conflict = status.conflict.expect("expected a conflict backup");
        let backup_dir = conflict.backup_dir.expect("backup dir");
        let backed = std::path::Path::new(&backup_dir).join("skills/x.md");
        assert!(
            backed.exists(),
            "local edit must be backed up even without a git identity"
        );
        assert_eq!(
            std::fs::read_to_string(&backed).unwrap(),
            "localB\n",
            "backup must preserve LOCAL content"
        );
    }

    // test helpers
    fn run(args: &[&str], cwd: &std::path::Path) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    fn cfg_identity(repo: &std::path::Path) {
        run(&["config", "user.email", "t@t"], repo);
        run(&["config", "user.name", "t"], repo);
    }

    #[test]
    fn rejects_unsafe_shared_dir_names() {
        for value in ["", ".", "..", ".hidden", "../bad", "bad/name"] {
            assert!(validate_shared_dir_name(value).is_err(), "{value}");
        }
    }

    #[test]
    fn resolves_shared_dir_under_workspace() {
        let path = shared_dir_path(Path::new("/tmp/workspace"), "teamclaw").unwrap();
        assert_eq!(path, PathBuf::from("/tmp/workspace/teamclaw"));
    }

    #[test]
    fn deserializes_workspace_team_config_shape() {
        let config: TeamSharedGitConfig = serde_json::from_value(serde_json::json!({
            "gitUrl": "https://example.com/repo.git",
            "gitBranch": "main",
            "gitToken": "token",
            "sharedDirName": "teamclaw",
            "envSecret": "00",
            "enabled": true
        }))
        .unwrap();

        assert_eq!(
            config.git_url.as_deref(),
            Some("https://example.com/repo.git")
        );
        assert_eq!(config.git_branch.as_deref(), Some("main"));
        assert_eq!(config.git_token.as_deref(), Some("token"));
        assert_eq!(config.shared_dir_name, "teamclaw");
        assert_eq!(config.env_secret.as_deref(), Some("00"));
        assert!(config.enabled);
    }
}

use std::path::Path;
use std::process::Command;

fn worktree_has_content(workdir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(workdir) else {
        return false;
    };
    entries
        .filter_map(|e| e.ok())
        .any(|e| e.file_name() != ".git")
}

fn clone_template(workdir: &Path, template_url: &str, parent: &Path) -> anyhow::Result<()> {
    if workdir.exists() {
        std::fs::remove_dir_all(workdir)?;
    }
    let wd = workdir.to_string_lossy();
    let shallow_ok = run_git(&["clone", "--depth=1", template_url, wd.as_ref()], parent).is_ok()
        && worktree_has_content(workdir);
    if !shallow_ok {
        if workdir.exists() {
            std::fs::remove_dir_all(workdir)?;
        }
        run_git(&["clone", template_url, wd.as_ref()], parent)?;
    }
    if !worktree_has_content(workdir) {
        anyhow::bail!("template clone produced an empty worktree");
    }
    Ok(())
}

/// Seed a freshly-created (empty) app repo from a GitHub template:
/// clone template (depth=1) → strip history → reinit → push to target.
///
/// The resulting repo contains only a single "scaffold" commit with no
/// connection to the template's git history.
pub fn seed_app_repo(
    workdir: &Path,
    remote_url: &str,
    template_url: &str,
    token: Option<&str>,
) -> anyhow::Result<()> {
    let target_url = embed(remote_url, token);
    let parent = workdir
        .parent()
        .ok_or_else(|| anyhow::anyhow!("workdir has no parent"))?;

    // 1. Shallow-clone the template into workdir (full clone fallback when shallow
    //    leaves an empty worktree — common for file:// bare repos on Linux CI).
    clone_template(workdir, template_url, parent)?;

    // 2. Strip the template's git history so the new repo starts fresh.
    std::fs::remove_dir_all(workdir.join(".git"))?;
    run_git(&["init", "--initial-branch=main"], workdir)?;

    let wd = workdir.to_string_lossy().to_string();
    run_git(
        &["-C", &wd, "config", "user.email", "daemon@teamclaw"],
        workdir,
    )?;
    run_git(
        &["-C", &wd, "config", "user.name", "teamclaw-daemon"],
        workdir,
    )?;
    run_git(&["-C", &wd, "add", "-A"], workdir)?;
    run_git(
        &[
            "-C",
            &wd,
            "-c",
            "user.email=daemon@teamclaw",
            "-c",
            "user.name=teamclaw-daemon",
            "commit",
            "-m",
            "chore: scaffold app template",
        ],
        workdir,
    )?;

    // 3. Push to the managed-git target.
    run_git(
        &["-C", &wd, "remote", "add", "origin", &target_url],
        workdir,
    )?;
    run_git(
        &["-C", &wd, "push", "-u", "origin", "HEAD:refs/heads/main"],
        workdir,
    )?;

    Ok(())
}

fn embed(url: &str, token: Option<&str>) -> String {
    match token.map(str::trim).filter(|t| !t.is_empty()) {
        Some(tok) => {
            let userinfo = if tok.contains(':') {
                tok.to_string()
            } else {
                format!("oauth2:{tok}")
            };
            if let Some(rest) = url.strip_prefix("https://") {
                format!("https://{userinfo}@{rest}")
            } else if let Some(rest) = url.strip_prefix("http://") {
                format!("http://{userinfo}@{rest}")
            } else {
                url.to_string()
            }
        }
        None => url.to_string(),
    }
}

/// Mask `scheme://user:secret@host` userinfo so credentials never reach logs.
fn redact(arg: &str) -> String {
    if let Some(scheme_end) = arg.find("://") {
        let after = &arg[scheme_end + 3..];
        let host_rel = after.find('/').unwrap_or(after.len());
        if let Some(at) = after[..host_rel].find('@') {
            return format!("{}://***@{}", &arg[..scheme_end], &after[at + 1..]);
        }
    }
    arg.to_string()
}

fn run_git(args: &[&str], cwd: &Path) -> anyhow::Result<()> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()?;
    if !out.status.success() {
        let safe: Vec<String> = args.iter().map(|a| redact(a)).collect();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        anyhow::bail!("git {:?} failed: {}", safe, detail);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn file_url(path: &Path) -> String {
        let abs: PathBuf = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        format!("file://{}", abs.to_string_lossy())
    }

    fn bare_has_file(bare: &Path, rel: &str) -> bool {
        Command::new("git")
            .args([
                "--git-dir",
                &bare.to_string_lossy(),
                "cat-file",
                "-e",
                &format!("main:{rel}"),
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Smoke-test using a local non-bare template repo and a bare target — no
    /// network required. Template is non-bare (like GitHub); bare file://
    /// shallow clones are unreliable on Linux CI.
    #[test]
    fn seeds_template_into_empty_remote() {
        let tmp = tempfile::tempdir().unwrap();

        let tmpl_dir = tmp.path().join("template");
        run_git(
            &["init", "--initial-branch=main", &tmpl_dir.to_string_lossy()],
            tmp.path(),
        )
        .unwrap();
        std::fs::create_dir_all(tmpl_dir.join("src")).unwrap();
        std::fs::write(tmpl_dir.join("README.md"), "# app").unwrap();
        std::fs::write(tmpl_dir.join("src/main.tsx"), "export {}").unwrap();
        let tmpl_wd = tmpl_dir.to_string_lossy().to_string();
        run_git(
            &[
                "-C",
                &tmpl_wd,
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "add",
                "-A",
            ],
            &tmpl_dir,
        )
        .unwrap();
        run_git(
            &[
                "-C",
                &tmpl_wd,
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-m",
                "init",
            ],
            &tmpl_dir,
        )
        .unwrap();

        let target_bare = tmp.path().join("target.git");
        run_git(
            &["init", "--bare", &target_bare.to_string_lossy()],
            tmp.path(),
        )
        .unwrap();

        let work = tmp.path().join("work");
        seed_app_repo(&work, &file_url(&target_bare), &file_url(&tmpl_dir), None).unwrap();

        assert!(bare_has_file(&target_bare, "README.md"));
        assert!(bare_has_file(&target_bare, "src/main.tsx"));
    }

    #[test]
    fn redacts_credentials_in_urls() {
        assert_eq!(
            redact("https://oauth2:secrettoken@codeup.example.com/x.git"),
            "https://***@codeup.example.com/x.git"
        );
        assert_eq!(
            redact("https://codeup.example.com/x.git"),
            "https://codeup.example.com/x.git"
        );
        assert_eq!(redact("clone"), "clone");
    }
}

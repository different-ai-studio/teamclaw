//! Seed an app checkout: write the starter template, then make it a git repo.
//!
//! There is no remote. Seeding used to create a managed-git repo, clone a
//! GitHub template into it and push — three network round trips and a
//! credential, none of which the deploy path uses (`app_build` builds whatever
//! is in this directory). What remains is a local `git init` + first commit,
//! which is what actually matters while an agent edits these files: `git diff`
//! and a way back. Adding a remote later is `git remote add` + push.

use std::path::Path;
use std::process::Command;

use crate::sync::app_templates::{write_template, TemplateVars};

/// Write the template into `workdir` and commit it as the initial revision.
///
/// `workdir` is created if missing. Re-seeding an existing checkout restores
/// the starter files over the top and commits the difference, so a wrecked app
/// can be reset without losing its history.
pub fn seed_app_repo(workdir: &Path, vars: &TemplateVars<'_>) -> anyhow::Result<()> {
    write_template(workdir, vars)?;

    let wd = workdir.to_string_lossy().to_string();
    if !workdir.join(".git").exists() {
        run_git(&["init", "--initial-branch=main"], workdir)?;
        run_git(
            &["-C", &wd, "config", "user.email", "daemon@teamclaw"],
            workdir,
        )?;
        run_git(
            &["-C", &wd, "config", "user.name", "teamclaw-daemon"],
            workdir,
        )?;
    }
    run_git(&["-C", &wd, "add", "-A"], workdir)?;
    // Nothing to commit is a success: re-seeding an untouched checkout is a
    // no-op, and `git commit` exits non-zero on an empty index.
    if git_has_staged_changes(workdir) {
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
    }
    Ok(())
}

fn git_has_staged_changes(workdir: &Path) -> bool {
    Command::new("git")
        .args(["diff", "--cached", "--quiet"])
        .current_dir(workdir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .status()
        .map(|s| !s.success())
        .unwrap_or(true)
}

fn run_git(args: &[&str], cwd: &Path) -> anyhow::Result<()> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        anyhow::bail!("git {:?} failed: {}", args, detail);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::app_templates::AppType;

    fn vars<'a>(app_type: AppType) -> TemplateVars<'a> {
        TemplateVars {
            app_id: "app-1",
            app_name: "Demo",
            app_type,
        }
    }

    fn head_files(workdir: &Path) -> Vec<String> {
        let out = Command::new("git")
            .args([
                "-C",
                &workdir.to_string_lossy(),
                "ls-tree",
                "-r",
                "--name-only",
                "HEAD",
            ])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn seeds_a_committed_checkout_with_no_remote() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        seed_app_repo(&work, &vars(AppType::StaticWeb)).unwrap();

        let files = head_files(&work);
        assert!(files.iter().any(|f| f == "AGENTS.md"), "{files:?}");
        assert!(files.iter().any(|f| f == "public/index.html"), "{files:?}");

        let remotes = Command::new("git")
            .args(["-C", &work.to_string_lossy(), "remote"])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&remotes.stdout).trim().is_empty(),
            "no remote is configured"
        );
    }

    fn commit_count(workdir: &Path) -> usize {
        let out = Command::new("git")
            .args([
                "-C",
                &workdir.to_string_lossy(),
                "rev-list",
                "--count",
                "HEAD",
            ])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
    }

    #[test]
    fn reseeding_restores_a_wrecked_file_and_keeps_history() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        seed_app_repo(&work, &vars(AppType::StaticWeb)).unwrap();
        std::fs::write(work.join("public/index.html"), "wrecked").unwrap();

        seed_app_repo(&work, &vars(AppType::StaticWeb)).unwrap();
        let restored = std::fs::read_to_string(work.join("public/index.html")).unwrap();
        assert!(restored.contains("Demo"), "starter content is back");
        // Restoring the file to exactly what HEAD already has leaves nothing to
        // commit — the point is that the scaffold commit is still there and was
        // not reset away.
        assert_eq!(commit_count(&work), 1);
    }

    #[test]
    fn work_the_agent_did_is_committed_by_a_reseed_not_destroyed() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        seed_app_repo(&work, &vars(AppType::StaticWeb)).unwrap();
        std::fs::write(work.join("public/about.html"), "<h1>agent wrote this</h1>").unwrap();

        seed_app_repo(&work, &vars(AppType::StaticWeb)).unwrap();
        assert!(
            work.join("public/about.html").is_file(),
            "a file the template does not know about survives"
        );
        assert_eq!(commit_count(&work), 2, "and lands in a commit");
    }

    #[test]
    fn reseeding_an_untouched_checkout_is_a_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        seed_app_repo(&work, &vars(AppType::Slides)).unwrap();
        // `git commit` exits non-zero with nothing staged; this must not fail.
        seed_app_repo(&work, &vars(AppType::Slides)).unwrap();
    }
}

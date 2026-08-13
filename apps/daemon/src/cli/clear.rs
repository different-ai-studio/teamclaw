use crate::config::DaemonConfig;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

/// Wipe every file the daemon writes to its config dir. Keeps the directory
/// itself in place.
pub fn run(force: bool) -> anyhow::Result<()> {
    let config_dir = DaemonConfig::config_dir();
    run_at(force, &DaemonConfig::lock_path(), candidate_paths())
        .map_err(|e| anyhow::anyhow!("cannot clear {}: {e}", config_dir.display()))
}

fn run_at(force: bool, lock_path: &std::path::Path, paths: Vec<PathBuf>) -> anyhow::Result<()> {
    let existing: Vec<_> = paths.into_iter().filter(|p| p.exists()).collect();

    if existing.is_empty() {
        println!("Nothing to clear.");
        return Ok(());
    }

    // Deleting identity files while a daemon is alive is unsafe: that process
    // still owns the old credentials in memory and can recreate backend.toml
    // on its next refresh-token rotation. Only take the lock once there is
    // something to remove — otherwise a no-op clear would fail with "already
    // running" whenever amuxd is up.
    let _daemon_lock = crate::cli::process::acquire_daemon_lock_at(lock_path, Duration::ZERO)?;

    // Paths are printed in full: they can span the config dir AND the legacy dir.
    println!("Will remove {} file(s):", existing.len());
    for p in &existing {
        println!("  - {}", p.display());
    }

    if !force {
        print!("Proceed? [y/N]: ");
        std::io::stdout().flush()?;
        let mut buf = String::new();
        std::io::stdin().read_line(&mut buf)?;
        let answer = buf.trim().to_lowercase();
        if answer != "y" && answer != "yes" {
            println!("Aborted.");
            return Ok(());
        }
    }

    let mut failed: Vec<String> = Vec::new();
    for p in existing {
        // The team's state is a directory now, so this removes trees as well as
        // files — that is the point of the layout: one path is the whole team.
        let outcome = if p.is_dir() {
            fs::remove_dir_all(&p)
        } else {
            fs::remove_file(&p)
        };
        match outcome {
            Ok(()) => println!("✓ removed {}", p.display()),
            Err(e) => {
                eprintln!("✗ {}: {e}", p.display());
                failed.push(format!("{}: {e}", p.display()));
            }
        }
    }

    // Report removal failures instead of exiting 0. The desktop app only checks
    // the exit code, so swallowing these left the UI insisting the daemon was
    // still bound to the old team with no error to show — a silent stuck loop.
    if !failed.is_empty() {
        anyhow::bail!(
            "failed to remove {} file(s):\n  {}",
            failed.len(),
            failed.join("\n  ")
        );
    }

    println!("Done. Run `amuxd init <teamclu://invite?token=...>` to re-onboard.");
    Ok(())
}

/// What `clear` removes: this daemon's identity, and the team it belongs to.
///
/// Two entries, because the layout made it two. Everything team-scoped lives
/// under `teams/<id>/`, so removing that directory takes the cloud credentials,
/// the per-team encryption key and the sealed secrets, the runtime index, the
/// session store and the event history in one operation — no list to keep in
/// sync with what the daemon actually writes.
///
/// The old list had drifted badly in both directions: it named
/// `workspaces.toml`, which had had no writer since the WorkspaceStore removal,
/// while leaving behind the cloud token, the HTTP token, `secret.key`,
/// `team-secrets/`, `teams/` and the collab session store. "Cleared" then
/// re-onboarded on top of a half-populated identity.
///
/// Deliberately kept: `device-id` (a machine identity, re-derived from hardware
/// anyway), `cache/`, and `logs/` — none of them bind this machine to a team.
fn candidate_paths() -> Vec<PathBuf> {
    vec![
        crate::config::layout::team_dir(&crate::config::layout::active_team()),
        DaemonConfig::default_path(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The identity `clear` exists to remove: the team's whole directory, and
    /// the config naming it.
    ///
    /// This replaces a regression test for the legacy config dir. That dir was
    /// a removal target only because `migrate_legacy_file` copied
    /// `<legacy>/daemon.toml` back over a cleared one, so switching teams looped
    /// on "This machine's agent belongs to another team". Both the copier and
    /// the directory are gone (ADR-0006), so there is nothing left to resurrect.
    #[test]
    fn candidate_paths_cover_the_team_and_the_config() {
        let _lock = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let paths = candidate_paths();

        assert!(
            paths.contains(&DaemonConfig::default_path()),
            "daemon.toml names the team, so it must go; got {paths:?}"
        );
        assert!(
            paths.contains(&crate::config::layout::team_dir(
                &crate::config::layout::active_team()
            )),
            "the team directory holds the credentials and the sealed secrets; \
             got {paths:?}"
        );
    }

    #[test]
    fn candidate_paths_have_no_duplicates() {
        let mut paths = candidate_paths();
        let before = paths.len();
        paths.sort();
        paths.dedup();
        assert_eq!(
            before,
            paths.len(),
            "candidate_paths must not list a path twice"
        );
    }

    #[test]
    fn clear_refuses_to_delete_config_while_daemon_lock_is_held() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("amuxd.lock");
        let config_path = dir.path().join("backend.toml");
        std::fs::write(&config_path, "new identity").unwrap();

        let held_lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .unwrap();
        held_lock.lock().unwrap();

        let error = run_at(true, &lock_path, vec![config_path.clone()]).unwrap_err();

        assert!(error.to_string().contains("already running"));
        assert_eq!(
            std::fs::read_to_string(config_path).unwrap(),
            "new identity"
        );
    }

    #[test]
    fn clear_noop_succeeds_even_when_daemon_lock_is_held() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("amuxd.lock");

        let held_lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .unwrap();
        held_lock.lock().unwrap();

        run_at(true, &lock_path, vec![dir.path().join("missing.toml")]).unwrap();
    }
}

use crate::config::DaemonConfig;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

/// Wipe every file the daemon writes to its config dir. Keeps the directory
/// itself in place.
pub fn run(force: bool) -> anyhow::Result<()> {
    let config_dir = DaemonConfig::config_dir();
    let paths = candidate_paths();
    let existing: Vec<_> = paths.into_iter().filter(|p| p.exists()).collect();

    if existing.is_empty() {
        println!("Nothing to clear under {}.", config_dir.display());
        return Ok(());
    }

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
        match fs::remove_file(&p) {
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

    println!("Done. Run `amuxd init <teamclaw://invite?token=...>` to re-onboard.");
    Ok(())
}

/// Every file `clear` must remove, in BOTH the current config dir and the legacy
/// one.
///
/// The legacy dir is not optional housekeeping: `DaemonConfig::migrate_legacy_file`
/// copies `<legacy>/daemon.toml` back to `<config>/daemon.toml` whenever the
/// latter is missing, and `default_path()` calls it on essentially every daemon
/// entry point — including `amuxd init` itself. Clearing only the config dir
/// therefore deleted the file and had it resurrected, stale `team_id` and all,
/// by the very next command. Switching teams then looped forever on
/// "This machine's agent belongs to another team".
fn candidate_paths() -> Vec<PathBuf> {
    const FILES: [&str; 5] = [
        "daemon.toml",
        "members.toml",
        "sessions.toml",
        "workspaces.toml",
        "backend.toml",
    ];
    let dir = DaemonConfig::config_dir();
    let legacy = DaemonConfig::legacy_config_dir();

    let mut out: Vec<PathBuf> = Vec::with_capacity(FILES.len() * 2);
    for f in FILES {
        out.push(dir.join(f));
        // legacy_config_dir() falls back to config_dir() when the platform has
        // no config dir, so guard against listing the same path twice.
        if legacy != dir {
            out.push(legacy.join(f));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: `clear` used to list only the config dir, so
    /// `migrate_legacy_file` copied `<legacy>/daemon.toml` straight back and the
    /// desktop app looped forever on "This machine's agent belongs to another
    /// team". The legacy copy MUST be a removal target.
    #[test]
    fn candidate_paths_cover_the_legacy_dir() {
        let legacy = DaemonConfig::legacy_config_dir();
        let dir = DaemonConfig::config_dir();
        if legacy == dir {
            return; // platform without a distinct config dir; nothing to assert
        }
        let paths = candidate_paths();
        assert!(
            paths.contains(&legacy.join("daemon.toml")),
            "legacy daemon.toml must be cleared or it resurrects the old team_id; got {paths:?}"
        );
        assert!(paths.contains(&dir.join("daemon.toml")));
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
}

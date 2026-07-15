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

    println!(
        "Will remove {} file(s) under {}:",
        existing.len(),
        config_dir.display()
    );
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

    for p in existing {
        match fs::remove_file(&p) {
            Ok(()) => println!("✓ removed {}", p.display()),
            Err(e) => eprintln!("✗ {}: {e}", p.display()),
        }
    }
    println!("Done. Run `amuxd init <teamclaw://invite?token=...>` to re-onboard.");
    Ok(())
}

fn candidate_paths() -> Vec<PathBuf> {
    let dir = DaemonConfig::config_dir();
    vec![
        dir.join("daemon.toml"),
        dir.join("members.toml"),
        dir.join("sessions.toml"),
        dir.join("workspaces.toml"),
        dir.join("backend.toml"),
    ]
}

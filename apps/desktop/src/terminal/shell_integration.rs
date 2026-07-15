//! Materializes the shell integration rc files into a process-scoped temp
//! directory so PTY spawns can point zsh/bash at them. Files are written
//! lazily on first use; if writing fails, integration is silently skipped
//! and the shell still works as a plain PTY.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const ZSH_RC: &str = include_str!("shell_integration/teamclaw.zshrc");
const BASH_RC: &str = include_str!("shell_integration/teamclaw-bashrc.sh");

const ZSH_FILE: &str = ".zshrc";
const BASH_FILE: &str = "teamclaw-bashrc.sh";

static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Returns the directory containing the shell integration rc files,
/// materializing them on first call. Returns `None` if the filesystem
/// is read-only or the temp dir cannot be created — callers should fall
/// through to a vanilla shell launch.
pub fn ensure_dir() -> Option<&'static Path> {
    DIR.get_or_init(|| materialize().ok())
        .as_deref()
        .map(|p| p as &Path)
}

/// Path to the bash rc file (only valid after [`ensure_dir`] succeeds).
pub fn bash_rc_path(dir: &Path) -> PathBuf {
    dir.join(BASH_FILE)
}

fn materialize() -> std::io::Result<PathBuf> {
    let pid = std::process::id();
    let dir = std::env::temp_dir().join(format!("teamclaw-shell-{pid}"));
    std::fs::create_dir_all(&dir)?;
    write_if_changed(&dir.join(ZSH_FILE), ZSH_RC)?;
    write_if_changed(&dir.join(BASH_FILE), BASH_RC)?;
    Ok(dir)
}

fn write_if_changed(path: &Path, content: &str) -> std::io::Result<()> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
    }
    let mut f = std::fs::File::create(path)?;
    f.write_all(content.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_dir_creates_both_files() {
        let dir = ensure_dir().expect("integration dir");
        assert!(dir.join(ZSH_FILE).exists(), "missing zsh rc");
        assert!(dir.join(BASH_FILE).exists(), "missing bash rc");
        // Second call is a no-op and returns the same path.
        let dir2 = ensure_dir().expect("integration dir 2");
        assert_eq!(dir, dir2);
    }

    #[test]
    fn zsh_rc_contains_osc_633_markers() {
        assert!(ZSH_RC.contains("\\e]633;A"));
        assert!(ZSH_RC.contains("\\e]633;B"));
        assert!(ZSH_RC.contains("\\e]633;D"));
        assert!(ZSH_RC.contains("\\e]633;E"));
        assert!(ZSH_RC.contains("\\e]633;P;Cwd="));
    }

    #[test]
    fn bash_rc_contains_osc_633_markers() {
        assert!(BASH_RC.contains("\\e]633;A"));
        assert!(BASH_RC.contains("\\e]633;B"));
        assert!(BASH_RC.contains("\\e]633;D"));
        assert!(BASH_RC.contains("\\e]633;P;Cwd="));
    }
}

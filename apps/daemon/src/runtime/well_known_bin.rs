//! Absolute-path fallbacks for the CLIs amuxd shells out to.
//!
//! A GUI-launched daemon does not get the user's shell PATH. macOS hands a
//! process started from Dock/Spotlight the bare system PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), which contains none of the places these
//! tools actually install into. The desktop app tries to repair that before
//! spawning us (`fix_path_env` in `apps/desktop/src/lib.rs`), but that probe has
//! a 4-second timeout and a shell-profile-mtime cache, so a slow or unusual
//! profile leaves us with the bare system PATH.
//!
//! The symptom is a runtime that works perfectly in a terminal yet reports
//! "not installed" in the app. opencode never had it, because it resolves
//! `~/.opencode/bin/opencode` by absolute path before falling back to the bare
//! name. This generalizes that step for the runtimes that only had the bare
//! name (claude) or a single home-relative directory (pi).
//!
//! Deliberately a fixed list rather than a filesystem crawl: it runs on every
//! `doctor` call and on the spawn path, so it must stay cheap and predictable.

use std::path::{Path, PathBuf};

/// Directories to search, in order. Home-relative first — a user-local install
/// is the one they chose most recently — then the system-wide package roots.
///
/// `/opt/homebrew` is Apple-silicon Homebrew, `/usr/local` covers Intel
/// Homebrew and npm's default global prefix.
pub fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        // The official Claude Code and cursor-agent installers both land here.
        dirs.push(home.join(".local").join("bin"));
        // npm's global prefix when the user relocated it out of /usr/local.
        dirs.push(home.join(".npm-global").join("bin"));
        dirs.push(home.join("bin"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs
}

/// Executable file name for this platform.
fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// First existing `<dir>/<name>` among the well-known directories.
///
/// `extra` is searched first, for a tool that owns a directory of its own
/// (`~/.pi/bin`, `~/.claude/local`).
pub fn find_with(name: &str, extra: &[PathBuf], dirs: &[PathBuf]) -> Option<PathBuf> {
    let file = exe_name(name);
    extra
        .iter()
        .chain(dirs.iter())
        .map(|dir| dir.join(&file))
        .find(|candidate| is_executable_file(candidate))
}

/// [`find_with`] against the real well-known directories.
pub fn find(name: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    find_with(name, extra, &search_dirs())
}

/// `PATH` for a child process, with the well-known directories appended.
///
/// Finding a CLI by absolute path is not always enough to RUN it: npm installs
/// a shim whose shebang is `#!/usr/bin/env node`, so `/opt/homebrew/bin/pi`
/// (a symlink to `dist/cli.js`) dies with `env: node: No such file or directory`
/// under the bare system PATH even though the file is right there. Appending —
/// not prepending — keeps whatever the user's real PATH says authoritative when
/// we do have one.
pub fn augmented_path() -> std::ffi::OsString {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let existing: Vec<PathBuf> = std::env::split_paths(&current).collect();
    let mut all = existing.clone();
    for dir in search_dirs() {
        if !existing.contains(&dir) {
            all.push(dir);
        }
    }
    std::env::join_paths(all).unwrap_or(current)
}

/// Exists and is a file (following symlinks — the Claude Code installer puts a
/// symlink in `~/.local/bin` pointing at the versioned binary).
fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file())
        .unwrap_or(false)
}

/// The shared resolution order for a runtime binary:
/// explicit config → the tool's own directory → well-known dirs → bare name
/// (i.e. whatever PATH we do have).
///
/// `configured` follows the existing convention: `AgentBackendConfig.binary`
/// serde-defaults to the shared string `"claude"`, so that value means
/// "not configured" for every runtime that is not claude itself.
pub fn resolve_binary(name: &str, configured: Option<&str>, extra: &[PathBuf]) -> String {
    resolve_binary_with(name, configured, extra, &search_dirs())
}

/// [`resolve_binary`] against an explicit directory list, so tests do not
/// depend on what happens to be installed on the machine running them.
pub fn resolve_binary_with(
    name: &str,
    configured: Option<&str>,
    extra: &[PathBuf],
    dirs: &[PathBuf],
) -> String {
    if let Some(b) = configured {
        if !b.is_empty() && b != "claude" {
            return b.to_string();
        }
    }
    find_with(name, extra, dirs)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(exe_name(name));
        std::fs::write(&p, "").unwrap();
        p
    }

    #[test]
    fn extra_dirs_win_over_well_known_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let own = tmp.path().join("own");
        let brew = tmp.path().join("brew");
        let in_own = touch(&own, "pi");
        touch(&brew, "pi");
        assert_eq!(
            find_with("pi", &[own.clone()], &[brew.clone()]),
            Some(in_own)
        );
    }

    #[test]
    fn falls_through_the_dir_list_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first");
        let second = tmp.path().join("second");
        std::fs::create_dir_all(&first).unwrap();
        let in_second = touch(&second, "claude");
        assert_eq!(
            find_with("claude", &[], &[first, second]),
            Some(in_second),
            "an empty earlier directory must not stop the search"
        );
    }

    #[test]
    fn missing_everywhere_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(find_with("nope", &[], &[tmp.path().to_path_buf()]), None);
    }

    #[test]
    fn a_directory_named_like_the_binary_does_not_count() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(exe_name("claude"))).unwrap();
        assert_eq!(find_with("claude", &[], &[tmp.path().to_path_buf()]), None);
    }

    #[test]
    fn explicit_config_beats_every_probe() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        touch(&dir, "pi");
        let dirs = [dir];
        assert_eq!(
            resolve_binary_with("pi", Some("/opt/pi"), &[], &dirs),
            "/opt/pi"
        );
        // The serde default for a shared field — treated as unconfigured, so
        // the probe still runs and wins over the bare name.
        assert_ne!(resolve_binary_with("pi", Some("claude"), &[], &dirs), "pi");
        assert_ne!(resolve_binary_with("pi", Some(""), &[], &dirs), "pi");
    }

    #[test]
    fn bare_name_is_the_last_resort() {
        // Nothing to find: keep the bare name so whatever PATH we do have still
        // gets a shot.
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_binary_with("claude", None, &[], &[tmp.path().to_path_buf()]),
            "claude"
        );
    }

    #[test]
    fn augmented_path_appends_without_dropping_the_existing_entries() {
        let before: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        let after: Vec<PathBuf> = std::env::split_paths(&augmented_path()).collect();
        for dir in &before {
            assert!(after.contains(dir), "{dir:?} must survive augmentation");
        }
        assert_eq!(
            &after[..before.len()],
            &before[..],
            "existing PATH stays first"
        );
        for dir in search_dirs() {
            assert!(after.contains(&dir), "{dir:?} must be reachable");
        }
    }
}

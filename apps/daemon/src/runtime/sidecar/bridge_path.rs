//! Resolve sidecar bridge entry scripts at runtime.
//!
//! Release bundles compile amuxd on CI, so compile-time `CARGO_MANIFEST_DIR`
//! paths point at the builder checkout — not the user's machine. Desktop ships
//! bridge trees under `Resources/` (or next to the sidecar in dev) instead.

use std::path::{Path, PathBuf};

const CURSOR_BRIDGE_REL: &str = "cursor-bridge/src/main.mjs";
const CLAUDE_BRIDGE_REL: &str = "claude-bridge/src/main.mjs";

/// Env override injected by the desktop supervisor when spawning amuxd.
pub const CURSOR_BRIDGE_MAIN_ENV: &str = "TEAMCLU_CURSOR_BRIDGE_MAIN";
pub const CLAUDE_BRIDGE_MAIN_ENV: &str = "TEAMCLU_CLAUDE_BRIDGE_MAIN";

fn env_override(env_key: &str) -> Option<PathBuf> {
    std::env::var(env_key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_file())
}

fn manifest_dev_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn push_candidate(out: &mut Vec<PathBuf>, path: PathBuf) {
    if !out.iter().any(|existing| existing == &path) {
        out.push(path);
    }
}

/// Candidate locations for a bundled bridge main script next to `exe_dir`
/// (typically `…/Contents/MacOS`), most-specific first.
///
/// Tauri ships `resources: ["binaries/claude-bridge/**/*"]` as
/// `Contents/Resources/binaries/claude-bridge/…` — the `binaries/` prefix is
/// preserved. Looking only under `Resources/<bridge>/` misses the release
/// layout and falls through to the CI `CARGO_MANIFEST_DIR` path.
pub fn bundled_bridge_candidates_from(exe_dir: &Path, relative: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    push_candidate(&mut out, exe_dir.join(relative));
    if let Some(parent) = exe_dir.parent() {
        push_candidate(&mut out, parent.join("Resources").join(relative));
        push_candidate(
            &mut out,
            parent.join("Resources").join("binaries").join(relative),
        );
        if let Some(bridge_dir) = relative.split('/').next().filter(|s| !s.is_empty()) {
            push_candidate(
                &mut out,
                parent
                    .join("share")
                    .join("teamclu")
                    .join(bridge_dir)
                    .join(relative.split('/').skip(1).collect::<Vec<_>>().join("/")),
            );
        }
    }
    out
}

/// Candidate locations for a bundled bridge main script, most-specific first.
pub fn bundled_bridge_candidates(relative: &str) -> Vec<PathBuf> {
    match std::env::current_exe() {
        Ok(exe) => exe
            .parent()
            .map(|dir| bundled_bridge_candidates_from(dir, relative))
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub fn resolve_bridge_main(relative: &str, env_key: &str) -> PathBuf {
    if let Some(path) = env_override(env_key) {
        return path;
    }
    for cand in bundled_bridge_candidates(relative) {
        if cand.is_file() {
            return cand;
        }
    }
    manifest_dev_path(relative)
}

pub fn default_cursor_bridge_main() -> PathBuf {
    resolve_bridge_main(CURSOR_BRIDGE_REL, CURSOR_BRIDGE_MAIN_ENV)
}

pub fn default_claude_bridge_main() -> PathBuf {
    resolve_bridge_main(CLAUDE_BRIDGE_REL, CLAUDE_BRIDGE_MAIN_ENV)
}

/// Root of a bridge tree (`…/cursor-bridge`) given its `src/main.mjs` path.
pub fn bridge_root_for_main(main: &Path) -> Option<PathBuf> {
    main.parent()
        .and_then(|src| src.parent())
        .map(|root| root.to_path_buf())
}

pub fn sdk_installed_for_main(main: &Path) -> bool {
    bridge_root_for_main(main)
        .map(|root| {
            root.join("node_modules")
                .join("@cursor/sdk/package.json")
                .is_file()
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_dev_paths_end_with_expected_suffixes() {
        assert!(manifest_dev_path(CURSOR_BRIDGE_REL)
            .to_string_lossy()
            .ends_with("cursor-bridge/src/main.mjs"));
        assert!(manifest_dev_path(CLAUDE_BRIDGE_REL)
            .to_string_lossy()
            .ends_with("claude-bridge/src/main.mjs"));
    }

    #[test]
    fn bundled_candidates_include_resources_layout() {
        let cands = bundled_bridge_candidates_from(
            Path::new("/Applications/App.app/Contents/MacOS"),
            CURSOR_BRIDGE_REL,
        );
        assert!(cands.iter().any(|p| p
            .to_string_lossy()
            .ends_with("Contents/Resources/cursor-bridge/src/main.mjs")));
    }

    #[test]
    fn bundled_candidates_include_tauri_resources_binaries_layout() {
        // Regression: Copilot 361 release bundles bridges under
        // Resources/binaries/<bridge>/ (tauri resource path prefix). Missing
        // this candidate made amuxd spawn the CI checkout path
        // (/Users/runner/work/…) and every list_models probe die with
        // "bridge exited before responding".
        let cands = bundled_bridge_candidates_from(
            Path::new("/Applications/Copilot 361.app/Contents/MacOS"),
            CLAUDE_BRIDGE_REL,
        );
        assert!(
            cands.iter().any(|p| {
                p.to_string_lossy()
                    .ends_with("Contents/Resources/binaries/claude-bridge/src/main.mjs")
            }),
            "candidates={cands:?}"
        );
    }

    #[test]
    fn env_override_wins_when_file_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let main = dir.path().join("main.mjs");
        std::fs::write(&main, "// test\n").expect("write main");
        // SAFETY: test-only; no other threads read this env var concurrently here.
        unsafe { std::env::set_var(CURSOR_BRIDGE_MAIN_ENV, &main) };
        let resolved = resolve_bridge_main(CURSOR_BRIDGE_REL, CURSOR_BRIDGE_MAIN_ENV);
        unsafe { std::env::remove_var(CURSOR_BRIDGE_MAIN_ENV) };
        assert_eq!(resolved, main);
    }
}

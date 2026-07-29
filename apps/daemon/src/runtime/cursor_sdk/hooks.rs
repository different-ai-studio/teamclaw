//! TeamClaw's `preToolUse` gate in `<worktree>/.cursor/hooks.json`.
//!
//! `@cursor/sdk` has no out-of-band approval API: the only way to gate a local
//! agent's tool call is a Cursor hook — the SDK spawns the hook's `command`,
//! feeds it the request on stdin, and reads `{"permission":"allow"|"deny"}` off
//! stdout. `preToolUse` is the one generic step (`tool_name` + `tool_input` +
//! `cwd` for every tool); `deny` turns the call into a `permission_denied`
//! rejection the model sees.
//!
//! Hooks are discovered from setting sources, and the `project` source resolves
//! from the *first* `local.cwd` entry only (`Array.isArray(cwd) ? cwd[0] : cwd`
//! in the SDK), so the file has to live in the worktree itself — a sidecar
//! directory passed as a second root is never scanned.
//!
//! The file is shared with whatever the user already put there, so we merge:
//! entries whose command contains [`HOOK_MARKER`] are ours and get replaced,
//! everything else is preserved verbatim.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tracing::warn;

/// Substring identifying a TeamClaw-managed hook entry.
pub const HOOK_MARKER: &str = "cursor-permission-hook";

/// How long the hook process waits for a human before giving up. The SDK reads
/// this per entry (`timeout`, in seconds) — its default is far too short for a
/// person to actually answer.
pub const HOOK_TIMEOUT_SECS: u64 = 600;

pub fn hooks_path(worktree: &str) -> PathBuf {
    Path::new(worktree).join(".cursor").join("hooks.json")
}

fn our_entry(amuxd_bin: &Path, sock: &Path, worktree: &str) -> Value {
    json!({
        "command": format!(
            "{} {HOOK_MARKER} --sock={} --worktree={}",
            shell_quote(&amuxd_bin.to_string_lossy()),
            shell_quote(&sock.to_string_lossy()),
            shell_quote(worktree),
        ),
        "timeout": HOOK_TIMEOUT_SECS,
    })
}

/// Single-quote a path for the shell the SDK runs hook commands through.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn is_ours(entry: &Value) -> bool {
    entry
        .get("command")
        .and_then(|v| v.as_str())
        .is_some_and(|c| c.contains(HOOK_MARKER))
}

/// Merge our `preToolUse` entry into an existing hooks document, preserving
/// every user-authored entry and dropping stale copies of our own.
pub fn merge_document(existing: Option<Value>, ours: Value) -> Value {
    let mut root = match existing {
        Some(Value::Object(map)) => Value::Object(map),
        _ => json!({}),
    };
    root["version"] = json!(1);
    if !root.get("hooks").map(|h| h.is_object()).unwrap_or(false) {
        root["hooks"] = json!({});
    }
    let step = root["hooks"]["preToolUse"].take();
    let mut entries: Vec<Value> = match step {
        Value::Array(items) => items.into_iter().filter(|e| !is_ours(e)).collect(),
        _ => Vec::new(),
    };
    // Ours runs first: a user hook that denies still denies, but we never make
    // a human answer for a call their own hook would have blocked outright.
    entries.insert(0, ours);
    root["hooks"]["preToolUse"] = Value::Array(entries);
    root
}

/// Write (or refresh) the gate in `<worktree>/.cursor/hooks.json`.
pub fn ensure(worktree: &str, amuxd_bin: &Path, sock: &Path) -> std::io::Result<PathBuf> {
    let path = hooks_path(worktree);
    let existing = std::fs::read_to_string(&path)
        .ok()
        .and_then(|body| serde_json::from_str::<Value>(&body).ok());
    let merged = merge_document(existing, our_entry(amuxd_bin, sock, worktree));
    let body = serde_json::to_string_pretty(&merged)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Skip the write when nothing changed so we don't touch mtime (and thus the
    // user's git status) on every attach.
    if std::fs::read_to_string(&path).ok().as_deref() == Some(body.as_str()) {
        return Ok(path);
    }
    std::fs::write(&path, &body)?;
    exclude_from_git(worktree);
    Ok(path)
}

/// Best-effort: keep the managed file out of `git status` via
/// `.git/info/exclude`. Only touches repos where it is not already ignored, and
/// never rewrites the user's `.gitignore`.
fn exclude_from_git(worktree: &str) {
    let info = Path::new(worktree).join(".git").join("info");
    if !info.is_dir() {
        return;
    }
    let exclude = info.join("exclude");
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    let line = ".cursor/hooks.json";
    if current.lines().any(|l| l.trim() == line) {
        return;
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("# TeamClaw cursor permission gate\n");
    next.push_str(line);
    next.push('\n');
    if let Err(e) = std::fs::write(&exclude, next) {
        warn!(worktree, error = %e, "cursor: .git/info/exclude update failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ours() -> Value {
        json!({ "command": "'/bin/amuxd' cursor-permission-hook --sock='/s'", "timeout": 600 })
    }

    #[test]
    fn merge_into_empty_document_creates_the_step() {
        let doc = merge_document(None, ours());
        assert_eq!(doc["version"], json!(1));
        assert_eq!(doc["hooks"]["preToolUse"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn merge_preserves_user_entries_and_other_steps() {
        let existing = json!({
            "version": 1,
            "hooks": {
                "preToolUse": [{ "command": "./scripts/audit.sh" }],
                "afterFileEdit": [{ "command": "./scripts/fmt.sh" }]
            }
        });
        let doc = merge_document(Some(existing), ours());
        let pre = doc["hooks"]["preToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2);
        assert!(is_ours(&pre[0]), "ours runs first");
        assert_eq!(pre[1]["command"], json!("./scripts/audit.sh"));
        assert_eq!(
            doc["hooks"]["afterFileEdit"][0]["command"],
            json!("./scripts/fmt.sh")
        );
    }

    #[test]
    fn merge_replaces_a_stale_copy_of_our_own_entry() {
        let existing = json!({
            "hooks": { "preToolUse": [
                { "command": "'/old/amuxd' cursor-permission-hook --sock='/old'" },
                { "command": "./keep.sh" }
            ]}
        });
        let doc = merge_document(Some(existing), ours());
        let pre = doc["hooks"]["preToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2);
        assert_eq!(pre[0]["command"], ours()["command"]);
        assert_eq!(pre[1]["command"], json!("./keep.sh"));
    }

    #[test]
    fn merge_survives_a_garbage_document() {
        let doc = merge_document(Some(json!("not an object")), ours());
        assert_eq!(doc["hooks"]["preToolUse"].as_array().unwrap().len(), 1);
        let doc = merge_document(Some(json!({ "hooks": 42 })), ours());
        assert_eq!(doc["hooks"]["preToolUse"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn ensure_writes_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path().to_string_lossy().into_owned();
        let bin = Path::new("/usr/local/bin/amuxd");
        let sock = Path::new("/tmp/amuxd.sock");

        let path = ensure(&worktree, bin, sock).unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        assert!(first.contains(HOOK_MARKER));
        assert!(first.contains("\"timeout\": 600"));

        ensure(&worktree, bin, sock).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
    }

    #[test]
    fn ensure_registers_the_file_in_git_info_exclude() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path().to_string_lossy().into_owned();
        std::fs::create_dir_all(dir.path().join(".git/info")).unwrap();

        ensure(&worktree, Path::new("/bin/amuxd"), Path::new("/s.sock")).unwrap();
        let exclude = std::fs::read_to_string(dir.path().join(".git/info/exclude")).unwrap();
        assert!(exclude.contains(".cursor/hooks.json"));

        // Second run must not duplicate the line.
        std::fs::remove_file(hooks_path(&worktree)).unwrap();
        ensure(&worktree, Path::new("/bin/amuxd"), Path::new("/s.sock")).unwrap();
        let exclude = std::fs::read_to_string(dir.path().join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.matches(".cursor/hooks.json").count(), 1);
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("/a/b"), "'/a/b'");
        assert_eq!(shell_quote("/it's"), r"'/it'\''s'");
    }
}

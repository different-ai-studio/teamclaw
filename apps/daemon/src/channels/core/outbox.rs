//! A directory the agent drops files into when it wants them sent.
//!
//! Why not a tool: `send` is an MCP tool, and only some runtimes have MCP.
//! `opencode` and `pi` read their servers from the workspace config, which does
//! not carry the daemon's own `amuxd-send`; `cursor` and `claude` merge in the
//! device file and do. So on a pi-backed gateway the agent has no `send` tool
//! at all — it was observed spending an entire turn shelling out to drive the
//! MCP server over stdio JSON-RPC by hand, and running out of turn before the
//! file was ever sent.
//!
//! Writing a file is something every runtime can do. The directory is also what
//! makes this safe: "attach whatever paths the reply mentions" would let a
//! prompt-injected agent post `~/.ssh/id_rsa` into a group chat, whereas here
//! the only thing that can be sent is something deliberately copied into a
//! directory that holds nothing else.
//!
//! One directory per session, emptied at the start of every turn: a file left
//! behind by a turn that failed must not surface in the middle of the next
//! conversation.

use std::path::PathBuf;

use super::PendingUpload;

/// `<team state>/outbox/<session id>` — daemon-owned, not inside the agent's
/// worktree, so nothing here can be committed by accident or synced to the team.
pub fn dir_for(session_id: &str) -> PathBuf {
    crate::config::layout::active_state_dir()
        .join("outbox")
        .join(session_id)
}

/// Create the session's outbox and empty it. Returns the path to put in the
/// prompt, or None when it cannot be created — the turn still runs, it just
/// cannot carry files.
pub fn prepare(session_id: &str) -> Option<PathBuf> {
    let dir = dir_for(session_id);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!(error = %e, dir = %dir.display(), "outbox: could not create");
        return None;
    }
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Some(dir)
}

/// Everything the agent left behind, as uploads.
///
/// The files are deliberately NOT deleted here: a channel that uploads media
/// itself (WeCom) needs the bytes on disk at delivery time, which happens after
/// this returns. [`prepare`] is what clears them, at the start of the next
/// turn — so a leftover can never surface mid-conversation either way.
///
/// Directories are ignored rather than walked: an attachment is a file, and
/// recursing would turn one stray `node_modules` into hundreds of messages.
pub fn collect(session_id: &str) -> Vec<PendingUpload> {
    let dir = dir_for(session_id);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let filename = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // A dotfile in here is housekeeping (.DS_Store on macOS), not something
        // the user asked to receive.
        if filename.starts_with('.') {
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(error = %e, file = %path.display(), "outbox: unreadable; skipped");
                continue;
            }
        };
        // An empty file is almost always a half-written one; sending it would
        // hand the user a broken download.
        if bytes.is_empty() {
            tracing::warn!(file = %filename, "outbox: empty file skipped");
            continue;
        }
        let mime = teamclu_gateway::wecom::resolve_mime(&bytes, Some(&filename));
        out.push(PendingUpload {
            filename,
            mime,
            bytes,
            // Kept so a channel that uploads media itself can read it back.
            local_path: Some(path.to_string_lossy().into_owned()),
        });
    }
    // Stable order so a multi-file reply does not shuffle between runs.
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    out
}

/// The line that tells the agent where to put files. One sentence, one path —
/// as opposed to a tool name plus an argument schema, which is what the model
/// was failing to get right.
pub fn prompt_note(dir: &std::path::Path) -> String {
    format!(
        "[SYSTEM] To send a file to this chat, copy it into {} — everything in \
that directory is attached to your reply when this turn ends. Nothing else is \
sent, so put a file there rather than describing where it is.",
        dir.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Points the daemon layout at a temp home for one test.
    ///
    /// Serialised on the repo-wide `TEST_HOME_LOCK`: `AMUXD_HOME` is process
    /// state, so two of these running at once resolve each other's outbox and
    /// every assertion here reads an empty directory.
    fn with_temp_home<T>(f: impl FnOnce() -> T) -> T {
        let _guard = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let prev = std::env::var("AMUXD_HOME").ok();
        std::env::set_var("AMUXD_HOME", tmp.path());
        let out = f();
        match prev {
            Some(v) => std::env::set_var("AMUXD_HOME", v),
            None => std::env::remove_var("AMUXD_HOME"),
        }
        out
    }

    #[test]
    fn files_dropped_in_the_outbox_come_back_as_uploads() {
        with_temp_home(|| {
            let dir = prepare("s-1").unwrap();
            std::fs::write(dir.join("poem.md"), b"# hi").unwrap();

            let collected = collect("s-1");
            assert_eq!(collected.len(), 1);
            assert_eq!(collected[0].filename, "poem.md");
            assert_eq!(collected[0].bytes, b"# hi");
        });
    }

    #[test]
    fn collected_files_survive_until_the_next_turn_clears_them() {
        // Deleting at collect time would pull the bytes out from under a
        // channel that uploads media itself, which happens after delivery is
        // decided.
        with_temp_home(|| {
            let dir = prepare("s-2").unwrap();
            std::fs::write(dir.join("a.txt"), b"x").unwrap();
            assert_eq!(collect("s-2").len(), 1);
            assert!(dir.join("a.txt").is_file(), "still readable for delivery");

            prepare("s-2");
            assert!(collect("s-2").is_empty(), "the next turn starts clean");
        });
    }

    #[test]
    fn a_turn_starts_with_an_empty_outbox() {
        // A file left by a turn that died must not surface mid-conversation
        // three messages later.
        with_temp_home(|| {
            let dir = prepare("s-3").unwrap();
            std::fs::write(dir.join("stale.txt"), b"from a dead turn").unwrap();

            prepare("s-3");
            assert!(collect("s-3").is_empty());
        });
    }

    #[test]
    fn empty_and_hidden_files_are_not_sent() {
        with_temp_home(|| {
            let dir = prepare("s-4").unwrap();
            std::fs::write(dir.join(".DS_Store"), b"junk").unwrap();
            std::fs::write(dir.join("half-written.pdf"), b"").unwrap();
            std::fs::write(dir.join("real.txt"), b"content").unwrap();

            let collected = collect("s-4");
            assert_eq!(collected.len(), 1);
            assert_eq!(collected[0].filename, "real.txt");
        });
    }

    #[test]
    fn a_directory_left_in_the_outbox_is_ignored_not_walked() {
        with_temp_home(|| {
            let dir = prepare("s-5").unwrap();
            std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
            std::fs::write(dir.join("node_modules/pkg/index.js"), b"x").unwrap();
            std::fs::write(dir.join("keep.txt"), b"y").unwrap();

            let collected = collect("s-5");
            assert_eq!(collected.len(), 1);
            assert_eq!(collected[0].filename, "keep.txt");
        });
    }

    #[test]
    fn two_sessions_have_separate_outboxes() {
        with_temp_home(|| {
            let a = prepare("s-a").unwrap();
            let b = prepare("s-b").unwrap();
            assert_ne!(a, b);
            std::fs::write(a.join("a.txt"), b"a").unwrap();
            assert!(collect("s-b").is_empty());
            assert_eq!(collect("s-a").len(), 1);
        });
    }

    #[test]
    fn the_prompt_note_carries_the_actual_path() {
        let note = prompt_note(std::path::Path::new("/tmp/outbox/s-1"));
        assert!(note.contains("/tmp/outbox/s-1"));
    }
}

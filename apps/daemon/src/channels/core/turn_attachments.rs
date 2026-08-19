//! Files an agent decides to attach while a turn is running.
//!
//! The `send` MCP tool used to push a file straight at the channel and record a
//! second message for it. The user then saw the same answer twice: once as the
//! pushed file and once in the turn's own reply, which describes what it just
//! sent. Here the file is instead parked against the session and collected when
//! the turn finishes, so one turn produces **one** message — text plus its
//! attachments.
//!
//! `send` keeps its other job untouched: pushing to a chat with no turn behind
//! it (cron, or a desktop user @-mentioning an external member). That path has
//! no reply to attach to and still delivers directly.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use teamclu_gateway::driver::SessionAttachment;

/// Sessions with a turn in flight, and what has been attached to each.
///
/// A process-wide map rather than something threaded through the MCP handler:
/// the tool call arrives on a completely separate path (the MCP server), with
/// only a reply token to connect it back to the turn.
fn registry() -> &'static Mutex<HashMap<String, Vec<SessionAttachment>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Vec<SessionAttachment>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Mark a turn as running, so `send` knows there is a reply to attach to.
pub fn open(session_id: &str) {
    registry()
        .lock()
        .unwrap()
        .insert(session_id.to_string(), Vec::new());
}

/// Whether a turn is running for this session. `send` uses this to choose
/// between attaching and pushing.
pub fn is_open(session_id: &str) -> bool {
    registry().lock().unwrap().contains_key(session_id)
}

/// Attach a file to the in-flight turn. Returns false when no turn is open —
/// the caller then falls back to delivering it directly.
pub fn attach(session_id: &str, attachment: SessionAttachment) -> bool {
    let mut reg = registry().lock().unwrap();
    match reg.get_mut(session_id) {
        Some(list) => {
            list.push(attachment);
            true
        }
        None => false,
    }
}

/// Collect what was attached and end the turn's window.
///
/// Always called, including on a failed turn: leaving the entry behind would
/// make the next `send` on that session attach to a reply that will never be
/// delivered, and the file would vanish.
pub fn close(session_id: &str) -> Vec<SessionAttachment> {
    registry()
        .lock()
        .unwrap()
        .remove(session_id)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(name: &str) -> SessionAttachment {
        SessionAttachment {
            filename: name.into(),
            mime: "text/markdown".into(),
            bucket_path: format!("bucket/{name}"),
            local_path: None,
        }
    }

    #[test]
    fn a_file_sent_during_a_turn_rides_out_with_the_reply() {
        open("s-1");
        assert!(attach("s-1", attachment("poem.md")));
        let collected = close("s-1");
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].filename, "poem.md");
    }

    #[test]
    fn a_file_sent_with_no_turn_running_is_refused_so_it_can_be_pushed_instead() {
        // cron, or a desktop user @-mentioning an external member: there is no
        // reply to attach to, and the file must still reach the chat.
        assert!(!attach("s-never-opened", attachment("report.pdf")));
    }

    #[test]
    fn closing_ends_the_window_even_when_nothing_was_attached() {
        open("s-2");
        assert!(is_open("s-2"));
        assert!(close("s-2").is_empty());
        assert!(
            !is_open("s-2"),
            "a failed turn must not leave the door open"
        );
        assert!(!attach("s-2", attachment("late.md")));
    }

    #[test]
    fn two_sessions_do_not_see_each_others_attachments() {
        open("s-a");
        open("s-b");
        attach("s-a", attachment("a.md"));
        attach("s-b", attachment("b.md"));
        assert_eq!(close("s-a")[0].filename, "a.md");
        assert_eq!(close("s-b")[0].filename, "b.md");
    }
}

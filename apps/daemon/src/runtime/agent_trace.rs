//! Structured tracing for ACP agent I/O. Filter with `RUST_LOG=agent_trace=info`.

use crate::proto::amux;
use tracing::{debug, error, info, warn};

pub const LOG_TARGET: &str = "agent_trace";

const PREVIEW_MAX: usize = 240;

pub fn preview(text: &str) -> String {
    let collapsed: String = text.chars().filter(|c| *c != '\r').collect();
    let trimmed = collapsed.trim();
    let char_count = trimmed.chars().count();
    if char_count <= PREVIEW_MAX {
        return trimmed.to_string();
    }
    let short: String = trimmed.chars().take(PREVIEW_MAX).collect();
    format!("{short}…")
}

pub fn log_runtime_prompt(
    agent_id: &str,
    acp_session_id: &str,
    text: &str,
    attachment_count: usize,
) {
    info!(
        target: LOG_TARGET,
        agent_id = %agent_id,
        acp_session_id = %acp_session_id,
        attachment_count,
        prompt = %preview(text),
        "runtime send_prompt"
    );
}

pub fn log_runtime_cancel(agent_id: &str, acp_session_id: &str) {
    info!(
        target: LOG_TARGET,
        agent_id = %agent_id,
        acp_session_id = %acp_session_id,
        "runtime cancel"
    );
}

pub fn log_prompt_begin(session_id: &str, text: &str, attachment_count: usize) {
    info!(
        target: LOG_TARGET,
        session_id = %session_id,
        attachment_count,
        prompt = %preview(text),
        "agent prompt begin"
    );
}

pub fn log_prompt_end(session_id: &str, ok: bool, err: &str, elapsed_ms: u64) {
    if ok {
        info!(
            target: LOG_TARGET,
            session_id = %session_id,
            elapsed_ms,
            "agent prompt end"
        );
    } else {
        error!(
            target: LOG_TARGET,
            session_id = %session_id,
            elapsed_ms,
            error = %err,
            "agent prompt end"
        );
    }
}

pub fn log_cancel(session_id: &str, ok: bool, err: &str) {
    if ok {
        info!(target: LOG_TARGET, session_id = %session_id, "agent cancel");
    } else {
        warn!(
            target: LOG_TARGET,
            session_id = %session_id,
            error = %err,
            "agent cancel failed"
        );
    }
}

pub fn log_acp_event(session_id: &str, event: &amux::AcpEvent) {
    match event.event.as_ref() {
        Some(amux::acp_event::Event::Thinking(t)) => {
            info!(
                target: LOG_TARGET,
                session_id = %session_id,
                text = %preview(&t.text),
                "agent thinking"
            );
        }
        Some(amux::acp_event::Event::Output(o)) => {
            info!(
                target: LOG_TARGET,
                session_id = %session_id,
                complete = o.is_complete,
                text = %preview(&o.text),
                "agent output"
            );
        }
        Some(amux::acp_event::Event::ToolUse(tu)) => {
            info!(
                target: LOG_TARGET,
                session_id = %session_id,
                tool_id = %tu.tool_id,
                tool_name = %tu.tool_name,
                description = %preview(&tu.description),
                "agent tool use"
            );
        }
        Some(amux::acp_event::Event::ToolResult(tr)) => {
            info!(
                target: LOG_TARGET,
                session_id = %session_id,
                tool_id = %tr.tool_id,
                success = tr.success,
                summary = %preview(&tr.summary),
                "agent tool result"
            );
        }
        Some(amux::acp_event::Event::StatusChange(sc)) => {
            info!(
                target: LOG_TARGET,
                session_id = %session_id,
                old_status = sc.old_status,
                new_status = sc.new_status,
                "agent status change"
            );
        }
        Some(amux::acp_event::Event::Error(e)) => {
            error!(
                target: LOG_TARGET,
                session_id = %session_id,
                message = %e.message,
                details = %preview(&e.details),
                "agent error event"
            );
        }
        Some(amux::acp_event::Event::PlanUpdate(p)) => {
            info!(
                target: LOG_TARGET,
                session_id = %session_id,
                entries = p.entries.len(),
                "agent plan update"
            );
        }
        Some(amux::acp_event::Event::PermissionRequest(p)) => {
            info!(
                target: LOG_TARGET,
                session_id = %session_id,
                request_id = %p.request_id,
                tool_name = %p.tool_name,
                description = %preview(&p.description),
                "agent permission request"
            );
        }
        _ => {
            debug!(target: LOG_TARGET, session_id = %session_id, "agent event other");
        }
    }
}

pub fn log_acp_error(session_id: &str, message: &str, details: &str) {
    error!(
        target: LOG_TARGET,
        session_id = %session_id,
        message = %message,
        details = %preview(details),
        "agent error emit"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_truncates_long_text() {
        let long = "a".repeat(300);
        assert!(preview(&long).ends_with('…'));
        assert!(preview(&long).chars().count() <= PREVIEW_MAX + 1);
    }

    #[test]
    fn preview_preserves_short_text() {
        assert_eq!(preview("hello"), "hello");
    }
}

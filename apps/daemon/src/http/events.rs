//! Event schema + ring buffer + replay.
//!
//! HTTP clients see a stable, versioned event vocabulary. Internal
//! `RuntimeManager` envelopes are translated *into* these types in
//! the adapter; downstream consumers never see ACP-specific wire
//! shapes.
//!
//! Every event carries a monotonic `seq` per session — this is the
//! identifier echoed as the SSE `id:` field and accepted back via
//! `Last-Event-ID` for replay.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use uuid::Uuid;

/// Stable, machine-readable event type. New variants must be added to
/// the end — clients dispatch on this string.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    SessionCreated,
    SessionState,
    PromptAccepted,
    TurnStarted,
    TokenDelta,
    ToolCall,
    ToolResult,
    MessageCompleted,
    TurnFinished,
    SessionError,
    SessionClosed,
}

impl EventKind {
    /// Render as `event:` field value for the SSE frame.
    pub fn as_str(&self) -> &'static str {
        match self {
            EventKind::SessionCreated => "session.created",
            EventKind::SessionState => "session.state",
            EventKind::PromptAccepted => "prompt.accepted",
            EventKind::TurnStarted => "turn.started",
            EventKind::TokenDelta => "token.delta",
            EventKind::ToolCall => "tool.call",
            EventKind::ToolResult => "tool.result",
            EventKind::MessageCompleted => "message.completed",
            EventKind::TurnFinished => "turn.finished",
            EventKind::SessionError => "session.error",
            EventKind::SessionClosed => "session.closed",
        }
    }
}

/// Single event delivered to subscribers. `data` is intentionally
/// `serde_json::Value` so per-kind shapes can evolve without adding
/// new wire types every release.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEvent {
    pub seq: u64,
    pub session_id: Uuid,
    pub kind: EventKind,
    pub at: DateTime<Utc>,
    pub data: serde_json::Value,
}

impl SessionEvent {
    pub fn new(session_id: Uuid, seq: u64, kind: EventKind, data: serde_json::Value) -> Self {
        Self {
            seq,
            session_id,
            kind,
            at: Utc::now(),
            data,
        }
    }

    /// Encode this event as an SSE frame.
    pub fn encode_sse(&self) -> String {
        let data = serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string());
        format!(
            "id: {}\nevent: {}\ndata: {}\n\n",
            self.seq,
            self.kind.as_str(),
            data
        )
    }
}

/// Ring buffer of recent events for a session. Bounded by configured
/// `max_event_backlog`. Older events fall off the back; the
/// `window_oldest_seq` lets the replay endpoint return `410 Gone`
/// when a client's `Last-Event-ID` is below the window.
#[derive(Debug)]
pub struct EventRingBuffer {
    inner: VecDeque<SessionEvent>,
    capacity: usize,
}

impl EventRingBuffer {
    pub fn new(capacity: usize) -> Self {
        let cap = capacity.max(1);
        Self {
            inner: VecDeque::with_capacity(cap),
            capacity: cap,
        }
    }

    pub fn push(&mut self, event: SessionEvent) {
        if self.inner.len() == self.capacity {
            self.inner.pop_front();
        }
        self.inner.push_back(event);
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    /// Oldest sequence id retained. Clients with `Last-Event-ID` below
    /// this number have fallen off the replay window.
    pub fn oldest_seq(&self) -> Option<u64> {
        self.inner.front().map(|e| e.seq)
    }

    /// Iterator over events with `seq > since` in order.
    pub fn replay_after(&self, since: u64) -> impl Iterator<Item = &SessionEvent> {
        self.inner.iter().filter(move |e| e.seq > since)
    }

    /// Bounded-limit replay: same as [`replay_after`] but caps the
    /// returned count for paginated `/v1/sessions/:id/events`.
    pub fn replay_after_limited(&self, since: u64, limit: usize) -> Vec<SessionEvent> {
        self.replay_after(since).take(limit).cloned().collect()
    }

    pub fn snapshot(&self) -> Vec<SessionEvent> {
        self.inner.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(seq: u64) -> SessionEvent {
        SessionEvent::new(
            Uuid::nil(),
            seq,
            EventKind::TokenDelta,
            serde_json::json!({}),
        )
    }

    #[test]
    fn ring_buffer_evicts_oldest() {
        let mut buf = EventRingBuffer::new(3);
        for s in 1..=5 {
            buf.push(ev(s));
        }
        assert_eq!(buf.len(), 3);
        assert_eq!(buf.oldest_seq(), Some(3));
        let replay: Vec<_> = buf.replay_after(2).map(|e| e.seq).collect();
        assert_eq!(replay, vec![3, 4, 5]);
    }

    #[test]
    fn replay_after_skips_seen() {
        let mut buf = EventRingBuffer::new(8);
        for s in 1..=5 {
            buf.push(ev(s));
        }
        let replay: Vec<_> = buf.replay_after(3).map(|e| e.seq).collect();
        assert_eq!(replay, vec![4, 5]);
    }

    #[test]
    fn sse_frame_includes_id_event_data() {
        let event = ev(42);
        let frame = event.encode_sse();
        assert!(frame.starts_with("id: 42\n"));
        assert!(frame.contains("event: token.delta\n"));
        assert!(frame.ends_with("\n\n"));
    }

    #[test]
    fn event_kind_str_table_stable() {
        // Defensive: this list pins the wire vocabulary. Adding a new
        // variant means the table here must grow too; renaming an
        // existing one is a wire-breaking change that tests should
        // surface here loudly.
        let pairs: &[(EventKind, &str)] = &[
            (EventKind::SessionCreated, "session.created"),
            (EventKind::SessionState, "session.state"),
            (EventKind::PromptAccepted, "prompt.accepted"),
            (EventKind::TurnStarted, "turn.started"),
            (EventKind::TokenDelta, "token.delta"),
            (EventKind::ToolCall, "tool.call"),
            (EventKind::ToolResult, "tool.result"),
            (EventKind::MessageCompleted, "message.completed"),
            (EventKind::TurnFinished, "turn.finished"),
            (EventKind::SessionError, "session.error"),
            (EventKind::SessionClosed, "session.closed"),
        ];
        for (k, s) in pairs {
            assert_eq!(k.as_str(), *s);
        }
    }

    #[test]
    fn limited_replay_caps_count() {
        let mut buf = EventRingBuffer::new(100);
        for s in 1..=20 {
            buf.push(ev(s));
        }
        let page = buf.replay_after_limited(5, 4);
        assert_eq!(page.len(), 4);
        assert_eq!(page.first().unwrap().seq, 6);
        assert_eq!(page.last().unwrap().seq, 9);
    }
}

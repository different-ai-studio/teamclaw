//! Per-runtime accumulator that turns the streaming ACP event firehose into
//! discrete "logical messages" (thinking blocks, tool calls/results, agent
//! replies). The daemon runs one of these per agent_id and feeds every
//! `AcpEvent` into it; emitted messages get persisted (TOML, plus the cloud
//! backend for AGENT_REPLY) and broadcast on session/live.
//!
//! ## metadata_json shapes
//!
//! Renderers should treat `metadata_json` as a stable contract per kind:
//!
//! - AgentThinking: `""` (no metadata)
//! - AgentToolCall: `{"tool_id": str, "tool_name": str, "description": str}`
//! - AgentToolResult: `{"tool_id": str, "success": bool}`
//! - AgentReply: `""` (no metadata)
//!
//! Always emit all keys for a kind (use empty strings/false rather than
//! omitting). New keys may be added; existing keys must not be removed
//! without a coordinated schema bump.

use crate::proto::amux;
use crate::proto::teamclaw::MessageKind;

fn tool_use_metadata(tu: &amux::AcpToolUse) -> String {
    serde_json::json!({
        "tool_id": tu.tool_id,
        "tool_name": tu.tool_name,
        "tool_kind": tu.tool_kind,
        "description": tu.description,
        "params": tu.params,
        "raw_input_json": tu.raw_input_json,
        "status": tu.status,
        "locations": tu
            .locations
            .iter()
            .map(|loc| {
                serde_json::json!({
                    "path": loc.path,
                    "line": loc.line,
                })
            })
            .collect::<Vec<_>>(),
        "content": proto_tool_content_json(&tu.content),
    })
    .to_string()
}

fn tool_result_metadata(tr: &amux::AcpToolResult) -> String {
    serde_json::json!({
        "tool_id": tr.tool_id,
        "success": tr.success,
        "raw_output_json": tr.raw_output_json,
        "content": proto_tool_content_json(&tr.content),
    })
    .to_string()
}

fn proto_tool_content_json(content: &[amux::AcpToolCallContent]) -> Vec<serde_json::Value> {
    content
        .iter()
        .filter_map(|item| {
            Some(match item.payload.as_ref()? {
                amux::acp_tool_call_content::Payload::Text(text) => serde_json::json!({
                    "type": "text",
                    "text": text.text,
                }),
                amux::acp_tool_call_content::Payload::Diff(diff) => serde_json::json!({
                    "type": "diff",
                    "path": diff.path,
                    "old_text": diff.old_text,
                    "new_text": diff.new_text,
                }),
                amux::acp_tool_call_content::Payload::Terminal(terminal) => serde_json::json!({
                    "type": "terminal",
                    "terminal_id": terminal.terminal_id,
                }),
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct EmittedMessage {
    pub kind: MessageKind,
    pub content: String,
    /// JSON blob for structured kinds (tool calls/results). Empty otherwise.
    pub metadata_json: String,
    /// Daemon-assigned correlation id stamped on every emit within one
    /// ACP turn (Idle→Active→…→Idle). Clients group consecutive
    /// same-turn_id AgentReply rows into one bubble. Empty when there
    /// is no active turn (shouldn't happen for agent emissions but
    /// renderers must tolerate it).
    pub turn_id: String,
}

#[derive(Debug, Default)]
pub struct TurnAggregator {
    thinking_buf: String,
    reply_buf: String,
    /// `Some(uuid)` while we're inside a turn (Active), `None` while
    /// Idle. Allocated on Idle→Active, cleared on Active→Idle. Every
    /// `EmittedMessage` carries this id so downstream INSERTs can
    /// correlate the rows belonging to the same logical turn.
    current_turn_id: Option<String>,
    /// True once this turn emits thinking, output, or tool events.
    turn_had_activity: bool,
    /// True once this turn emits an AgentReply (mid-turn flush or turn end).
    turn_had_reply: bool,
}

impl TurnAggregator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one ACP event in; return any logical messages this triggers.
    pub fn ingest(&mut self, event: &amux::AcpEvent) -> Vec<EmittedMessage> {
        let mut out = Vec::new();
        match event.event.as_ref() {
            Some(amux::acp_event::Event::Thinking(t)) => {
                self.ensure_turn_started();
                self.turn_had_activity = true;
                self.thinking_buf.push_str(&t.text);
            }
            Some(amux::acp_event::Event::Output(o)) => {
                self.ensure_turn_started();
                self.turn_had_activity = true;
                self.reply_buf.push_str(&o.text);
            }
            Some(amux::acp_event::Event::ToolUse(tu)) => {
                // A tool call interrupts: flush any pending thinking + reply
                // first, then emit the tool call as its own message.
                self.ensure_turn_started();
                self.turn_had_activity = true;
                self.flush_thinking_into(&mut out);
                self.flush_reply_into(&mut out);
                let metadata = tool_use_metadata(tu);
                out.push(EmittedMessage {
                    kind: MessageKind::AgentToolCall,
                    content: tu.tool_name.clone(),
                    metadata_json: metadata,
                    turn_id: self.current_turn_id.clone().unwrap_or_default(),
                });
            }
            Some(amux::acp_event::Event::ToolResult(tr)) => {
                self.ensure_turn_started();
                self.turn_had_activity = true;
                let metadata = tool_result_metadata(tr);
                out.push(EmittedMessage {
                    kind: MessageKind::AgentToolResult,
                    content: tr.summary.clone(),
                    metadata_json: metadata,
                    turn_id: self.current_turn_id.clone().unwrap_or_default(),
                });
            }
            Some(amux::acp_event::Event::StatusChange(sc)) => {
                let active = amux::AgentStatus::Active as i32;
                let idle = amux::AgentStatus::Idle as i32;
                // Idle -> Active opens a new turn. Allocate a fresh
                // turn_id so any subsequent thinking/output/tool emits
                // get stamped with it. Defensive: don't clobber an
                // already-open turn (shouldn't happen, but if it does
                // the existing id stays in force).
                if sc.old_status == idle && sc.new_status == active {
                    self.turn_had_activity = false;
                    self.turn_had_reply = false;
                    self.ensure_turn_started();
                }
                // Active -> Idle is the canonical "turn ended" signal
                // (`daemon/src/runtime/adapter.rs:622-633`). Flush
                // pending buffers, then close out the turn so the next
                // turn allocates a fresh id.
                if sc.old_status == active && sc.new_status == idle {
                    self.flush_thinking_into(&mut out);
                    self.flush_reply_into(&mut out);
                    // Tool-only turns never accumulate reply text. Emit an
                    // empty AgentReply so clients get message.created and
                    // can anchor the turn in the main timeline.
                    if !self.turn_had_reply && self.turn_had_activity {
                        out.push(EmittedMessage {
                            kind: MessageKind::AgentReply,
                            content: String::new(),
                            metadata_json: String::new(),
                            turn_id: self.current_turn_id.clone().unwrap_or_default(),
                        });
                    }
                    self.turn_had_activity = false;
                    self.turn_had_reply = false;
                    self.current_turn_id = None;
                }
            }
            _ => {}
        }
        out
    }

    /// Lazy turn open. Some ACP streams emit thinking/output before any
    /// StatusChange to Active (e.g. session resume), so we treat the
    /// first content-bearing event as an implicit turn boundary.
    fn ensure_turn_started(&mut self) {
        if self.current_turn_id.is_none() {
            self.current_turn_id = Some(uuid::Uuid::new_v4().to_string());
        }
    }

    fn flush_thinking_into(&mut self, out: &mut Vec<EmittedMessage>) {
        if !self.thinking_buf.is_empty() {
            out.push(EmittedMessage {
                kind: MessageKind::AgentThinking,
                content: std::mem::take(&mut self.thinking_buf),
                metadata_json: String::new(),
                turn_id: self.current_turn_id.clone().unwrap_or_default(),
            });
        }
    }

    fn flush_reply_into(&mut self, out: &mut Vec<EmittedMessage>) {
        if !self.reply_buf.is_empty() {
            out.push(EmittedMessage {
                kind: MessageKind::AgentReply,
                content: std::mem::take(&mut self.reply_buf),
                metadata_json: String::new(),
                turn_id: self.current_turn_id.clone().unwrap_or_default(),
            });
            self.turn_had_reply = true;
        }
    }

    /// True if this emitted message should be persisted to the cloud backend.
    /// We only persist `AgentReply` (per design — the cloud backend is the
    /// durable canonical conversation log, not an audit trail).
    pub fn cloud_persistent(msg: &EmittedMessage) -> bool {
        matches!(msg.kind, MessageKind::AgentReply) && !msg.content.trim().is_empty()
    }

    /// Current per-turn correlation id, or `None` between turns. Read by the
    /// publish path so outgoing `Envelope`s carry `turn_id`, letting clients
    /// dedupe `output isComplete=true` events by `(runtime_id, turn_id)`
    /// across daemon-restart-renumbered sequence space.
    pub fn current_turn_id(&self) -> Option<&str> {
        self.current_turn_id.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::amux;

    fn thinking_chunk(text: &str) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::Thinking(amux::AcpThinking {
                text: text.into(),
            })),
            model: String::new(),
        }
    }

    fn output_chunk(text: &str) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.into(),
                is_complete: false,
            })),
            model: String::new(),
        }
    }

    fn tool_use(id: &str, name: &str, desc: &str) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                tool_id: id.into(),
                tool_name: name.into(),
                description: desc.into(),
                params: Default::default(),
                tool_kind: String::new(),
                raw_input_json: String::new(),
                raw_output_json: String::new(),
                content: vec![],
                locations: vec![],
                status: String::new(),
            })),
            model: String::new(),
        }
    }

    fn tool_use_with_params(
        id: &str,
        name: &str,
        desc: &str,
        params: impl IntoIterator<Item = (&'static str, &'static str)>,
    ) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                tool_id: id.into(),
                tool_name: name.into(),
                description: desc.into(),
                params: params
                    .into_iter()
                    .map(|(key, value)| (key.to_string(), value.to_string()))
                    .collect(),
                tool_kind: String::new(),
                raw_input_json: String::new(),
                raw_output_json: String::new(),
                content: vec![],
                locations: vec![],
                status: String::new(),
            })),
            model: String::new(),
        }
    }

    fn tool_result(id: &str, success: bool, summary: &str) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::ToolResult(amux::AcpToolResult {
                tool_id: id.into(),
                success,
                summary: summary.into(),
                raw_output_json: String::new(),
                content: vec![],
            })),
            model: String::new(),
        }
    }

    fn status_change(old: amux::AgentStatus, new: amux::AgentStatus) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::StatusChange(
                amux::AcpStatusChange {
                    old_status: old as i32,
                    new_status: new as i32,
                },
            )),
            model: String::new(),
        }
    }

    #[test]
    fn aggregates_thinking_then_reply_at_turn_end() {
        let mut agg = TurnAggregator::new();
        assert!(agg.ingest(&thinking_chunk("Let me ")).is_empty());
        assert!(agg.ingest(&thinking_chunk("think...")).is_empty());
        assert!(agg.ingest(&output_chunk("The ")).is_empty());
        assert!(agg.ingest(&output_chunk("answer is 579.")).is_empty());

        let emitted = agg.ingest(&status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        ));
        assert_eq!(emitted.len(), 2);
        assert_eq!(emitted[0].kind, MessageKind::AgentThinking);
        assert_eq!(emitted[0].content, "Let me think...");
        assert_eq!(emitted[1].kind, MessageKind::AgentReply);
        assert_eq!(emitted[1].content, "The answer is 579.");
    }

    #[test]
    fn tool_call_interrupts_and_flushes_thinking_and_reply() {
        let mut agg = TurnAggregator::new();
        agg.ingest(&thinking_chunk("Need to read a file"));
        agg.ingest(&output_chunk("I'll use the Read tool."));
        let emitted = agg.ingest(&tool_use("t1", "Read", "{file:foo}"));

        assert_eq!(emitted.len(), 3);
        assert_eq!(emitted[0].kind, MessageKind::AgentThinking);
        assert_eq!(emitted[1].kind, MessageKind::AgentReply);
        assert_eq!(emitted[2].kind, MessageKind::AgentToolCall);
        assert!(emitted[2].content.contains("Read"));
        assert!(emitted[2].metadata_json.contains("\"tool_id\":\"t1\""));
    }

    #[test]
    fn tool_call_metadata_preserves_params() {
        let mut agg = TurnAggregator::new();
        let emitted = agg.ingest(&tool_use_with_params(
            "t1",
            "Bash",
            "Execute ps command",
            [("command", "ps aux")],
        ));

        assert_eq!(emitted.len(), 1);
        let metadata: serde_json::Value = serde_json::from_str(&emitted[0].metadata_json).unwrap();
        assert_eq!(metadata["params"]["command"], "ps aux");
    }

    #[test]
    fn tool_result_emits_immediately() {
        let mut agg = TurnAggregator::new();
        let emitted = agg.ingest(&tool_result("t1", true, "file content here"));
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].kind, MessageKind::AgentToolResult);
        assert_eq!(emitted[0].content, "file content here");
        assert!(emitted[0].metadata_json.contains("\"success\":true"));
    }

    #[test]
    fn tool_only_turn_emits_empty_agent_reply_at_idle() {
        let mut agg = TurnAggregator::new();
        agg.ingest(&status_change(
            amux::AgentStatus::Idle,
            amux::AgentStatus::Active,
        ));
        agg.ingest(&thinking_chunk("Need todos"));
        agg.ingest(&tool_use("t1", "todowrite", "{}"));
        agg.ingest(&tool_result("t1", true, "ok"));

        let emitted = agg.ingest(&status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        ));
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].kind, MessageKind::AgentReply);
        assert!(emitted[0].content.is_empty());
        assert!(!emitted[0].turn_id.is_empty());
    }

    #[test]
    fn empty_agent_reply_is_not_cloud_persistent() {
        let mut agg = TurnAggregator::new();
        agg.ingest(&status_change(
            amux::AgentStatus::Idle,
            amux::AgentStatus::Active,
        ));
        agg.ingest(&thinking_chunk("Need todos"));
        agg.ingest(&tool_use("t1", "todowrite", "{}"));
        agg.ingest(&tool_result("t1", true, "ok"));

        let emitted = agg.ingest(&status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        ));
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].kind, MessageKind::AgentReply);
        assert!(emitted[0].content.is_empty());
        assert!(!TurnAggregator::cloud_persistent(&emitted[0]));
    }

    #[test]
    fn turn_end_with_empty_buffers_emits_nothing() {
        let mut agg = TurnAggregator::new();
        let emitted = agg.ingest(&status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        ));
        assert!(emitted.is_empty());
    }

    #[test]
    fn unrelated_status_changes_do_not_flush() {
        let mut agg = TurnAggregator::new();
        agg.ingest(&output_chunk("partial"));
        let emitted = agg.ingest(&status_change(
            amux::AgentStatus::Idle,
            amux::AgentStatus::Active,
        ));
        assert!(emitted.is_empty());
    }

    #[test]
    fn multi_tool_turn_emits_in_order() {
        let mut agg = TurnAggregator::new();
        agg.ingest(&output_chunk("First, "));
        let r1 = agg.ingest(&tool_use("t1", "Read", "{}"));
        assert_eq!(r1.len(), 2); // reply flush + tool call
        assert_eq!(r1[0].kind, MessageKind::AgentReply);
        assert_eq!(r1[1].kind, MessageKind::AgentToolCall);

        let r2 = agg.ingest(&tool_result("t1", true, "done"));
        assert_eq!(r2.len(), 1);
        assert_eq!(r2[0].kind, MessageKind::AgentToolResult);

        agg.ingest(&output_chunk("then "));
        let r3 = agg.ingest(&tool_use("t2", "Edit", "{}"));
        assert_eq!(r3.len(), 2);
        assert_eq!(r3[0].kind, MessageKind::AgentReply);
        assert_eq!(r3[0].content, "then ");
        assert_eq!(r3[1].kind, MessageKind::AgentToolCall);

        let r4 = agg.ingest(&status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        ));
        assert!(r4.is_empty()); // nothing buffered after the second tool
    }
}

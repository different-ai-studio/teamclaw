//! claude-bridge events → `amux::AcpEvent`.
//!
//! Same vocabulary as `cursor_sdk/translate.rs` and `opencode_http/translate.rs`
//! — the client protocol is backend-neutral, so a new backend's only job here is
//! to map its own event names onto these blocks.

use std::collections::HashMap;

use crate::proto::amux;
use crate::runtime::opencode_http::translate::truncate_tool_summary;

fn text_event(thinking: bool, text: String) -> amux::AcpEvent {
    let event = if thinking {
        amux::acp_event::Event::Thinking(amux::AcpThinking { text })
    } else {
        amux::acp_event::Event::Output(amux::AcpOutput {
            text,
            is_complete: false,
        })
    };
    amux::AcpEvent {
        event: Some(event),
        model: String::new(),
    }
}

fn params_from_map(args: &serde_json::Value) -> HashMap<String, String> {
    match args {
        serde_json::Value::Object(map) => map
            .iter()
            .map(|(k, v)| {
                let s = match v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                (k.clone(), s)
            })
            .collect(),
        _ => HashMap::new(),
    }
}

/// Claude Code's built-in tool names → the shared `tool_kind` vocabulary.
pub fn tool_kind(name: &str) -> &'static str {
    match name {
        "Bash" | "BashOutput" | "KillShell" => "execute",
        "Edit" | "Write" | "NotebookEdit" => "edit",
        "Read" => "read",
        "Glob" | "Grep" => "search",
        "WebFetch" | "WebSearch" => "fetch",
        _ => "other",
    }
}

pub fn translate_event(event: &serde_json::Value) -> Vec<amux::AcpEvent> {
    let name = event.get("event").and_then(|v| v.as_str()).unwrap_or("");
    let text = || {
        event
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };

    match name {
        "assistant_delta" => {
            let text = text();
            if text.is_empty() {
                return Vec::new();
            }
            vec![text_event(false, text)]
        }
        "thinking_delta" => {
            let text = text();
            if text.is_empty() {
                return Vec::new();
            }
            vec![text_event(true, text)]
        }
        "tool_start" => {
            let tool_name = event
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                    tool_id: event
                        .get("toolCallId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    tool_name: tool_name.clone(),
                    description: String::new(),
                    params: params_from_map(event.get("args").unwrap_or(&serde_json::Value::Null)),
                    tool_kind: tool_kind(&tool_name).to_string(),
                    raw_input_json: event.get("args").map(|v| v.to_string()).unwrap_or_default(),
                    raw_output_json: String::new(),
                    content: vec![],
                    locations: vec![],
                    status: "in_progress".to_string(),
                })),
                model: String::new(),
            }]
        }
        "tool_end" => {
            let is_error = event
                .get("isError")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::ToolResult(amux::AcpToolResult {
                    tool_id: event
                        .get("toolCallId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    success: !is_error,
                    summary: truncate_tool_summary(
                        event
                            .get("summary")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    ),
                    raw_output_json: String::new(),
                    content: vec![],
                })),
                model: String::new(),
            }]
        }
        "run_error" => {
            let message = event
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("claude run error")
                .to_string();
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::Error(amux::AcpError {
                    message: message.clone(),
                    details: message,
                })),
                model: String::new(),
            }]
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn one(event: serde_json::Value) -> amux::AcpEvent {
        let mut out = translate_event(&event);
        assert_eq!(out.len(), 1, "expected exactly one event");
        out.remove(0)
    }

    #[test]
    fn tool_kind_maps_claude_code_builtins() {
        assert_eq!(tool_kind("Bash"), "execute");
        assert_eq!(tool_kind("Edit"), "edit");
        assert_eq!(tool_kind("Read"), "read");
        assert_eq!(tool_kind("Grep"), "search");
        assert_eq!(tool_kind("WebFetch"), "fetch");
        assert_eq!(tool_kind("mcp__foo__bar"), "other");
    }

    #[test]
    fn assistant_and_thinking_deltas_split_by_kind() {
        let out = one(json!({"event": "assistant_delta", "text": "hi"}));
        assert!(matches!(out.event, Some(amux::acp_event::Event::Output(_))));
        let out = one(json!({"event": "thinking_delta", "text": "hmm"}));
        assert!(matches!(
            out.event,
            Some(amux::acp_event::Event::Thinking(_))
        ));
    }

    #[test]
    fn empty_text_deltas_are_dropped() {
        assert!(translate_event(&json!({"event": "assistant_delta", "text": ""})).is_empty());
        assert!(translate_event(&json!({"event": "thinking_delta"})).is_empty());
    }

    #[test]
    fn tool_start_carries_kind_and_params() {
        let out = one(json!({
            "event": "tool_start", "toolCallId": "t1", "toolName": "Bash",
            "args": {"command": "ls", "timeout": 5}
        }));
        let Some(amux::acp_event::Event::ToolUse(use_)) = out.event else {
            panic!("expected ToolUse");
        };
        assert_eq!(use_.tool_id, "t1");
        assert_eq!(use_.tool_kind, "execute");
        assert_eq!(use_.params.get("command").map(String::as_str), Some("ls"));
        assert_eq!(use_.params.get("timeout").map(String::as_str), Some("5"));
    }

    #[test]
    fn tool_end_maps_error_flag_to_success() {
        let Some(amux::acp_event::Event::ToolResult(ok)) =
            one(json!({"event": "tool_end", "toolCallId": "t1", "summary": "done"})).event
        else {
            panic!("expected ToolResult");
        };
        assert!(ok.success);
        assert_eq!(ok.summary, "done");

        let Some(amux::acp_event::Event::ToolResult(bad)) =
            one(json!({"event": "tool_end", "toolCallId": "t1", "isError": true})).event
        else {
            panic!("expected ToolResult");
        };
        assert!(!bad.success);
    }

    #[test]
    fn unknown_and_lifecycle_events_translate_to_nothing() {
        // turn_start / turn_end drive route state, not the event stream.
        for name in ["turn_start", "turn_end", "permission_request", "slash_commands", "bogus"] {
            assert!(
                translate_event(&json!({"event": name})).is_empty(),
                "{name} should not translate"
            );
        }
    }
}

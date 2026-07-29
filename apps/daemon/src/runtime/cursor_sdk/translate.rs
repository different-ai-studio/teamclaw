//! cursor-bridge events → `amux::AcpEvent`.

use std::collections::HashMap;

use crate::proto::amux;
use crate::runtime::opencode_http::translate::truncate_tool_summary;

#[derive(Debug, Default)]
pub struct TranslateState {
    emitted_text: HashMap<String, usize>,
}

impl TranslateState {
    pub fn reset_turn(&mut self) {
        self.emitted_text.clear();
    }
}

fn text_event(kind: &str, text: String) -> amux::AcpEvent {
    let event = if kind == "thinking_delta" {
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
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or(&v.to_string()).to_string()))
            .collect(),
        _ => HashMap::new(),
    }
}

fn tool_kind(name: &str) -> &'static str {
    match name {
        "bash" | "shell" | "terminal" => "execute",
        "edit" | "write" | "search_replace" => "edit",
        "read" | "read_file" => "read",
        "grep" | "glob" | "list_dir" => "search",
        "web_fetch" => "fetch",
        _ => "other",
    }
}

pub fn translate_event(
    state: &mut TranslateState,
    event: &serde_json::Value,
) -> Vec<amux::AcpEvent> {
    let name = event.get("event").and_then(|v| v.as_str()).unwrap_or("");
    let run_id = event.get("runId").and_then(|v| v.as_str()).unwrap_or("");

    match name {
        "assistant_delta" => {
            let text = event.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if text.is_empty() {
                return Vec::new();
            }
            let key = format!("{run_id}:text");
            let prev = state.emitted_text.get(&key).copied().unwrap_or(0);
            let full = prev + text.len();
            state.emitted_text.insert(key, full);
            vec![text_event("assistant_delta", text.to_string())]
        }
        "thinking_delta" => {
            let text = event.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if text.is_empty() {
                return Vec::new();
            }
            vec![text_event("thinking_delta", text.to_string())]
        }
        "tool_start" => {
            let tool_call_id = event
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tool_name = event
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let params = params_from_map(event.get("args").unwrap_or(&serde_json::Value::Null));
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                    tool_id: tool_call_id,
                    tool_name: tool_name.clone(),
                    description: String::new(),
                    params,
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
            let tool_call_id = event
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let summary = event
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let is_error = event
                .get("isError")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::ToolResult(amux::AcpToolResult {
                    tool_id: tool_call_id,
                    success: !is_error,
                    summary: truncate_tool_summary(summary),
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
                .unwrap_or("cursor run error")
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

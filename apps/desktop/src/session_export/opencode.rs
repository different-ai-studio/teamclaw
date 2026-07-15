use serde_json::{json, Map, Value};

#[derive(Debug, Clone)]
pub enum SdkPart {
    Reasoning { text: String },
    Text { text: String },
    ToolCall { tool_call: Box<SdkToolCall> },
}

#[derive(Debug, Clone)]
pub struct SdkToolCall {
    pub name: String,
    pub status: String,
    pub arguments: Value,
    pub result: Option<Value>,
    pub raw_output: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct SdkMessage {
    pub id: String,
    pub session_id: String,
    pub sender_actor_id: Option<String>,
    pub role: String,
    pub timestamp_ms: i64,
    pub model_id: Option<String>,
    pub provider_id: Option<String>,
    pub agent: Option<Value>,
    pub parts: Vec<SdkPart>,
}

fn tool_call_status_to_opencode(status: &str) -> &'static str {
    match status {
        "completed" => "completed",
        "failed" => "error",
        "waiting" => "pending",
        _ => "running",
    }
}

fn part_to_opencode(part: &SdkPart) -> Option<Value> {
    match part {
        SdkPart::Reasoning { text } => {
            if text.is_empty() {
                None
            } else {
                Some(json!({ "type": "reasoning", "text": text }))
            }
        }
        SdkPart::Text { text } => {
            if text.is_empty() {
                None
            } else {
                Some(json!({ "type": "text", "text": text }))
            }
        }
        SdkPart::ToolCall { tool_call } => {
            let output = tool_call
                .result
                .clone()
                .or_else(|| tool_call.raw_output.clone())
                .unwrap_or(Value::Null);
            Some(json!({
                "type": "tool",
                "tool": tool_call.name,
                "state": {
                    "status": tool_call_status_to_opencode(&tool_call.status),
                    "input": tool_call.arguments,
                    "output": output
                }
            }))
        }
    }
}

pub fn sdk_message_to_opencode(msg: &SdkMessage) -> Value {
    let mut info = Map::new();
    info.insert("id".to_string(), Value::String(msg.id.clone()));
    info.insert(
        "sessionID".to_string(),
        Value::String(msg.session_id.clone()),
    );
    info.insert("role".to_string(), Value::String(msg.role.clone()));
    info.insert("time".to_string(), json!({ "created": msg.timestamp_ms }));
    if let Some(model_id) = &msg.model_id {
        info.insert("modelID".to_string(), Value::String(model_id.clone()));
    }
    if let Some(provider_id) = &msg.provider_id {
        info.insert("providerID".to_string(), Value::String(provider_id.clone()));
    }
    if let Some(agent) = &msg.agent {
        info.insert("agent".to_string(), agent.clone());
    }
    if let Some(sender_actor_id) = &msg.sender_actor_id {
        if !sender_actor_id.is_empty() {
            info.insert(
                "senderActorId".to_string(),
                Value::String(sender_actor_id.clone()),
            );
        }
    }

    let parts = msg
        .parts
        .iter()
        .filter_map(part_to_opencode)
        .collect::<Vec<_>>();

    json!({
        "info": info,
        "parts": parts
    })
}

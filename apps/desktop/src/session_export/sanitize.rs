use serde_json::{Map, Value};

const INLINE_PAYLOAD_MIN_LENGTH: usize = 256;
const INLINE_PAYLOAD_KEYS: [&str; 4] = ["base64", "binary", "bytes", "data"];
const MEDIA_PART_TYPES: [&str; 4] = ["image", "video", "audio", "file"];

fn is_media_part(part: &Value) -> bool {
    let Some(obj) = part.as_object() else {
        return false;
    };
    let Some(kind) = obj.get("type").and_then(Value::as_str) else {
        return false;
    };
    MEDIA_PART_TYPES.contains(&kind)
}

fn is_large_inline_payload(value: &Value) -> bool {
    let Some(raw) = value.as_str() else {
        return false;
    };
    if raw.len() < INLINE_PAYLOAD_MIN_LENGTH {
        return false;
    }
    if raw
        .get(..22)
        .map(|prefix| prefix.eq_ignore_ascii_case("data:") && raw.contains(";base64,"))
        .unwrap_or(false)
    {
        return true;
    }

    let compact = raw.chars().filter(|ch| !ch.is_whitespace());
    let mut len = 0usize;
    for ch in compact {
        len += 1;
        if !(ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=')) {
            return false;
        }
    }
    len >= INLINE_PAYLOAD_MIN_LENGTH
}

fn sanitize_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => sanitize_list(items),
        Value::Object(obj) => Value::Object(sanitize_dict(obj)),
        _ => value.clone(),
    }
}

fn sanitize_dict(data: &Map<String, Value>) -> Map<String, Value> {
    let mut cleaned = Map::new();
    for (key, value) in data {
        let lower = key.to_ascii_lowercase();
        if INLINE_PAYLOAD_KEYS.contains(&lower.as_str()) && is_large_inline_payload(value) {
            continue;
        }
        if is_large_inline_payload(value) {
            continue;
        }
        cleaned.insert(key.clone(), sanitize_value(value));
    }
    cleaned
}

fn sanitize_list(items: &[Value]) -> Value {
    let mut cleaned = Vec::with_capacity(items.len());
    for item in items {
        if is_media_part(item) {
            continue;
        }
        cleaned.push(sanitize_value(item));
    }
    Value::Array(cleaned)
}

fn sanitize_message(message: &Value) -> Value {
    let Some(obj) = message.as_object() else {
        return message.clone();
    };
    let mut cleaned = sanitize_dict(obj);
    if let Some(parts) = obj.get("parts").and_then(Value::as_array) {
        cleaned.insert("parts".to_string(), sanitize_list(parts));
    }
    Value::Object(cleaned)
}

pub fn sanitize_opencode_messages(messages: &[Value]) -> Vec<Value> {
    messages.iter().map(sanitize_message).collect()
}

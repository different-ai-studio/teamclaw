//! Pure ACP → amux-proto translation + tool-call formatting, extracted from
//! `adapter.rs`.
//!
//! All stateless free functions converting `agent_client_protocol` types into
//! the daemon's `amux` wire proto, plus tool-call title/summary formatting and
//! attachment fetching. No shared state — isolates ~560 lines of mechanical
//! translation from the ACP host process-management core.
//!
//! Child module of `runtime::adapter`; functions are `pub(super)` and glob-
//! imported back via `use translate::*` so the call sites are unchanged.

use std::collections::HashMap;

use agent_client_protocol as acp;
use base64::Engine as _;

use crate::proto::amux;
use tracing::{debug, info};

pub(super) fn translate_session_update(update: acp::SessionUpdate) -> Vec<amux::AcpEvent> {
    match update {
        acp::SessionUpdate::AgentMessageChunk(chunk) => {
            let text = extract_text(&chunk.content);
            if text.is_empty() {
                return vec![];
            }
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                    text,
                    is_complete: false,
                })),
                model: String::new(),
            }]
        }
        acp::SessionUpdate::AgentThoughtChunk(chunk) => {
            let text = extract_text(&chunk.content);
            if text.is_empty() {
                return vec![];
            }
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::Thinking(amux::AcpThinking { text })),
                model: String::new(),
            }]
        }
        acp::SessionUpdate::ToolCall(tc) => {
            info!(
                tool_id = %tc.tool_call_id,
                title = %tc.title,
                kind = ?tc.kind,
                status = ?tc.status,
                content_count = tc.content.len(),
                has_raw_input = tc.raw_input.is_some(),
                "ACP ToolCall"
            );
            let (tool_name, params) = tool_use_wire_fields(&tc.title, tc.raw_input.as_ref());
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::ToolUse(make_acp_tool_use(
                    tc.tool_call_id.to_string(),
                    tool_name,
                    params,
                    kind_to_snake(&tc.kind),
                    tc.raw_input.as_ref(),
                    None,
                    &tc.content,
                    &tc.locations,
                    Some(tc.status),
                ))),
                model: String::new(),
            }]
        }
        acp::SessionUpdate::ToolCallUpdate(tcu) => {
            info!(
                tool_id = %tcu.tool_call_id,
                title = ?tcu.fields.title,
                status = ?tcu.fields.status,
                kind = ?tcu.fields.kind,
                content_count = tcu.fields.content.as_ref().map(|c| c.len()).unwrap_or(0),
                "ACP ToolCallUpdate"
            );
            let tool_id = tcu.tool_call_id.to_string();
            let status = tcu.fields.status;
            let is_completed = matches!(
                status,
                Some(acp::ToolCallStatus::Completed) | Some(acp::ToolCallStatus::Failed)
            );

            if is_completed {
                let success = matches!(status, Some(acp::ToolCallStatus::Completed));
                let has_raw_output = tcu.fields.raw_output.is_some();
                let fallback_summary = || {
                    tcu.fields.title.clone().unwrap_or_else(|| {
                        if success {
                            "completed".into()
                        } else {
                            "failed".into()
                        }
                    })
                };
                let summary = truncate_tool_summary(
                    tool_output_summary(tcu.fields.raw_output.as_ref())
                        .or_else(|| tool_content_summary(tcu.fields.content.as_deref()))
                        .unwrap_or_else(|| {
                            if has_raw_output {
                                String::new()
                            } else {
                                fallback_summary()
                            }
                        }),
                );
                vec![amux::AcpEvent {
                    event: Some(amux::acp_event::Event::ToolResult(make_acp_tool_result(
                        tool_id,
                        success,
                        summary,
                        tcu.fields.raw_output.as_ref(),
                        tcu.fields.content.as_deref(),
                    ))),
                    model: String::new(),
                }]
            } else {
                let kind = tcu.fields.kind.as_ref().unwrap_or(&acp::ToolKind::Other);
                let title = tcu.fields.title.as_deref().unwrap_or_default();
                let (tool_name, params) =
                    tool_use_wire_fields(title, tcu.fields.raw_input.as_ref());
                let content_slice = tcu.fields.content.as_deref().unwrap_or_default();
                let locations_slice = tcu.fields.locations.as_deref().unwrap_or_default();
                let has_payload = !tool_name.is_empty()
                    || !params.is_empty()
                    || tcu.fields.raw_input.is_some()
                    || tcu.fields.raw_output.is_some()
                    || !content_slice.is_empty()
                    || !locations_slice.is_empty()
                    || tcu.fields.status.is_some();
                if has_payload {
                    vec![amux::AcpEvent {
                        event: Some(amux::acp_event::Event::ToolUse(make_acp_tool_use(
                            tool_id,
                            tool_name,
                            params,
                            kind_to_snake(kind),
                            tcu.fields.raw_input.as_ref(),
                            tcu.fields.raw_output.as_ref(),
                            content_slice,
                            locations_slice,
                            tcu.fields.status,
                        ))),
                        model: String::new(),
                    }]
                } else {
                    vec![]
                }
            }
        }
        acp::SessionUpdate::SessionInfoUpdate(info) => {
            if let acp::MaybeUndefined::Value(title) = info.title {
                // Use RawJson to carry session title update to the main runtime
                vec![amux::AcpEvent {
                    event: Some(amux::acp_event::Event::Raw(amux::AcpRawJson {
                        method: "session_title".into(),
                        json_payload: title.into_bytes(),
                    })),
                    model: String::new(),
                }]
            } else {
                vec![]
            }
        }
        acp::SessionUpdate::AvailableCommandsUpdate(upd) => {
            let commands = upd
                .available_commands
                .into_iter()
                .map(|c| {
                    let input_hint = match c.input {
                        Some(acp::AvailableCommandInput::Unstructured(u)) => u.hint,
                        _ => String::new(),
                    };
                    amux::AcpAvailableCommand {
                        name: c.name,
                        description: c.description,
                        input_hint,
                    }
                })
                .collect();
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::AvailableCommands(
                    amux::AcpAvailableCommands { commands },
                )),
                model: String::new(),
            }]
        }
        acp::SessionUpdate::Plan(plan) => {
            let entries = plan
                .entries
                .into_iter()
                .map(|e| amux::AcpPlanEntry {
                    content: e.content,
                    priority: plan_priority_to_snake(&e.priority),
                    status: plan_status_to_snake(&e.status),
                })
                .collect();
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::PlanUpdate(amux::AcpPlanUpdate {
                    entries,
                })),
                model: String::new(),
            }]
        }
        _ => {
            debug!("unhandled SessionUpdate variant");
            vec![]
        }
    }
}

pub(super) fn plan_priority_to_snake(p: &acp::PlanEntryPriority) -> String {
    match p {
        acp::PlanEntryPriority::High => "high",
        acp::PlanEntryPriority::Medium => "medium",
        acp::PlanEntryPriority::Low => "low",
        _ => "medium",
    }
    .to_string()
}

pub(super) fn plan_status_to_snake(s: &acp::PlanEntryStatus) -> String {
    match s {
        acp::PlanEntryStatus::Pending => "pending",
        acp::PlanEntryStatus::InProgress => "in_progress",
        acp::PlanEntryStatus::Completed => "completed",
        _ => "pending",
    }
    .to_string()
}

pub(super) fn clean_tool_title(title: &str) -> String {
    let trimmed = title.trim().trim_matches('"').trim();
    if trimmed.is_empty() || trimmed == "undefined" {
        String::new()
    } else {
        trimmed.to_string()
    }
}

/// Map ACP tool call to amux wire fields (Phase 1 fidelity):
/// - `tool_name` = ACP `title` verbatim (after clean_tool_title)
/// - `params` = rawInput key/values only
pub(super) fn tool_use_wire_fields(
    title: &str,
    raw_input: Option<&serde_json::Value>,
) -> (String, HashMap<String, String>) {
    let params = tool_call_params(raw_input);
    let tool_name = clean_tool_title(title);
    (tool_name, params)
}

pub(super) fn acp_status_to_snake(status: acp::ToolCallStatus) -> String {
    match status {
        acp::ToolCallStatus::Pending => "pending",
        acp::ToolCallStatus::InProgress => "in_progress",
        acp::ToolCallStatus::Completed => "completed",
        acp::ToolCallStatus::Failed => "failed",
        _ => "pending",
    }
    .to_string()
}

pub(super) fn acp_locations_to_proto(
    locations: &[acp::ToolCallLocation],
) -> Vec<amux::AcpToolCallLocation> {
    locations
        .iter()
        .map(|loc| amux::AcpToolCallLocation {
            path: loc.path.display().to_string(),
            line: loc.line,
        })
        .collect()
}

pub(super) fn acp_content_to_proto(
    content: &[acp::ToolCallContent],
) -> Vec<amux::AcpToolCallContent> {
    content
        .iter()
        .filter_map(|item| {
            let payload = match item {
                acp::ToolCallContent::Content(c) => {
                    let text = extract_text(&c.content);
                    if text.trim().is_empty() {
                        return None;
                    }
                    amux::acp_tool_call_content::Payload::Text(amux::AcpToolCallTextContent {
                        text,
                    })
                }
                acp::ToolCallContent::Diff(d) => {
                    amux::acp_tool_call_content::Payload::Diff(amux::AcpToolCallDiff {
                        path: d.path.display().to_string(),
                        old_text: d.old_text.clone(),
                        new_text: d.new_text.clone(),
                    })
                }
                acp::ToolCallContent::Terminal(t) => {
                    amux::acp_tool_call_content::Payload::Terminal(amux::AcpToolCallTerminal {
                        terminal_id: t.terminal_id.to_string(),
                    })
                }
                _ => return None,
            };
            Some(amux::AcpToolCallContent {
                payload: Some(payload),
            })
        })
        .collect()
}

pub(super) fn make_acp_tool_use(
    tool_id: String,
    tool_name: String,
    params: HashMap<String, String>,
    tool_kind: String,
    raw_input: Option<&serde_json::Value>,
    raw_output: Option<&serde_json::Value>,
    content: &[acp::ToolCallContent],
    locations: &[acp::ToolCallLocation],
    status: Option<acp::ToolCallStatus>,
) -> amux::AcpToolUse {
    amux::AcpToolUse {
        tool_id,
        tool_name,
        description: String::new(),
        params,
        tool_kind,
        raw_input_json: raw_input.map(|v| v.to_string()).unwrap_or_default(),
        raw_output_json: raw_output.map(|v| v.to_string()).unwrap_or_default(),
        content: acp_content_to_proto(content),
        locations: acp_locations_to_proto(locations),
        status: status.map(acp_status_to_snake).unwrap_or_default(),
    }
}

pub(super) fn make_acp_tool_result(
    tool_id: String,
    success: bool,
    summary: String,
    raw_output: Option<&serde_json::Value>,
    content: Option<&[acp::ToolCallContent]>,
) -> amux::AcpToolResult {
    amux::AcpToolResult {
        tool_id,
        success,
        summary,
        raw_output_json: raw_output.map(|v| v.to_string()).unwrap_or_default(),
        content: acp_content_to_proto(content.unwrap_or_default()),
    }
}

// ACP ToolKind → snake_case wire string for `AcpToolUse.tool_kind`.
// Matches the ACP JSON schema serde rename so renderers can switch on
// the same vocabulary as the protocol.
pub(super) fn kind_to_snake(kind: &acp::ToolKind) -> String {
    match kind {
        acp::ToolKind::Read => "read",
        acp::ToolKind::Edit => "edit",
        acp::ToolKind::Delete => "delete",
        acp::ToolKind::Move => "move",
        acp::ToolKind::Search => "search",
        acp::ToolKind::Execute => "execute",
        acp::ToolKind::Think => "think",
        acp::ToolKind::Fetch => "fetch",
        acp::ToolKind::SwitchMode => "switch_mode",
        _ => "other",
    }
    .to_string()
}

pub(super) fn extract_text(content: &acp::ContentBlock) -> String {
    match content {
        acp::ContentBlock::Text(t) => t.text.clone(),
        acp::ContentBlock::Image(_) => "<image>".into(),
        acp::ContentBlock::Audio(_) => "<audio>".into(),
        acp::ContentBlock::ResourceLink(rl) => rl.uri.clone(),
        acp::ContentBlock::Resource(_) => "<resource>".into(),
        _ => String::new(),
    }
}

pub(super) fn json_value_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        _ => value.to_string(),
    }
}

pub(super) fn tool_call_params(raw_input: Option<&serde_json::Value>) -> HashMap<String, String> {
    match raw_input {
        Some(serde_json::Value::Object(map)) => map
            .iter()
            .map(|(key, value)| (key.clone(), json_value_to_string(value)))
            .collect(),
        Some(value) => HashMap::from([("input".to_string(), json_value_to_string(value))]),
        None => HashMap::new(),
    }
}

pub(super) fn tool_output_summary(raw_output: Option<&serde_json::Value>) -> Option<String> {
    let value = raw_output?;
    json_tool_output_text(value).or_else(|| match value {
        serde_json::Value::Object(map) => {
            if map.contains_key("metadata") || map.contains_key("content") {
                None
            } else {
                let text = json_value_to_string(value);
                if text.is_empty() { None } else { Some(text) }
            }
        }
        serde_json::Value::Array(_) => None,
        _ => {
            let text = json_value_to_string(value);
            if text.is_empty() { None } else { Some(text) }
        }
    })
}

pub(super) fn json_tool_output_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => {
            if text.is_empty() {
                None
            } else {
                Some(text.clone())
            }
        }
        serde_json::Value::Object(map) => {
            for key in ["raw", "output", "result", "text"] {
                if let Some(summary) = map.get(key).and_then(json_tool_output_text) {
                    return Some(summary);
                }
            }

            let stdio = ["stdout", "stderr"]
                .into_iter()
                .filter_map(|key| map.get(key).and_then(json_tool_output_text))
                .filter(|text| !text.trim().is_empty())
                .collect::<Vec<_>>();
            if !stdio.is_empty() {
                return Some(stdio.join("\n"));
            }

            if let Some(summary) = map.get("metadata").and_then(json_tool_output_text) {
                return Some(summary);
            }

            map.get("content").and_then(json_content_summary)
        }
        serde_json::Value::Array(_) => json_content_summary(value),
        serde_json::Value::Null => None,
        _ => {
            let text = value.to_string();
            if text.is_empty() { None } else { Some(text) }
        }
    }
}

pub(super) fn json_content_summary(value: &serde_json::Value) -> Option<String> {
    let items = value.as_array()?;
    let mut parts = Vec::new();
    for item in items {
        match item {
            serde_json::Value::String(text) if !text.trim().is_empty() => {
                parts.push(text.clone());
            }
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::String(text)) = map.get("text") {
                    if !text.trim().is_empty() {
                        parts.push(text.clone());
                    }
                } else if let Some(text) = map.get("content").and_then(json_tool_output_text) {
                    if !text.trim().is_empty() {
                        parts.push(text);
                    }
                }
            }
            _ => {}
        }
    }
    let text = parts.join("\n\n");
    if text.is_empty() { None } else { Some(text) }
}

pub(super) fn tool_content_summary(content: Option<&[acp::ToolCallContent]>) -> Option<String> {
    let content = content?;
    let mut parts = Vec::new();
    for item in content {
        match item {
            acp::ToolCallContent::Content(content) => {
                let text = extract_text(&content.content);
                if !text.trim().is_empty() {
                    parts.push(text);
                }
            }
            acp::ToolCallContent::Diff(_) => {}
            acp::ToolCallContent::Terminal(_) => {}
            _ => {}
        }
    }
    let text = parts.join("\n\n");
    if text.is_empty() { None } else { Some(text) }
}

pub(super) fn truncate_tool_summary(summary: String) -> String {
    const LIMIT: usize = 20_000;
    if summary.chars().count() > LIMIT {
        format!("{}...", summary.chars().take(LIMIT).collect::<String>())
    } else {
        summary
    }
}

// ---------------------------------------------------------------------------
// Attachment → ACP ContentBlock
// ---------------------------------------------------------------------------

static IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp"];

/// Return the (path, extension) for a URL, stripping the query string FIRST
/// so a JWT in `?token=…` (Supabase signed URLs put one there, and the JWT
/// payload contains `.` separators) does not poison the `rsplit('.')` ext
/// sniff. Without this, `eyJ.foo.bar` makes every signed image URL look
/// like it ends in `.bar` and the image gets misclassified as a non-image
/// ResourceLink.
pub(super) fn path_and_ext(url: &str) -> (&str, String) {
    let path = url.split('?').next().unwrap_or(url);
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    (path, ext)
}

/// Download a Supabase Storage URL and return the appropriate ACP ContentBlock:
/// - Image extensions → ContentBlock::Image (base64-encoded bytes)
/// - All others       → ContentBlock::ResourceLink (URL reference)
pub(super) async fn build_attachment_block(url: &str) -> anyhow::Result<acp::ContentBlock> {
    let (path, ext) = path_and_ext(url);

    if IMAGE_EXTS.contains(&ext.as_str()) {
        let bytes = reqwest::get(url).await?.bytes().await?;
        let mime = match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => "image/png",
        };
        // Safety net for originals uploaded by older clients: base64-inlining
        // a multi-MB image into the prompt wastes tokens/memory (issue #710),
        // so downscale/re-encode oversized ones before encoding.
        let (bytes, mime) = compress_image_for_prompt(bytes.to_vec(), mime).await;
        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(acp::ContentBlock::Image(acp::ImageContent::new(data, mime)))
    } else {
        let name = path.rsplit('/').next().unwrap_or("attachment").to_string();
        Ok(acp::ContentBlock::ResourceLink(acp::ResourceLink::new(
            name, url,
        )))
    }
}

/// Longest edge cap for images inlined into ACP prompts.
const PROMPT_IMAGE_MAX_DIMENSION: u32 = 2048;
/// Images at or below this byte size are inlined as-is.
const PROMPT_IMAGE_SKIP_BELOW_BYTES: usize = 512 * 1024;

/// Downscale + re-encode an oversized image as JPEG (quality 85) before it is
/// base64-inlined into the prompt. Returns the original bytes and mime on any
/// decode failure, for GIFs (may be animated), or when re-encoding would not
/// shrink the payload. Runs on a blocking thread — decode/resize is CPU-bound.
async fn compress_image_for_prompt(bytes: Vec<u8>, mime: &'static str) -> (Vec<u8>, &'static str) {
    if mime == "image/gif" || bytes.len() <= PROMPT_IMAGE_SKIP_BELOW_BYTES {
        return (bytes, mime);
    }
    let original_len = bytes.len();
    let input = bytes.clone();
    let compressed = tokio::task::spawn_blocking(move || -> Option<Vec<u8>> {
        let img = match image::load_from_memory(&input) {
            Ok(img) => img,
            Err(err) => {
                tracing::warn!("attachment image decode failed, inlining original: {err}");
                return None;
            }
        };
        let img = if img.width().max(img.height()) > PROMPT_IMAGE_MAX_DIMENSION {
            img.resize(
                PROMPT_IMAGE_MAX_DIMENSION,
                PROMPT_IMAGE_MAX_DIMENSION,
                image::imageops::FilterType::Triangle,
            )
        } else {
            img
        };
        let mut out = std::io::Cursor::new(Vec::new());
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
        // JPEG has no alpha — flatten to RGB first.
        if let Err(err) = img.to_rgb8().write_with_encoder(encoder) {
            tracing::warn!("attachment image re-encode failed, inlining original: {err}");
            return None;
        }
        let encoded = out.into_inner();
        (encoded.len() < original_len).then_some(encoded)
    })
    .await;
    match compressed {
        Ok(Some(encoded)) => (encoded, "image/jpeg"),
        Ok(None) => (bytes, mime),
        Err(err) => {
            tracing::warn!("attachment image compression task failed: {err}");
            (bytes, mime)
        }
    }
}

/// Parse task tool in-progress metadata for subagent child session binding.
pub(super) fn extract_task_child_metadata(update: &acp::SessionUpdate) -> Option<(String, String)> {
    let tcu = match update {
        acp::SessionUpdate::ToolCallUpdate(tcu) => tcu,
        _ => return None,
    };
    if !matches!(tcu.fields.status, Some(acp::ToolCallStatus::InProgress)) {
        return None;
    }
    let raw_output = tcu.fields.raw_output.as_ref()?;
    let metadata = raw_output.get("metadata")?.as_object()?;
    let child = metadata.get("sessionId")?.as_str()?.trim();
    if child.is_empty() {
        return None;
    }
    let root = metadata
        .get("parentSessionId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Some((child.to_string(), root))
}

use serde_json::{json, Value};

pub const TOOL_GET_PAGE_DOM: &str = "get_page_dom";
pub const TOOL_SHOW_PAGE_NAV_LINKS: &str = "show_page_nav_links";

pub const DEFAULT_TIMEOUT_MS: i32 = 30_000;

/// All remote tools exposed to agents via remote-tools-mcp.
pub fn all_tool_names() -> &'static [&'static str] {
    &[TOOL_GET_PAGE_DOM, TOOL_SHOW_PAGE_NAV_LINKS]
}

pub fn is_known_tool(tool_name: &str) -> bool {
    all_tool_names().iter().any(|n| *n == tool_name)
}

/// UI-only tools: daemon returns immediately; chat renders buttons from the
/// tool-call arguments already in the ACP transcript (no MQTT client roundtrip).
pub fn is_daemon_local_tool(tool_name: &str) -> bool {
    tool_name == TOOL_SHOW_PAGE_NAV_LINKS
}

pub fn tool_input_schema(tool_name: &str) -> Option<Value> {
    match tool_name {
        TOOL_GET_PAGE_DOM => Some(json!({
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["outline", "text"],
                    "default": "outline"
                },
                "max_chars": {
                    "type": "integer",
                    "default": 8000,
                    "maximum": 16000
                }
            }
        })),
        TOOL_SHOW_PAGE_NAV_LINKS => Some(json!({
            "type": "object",
            "required": ["links"],
            "properties": {
                "links": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 1,
                    "maxItems": 8
                },
                "labels": {
                    "type": "array",
                    "items": { "type": "string" }
                }
            }
        })),
        _ => None,
    }
}

pub fn tool_description(tool_name: &str) -> Option<&'static str> {
    match tool_name {
        TOOL_GET_PAGE_DOM => Some(
            "Read the user's current browser page as a compact outline or plain text. \
             Supported clients: chrome-extension (TeamClaw browser extension with the active tab). \
             Do not call unless the user's environment indicates the extension client.",
        ),
        TOOL_SHOW_PAGE_NAV_LINKS => Some(
            "Show navigation buttons in the user's TeamClaw chat for the given links. \
             Each button navigates the user's active browser tab when clicked (extension). \
             Optional labels[] provides button text (same length as links). \
             Returns nothing to the agent — UI is rendered from tool-call arguments; \
             no browser roundtrip during the tool call.",
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_phase1_tools() {
        assert!(is_known_tool(TOOL_GET_PAGE_DOM));
        assert!(is_known_tool(TOOL_SHOW_PAGE_NAV_LINKS));
        assert!(!is_known_tool("other"));
    }
}

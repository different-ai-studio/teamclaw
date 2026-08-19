//! The WeCom bot's own MCP server, over plain HTTP.
//!
//! Separate from the long connection on purpose: that link can only answer what
//! it is handed — it has no way to ask "which chats is this bot in" — while this
//! one is an account-level credential that answers exactly that, whether or not
//! the websocket is up.
//!
//! Only the read side is wired. Sending stays on the gateway, which already
//! records what it sends into the session; a second outbound path that the core
//! never sees is how a reply ends up in a chat and nowhere else.

use serde::Deserialize;

/// One conversation the bot is part of.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct BotChat {
    pub chat_id: String,
    /// WeCom leaves this empty for groups; only DMs come back named.
    pub chat_name: String,
    /// `single` or `group`.
    pub chat_type: String,
    pub last_msg_time: String,
}

#[derive(Deserialize)]
struct RpcEnvelope {
    result: Option<RpcResult>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct RpcResult {
    content: Vec<RpcContent>,
}

#[derive(Deserialize)]
struct RpcContent {
    text: String,
}

#[derive(Deserialize)]
struct SessionsPayload {
    #[serde(default)]
    sessions: Vec<SessionRow>,
    #[serde(default)]
    errcode: i64,
    #[serde(default)]
    errmsg: String,
}

#[derive(Deserialize)]
struct SessionRow {
    chat_id: String,
    #[serde(default)]
    chat_name: String,
    #[serde(default)]
    chat_type: String,
    #[serde(default)]
    last_msg_time: String,
}

/// Where the bot's MCP server lives. The api key is the whole credential, so it
/// travels in the query string exactly as WeCom hands it out.
fn endpoint(api_key: &str) -> String {
    format!("https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey={api_key}")
}

/// The chats this bot can be addressed in.
///
/// Returns them in the order WeCom gives, which is most-recent-first.
pub async fn list_chats(api_key: &str) -> Result<Vec<BotChat>, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("wecom mcp: no api key configured for this bot".into());
    }
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": "message_aibot_sessions_list", "arguments": {} }
    });
    let resp = reqwest::Client::new()
        .post(endpoint(api_key))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("wecom mcp: request failed: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("wecom mcp: unreadable response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "wecom mcp: http {status}: {}",
            text.chars().take(200).collect::<String>()
        ));
    }
    parse_chats(&text)
}

/// Split out so the two-layer envelope is testable without a network.
///
/// The payload is JSON *inside a JSON string* inside the RPC result, and its
/// own `errcode` is where WeCom reports a bad key — an HTTP 200 says nothing.
pub(crate) fn parse_chats(raw: &str) -> Result<Vec<BotChat>, String> {
    let env: RpcEnvelope =
        serde_json::from_str(raw).map_err(|e| format!("wecom mcp: bad envelope: {e}"))?;
    if let Some(err) = env.error {
        return Err(format!("wecom mcp: {err}"));
    }
    let inner = env
        .result
        .and_then(|r| r.content.into_iter().next())
        .ok_or_else(|| "wecom mcp: response carried no content".to_string())?;
    let payload: SessionsPayload =
        serde_json::from_str(&inner.text).map_err(|e| format!("wecom mcp: bad payload: {e}"))?;
    if payload.errcode != 0 {
        return Err(format!(
            "wecom mcp: errcode {} {}",
            payload.errcode, payload.errmsg
        ));
    }
    Ok(payload
        .sessions
        .into_iter()
        .map(|s| BotChat {
            chat_id: s.chat_id,
            chat_name: s.chat_name,
            chat_type: s.chat_type,
            last_msg_time: s.last_msg_time,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_list_comes_back_as_chats() {
        // Shape copied from a live call: the useful JSON is a string inside
        // `result.content[0].text`, and WeCom also injects an identity blob we
        // have no use for.
        let raw = r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"extra_identity_context\":\"…\",\"sessions\":[{\"chat_id\":\"wr1\",\"chat_name\":\"\",\"last_msg_time\":\"2026-08-19 14:24:01\",\"chat_type\":\"group\"},{\"chat_id\":\"wo1\",\"chat_name\":\"Matt chow\",\"last_msg_time\":\"2026-08-19 13:29:20\",\"chat_type\":\"single\"}],\"sessions_count\":2,\"errcode\":0,\"errmsg\":\"ok\"}"}],"isError":false}}"#;
        let chats = parse_chats(raw).unwrap();
        assert_eq!(chats.len(), 2);
        assert_eq!(chats[0].chat_id, "wr1");
        assert_eq!(chats[0].chat_type, "group");
        assert_eq!(chats[1].chat_name, "Matt chow");
    }

    #[test]
    fn a_rejected_key_is_an_error_even_though_the_http_call_succeeded() {
        // WeCom answers 200 with the failure inside the payload; reading only
        // the status would show the user an empty chat list and no reason.
        let raw = r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"errcode\":40001,\"errmsg\":\"invalid apikey\"}"}]}}"#;
        let err = parse_chats(raw).unwrap_err();
        assert!(err.contains("40001"), "{err}");
        assert!(err.contains("invalid apikey"), "{err}");
    }

    #[test]
    fn an_rpc_level_error_is_reported_as_one() {
        let raw =
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}"#;
        assert!(parse_chats(raw).unwrap_err().contains("Method not found"));
    }

    #[tokio::test]
    async fn no_key_means_no_call() {
        assert!(list_chats("  ").await.unwrap_err().contains("no api key"));
    }
}

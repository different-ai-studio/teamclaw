use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex;
use tokio::time::timeout;
use tracing::warn;

use crate::proto::teamclaw::{
    rpc_request, rpc_response, RemoteToolInvokeRequest, RemoteToolInvokeResult, RpcRequest,
};
use crate::teamclaw::rpc::RpcClient;

use super::registry::{is_daemon_local_tool, is_known_tool, DEFAULT_TIMEOUT_MS};
use super::session_target::SessionRemoteTargetStore;

pub struct InvokeError {
    pub code: &'static str,
    pub message: String,
}

impl InvokeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub async fn invoke_remote_tool(
    rpc_client: &Arc<Mutex<RpcClient>>,
    daemon_actor_id: &str,
    member_actor_id: &str,
    session_id: &str,
    tool_name: &str,
    arguments: &Value,
) -> Result<Value, InvokeError> {
    if tool_name.is_empty() {
        return Err(InvokeError::new("invalid_arguments", "tool_name required"));
    }
    if !is_known_tool(tool_name) {
        return Err(InvokeError::new(
            "unknown_tool",
            format!("unknown tool: {tool_name}"),
        ));
    }
    if is_daemon_local_tool(tool_name) {
        return Ok(Value::Null);
    }
    if member_actor_id.is_empty() {
        return Err(InvokeError::new(
            "no_remote_client",
            "no member actor registered for session (runtimeStart not seen recently)",
        ));
    }

    let arguments_json = serde_json::to_string(arguments).map_err(|e| {
        InvokeError::new(
            "invalid_arguments",
            format!("arguments serialize failed: {e}"),
        )
    })?;

    let invoke = RemoteToolInvokeRequest {
        session_id: session_id.to_string(),
        tool_name: tool_name.to_string(),
        arguments_json,
    };

    let request = RpcRequest {
        request_id: String::new(),
        requester_client_id: String::new(),
        requester_actor_id: daemon_actor_id.to_string(),
        method: Some(rpc_request::Method::RemoteToolInvoke(invoke)),
    };

    let wait = Duration::from_millis(DEFAULT_TIMEOUT_MS.max(1) as u64);
    let (request_id, rx) = {
        let mut client = rpc_client.lock().await;
        client
            .request_remote_tool(member_actor_id, request)
            .await
            .map_err(|e| InvokeError::new("mqtt_unavailable", format!("publish rpc failed: {e}")))?
    };

    let response = match timeout(wait, rx).await {
        Ok(Ok(resp)) => resp,
        Ok(Err(_)) => {
            rpc_client
                .lock()
                .await
                .remote_tool_pending
                .remove(&request_id);
            return Err(InvokeError::new(
                "no_handler",
                "no client handled the remote tool call",
            ));
        }
        Err(_) => {
            rpc_client
                .lock()
                .await
                .remote_tool_pending
                .remove(&request_id);
            return Err(InvokeError::new(
                "rpc_timeout",
                "remote tool call timed out with no capable client",
            ));
        }
    };

    if !response.success {
        return Err(InvokeError::new(
            "executor_error",
            if response.error.is_empty() {
                "remote tool rpc failed".to_string()
            } else {
                response.error.clone()
            },
        ));
    }

    match response.result {
        Some(rpc_response::Result::RemoteToolInvokeResult(result)) => parse_invoke_result(result),
        _ => Err(InvokeError::new(
            "executor_error",
            "unexpected rpc result variant",
        )),
    }
}

fn parse_invoke_result(result: RemoteToolInvokeResult) -> Result<Value, InvokeError> {
    if result.success {
        if result.result_json.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&result.result_json)
            .map_err(|e| InvokeError::new("executor_error", format!("invalid result_json: {e}")))
    } else {
        let code = if result.error_code.is_empty() {
            "executor_error".to_string()
        } else {
            result.error_code.clone()
        };
        Err(InvokeError::new(
            "executor_error",
            if result.error_message.is_empty() {
                format!("remote tool failed ({code})")
            } else {
                result.error_message
            },
        ))
    }
}

pub(crate) fn resolve_member_target(
    targets: &SessionRemoteTargetStore,
    session_id: &str,
) -> Option<String> {
    targets.get(session_id).map(str::to_string)
}

pub async fn handle_sock_invoke_for_target(
    rpc_client: &Arc<Mutex<RpcClient>>,
    daemon_actor_id: &str,
    member_actor_id: &str,
    session_id: &str,
    tool_name: &str,
    arguments: &Value,
) -> Value {
    match invoke_remote_tool(
        rpc_client,
        daemon_actor_id,
        member_actor_id,
        session_id,
        tool_name,
        arguments,
    )
    .await
    {
        Ok(result) => serde_json::json!({ "ok": true, "result": result }),
        Err(e) => {
            warn!(
                session_id,
                tool_name,
                member_actor_id,
                code = e.code,
                err = %e.message,
                "remote-tool-call failed"
            );
            sock_err(e.code, &e.message)
        }
    }
}

pub(crate) fn sock_err(code: &str, message: &str) -> Value {
    serde_json::json!({
        "ok": false,
        "error": code,
        "message": message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use teamclaw_transport::MessagePublisher;

    #[test]
    fn resolve_member_target_returns_latest_runtime_start_actor() {
        let mut store = SessionRemoteTargetStore::default();
        store.set("s1", "member-a");
        store.set("s1", "member-b");
        assert_eq!(
            resolve_member_target(&store, "s1").as_deref(),
            Some("member-b")
        );
        assert!(resolve_member_target(&store, "missing").is_none());
    }

    #[tokio::test]
    async fn invoke_errors_when_member_actor_missing() {
        let (client, _eventloop) =
            rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
        let rpc_client = Arc::new(Mutex::new(RpcClient::new(
            Arc::new(client) as Arc<dyn MessagePublisher>,
            "team1".to_string(),
            "daemon".to_string(),
        )));

        let err = invoke_remote_tool(
            &rpc_client,
            "daemon",
            "",
            "s1",
            "get_page_dom",
            &serde_json::json!({}),
        )
        .await
        .unwrap_err();

        assert_eq!(err.code, "no_remote_client");
    }

    #[tokio::test]
    async fn local_tool_returns_without_member_or_mqtt() {
        let (client, _eventloop) =
            rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
        let rpc_client = Arc::new(Mutex::new(RpcClient::new(
            Arc::new(client) as Arc<dyn MessagePublisher>,
            "team1".to_string(),
            "daemon".to_string(),
        )));

        match invoke_remote_tool(
            &rpc_client,
            "daemon",
            "",
            "s1",
            "show_page_nav_links",
            &serde_json::json!({ "links": ["https://example.com"] }),
        )
        .await
        {
            Ok(v) => assert!(v.is_null()),
            Err(e) => panic!("local tool should succeed: {}", e.message),
        }
    }
}

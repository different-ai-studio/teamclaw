//! Unix-sock remote-tool-call handler (deduplicated).

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::oneshot;

use super::DaemonServer;

impl DaemonServer {
    pub(crate) async fn spawn_remote_tool_sock_handler(
        &self,
        payload: Value,
        reply_tx: oneshot::Sender<String>,
    ) {
        let session_id = payload
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let tool_name = payload
            .get("tool_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let arguments = payload
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        let member_actor_id = {
            let agents = self.agents.lock().await;
            let targets = self.session_remote_targets.lock().await;
            crate::remote_tools::resolve_member_for_session(&agents, &targets, &session_id)
        };
        let rpc_client = Arc::clone(&self.rpc_client);
        let actor_id = self.actor_id.clone();
        tokio::spawn(async move {
            let resp = match member_actor_id {
                Some(target) => {
                    crate::remote_tools::proxy::handle_sock_invoke_for_target(
                        &rpc_client,
                        &actor_id,
                        &target,
                        &session_id,
                        &tool_name,
                        &arguments,
                    )
                    .await
                }
                None => crate::remote_tools::proxy::sock_err(
                    "no_remote_client",
                    "no member actor registered for session (runtimeStart not seen recently)",
                ),
            };
            let _ = reply_tx.send(resp.to_string());
        });
    }
}
